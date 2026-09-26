const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

require('./db/init');

const importCSV = require('./db/import-csv');
const { buildGroups, buildGroupsWithReview } = require('./backend/groupBuilder');
const { createCompetitorStore } = require('./backend/competitorStore');
const { createGroupStore } = require('./backend/groupStore');
const { createDivisionRouter } = require('./backend/divisionRoutes');
const { createRingRouter } = require('./backend/ringRoutes');
const { createResultPacketStore } = require('./backend/resultPacket');
const { registerPageRoutes } = require('./backend/pages');

const app = express();
const PORT = 3000;

// ─────────────────────────────────────────────
// BASE CONSTANTS
// ─────────────────────────────────────────────
const ROOT_DIR = __dirname;
const CONTROL_BOARD_DIR = path.join(ROOT_DIR, 'head-table');
const DISCONNECT_AFTER_MS = 90 * 1000;
const MAX_LETTERS = 26;
const MAX_NUMBERS = 50;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GROUPS_DIR = path.join(ROOT_DIR, 'groups');
const RESULTS_DIR = path.join(ROOT_DIR, 'Results');
const RING_ASSIGNMENTS_FILE = path.join(ROOT_DIR, 'ring-assignments.json');
const DEFAULT_TOURNAMENT_DB_PATH = path.join(ROOT_DIR, 'db', 'tournament.db');
const TOURNAMENT_DB_PATH = DEFAULT_TOURNAMENT_DB_PATH;
const EVENTS_ROOT = path.join(ROOT_DIR, 'events');
//const EVENTS_ROOT = [
//  path.join(ROOT_DIR, 'event'),
//  path.join(ROOT_DIR, 'events')
//].find((candidate) => fs.existsSync(candidate)) || path.join(ROOT_DIR, 'event');
const ACTIVE_EVENT_FILE = path.join(EVENTS_ROOT, 'active.json');

function resolveEventDbPath(eventName = readActiveEvent()) {
  const normalizedEventName = String(eventName || '').trim();
  if (!normalizedEventName) {
    return TOURNAMENT_DB_PATH;
  }

  const eventDbPath = path.join(EVENTS_ROOT, normalizedEventName, 'tournament.db');
  return fs.existsSync(eventDbPath) ? eventDbPath : TOURNAMENT_DB_PATH;
}

function resolveEventDirectory(eventName = readActiveEvent()) {
  const normalizedEventName = String(eventName || '').trim();
  if (!normalizedEventName) {
    return '';
  }

  return path.join(EVENTS_ROOT, normalizedEventName);
}

const resultPacketStore = createResultPacketStore({
  getResultsDirectory: () => {
    const activeEvent = readActiveEvent();
    return activeEvent
      ? path.join(EVENTS_ROOT, activeEvent, 'results')
      : RESULTS_DIR;
  }
});

function resolveGroupsDir(eventName = readActiveEvent()) {
  const normalizedEventName = String(eventName || '').trim();
  if (!normalizedEventName) {
    return GROUPS_DIR;
  }

  const eventDir = resolveEventDirectory(normalizedEventName);
  if (eventDir && fs.existsSync(eventDir)) {
    return path.join(eventDir, 'groups');
  }

  return GROUPS_DIR;
}

// ─────────────────────────────────────────────
// STORES (NOW USING EVENT PATHS)
// ─────────────────────────────────────────────
const competitorStore = createCompetitorStore(TOURNAMENT_DB_PATH);
const groupStoresByEvent = new Map();
function currentGroupStore() {
  const cacheKey = resolveGroupsDir() || '__default__';
  if (!groupStoresByEvent.has(cacheKey)) {
    groupStoresByEvent.set(cacheKey, createGroupStore());
  }
  return groupStoresByEvent.get(cacheKey);
}
const groupStore = {
  saveGroups(groups) {
    return currentGroupStore().saveGroups(groups);
  },
  loadGroups() {
    return currentGroupStore().loadGroups();
  },
  loadGroup(groupId) {
    return currentGroupStore().loadGroup(groupId);
  },
  groupExists(groupId) {
    return currentGroupStore().groupExists(groupId);
  },
  clearGroups() {
    return currentGroupStore().clearGroups();
  }
};

async function primeGroupCacheFromDatabase() {
  const activeDbPath = resolveEventDbPath();
  const groups = await loadGroupsFromDatabase(activeDbPath);
  currentGroupStore().saveGroups(groups);
}

function groupRowsToGroups(rows) {
  const groupsByKey = new Map();
  for (const row of rows) {
    const groupDivisionNumber = Number.parseInt(row.groupDivisionNumber, 10);
    const key = Number.isFinite(groupDivisionNumber) ? `num-${groupDivisionNumber}` : `id-${String(row.groupDivisionId || '').trim()}`;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        groupId: String(row.groupDivisionId || `group-${groupDivisionNumber || groupsByKey.size + 1}`),
        id: String(row.groupDivisionId || `group-${groupDivisionNumber || groupsByKey.size + 1}`),
        name: String(row.groupDivisionName || row.groupDivisionId || `Group ${groupDivisionNumber || groupsByKey.size + 1}`),
        groupDivisionNumber: Number.isFinite(groupDivisionNumber) ? groupDivisionNumber : undefined,
        competitors: []
      });
    }

    const group = groupsByKey.get(key);
    group.competitors.push({
      ...row,
      id: String(row.id),
      firstName: row.firstName || '',
      lastName: row.lastName || '',
      fullName: [row.firstName, row.lastName].filter(Boolean).join(' ') || '',
      gender: row.gender || 'Unknown',
      rank: row.rank || '',
      age: Number.isFinite(Number(row.age)) ? Number(row.age) : 0
    });
  }

  return Array.from(groupsByKey.values()).map((group) => ({
    ...group,
    competitors: group.competitors.sort((a, b) => {
      const aDivision = Number.parseInt(a.competitionDivisionNumber, 10);
      const bDivision = Number.parseInt(b.competitionDivisionNumber, 10);
      if (Number.isFinite(aDivision) && Number.isFinite(bDivision) && aDivision !== bDivision) {
        return aDivision - bDivision;
      }
      return Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10);
    })
  }));
}

async function loadGroupsFromDatabase(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return [];
  }

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM competitors WHERE groupDivisionNumber IS NOT NULL ORDER BY groupDivisionNumber ASC, competitionDivisionNumber ASC, id ASC', (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result || []);
      });
    });
    return groupRowsToGroups(rows);
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}
const db = new sqlite3.Database(TOURNAMENT_DB_PATH);

// ─────────────────────────────────────────────
// GLOBAL MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ errors: ['payload: malformed JSON'] });
  }
  return next(err);
});

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readActiveEvent() {
  try {
    if (!fs.existsSync(ACTIVE_EVENT_FILE)) {
      return '';
    }
    const raw = JSON.parse(fs.readFileSync(ACTIVE_EVENT_FILE, 'utf8'));
    return String(raw && raw.activeEvent ? raw.activeEvent : '').trim();
  } catch (err) {
    return '';
  }
}

function getEventPaths(eventName) {
  const eventDir = path.join(EVENTS_ROOT, eventName);
  return {
    eventDir,
    dbPath: path.join(eventDir, 'tournament.db'),
    groupsDir: path.join(eventDir, 'groups'),
    resultsDir: path.join(eventDir, 'results'),
    ringAssignmentsFile: path.join(eventDir, 'ring-assignments.json')
  };
}

function buildRingId(letter, number) {
  return `ring-${letter.toLowerCase()}-${number}`;
}

function buildRingLabel(letter, number) {
  return `${letter}${number}`;
}

function createEmptyRingState(ringLabel) {
  return {
    ringLabel,
    currentGroupId: '',
    queuedGroupIds: [],
    completedGroupIds: [],
    assignmentStartedAt: '',
    checkInCount: 0,
    checkInTotal: 0,
    phaseCompletedCount: 0,
    phaseTotalCount: 0,
    phaseProgress: 0,
    assistanceType: '',
    assistanceRequestedAt: '',
    tabletLabel: '',
    lastHeartbeatAt: '',
    phaseStartedAt: '',
    phase: 'idle'
  };
}

function normalizeRingState(ringState, ringLabel) {
  const normalized = createEmptyRingState(ringLabel);
  if (!ringState || typeof ringState !== 'object') {
    return normalized;
  }
  normalized.ringLabel = ringState.ringLabel || ringLabel;
  normalized.currentGroupId = ringState.currentGroupId || '';
  normalized.queuedGroupIds = Array.isArray(ringState.queuedGroupIds) ? ringState.queuedGroupIds : [];
  normalized.completedGroupIds = Array.isArray(ringState.completedGroupIds) ? ringState.completedGroupIds : [];
  normalized.assignmentStartedAt = ringState.currentGroupId
    ? (ringState.assignmentStartedAt || ringState.phaseStartedAt || ringState.lastHeartbeatAt || '')
    : '';
  normalized.checkInCount = clampInt(ringState.checkInCount, 0, 0, 9999);
  normalized.checkInTotal = clampInt(ringState.checkInTotal, 0, 0, 9999);
  normalized.phaseCompletedCount = clampInt(ringState.phaseCompletedCount, 0, 0, 9999);
  normalized.phaseTotalCount = clampInt(ringState.phaseTotalCount, 0, 0, 9999);
  normalized.phaseProgress = clampInt(ringState.phaseProgress, 0, 0, 100);
  normalized.assistanceType = ringState.assistanceType || '';
  normalized.assistanceRequestedAt = ringState.assistanceRequestedAt || '';
  normalized.tabletLabel = ringState.tabletLabel || '';
  normalized.lastHeartbeatAt = ringState.lastHeartbeatAt || '';
  normalized.phase = ringState.phase || 'idle';
  normalized.phaseStartedAt = ringState.phaseStartedAt || (normalized.phase !== 'idle' ? normalized.lastHeartbeatAt || '' : '');
  return normalized;
}

function normalizeConfig(rawConfig) {
  const defaults = { letterCount: 1, numberCount: 2 };
  if (!rawConfig || typeof rawConfig !== 'object') return defaults;
  return {
    letterCount: clampInt(rawConfig.letterCount, defaults.letterCount, 1, MAX_LETTERS),
    numberCount: clampInt(rawConfig.numberCount, defaults.numberCount, 1, MAX_NUMBERS)
  };
}

function generateRings(config, existingRings = {}) {
  const rings = {};
  for (let letterIndex = 0; letterIndex < config.letterCount; letterIndex += 1) {
    const letter = LETTERS[letterIndex];
    for (let number = 1; number <= config.numberCount; number += 1) {
      const ringId = buildRingId(letter, number);
      const ringLabel = buildRingLabel(letter, number);
      rings[ringId] = normalizeRingState(existingRings[ringId], ringLabel);
    }
  }
  return rings;
}

function createDefaultAssignments() {
  const config = { letterCount: 1, numberCount: 2 };
  return {
    config,
    eventStartedAt: '',
    rings: generateRings(config)
  };
}

function ensureStateStructure(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const config = normalizeConfig(state.config);
  const rings = generateRings(config, state.rings || {});
  const inferredStart = (() => {
    const timestamps = [];
    for (const ringState of Object.values(rings)) {
      const candidate = ringState.phaseStartedAt || ringState.lastHeartbeatAt;
      if (!candidate) continue;
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) timestamps.push(parsed);
    }
    if (!timestamps.length) return '';
    return new Date(Math.min.apply(null, timestamps)).toISOString();
  })();
  return {
    config,
    eventStartedAt: String(state.eventStartedAt || inferredStart || '').trim(),
    rings
  };
}

function readAssignmentsState() {
  if (!fs.existsSync(RING_ASSIGNMENTS_FILE)) {
    const defaults = createDefaultAssignments();
    fs.writeFileSync(RING_ASSIGNMENTS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const raw = JSON.parse(fs.readFileSync(RING_ASSIGNMENTS_FILE, 'utf8'));
  const normalized = ensureStateStructure(raw);
  fs.writeFileSync(RING_ASSIGNMENTS_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function writeAssignmentsState(state) {
  fs.writeFileSync(RING_ASSIGNMENTS_FILE, JSON.stringify(state, null, 2));
}

function getRingState(state, ringId) {
  return state.rings[ringId] || null;
}

function listAllowedRingLabels(state) {
  return Object.values(state.rings).map((ring) => ring.ringLabel);
}

function serverBaseUrlForRequest(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function buildRingResponse(req, ringId, ringState, state = {}) {
  return {
    ringId,
    ringLabel: ringState.ringLabel,
    serverBaseUrl: serverBaseUrlForRequest(req),
    eventStartedAt: state.eventStartedAt || '',
    currentGroupId: ringState.currentGroupId,
    queuedGroupIds: ringState.queuedGroupIds,
    completedGroupIds: ringState.completedGroupIds,
    assignmentStartedAt: ringState.assignmentStartedAt,
    checkInCount: ringState.checkInCount,
    checkInTotal: ringState.checkInTotal,
    phaseCompletedCount: ringState.phaseCompletedCount,
    phaseTotalCount: ringState.phaseTotalCount,
    phaseProgress: ringState.phaseProgress,
    assistanceType: ringState.assistanceType,
    assistanceRequestedAt: ringState.assistanceRequestedAt,
    tabletLabel: ringState.tabletLabel,
    lastHeartbeatAt: ringState.lastHeartbeatAt,
    phaseStartedAt: ringState.phaseStartedAt,
    phase: ringState.phase,
    currentGroup: groupStore.loadGroup(ringState.currentGroupId)
  };
}

function touchHeartbeat(ringState) {
  ringState.lastHeartbeatAt = new Date().toISOString();
}

function setRingPhase(ringState, phase) {
  const nextPhase = phase || 'idle';
  if (ringState.phase !== nextPhase || !ringState.phaseStartedAt) {
    ringState.phase = nextPhase;
    ringState.phaseStartedAt = new Date().toISOString();
    return;
  }
  ringState.phase = nextPhase;
}

function resetRingToScratch(ringState) {
  ringState.currentGroupId = '';
  ringState.queuedGroupIds = [];
  ringState.completedGroupIds = [];
  ringState.assignmentStartedAt = '';
  ringState.checkInCount = 0;
  ringState.checkInTotal = 0;
  ringState.phaseCompletedCount = 0;
  ringState.phaseTotalCount = 0;
  ringState.phaseProgress = 0;
  ringState.assistanceType = '';
  ringState.assistanceRequestedAt = '';
  ringState.tabletLabel = '';
  ringState.lastHeartbeatAt = '';
  ringState.phaseStartedAt = '';
  ringState.phase = 'idle';
}

function applyHeartbeatPolicy() {
  return false;
}

function resetAssignments(state) {
  state.rings = generateRings(state.config);
  state.eventStartedAt = '';
}

function setRingConfig(state, letterCount, numberCount) {
  state.config = normalizeConfig({ letterCount, numberCount });
  state.rings = generateRings(state.config);
}

function findGroupUsageAcrossRings(state, targetGroupId, excludedRingId = '') {
  if (!targetGroupId) return null;
  const rings = state.rings || {};
  for (const [ringId, ringState] of Object.entries(rings)) {
    if (ringId === excludedRingId) continue;
    const queue = Array.isArray(ringState.queuedGroupIds) ? ringState.queuedGroupIds : [];
    if (ringState.currentGroupId === targetGroupId || queue.includes(targetGroupId)) {
      return {
        ringId,
        ringLabel: ringState.ringLabel || ringId
      };
    }
  }
  return null;
}

function readAndroidVersionInfo() {
  const candidates = [
    path.join(ROOT_DIR, 'app', 'build.gradle.kts'),
    path.join(ROOT_DIR, 'build.gradle.kts')
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    const gradleText = fs.readFileSync(candidate, 'utf8');
    const versionCodeMatch = gradleText.match(/versionCode\s*=\s*(\d+)/);
    const versionNameMatch = gradleText.match(/versionName\s*=\s*["']([^"']+)["']/);

    if (versionCodeMatch && versionNameMatch) {
      return {
        versionCode: Number.parseInt(versionCodeMatch[1], 10),
        versionName: versionNameMatch[1]
      };
    }
  }

  return { versionCode: 0, versionName: '0.0' };
}

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

function sanitizeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function saveUploadedDivisionPacket(ringId, packet) {
  if (!packet || typeof packet !== 'object') return;
  ensureResultsDir();
  const divisionId = sanitizeFilePart(packet.divisionId || packet.groupId || ringId || 'division-unknown');
  const filePath = path.join(RESULTS_DIR, `${divisionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(packet, null, 2));
}

registerPageRoutes(app, ROOT_DIR, CONTROL_BOARD_DIR);

app.get('/api/version', (req, res) => {
  const versionInfo = readAndroidVersionInfo();
  res.json({
    versionCode: versionInfo.versionCode,
    versionName: versionInfo.versionName
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Group server is running' });
});

app.get('/api/events/active', (req, res) => {
  try {
    return res.json({
      activeEvent: readActiveEvent()
    });
  } catch (err) {
    console.error('Failed to read active event:', err);
    return res.status(500).json({
      error: 'Failed to read active event'
    });
  }
});

app.get('/api/results', (req, res) => {
  try {
    return res.json(resultPacketStore.listSummaries());
  } catch (err) {
    console.error('Failed to list result records:', err);
    return res.status(500).json({ error: 'Failed to list result records' });
  }
});

app.get('/api/results/group/:groupId', (req, res) => {
  try {
    const records = resultPacketStore.findByGroupId(String(req.params.groupId || '').trim());
    if (!records.length) {
      return res.status(404).json({ error: `Result not found for group: ${req.params.groupId}` });
    }
    return res.json(records);
  } catch (err) {
    console.error('Failed to load group result history:', err);
    return res.status(500).json({ error: 'Failed to load group result history' });
  }
});

app.get('/api/results/:serverRecordId', (req, res) => {
  try {
    const record = resultPacketStore.get(String(req.params.serverRecordId || '').trim());
    if (!record) {
      return res.status(404).json({ error: `Result not found: ${req.params.serverRecordId}` });
    }
    return res.json(record);
  } catch (err) {
    console.error('Failed to load result record:', err);
    return res.status(500).json({ error: 'Failed to load result record' });
  }
});

app.get('/api/competitors', async (req, res) => {
  try {
    const activeDbPath = resolveEventDbPath();
    const activeCompetitorStore = createCompetitorStore(activeDbPath);
    const competitors = await activeCompetitorStore.loadCompetitors();
    res.json(competitors);
  } catch (err) {
    console.error('Error loading competitors:', err);
    res.status(500).json({ error: 'Failed to load competitors' });
  }
});

app.get('/api/competitors/table', (req, res) => {
  const activeDbPath = resolveEventDbPath();
  const activeDb = new sqlite3.Database(activeDbPath, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) {
      console.error(openErr);
      return res.status(500).json({ error: 'Database error' });
    }
  });

  activeDb.all('SELECT * FROM competitors', [], (err, rows) => {
    activeDb.close();

    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }

    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return res.json({ headers, rows });
  });
});

app.get('/download-app', (req, res) => {
  const apkPath = path.join(ROOT_DIR, 'app-debug.apk');
  if (!fs.existsSync(apkPath)) {
    return res.status(404).send('APK not found. Build the app first and place app-debug.apk in the server folder.');
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="tournament-scoring.apk"');
  return res.sendFile(apkPath);
});

app.get('/search', (req, res) => {
  const firstName = String(req.query.firstName || req.query.name || '').trim();
  const lastName = String(req.query.lastName || '').trim();
  const associationNumber = String(req.query.associationNumber || '').trim();
  const groupDivisionNumber = String(req.query.groupDivisionNumber || '').trim();
  const rank = String(req.query.rank || '').trim();
  const activeDbPath = resolveEventDbPath();
  const activeDb = new sqlite3.Database(activeDbPath, sqlite3.OPEN_READONLY, (openErr) => {
   if (openErr) {
     console.error(openErr);
     return res.status(500).json({ error: 'Database search failed.' });
   }
  });

  const clauses = [];
  const params = [];

  if (firstName) {
   clauses.push('firstName LIKE ?');
   params.push(`${firstName}%`);
  }
  if (lastName) {
   clauses.push('lastName LIKE ?');
   params.push(`${lastName}%`);
  }
  if (associationNumber) {
   clauses.push('associationNumber = ?');
   params.push(associationNumber);
  }
  if (groupDivisionNumber) {
   const parsedGroupDivision = Number.parseInt(groupDivisionNumber, 10);
   if (Number.isFinite(parsedGroupDivision)) {
     clauses.push('groupDivisionNumber = ?');
     params.push(parsedGroupDivision);
   }
  }
  if (rank) {
   clauses.push('rank = ?');
   params.push(rank);
  }

  const sql = clauses.length
   ? `SELECT * FROM competitors WHERE ${clauses.join(' AND ')} ORDER BY lastName ASC, firstName ASC, id ASC`
   : 'SELECT * FROM competitors ORDER BY lastName ASC, firstName ASC, id ASC LIMIT 0';

  activeDb.all(sql, params, (err, rows) => {
   activeDb.close();

   if (err) {
     console.error('Search error:', err);
     return res.status(500).json({ error: 'Database search failed.' });
    }
    return res.json(rows);
  });
});

app.use('/api', createDivisionRouter({
  competitorStore: () => createCompetitorStore(resolveEventDbPath()),
  groupStore,
  buildGroups,
  buildGroupsWithReview
}));

app.post('/api/events/activate', async (req, res) => {
  const body = req.body || {};
  const eventName = String(body.eventName || '').trim();
  if (!eventName) {
    return res.status(400).json({ error: 'eventName is required' });
  }

  if (!fs.existsSync(EVENTS_ROOT)) {
    fs.mkdirSync(EVENTS_ROOT, { recursive: true });
  }

  const eventDir = path.join(EVENTS_ROOT, eventName);
  if (!fs.existsSync(eventDir)) {
    return res.status(404).json({ error: `Event folder not found: ${eventName}` });
  }

  try {
    currentGroupStore().clearGroups();
    fs.writeFileSync(ACTIVE_EVENT_FILE, JSON.stringify({ activeEvent: eventName }, null, 2));
    await primeGroupCacheFromDatabase();
    return res.json({ ok: true, activeEvent: eventName, dbPath: path.join(eventDir, 'tournament.db') });
  } catch (err) {
    console.error('Failed to activate event:', err);
    return res.status(500).json({ error: 'Failed to activate event' });
  }
});

app.post('/api/events/import-csv', async (req, res) => {
  let tempCsvPath = '';
  try {
    const body = req.body || {};
    const csvFilePath = String(body.csvPath || '').trim();
    const csvText = typeof body.csvText === 'string' ? body.csvText : '';
    const csvName = path.basename(String(body.csvName || 'uploaded.csv').trim() || 'uploaded.csv').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const eventName = String(body.eventName || readActiveEvent() || '').trim();
    let importPath = csvFilePath;

    if (!csvFilePath && !csvText) {
      return res.status(400).json({ error: 'csvPath is required' });
    }

    if (csvText) {
      tempCsvPath = path.join(os.tmpdir(), `tournament-import-${Date.now()}-${csvName}`);
      fs.writeFileSync(tempCsvPath, csvText, 'utf8');
      importPath = tempCsvPath;
    }

    if (!fs.existsSync(importPath)) {
      if (tempCsvPath && fs.existsSync(tempCsvPath)) {
        fs.unlinkSync(tempCsvPath);
      }
      return res.status(404).json({ error: `CSV not found: ${csvFilePath}` });
    }

    const targetEventName = eventName || readActiveEvent();
    const targetDbPath = targetEventName
      ? path.join(EVENTS_ROOT, targetEventName, 'tournament.db')
      : TOURNAMENT_DB_PATH;

    if (targetEventName && !fs.existsSync(path.dirname(targetDbPath))) {
      return res.status(404).json({ error: `Event folder not found: ${targetEventName}` });
    }

    const result = await importCSV(importPath, targetDbPath, { clearExisting: true });
    return res.json({ ok: true, eventName: targetEventName || 'default', dbPath: targetDbPath, ...result });
  } catch (err) {
    console.error('Failed to import CSV for active event:', err);
    return res.status(500).json({ error: err.message || 'Failed to import CSV' });
  } finally {
    if (tempCsvPath && fs.existsSync(tempCsvPath)) {
      try {
        fs.unlinkSync(tempCsvPath);
      } catch (cleanupErr) {
        console.error('Failed to clean up temporary CSV:', cleanupErr);
      }
    }
  }
});

app.get('/api/events/list', (req, res) => {
  try {
    if (!fs.existsSync(EVENTS_ROOT)) {
      fs.mkdirSync(EVENTS_ROOT, { recursive: true });
      return res.json({ events: [] });
    }

    const items = fs.readdirSync(EVENTS_ROOT, { withFileTypes: true });
    const events = items
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .sort((a, b) => a.localeCompare(b));

    return res.json({ events });
  } catch (err) {
    console.error('Failed to list events:', err);
    return res.status(500).json({ error: 'Failed to list events' });
  }
});

app.post('/api/events/create', (req, res) => {
  const body = req.body || {};
  const eventName = String(body.eventName || '').trim();

  if (!eventName) {
    return res.status(400).json({ error: 'eventName is required' });
  }

  const { eventDir, dbPath, groupsDir, resultsDir, ringAssignmentsFile } = getEventPaths(eventName);

  try {
    if (fs.existsSync(eventDir)) {
      return res.status(409).json({ error: `Event already exists: ${eventName}` });
    }

    fs.mkdirSync(eventDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });
    currentGroupStore().clearGroups();

    const initializeDatabase = require('./db/init');
    initializeDatabase(dbPath)
      .then(() => {
        const defaultAssignments = {
          config: { letterCount: 1, numberCount: 2 },
          eventStartedAt: '',
          rings: {},
        };
        fs.writeFileSync(ringAssignmentsFile, JSON.stringify(defaultAssignments, null, 2));
        return res.json({ ok: true, eventName, dbPath});
      })
      .catch((err) => {
        console.error('Failed to create event database:', err);
        return res.status(500).json({ error: 'Failed to initialize event database' });
      });

    return;
  } catch (err) {
    console.error('Failed to create event:', err);
    return res.status(500).json({ error: 'Failed to create event' });
  }
});

async function resetEvent(eventName) {
  const normalizedName = String(eventName || '').trim() || readActiveEvent();
  if (!normalizedName) {
    throw new Error('eventName is required or no active event is set');
  }

  const { eventDir, dbPath, groupsDir, resultsDir, ringAssignmentsFile } = getEventPaths(normalizedName);
  if (!fs.existsSync(eventDir)) {
    const err = new Error(`Event folder not found: ${normalizedName}`);
    err.statusCode = 404;
    throw err;
  }

  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  if (fs.existsSync(groupsDir)) {
    fs.rmSync(groupsDir, { recursive: true, force: true });
  }

  if (fs.existsSync(resultsDir)) {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }

  if (fs.existsSync(ringAssignmentsFile)) {
    fs.unlinkSync(ringAssignmentsFile);
  }

  currentGroupStore().clearGroups();

  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const initializeDatabase = require('./db/init');
  await initializeDatabase(dbPath);

  const defaultAssignments = {
    config: { letterCount: 1, numberCount: 2 },
    eventStartedAt: '',
    rings: {},
  };
  fs.writeFileSync(ringAssignmentsFile, JSON.stringify(defaultAssignments, null, 2));
  fs.writeFileSync(ACTIVE_EVENT_FILE, JSON.stringify({ activeEvent: normalizedName }, null, 2));

  return { ok: true, eventName: normalizedName, activeEvent: normalizedName };
}

app.post('/api/events/reset', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await resetEvent(body.eventName);
    return res.json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    console.error('Failed to reset event:', err);
    return res.status(statusCode).json({ error: err.message || 'Failed to reset event' });
  }
});

app.use('/api', createRingRouter({
  readAssignmentsState,
  writeAssignmentsState,
  applyHeartbeatPolicy,
  setRingConfig,
  getRingState,
  listAllowedRingLabels,
  buildRingResponse,
  touchHeartbeat,
  setRingPhase,
  resetRingToScratch,
  resetAssignments,
  groupExists: groupStore.groupExists,
  findGroupUsageAcrossRings,
  loadGroup: groupStore.loadGroup,
  serverBaseUrlForRequest,
  DISCONNECT_AFTER_MS,
  saveUploadedDivisionPacket,
  resultPacketStore,
  readActiveEvent
}));

async function startServer() {
  try {
    await primeGroupCacheFromDatabase();
  } catch (err) {
    console.error('Failed to prime group cache from database:', err);
  }

  app.listen(PORT, () => {
    console.log(`Group server running at http://localhost:${PORT}`);
    console.log(`Control board: http://localhost:${PORT}/control-board`);
    console.log(`Group example: http://localhost:${PORT}/api/groups/group-1`);
    console.log(`Ring request-group example: http://localhost:${PORT}/api/rings/ring-a-1/request-group`);
  });
}

startServer();

if (process.argv.includes('--import')) {
  setTimeout(() => {
    importCSV(path.join(ROOT_DIR, 'competitors.csv'));
  }, 500);
}
