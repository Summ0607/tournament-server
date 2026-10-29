const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeTournamentDays } = require('./tournamentSchedule');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

const CONFIG_LOCK_MESSAGE = 'Event configuration is locked because operational use has begun. Reset the run to return to preparation before editing.';

function hasOperationalUse(state) {
  return Boolean(state && (state.configLockedAt || state.eventStartedAt || state.day2StartedAt ||
    Object.values(state.rings || {}).some((ring) =>
      ring.groupDivisionNumber || ring.currentGroupDivisionNumber || ring.currentGroupId ||
      ['queuedGroupDivisionNumbers', 'queuedGroupIds', 'completedGroupDivisionNumbers', 'completedGroupIds', 'phaseHistory']
        .some((field) => (ring[field] || []).length) ||
      ring.tabletLabel || ring.assignmentStartedAt || ring.phaseStartedAt ||
      ring.currentPhaseStartTime || ring.currentPhaseEndTime || ring.assistanceRequestedAt || ring.assistanceType ||
      (ring.phase && ring.phase !== 'idle') || ring.checkInCount || ring.checkInTotal ||
      ring.phaseCompletedCount || ring.phaseTotalCount || ring.phaseProgress)));
}

function normalizeEventRingConfig(config) {
  const dimensions = {};
  for (const field of ['ringConfigX', 'ringConfigY']) {
    const value = config && config[field];
    const number = value == null || value === '' ? 0 : Number(value);
    if ((value != null && typeof value !== 'number' && typeof value !== 'string')
      || !Number.isSafeInteger(number) || number < 0 || number > (field === 'ringConfigX' ? 26 : 50)) {
      const error = new Error(`${field} must be a non-negative whole number no greater than ${field === 'ringConfigX' ? 26 : 50}`);
      error.statusCode = 400;
      throw error;
    }
    dimensions[field] = number;
  }
  return dimensions;
}

function createEventConfigStore(eventsRoot) {
  function configFile(eventName) {
    return path.join(eventsRoot, eventName, 'event-config.json');
  }

  function readAssignmentState(eventName) {
    const file = path.join(eventsRoot, eventName, 'ring-assignments.json');
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { rings: {} };
    const resultsDir = path.join(eventsRoot, eventName, 'results');
    const locked = hasOperationalUse(state) || (fs.existsSync(resultsDir) && fs.readdirSync(resultsDir).length > 0);
    if (locked) {
      if (!state.configLockedAt) {
        state.configLockedAt = new Date().toISOString();
        writeJsonAtomicSync(file, state);
      }
    } else {
      const event = readEventConfig(eventName);
      const config = { letterCount: event.ringConfigX, numberCount: event.ringConfigY };
      if (!state.config || state.config.letterCount !== config.letterCount || state.config.numberCount !== config.numberCount) {
        Object.assign(state, { config, rings: {}, eventStartedAt: '', day2StartedAt: '', configLockedAt: '' });
        writeJsonAtomicSync(file, state);
      }
    }
    return state;
  }

  function configurationStatus(eventName) {
    const state = readAssignmentState(eventName);
    const config = readEventConfig(eventName);
    return {
      configurationLocked: hasOperationalUse(state),
      configurationLockReason: hasOperationalUse(state) ? CONFIG_LOCK_MESSAGE : '',
      layoutMismatch: state.config?.letterCount !== config.ringConfigX || state.config?.numberCount !== config.ringConfigY
    };
  }

  function readEventConfig(eventName) {
    const name = String(eventName || '').trim();
    const defaults = {
      eventName: name,
      name,
      location: '',
      date: '',
      tournamentDays: 1,
      ringConfigX: 0,
      ringConfigY: 0,
      createdAt: '',
      updatedAt: ''
    };
    if (!name || !fs.existsSync(configFile(name))) return defaults;

    const raw = JSON.parse(fs.readFileSync(configFile(name), 'utf8'));
    const { ringConfig, ...metadata } = raw;
    const dimensions = normalizeEventRingConfig(raw);
    if (raw.ringConfigX == null && raw.ringConfigY == null && typeof ringConfig === 'string') {
      const match = ringConfig.match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i);
      if (match) {
        Object.assign(dimensions, normalizeEventRingConfig({
          ringConfigX: match[1],
          ringConfigY: match[2]
        }));
      }
    }
    return {
      ...defaults,
      ...metadata,
      ...dimensions,
      tournamentDays: normalizeTournamentDays(raw.tournamentDays),
      eventName: name,
      name: String(raw.name || name).trim() || name
    };
  }

  function writeEventConfig(eventName, config) {
    const name = String(eventName || '').trim();
    if (!name) throw new Error('eventName is required');
    if (configurationStatus(name).configurationLocked) {
      const error = new Error(CONFIG_LOCK_MESSAGE);
      error.statusCode = 409;
      throw error;
    }

    const payload = {
      eventName: name,
      name: String(config && config.name || name).trim() || name,
      location: String(config && config.location || '').trim(),
      date: String(config && config.date || '').trim(),
      tournamentDays: normalizeTournamentDays(config && config.tournamentDays),
      ...normalizeEventRingConfig(config),
      createdAt: String(config && config.createdAt || '').trim(),
      updatedAt: new Date().toISOString()
    };
    if (!payload.createdAt) payload.createdAt = payload.updatedAt;
    const previous = fs.existsSync(configFile(name)) ? JSON.parse(fs.readFileSync(configFile(name), 'utf8')) : null;
    writeJsonAtomicSync(configFile(name), payload);
    try {
      readAssignmentState(name);
    } catch (error) {
      if (previous) writeJsonAtomicSync(configFile(name), previous);
      else fs.unlinkSync(configFile(name));
      throw error;
    }
    return payload;
  }

  function resetRun(eventName) {
    const eventDir = path.join(eventsRoot, eventName);
    const state = readAssignmentState(eventName);
    const config = readEventConfig(eventName);
    const archiveDir = path.join(eventDir, 'run-archives', `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    writeJsonAtomicSync(path.join(archiveDir, 'event-config.json'), config);
    writeJsonAtomicSync(path.join(archiveDir, 'ring-assignments.json'), state);
    const resultsDir = path.join(eventDir, 'results');
    const archivedResults = path.join(archiveDir, 'results');
    const hadResults = fs.existsSync(resultsDir);
    if (hadResults) fs.renameSync(resultsDir, archivedResults);
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      writeJsonAtomicSync(path.join(eventDir, 'ring-assignments.json'), {
        config: { letterCount: config.ringConfigX, numberCount: config.ringConfigY },
        configLockedAt: '', eventStartedAt: '', day2StartedAt: '', rings: {}
      });
    } catch (error) {
      if (hadResults) {
        fs.rmdirSync(resultsDir);
        fs.renameSync(archivedResults, resultsDir);
      }
      throw error;
    }
    return { archive: path.relative(eventDir, archiveDir) };
  }

  return { readEventConfig, writeEventConfig, readAssignmentState, configurationStatus, resetRun };
}

module.exports = { createEventConfigStore, normalizeEventRingConfig, hasOperationalUse, CONFIG_LOCK_MESSAGE };
