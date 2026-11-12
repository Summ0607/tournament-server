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
      const hasReplacementMetadata = Object.hasOwn(entry, 'assignmentRevision') ||
        Object.hasOwn(entry, 'replacementPinVerified') || Object.hasOwn(entry, 'requiresCoordinatorReview');
      if (hasReplacementMetadata && entry.action !== 'REPLACED') {
        fail('Replacement verification metadata is only valid for replacement history.');
      }
      if (hasReplacementMetadata &&
          (entry.replacementPinVerified !== true || entry.requiresCoordinatorReview !== true)) {
        fail('A replacement must have a verified event PIN and coordinator review flag.');
      }
      const replacementMetadata = hasReplacementMetadata ? {
        assignmentRevision: boundedText(entry.assignmentRevision, 'Replacement assignment revision', 100),
        replacementPinVerified: true,
        requiresCoordinatorReview: true
      } : {};
      const hasSwapMetadata = Object.hasOwn(entry, 'swapPartnerAssociationId') ||
        Object.hasOwn(entry, 'otherRole') || Object.hasOwn(entry, 'creditedRole');
      if (hasSwapMetadata && entry.action !== 'SWAPPED') {
        fail('Role-swap credit metadata is only valid for a role swap.');
      }
      let swapMetadata = {};
      if (hasSwapMetadata) {
        const swapPartnerAssociationId = boundedText(
          entry.swapPartnerAssociationId, 'Swap partner Association ID', 100
        );
        const otherRole = boundedText(entry.otherRole, 'Other swapped role', 20);
        const creditedRole = boundedText(entry.creditedRole, 'Role-swap credit role', 20);
        if (swapPartnerAssociationId.toUpperCase() === judgeAssociationId.toUpperCase() ||
            !serviceRoles.includes(otherRole) || !serviceRoles.includes(creditedRole) ||
            entry.previousJudgeAssociationId !== otherRole ||
            ![entry.role, otherRole].includes('center') ||
            ![entry.role, otherRole].includes('corner') ||
            creditedRole !== 'center') {
          fail('A Center/Corner swap must identify its partner and award Center service only.');
        }
        swapMetadata = { swapPartnerAssociationId, otherRole, creditedRole };
      }
      return {
        at, action: entry.action, role: entry.role, judgeAssociationId, previousJudgeAssociationId,
        ...replacementMetadata, ...swapMetadata
      };
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

function replacementReviewId(groupAnchor, historyIndex) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([groupAnchor, historyIndex]))
    .digest('hex');
}

function flaggedReplacements(packet) {
  return packet.divisions.flatMap((division) =>
    division.history.flatMap((entry, historyIndex) => {
      if (entry.action !== 'REPLACED' || entry.requiresCoordinatorReview !== true) return [];
      return [{
        replacementId: replacementReviewId(division.groupAnchor, historyIndex),
        groupAnchor: division.groupAnchor,
        historyIndex,
        role: entry.role,
        incomingAssociationId: entry.judgeAssociationId,
        outgoingAssociationId: entry.previousJudgeAssociationId,
        assignmentRevision: entry.assignmentRevision,
        replacementPinVerified: entry.replacementPinVerified
      }];
    }));
}

function actualServiceRoles(packet, sktkRoles = {}, replacementReviews = []) {
  const participants = new Map();
  const sktkRoleById = new Map(Object.entries(sktkRoles).map(([id, role]) => [id.toUpperCase(), role]));
  const reviewById = new Map(replacementReviews.map((review) => [review.replacementId, review]));
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
    const rejectedIds = new Set(division.history.flatMap((entry, historyIndex) => {
      const review = reviewById.get(replacementReviewId(division.groupAnchor, historyIndex));
      return entry.action === 'REPLACED' && entry.requiresCoordinatorReview === true &&
        review?.decision === 'REJECTED' && entry.judgeAssociationId
        ? [entry.judgeAssociationId.toUpperCase()]
        : [];
    }));
    const addActualRole = (associationId, role) => {
      const id = associationId.toUpperCase();
      if (!rejectedIds.has(id) && !swapCredits.has(id)) add(associationId, role);
    };
    const swapCredits = new Map();
    for (const entry of division.history) {
      if (entry.action !== 'SWAPPED' || !entry.swapPartnerAssociationId) continue;
      if (!rejectedIds.has(entry.judgeAssociationId.toUpperCase())) {
        swapCredits.set(entry.judgeAssociationId.toUpperCase(), {
          associationId: entry.judgeAssociationId,
          role: entry.creditedRole
        });
      }
      if (!rejectedIds.has(entry.swapPartnerAssociationId.toUpperCase())) {
        swapCredits.set(entry.swapPartnerAssociationId.toUpperCase(), {
          associationId: entry.swapPartnerAssociationId,
          role: entry.creditedRole
        });
      }
    }
    for (const [role, judges] of Object.entries(division.seats)) {
      const actualRole = roleNames[role] || role;
      for (const judge of judges) addActualRole(judge.associationId, actualRole);
    }
    for (const entry of division.history) {
      const actualRole = roleNames[entry.role] || entry.role;
      addActualRole(entry.judgeAssociationId, actualRole);
      if (entry.action === 'REPLACED') addActualRole(entry.previousJudgeAssociationId, actualRole);
      if (entry.action === 'SWAPPED' && !entry.swapPartnerAssociationId) {
        addActualRole(
          entry.judgeAssociationId,
          roleNames[entry.previousJudgeAssociationId] || entry.previousJudgeAssociationId
        );
      }
    }
    for (const swapCredit of swapCredits.values()) {
      add(swapCredit.associationId, roleNames[swapCredit.role] || swapCredit.role);
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
  const decoratedRecord = (record, stored) => {
    const savedReviews = new Map(
      (record.replacementReviews || []).map((review) => [review.replacementId, review])
    );
    return {
      ...record,
      replacementReviews: flaggedReplacements(stored.packet).map((replacement) => ({
        ...replacement,
        ...(savedReviews.get(replacement.replacementId) || {})
      })),
      event: stored.event,
      packet: stored.packet
    };
  };
  const transaction = (callback) => {
    const result = queue.then(callback);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const resolvePacketRecord = (index, eventName, submissionId) => {
    const record = index.packets.find((candidate) =>
      candidate.eventName === eventName && candidate.submissionId === submissionId);
    if (!record) fail('Judge service packet not found.', 404);
    const stored = JSON.parse(fs.readFileSync(packetFile(submissionId), 'utf8'));
    return { record, packet: stored.packet };
  };
  const validateReplacementReviews = (packet, supplied, reviewedAt) => {
    if (!Array.isArray(supplied)) fail('Replacement reviews must be provided as a list.');
    const expected = flaggedReplacements(packet);
    if (supplied.length !== expected.length) {
      fail('Review every flagged replacement before saving the reconciliation.', 409);
    }
    const byId = new Map();
    for (const item of supplied) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Invalid replacement review.');
      const replacementId = boundedText(item.replacementId, 'Replacement review ID', 64);
      if (byId.has(replacementId)) fail('A replacement may be reviewed only once.');
      if (!['APPROVED', 'REJECTED'].includes(item.decision)) {
        fail('Choose whether the replacement judge is approved or rejected for service credit.');
      }
      if (item.reviewedWithAffectedParties !== true) {
        fail('Confirm that the replacement was reviewed with the affected parties.');
      }
      byId.set(replacementId, item);
    }
    return expected.map((replacement) => {
      const suppliedReview = byId.get(replacement.replacementId);
      if (!suppliedReview) fail('Review every flagged replacement before saving the reconciliation.', 409);
      return {
        ...replacement,
        decision: suppliedReview.decision,
        reviewedWithAffectedParties: true,
        reviewedAt
      };
    });
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
          acknowledgement, importedAt: '', replacementReviews: []
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
          return decoratedRecord(item, stored);
        });
    },
    get(eventName, submissionId) {
      const item = readIndex().packets.find((candidate) =>
        candidate.eventName === eventName && candidate.submissionId === submissionId);
      if (!item) return null;
      return decoratedRecord(item, JSON.parse(fs.readFileSync(packetFile(submissionId), 'utf8')));
    },
    saveReplacementReviews(eventName, submissionId, suppliedReviews) {
      return transaction(() => {
        const index = readIndex();
        const { record, packet } = resolvePacketRecord(index, eventName, submissionId);
        if (record.importedAt) fail('Replacement reviews cannot be changed after service import.', 409);
        const replacementReviews = validateReplacementReviews(packet, suppliedReviews, now());
        record.replacementReviews = replacementReviews;
        writeIndex(index);
        return replacementReviews;
      });
    },
    markImported(eventName, submissionId, importedAt = now()) {
      return transaction(() => {
        const index = readIndex();
        const { record: item, packet } = resolvePacketRecord(index, eventName, submissionId);
        if (flaggedReplacements(packet).length !== (item.replacementReviews || []).length) {
          fail('Review every flagged replacement before importing this service packet.', 409);
        }
        item.importedAt ||= importedAt;
        writeIndex(index);
        return item.importedAt;
      });
    }
  };
}

module.exports = {
  actualServiceRoles, createJudgeServicePacketStore, eventIdFor, flaggedReplacements,
  replacementReviewId, validateServicePacket
};
