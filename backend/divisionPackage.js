const express = require('express');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const DIVISION_PACKAGE_TYPE = 'tournament-division-package';
const DIVISION_QR_TYPE = 'tournament-division-qr';
const DIVISION_PACKAGE_VERSION = 1;
const MAX_TABLET_DIVISION_COMPETITORS = 12;
const CHECKSUM_LENGTH = 16;

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function divisionLabel(group) {
  const divisionNumber = Number.parseInt(group && group.groupDivisionNumber, 10);
  if (Number.isFinite(divisionNumber)) return `Division ${divisionNumber}`;
  const name = String(group && (group.name || group.groupId || group.id) || '').trim();
  return name || 'Unnamed division';
}

function integerOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function packageCompetitor(competitor, index) {
  const name = String(competitor.fullName ||
    [competitor.firstName, competitor.lastName].filter(Boolean).join(' ') || competitor.name || '').trim();
  return {
    id: String(competitor.id ?? competitor.competitorId ?? `competitor-${index + 1}`),
    name,
    studio: String(competitor.studio ?? competitor.school ?? '').trim(),
    rank: String(competitor.rank ?? competitor.rankCode ?? '').trim(),
    age: integerOrNull(competitor.age) ?? 0,
    height: integerOrNull(competitor.heightInInches ?? competitor.height)
  };
}

function packageDivision(group) {
  const label = divisionLabel(group);
  if (!group || !Array.isArray(group.competitors)) fail(`${label} has no competitor list and cannot be packaged.`);
  if (!group.competitors.length) fail(`${label} has no competitors and cannot be packaged.`);
  if (group.competitors.length > MAX_TABLET_DIVISION_COMPETITORS) {
    fail(`${label} has ${group.competitors.length} competitors; tablet divisions allow at most ` +
      `${MAX_TABLET_DIVISION_COMPETITORS}. Split the division before packaging.`);
  }
  const division = {
    groupId: String(group.groupId || group.id || '').trim() || label,
    groupDivisionNumber: integerOrNull(group.groupDivisionNumber),
    name: String(group.name || '').trim() || label,
    competitors: group.competitors.map(packageCompetitor)
  };
  for (const field of ['ageRange', 'rankRange', 'rankRangeLabel']) {
    if (group[field] != null) division[field] = group[field];
  }
  return division;
}

function buildDivisionPackage({ eventName, ringId, ringLabel, divisions }) {
  const built = {
    type: DIVISION_PACKAGE_TYPE,
    version: DIVISION_PACKAGE_VERSION,
    eventName: String(eventName || ''),
    generatedAt: new Date().toISOString(),
    divisions: divisions.map(packageDivision)
  };
  if (ringId) {
    built.ringId = String(ringId);
    built.ringLabel = String(ringLabel || ringId);
  }
  return built;
}

function checksumOf(json) {
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex').slice(0, CHECKSUM_LENGTH);
}

function buildDivisionQrPayload({ eventName, group }) {
  const division = packageDivision(group);
  const json = JSON.stringify({ eventName: String(eventName || ''), division });
  return {
    type: DIVISION_QR_TYPE,
    version: DIVISION_PACKAGE_VERSION,
    checksum: checksumOf(json),
    data: zlib.deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url')
  };
}

function decodeDivisionQrPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Division QR payload must be an object.');
  if (payload.type !== DIVISION_QR_TYPE) fail('Not a tournament division QR code.');
  if (payload.version !== DIVISION_PACKAGE_VERSION) fail(`Unsupported division QR version: ${payload.version}.`);
  if (typeof payload.data !== 'string' || !payload.data) fail('Division QR code is missing its data.');
  if (typeof payload.checksum !== 'string' || payload.checksum.length !== CHECKSUM_LENGTH) {
    fail('Division QR code is missing its checksum.');
  }
  let json;
  try {
    json = zlib.inflateRawSync(Buffer.from(payload.data, 'base64url')).toString('utf8');
  } catch {
    fail('Division QR code data could not be decompressed.');
  }
  if (checksumOf(json) !== payload.checksum) fail('Division QR code failed its integrity check. Rescan or reprint it.');
  const decoded = JSON.parse(json);
  if (!decoded.division || !Array.isArray(decoded.division.competitors) ||
      !decoded.division.competitors.length ||
      decoded.division.competitors.length > MAX_TABLET_DIVISION_COMPETITORS) {
    fail('Division QR code contains an invalid division.');
  }
  return decoded;
}

function createDivisionPackageRouter(deps) {
  const {
    readAssignmentsState, getRingState, listAllowedRingLabels,
    loadGroup, loadSavedGroups, readActiveEvent
  } = deps;
  const router = express.Router();

  router.get('/rings/:ringId/division-package', (req, res) => {
    try {
      const state = readAssignmentsState();
      const ringId = String(req.params.ringId || '').trim();
      const ringState = getRingState(state, ringId);
      if (!ringState) {
        return res.status(400).json({
          error: `Invalid ring '${ringId}'. Allowed rings: ${listAllowedRingLabels(state).join(', ')}`
        });
      }
      const anchors = [ringState.currentGroupId, ...(ringState.queuedGroupDivisionNumbers || [])]
        .map((anchor) => String(anchor || '').trim()).filter(Boolean);
      const missing = anchors.filter((anchor) => !loadGroup(anchor));
      if (missing.length) {
        fail(`Divisions assigned to this ring were not found: ${missing.join(', ')}. Rebuild or reassign divisions.`, 409);
      }
      const divisions = anchors.map(loadGroup);
      let built;
      try {
        built = buildDivisionPackage({
          eventName: readActiveEvent() || '',
          ringId,
          ringLabel: ringState.ringLabel || ringId,
          divisions
        });
      } catch (error) {
        // Packaging failures describe ring-state problems the operator must fix first.
        if (error.statusCode) error.statusCode = 409;
        throw error;
      }
      res.set('Cache-Control', 'no-store');
      return res.json(built);
    } catch (error) {
      if (!error.statusCode) {
        console.error('Division package failed:', error);
        return res.status(500).json({ error: 'Unable to build the division package. Check the server log.' });
      }
      return res.status(error.statusCode).json({ error: error.message });
    }
  });

  router.post('/divisions/qr-codes', async (req, res) => {
    try {
      const body = req.body || {};
      const eventName = String(body.eventName || readActiveEvent() || '').trim();
      if (!eventName) fail('Activate a tournament or specify eventName before printing division QR codes.');
      if (body.groupIds !== undefined &&
          (!Array.isArray(body.groupIds) || !body.groupIds.length ||
           body.groupIds.some((id) => !['string', 'number'].includes(typeof id)))) {
        fail('groupIds must be a nonempty array of division identifiers.');
      }
      const groups = await loadSavedGroups(eventName);
      const anchorOf = (value) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? String(parsed) : String(value || '').trim();
      };
      const groupMatches = (group, requested) => anchorOf(group.groupDivisionNumber) === requested ||
        String(group.groupId || group.id || '').trim() === requested;
      let selected = groups;
      if (body.groupIds !== undefined) {
        const requestedAnchors = body.groupIds.map(anchorOf);
        const unknown = requestedAnchors.filter((requested) => !groups.some((group) => groupMatches(group, requested)));
        if (unknown.length) fail(`Divisions not found for this event: ${unknown.join(', ')}.`, 404);
        selected = requestedAnchors.map((requested) => groups.find((group) => groupMatches(group, requested)));
      }
      if (!selected.length) fail('No saved divisions found. Build and save divisions first.', 404);
      const codes = [];
      for (const group of selected) {
        const entry = {
          groupId: String(group.groupId || group.id || '').trim(),
          groupDivisionNumber: integerOrNull(group.groupDivisionNumber),
          name: String(group.name || '').trim() || divisionLabel(group),
          competitorCount: Array.isArray(group.competitors) ? group.competitors.length : 0
        };
        try {
          const payload = buildDivisionQrPayload({ eventName, group });
          entry.image = await QRCode.toDataURL(JSON.stringify(payload), {
            width: 640, margin: 4, errorCorrectionLevel: 'M'
          });
        } catch (error) {
          entry.error = error.statusCode ? error.message :
            `${divisionLabel(group)} does not fit in a single QR code. Split the division before printing.`;
        }
        codes.push(entry);
      }
      return res.json({ eventName, generatedAt: new Date().toISOString(), codes });
    } catch (error) {
      if (!error.statusCode) {
        console.error('Division QR generation failed:', error);
        return res.status(500).json({ error: 'Unable to generate division QR codes. Check the server log.' });
      }
      return res.status(error.statusCode).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  DIVISION_PACKAGE_TYPE,
  DIVISION_QR_TYPE,
  DIVISION_PACKAGE_VERSION,
  MAX_TABLET_DIVISION_COMPETITORS,
  packageDivision,
  buildDivisionPackage,
  buildDivisionQrPayload,
  decodeDivisionQrPayload,
  createDivisionPackageRouter
};
