const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

const packetType = 'tournament-judge-service';
const serviceRoles = ['center', 'corner', 'scorekeeper', 'timekeeper', 'sktk', 'arbitrator'];
const actions = ['SEATED', 'REPLACED', 'SWAPPED'];
const phaseNames = ['P1', 'P2'];
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

function boundedText(value, label, maximum, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) {
    fail(`${label} must be a nonempty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function validateJudge(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}.`);
  return {
    associationId: boundedText(value.associationId, `${label} Association ID`, 100),
    name: boundedText(value.name || '', `${label} name`, 200, true),
    rank: boundedText(value.rank || '', `${label} rank`, 40, true)
  };
}

function validateServicePacket(input, ringId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      input.type !== packetType || input.schemaVersion !== 1) fail('Unsupported judge service packet.');
  const submissionId = boundedText(input.submissionId, 'submissionId', 80);
  if (!/^[a-f0-9-]{36}$/i.test(submissionId)) fail('submissionId must be a UUID.');
  const packetRing = boundedText(input.ringId, 'ringId', 100);
  if (packetRing !== ringId) fail('The service packet ring does not match the request ring.', 409);
  const phase = boundedText(input.phase, 'phase', 2);
  if (!phaseNames.includes(phase)) fail('phase must be P1 or P2.');
  if (!Array.isArray(input.divisions) || !input.divisions.length || input.divisions.length > 500) {
    fail('A service packet must contain 1 to 500 divisions.');
  }
  const anchors = new Set();
  let historyCount = 0;
  const divisions = input.divisions.map((division) => {
    if (!division || typeof division !== 'object' || Array.isArray(division)) fail('Invalid division service history.');
    const groupAnchor = boundedText(division.groupAnchor, 'groupAnchor', 120);
    if (anchors.has(groupAnchor)) fail('A division may appear only once in a ring-phase packet.');
    anchors.add(groupAnchor);
    if (!division.seats || typeof division.seats !== 'object' || Array.isArray(division.seats)) fail('Division service seats are required.');
    const seats = {};
    const seatedIds = new Set();
    for (const [role, list] of Object.entries(division.seats)) {
      if (!serviceRoles.includes(role) || !Array.isArray(list) || list.length > 20) fail('Invalid service role or seat list.');
      seats[role] = list.map((judge) => {
        const valid = validateJudge(judge, 'Seated judge');
        if (seatedIds.has(valid.associationId.toUpperCase())) fail('A judge cannot occupy multiple service roles in one division.');
        seatedIds.add(valid.associationId.toUpperCase());
        return valid;
      });
    }
    if (!Array.isArray(division.history) || division.history.length > 5000) fail('Invalid division service history.');
    historyCount += division.history.length;
    if (historyCount > 20000) fail('Service history exceeds the packet limit.');
    const history = division.history.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !actions.includes(entry.action) || !serviceRoles.includes(entry.role)) fail('Invalid service history entry.');
      const at = boundedText(entry.at, 'Service history timestamp', 40);
      if (!Number.isFinite(Date.parse(at))) fail('Service history timestamps must be valid dates.');
      const judgeAssociationId = boundedText(entry.judgeAssociationId || '', 'Service history Association ID', 100, true);
      const previousJudgeAssociationId = boundedText(entry.previousJudgeAssociationId || '', 'Previous service identity', 100, true);
      if (entry.action === 'SEATED' && !judgeAssociationId) fail('A seating history entry must identify the judge.');
      if (entry.action === 'REPLACED' && !judgeAssociationId && !previousJudgeAssociationId) fail('A removal history entry must identify the outgoing judge.');
      if (entry.action === 'SWAPPED' && (!judgeAssociationId || !serviceRoles.includes(previousJudgeAssociationId))) {
        fail('A role swap must identify the judge and both roles.');
      }
      return { at, action: entry.action, role: entry.role, judgeAssociationId, previousJudgeAssociationId };
    });
    return { groupAnchor, seats, history };
  });
  const packet = { type: packetType, schemaVersion: 1, submissionId, ringId: packetRing, phase, divisions };
  if (Buffer.byteLength(JSON.stringify(packet)) > 2 * 1024 * 1024) fail('Service packet exceeds 2 MB.');
  return packet;
}

function eventIdFor(eventName, eventDate) {
  return `tournament:${crypto.createHash('sha256').update(JSON.stringify([eventName, eventDate])).digest('hex').slice(0, 32)}`;
}

function actualServiceRoles(packet, sktkRoles = {}) {
  const participants = new Map();
  const sktkRoleById = new Map(Object.entries(sktkRoles).map(([id, role]) => [id.toUpperCase(), role]));
  const add = (associationId, role) => {
    if (!associationId) return;
    let actualRole = role;
    if (role === 'sktk') {
      actualRole = sktkRoleById.get(associationId.toUpperCase());
      if (!['SCOREKEEPER', 'TIMEKEEPER'].includes(actualRole)) {
        fail(`Select SCOREKEEPER or TIMEKEEPER for ${associationId} before importing this legacy SK/TK service.`, 409);
      }
    }
    const key = `${associationId.toUpperCase()}\u0000${actualRole}`;
    participants.set(key, { associationId, role: actualRole });
  };
  const roleNames = {
    center: 'CENTER_JUDGE', corner: 'CORNER_JUDGE', scorekeeper: 'SCOREKEEPER',
    timekeeper: 'TIMEKEEPER', arbitrator: 'ARBITRATOR'
  };
  for (const division of packet.divisions) {
    for (const [role, judges] of Object.entries(division.seats)) {
      const actualRole = roleNames[role] || role;
      for (const judge of judges) add(judge.associationId, actualRole);
    }
    for (const entry of division.history) {
      const actualRole = roleNames[entry.role] || entry.role;
      add(entry.judgeAssociationId, actualRole);
      if (entry.action === 'REPLACED') add(entry.previousJudgeAssociationId, actualRole);
      if (entry.action === 'SWAPPED') add(entry.judgeAssociationId, roleNames[entry.previousJudgeAssociationId] || entry.previousJudgeAssociationId);
    }
  }
  return [...participants.values()].sort((a, b) => a.associationId.localeCompare(b.associationId) || a.role.localeCompare(b.role));
}

function createJudgeServicePacketStore({ root, now = () => new Date().toISOString() }) {
  if (!path.isAbsolute(root)) throw new Error('An absolute judge service packet directory is required.');
  fs.mkdirSync(root, { recursive: true });
  const indexFile = path.join(root, 'index.json');
  let queue = Promise.resolve();
  const readIndex = () => {
    if (!fs.existsSync(indexFile)) return { schemaVersion: 1, packets: [] };
    const value = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.packets)) throw new Error('Invalid judge service packet index.');
    return value;
  };
  const writeIndex = (index) => writeJsonAtomicSync(indexFile, index);
  const packetFile = (id) => path.join(root, `${id}.json`);
  const serialize = (packet) => JSON.stringify(packet);
  const transaction = (callback) => {
    const result = queue.then(callback);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    accept(eventName, packetInput, ringId, eventMetadata) {
      return transaction(() => {
        const packet = validateServicePacket(packetInput, ringId);
        const eventNameValue = boundedText(eventName, 'eventName', 200);
        const eventDate = boundedText(eventMetadata?.date, 'eventDate', 10);
        const parsedDate = new Date(`${eventDate}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(parsedDate.getTime()) ||
            parsedDate.toISOString().slice(0, 10) !== eventDate) {
          fail('eventDate must be a valid YYYY-MM-DD date.');
        }
        const eventScope = boundedText(eventMetadata?.scope, 'eventScope', 20);
        if (!['REGIONAL', 'NATIONAL', 'WORLD', 'IN_HOUSE'].includes(eventScope)) fail('eventScope is invalid.');
        const location = boundedText(eventMetadata?.location || '', 'event location', 200, true);
        const event = {
          name: eventNameValue,
          id: eventIdFor(eventNameValue, eventDate),
          date: eventDate,
          scope: eventScope,
          location
        };
        const index = readIndex();
        const packetHash = crypto.createHash('sha256').update(serialize(packet)).digest('hex');
        const existing = index.packets.find((item) => item.submissionId === packet.submissionId);
        if (existing) {
          if (existing.eventName !== eventNameValue) fail('submissionId was already used for a different event.', 409);
          if (existing.packetHash !== packetHash) fail('submissionId was already used for a different service packet.', 409);
          return { duplicate: true, ...existing.acknowledgement };
        }
        const phaseExisting = index.packets.find((item) => item.eventName === eventNameValue &&
          item.ringId === packet.ringId && item.phase === packet.phase);
        if (phaseExisting) fail('A service packet has already been received for this ring and phase.', 409);
        const serverRecordId = crypto.randomUUID();
        const receivedAt = now();
        const acknowledgement = {
          ok: true, accepted: true, status: 'accepted', submissionId: packet.submissionId,
          serverRecordId, receivedAt
        };
        writeJsonAtomicSync(packetFile(packet.submissionId), {
          schemaVersion: 1, event,
          packet
        });
        index.packets.push({
          eventName: eventNameValue, submissionId: packet.submissionId, serverRecordId, receivedAt,
          ringId: packet.ringId, phase: packet.phase, packetHash,
          acknowledgement, importedAt: ''
        });
        try { writeIndex(index); }
        catch (error) {
          try { fs.rmSync(packetFile(packet.submissionId), { force: true }); }
          catch (cleanupError) { console.error('Unable to remove unindexed judge service packet:', cleanupError); }
          throw error;
        }
        return { duplicate: false, ...acknowledgement };
      });
    },
    list(eventName) {
      const index = readIndex();
      return index.packets.filter((item) => !eventName || item.eventName === eventName)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
        .map((item) => {
          const stored = JSON.parse(fs.readFileSync(packetFile(item.submissionId), 'utf8'));
          return { ...item, event: stored.event, packet: stored.packet };
        });
    },
    get(eventName, submissionId) {
      const item = readIndex().packets.find((candidate) =>
        candidate.eventName === eventName && candidate.submissionId === submissionId);
      if (!item) return null;
      return { ...item, ...JSON.parse(fs.readFileSync(packetFile(submissionId), 'utf8')) };
    },
    markImported(eventName, submissionId, importedAt = now()) {
      return transaction(() => {
        const index = readIndex();
        const item = index.packets.find((candidate) =>
          candidate.eventName === eventName && candidate.submissionId === submissionId);
        if (!item) fail('Judge service packet not found.', 404);
        item.importedAt ||= importedAt;
        writeIndex(index);
        return item.importedAt;
      });
    }
  };
}

module.exports = {
  actualServiceRoles, createJudgeServicePacketStore, eventIdFor, validateServicePacket
};
