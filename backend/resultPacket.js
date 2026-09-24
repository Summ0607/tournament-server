const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORM_STATUSES = new Set(['COMPLETED', 'NOT_HELD']);
const ENTRY_STATUSES = new Set(['REGISTERED', 'SCRATCHED', 'COMPLETED']);
const CHECK_IN_STATUSES = new Set(['REGISTERED', 'CHECKED_IN', 'NO_SHOW']);
const SPARRING_OUTCOMES = new Set([
  'BYE',
  'FIRST_TO_THREE',
  'TIME_EXPIRED',
  'WARNING_DISQUALIFICATION',
  'SEVERE_WARNING_DISQUALIFICATION',
  'DOUBLE_DISQUALIFICATION',
  'TIE_BREAK_REQUIRED'
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function integerOrNull(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeFileIdentifier(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'result';
}

function isIsoTimestamp(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function addError(errors, pathName, message) {
  errors.push(`${pathName}: ${message}`);
}

function validateForms(name, value, participantIds, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, `disciplines.${name}`, 'must be an object');
    return;
  }
  if (!FORM_STATUSES.has(value.status)) {
    addError(errors, `disciplines.${name}.status`, 'must be COMPLETED or NOT_HELD');
  }
  if (!Number.isInteger(value.judgeCount) || value.judgeCount < 0 || value.judgeCount > 5) {
    addError(errors, `disciplines.${name}.judgeCount`, 'must be an integer from 0 through 5');
  }
  if (!Array.isArray(value.results)) {
    addError(errors, `disciplines.${name}.results`, 'must be an array');
    return;
  }
  value.results.forEach((result, index) => {
    const prefix = `disciplines.${name}.results[${index}]`;
    if (!result || typeof result !== 'object') {
      addError(errors, prefix, 'must be an object');
      return;
    }
    if (!nonEmpty(result.participantId) || !participantIds.has(result.participantId)) {
      addError(errors, `${prefix}.participantId`, 'must reference a packet participant');
    }
    if (!Array.isArray(result.scores) || result.scores.length < 1 || result.scores.length > 5 ||
        result.scores.some((score) => !finiteNumber(score))) {
      addError(errors, `${prefix}.scores`, 'must contain one through five finite numbers');
    }
    if (!finiteNumber(result.total)) addError(errors, `${prefix}.total`, 'must be a finite number');
    if (typeof result.place !== 'string') addError(errors, `${prefix}.place`, 'must be a string');
    if (typeof result.tieBreakDetail !== 'string') addError(errors, `${prefix}.tieBreakDetail`, 'must be a string');
  });
}

function validateSparring(value, participantIds, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'disciplines.sparring', 'must be an object');
    return;
  }
  if (!FORM_STATUSES.has(value.status)) {
    addError(errors, 'disciplines.sparring.status', 'must be COMPLETED or NOT_HELD');
  }
  if (!Number.isInteger(value.bracketSize) || value.bracketSize < 0) {
    addError(errors, 'disciplines.sparring.bracketSize', 'must be a nonnegative integer');
  }
  if (!Array.isArray(value.awards) || !Array.isArray(value.rounds)) {
    addError(errors, 'disciplines.sparring', 'awards and rounds must be arrays');
    return;
  }
  value.awards.forEach((award, index) => {
    const prefix = `disciplines.sparring.awards[${index}]`;
    if (!award || !nonEmpty(award.place) || !nonEmpty(award.participantId) ||
        !participantIds.has(award.participantId)) {
      addError(errors, prefix, 'must contain a place and valid participantId');
    }
  });
  value.rounds.forEach((round, roundIndex) => {
    const prefix = `disciplines.sparring.rounds[${roundIndex}]`;
    if (!round || !Number.isInteger(round.roundNumber) || round.roundNumber < 1 || !Array.isArray(round.bouts)) {
      addError(errors, prefix, 'must contain a positive roundNumber and bouts array');
      return;
    }
    round.bouts.forEach((bout, boutIndex) => {
      const boutPrefix = `${prefix}.bouts[${boutIndex}]`;
      if (!bout || !Number.isInteger(bout.boutNumber) || bout.boutNumber < 1) {
        addError(errors, `${boutPrefix}.boutNumber`, 'must be a positive integer');
        return;
      }
      for (const side of ['blue', 'red']) {
        const participantId = bout[`${side}ParticipantId`];
        if (participantId !== null && (!nonEmpty(participantId) || !participantIds.has(participantId))) {
          addError(errors, `${boutPrefix}.${side}ParticipantId`, 'must be null or reference a packet participant');
        }
        for (const field of ['RawPoints', 'AdjustedPoints', 'StandardWarnings', 'SevereWarnings']) {
          const value = bout[`${side}${field}`];
          if (!Number.isInteger(value) || value < 0) {
            addError(errors, `${boutPrefix}.${side}${field}`, 'must be a nonnegative integer');
          }
        }
      }
      if (!Number.isInteger(bout.elapsedSeconds) || bout.elapsedSeconds < 0) {
        addError(errors, `${boutPrefix}.elapsedSeconds`, 'must be a nonnegative integer');
      }
      if (!SPARRING_OUTCOMES.has(bout.outcome)) {
        addError(errors, `${boutPrefix}.outcome`, 'is not a valid completed outcome');
      }
      if (bout.winnerParticipantId !== null &&
          (!nonEmpty(bout.winnerParticipantId) || !participantIds.has(bout.winnerParticipantId))) {
        addError(errors, `${boutPrefix}.winnerParticipantId`, 'must be null or reference a packet participant');
      }
      if (!Array.isArray(bout.warnings)) {
        addError(errors, `${boutPrefix}.warnings`, 'must be an array');
      } else {
        bout.warnings.forEach((warning, warningIndex) => {
          const warningPrefix = `${boutPrefix}.warnings[${warningIndex}]`;
          if (!warning || !['BLUE', 'RED'].includes(warning.side) ||
              !['STANDARD', 'SEVERE'].includes(warning.type) || typeof warning.reason !== 'string') {
            addError(errors, warningPrefix, 'has invalid side, type, or reason');
          }
        });
      }
    });
  });
}

function validateResultPacket(packet, ringId, activeEventName) {
  const errors = [];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return ['payload: must be a JSON object'];
  }
  if (packet.schemaVersion !== 1) addError(errors, 'schemaVersion', 'must be exactly 1');
  for (const field of ['submissionId', 'groupId', 'groupName', 'ringId', 'ringLabel', 'completedAt']) {
    if (!nonEmpty(packet[field])) addError(errors, field, 'must be nonempty');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(packet.submissionId || ''))) {
    addError(errors, 'submissionId', 'must be UUID-like');
  }
  if (typeof packet.eventName !== 'string') addError(errors, 'eventName', 'must be a string');
  if (!activeEventName && packet.eventName !== '') {
    addError(errors, 'eventName', 'must be empty when there is no active event');
  }
  if (packet.ringId !== ringId) addError(errors, 'ringId', 'must match the requested ring');
  if (activeEventName && packet.eventName !== activeEventName) {
    addError(errors, 'eventName', 'must match the active event');
  }
  if (!isIsoTimestamp(packet.completedAt)) addError(errors, 'completedAt', 'must be an ISO timestamp');
  if (!Number.isInteger(packet.groupDivisionNumber) && packet.groupDivisionNumber !== null) {
    addError(errors, 'groupDivisionNumber', 'must be an integer or null');
  }
  if (!Array.isArray(packet.participants)) {
    addError(errors, 'participants', 'must be an array');
  }
  const participants = Array.isArray(packet.participants) ? packet.participants : [];
  const participantIds = new Set();
  participants.forEach((participant, index) => {
    const prefix = `participants[${index}]`;
    if (!participant || typeof participant !== 'object') {
      addError(errors, prefix, 'must be an object');
      return;
    }
    if (!nonEmpty(participant.participantId)) addError(errors, `${prefix}.participantId`, 'must be nonempty');
    if (participantIds.has(participant.participantId)) addError(errors, `${prefix}.participantId`, 'must be unique');
    participantIds.add(participant.participantId);
    for (const field of ['name', 'studio', 'rankCode', 'rankLabel']) {
      if (typeof participant[field] !== 'string') addError(errors, `${prefix}.${field}`, 'must be a string');
    }
    if (!Number.isInteger(participant.age) || participant.age < 0) addError(errors, `${prefix}.age`, 'must be a nonnegative integer');
    if (!integerOrNull(participant.heightInInches)) addError(errors, `${prefix}.heightInInches`, 'must be an integer or null');
    if (!CHECK_IN_STATUSES.has(participant.checkInStatus)) addError(errors, `${prefix}.checkInStatus`, 'is invalid');
    if (!participant.entries || typeof participant.entries !== 'object') {
      addError(errors, `${prefix}.entries`, 'must be an object');
    } else {
      for (const discipline of ['weapons', 'hyungs', 'sparring']) {
        if (!ENTRY_STATUSES.has(participant.entries[discipline])) {
          addError(errors, `${prefix}.entries.${discipline}`, 'is invalid');
        }
      }
    }
  });
  validateForms('weapons', packet.disciplines && packet.disciplines.weapons, participantIds, errors);
  validateForms('hyungs', packet.disciplines && packet.disciplines.hyungs, participantIds, errors);
  validateSparring(packet.disciplines && packet.disciplines.sparring, participantIds, errors);
  if (!packet.disciplines || typeof packet.disciplines !== 'object') addError(errors, 'disciplines', 'must be an object');
  if (!packet.overallAwards || typeof packet.overallAwards !== 'object') {
    addError(errors, 'overallAwards', 'must be an object');
  } else {
    for (const discipline of ['weapons', 'hyungs', 'sparring']) {
      if (!Array.isArray(packet.overallAwards[discipline])) {
        addError(errors, `overallAwards.${discipline}`, 'must be an array');
      } else {
        packet.overallAwards[discipline].forEach((award, index) => {
          if (!award || typeof award !== 'object' || !nonEmpty(award.participantId) ||
              !participantIds.has(award.participantId)) {
            addError(errors, `overallAwards.${discipline}[${index}].participantId`, 'must reference a packet participant');
          }
        });
      }
    }
  }
  if (!Array.isArray(packet.signatures)) {
    addError(errors, 'signatures', 'must be an array');
  } else {
    packet.signatures.forEach((signature, index) => {
      if (!signature || typeof signature !== 'object' ||
          typeof signature.role !== 'string' || typeof signature.name !== 'string' ||
          typeof signature.dan !== 'string' || !isIsoTimestamp(signature.signedAt)) {
        addError(errors, `signatures[${index}]`, 'must contain role, name, dan, and ISO signedAt');
      }
    });
  }
  if (!packet.source || typeof packet.source !== 'object' ||
      packet.source.client !== 'TournamentScoringApp' || typeof packet.source.appVersionName !== 'string' ||
      !Number.isInteger(packet.source.appVersionCode) || typeof packet.source.tabletLabel !== 'string' ||
      !isIsoTimestamp(packet.source.createdAt)) {
    addError(errors, 'source', 'must contain valid client, version, tabletLabel, and createdAt fields');
  }
  if (JSON.stringify(packet).includes('"IN_PROGRESS"')) {
    addError(errors, 'payload', 'must not contain an unresolved IN_PROGRESS state');
  }
  return errors;
}

function createResultPacketStore({ getResultsDirectory }) {
  function resultsDirectory() {
    const directory = getResultsDirectory();
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  function readRecords() {
    const directory = resultsDirectory();
    return fs.readdirSync(directory)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(directory, fileName), 'utf8'));
        } catch (error) {
          console.error(`Failed to read result record ${fileName}:`, error);
          return null;
        }
      })
      .filter(Boolean);
  }

  function findBySubmissionId(submissionId) {
    return readRecords().find((record) => record.submissionId === submissionId) || null;
  }

  function findByGroupId(groupId) {
    return readRecords()
      .filter((record) => record.groupId === groupId)
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  }

  function store(packet, receipt) {
    const serverRecordId = `result-${crypto.randomUUID()}`;
    receipt.acknowledgement.serverRecordId = serverRecordId;
    receipt.acknowledgement.receivedAt = receipt.receivedAt;
    const record = {
      serverRecordId,
      submissionId: packet.submissionId,
      groupId: packet.groupId,
      groupDivisionNumber: packet.groupDivisionNumber,
      groupName: packet.groupName,
      ringId: packet.ringId,
      ringLabel: packet.ringLabel,
      completedAt: packet.completedAt,
      receivedAt: receipt.receivedAt,
      status: 'ACCEPTED',
      receipt,
      packet
    };
    const directory = resultsDirectory();
    const filePath = path.join(directory, `${safeFileIdentifier(serverRecordId)}.json`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
    return record;
  }

  return {
    validate: validateResultPacket,
    findBySubmissionId,
    findByGroupId,
    store,
    listSummaries() {
      return readRecords().map((record) => ({
        serverRecordId: record.serverRecordId,
        submissionId: record.submissionId,
        groupId: record.groupId,
        groupDivisionNumber: record.groupDivisionNumber,
        groupName: record.groupName,
        ringId: record.ringId,
        ringLabel: record.ringLabel,
        completedAt: record.completedAt,
        receivedAt: record.receivedAt,
        status: record.status
      })).sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    },
    get(serverRecordId) {
      return readRecords().find((record) => record.serverRecordId === serverRecordId) || null;
    }
  };
}

module.exports = {
  createResultPacketStore,
  safeFileIdentifier,
  validateResultPacket
};
