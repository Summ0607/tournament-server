const fs = require('node:fs');
const path = require('node:path');
const { validDate } = require('./tournamentAge');
const {
  generateJudgePool, SIMULATION_JUDGE_POOL_SEED, SIMULATION_JUDGE_POOL_REFERENCE_DATE
} = require('./simulatorSetupGenerator');

const DEFAULT_EXPERIENCE_PERCENTAGE = 30;
const DEFAULT_EXPERIENCE_SEED = 'simulation-judge-pool-experience-v1';

function regionalDataset(today) {
  validDate(today);
  if (today < SIMULATION_JUDGE_POOL_REFERENCE_DATE) {
    throw new Error(`Judge dataset date must be on or after the fixed pool reference date ${SIMULATION_JUDGE_POOL_REFERENCE_DATE}.`);
  }
  const offset = (days) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const headers = ['idNumber', 'firstName', 'lastName', 'studioName', 'rank', 'level', 'judgingLevelExpDate', 'status', 'DOB', 'notes'];
  const pool = generateJudgePool({
    eventDate: SIMULATION_JUDGE_POOL_REFERENCE_DATE,
    seed: SIMULATION_JUDGE_POOL_SEED
  });
  const judges = pool.judges.map((judge) => ({
    ...judge,
    expiration: offset(365 * 4)
  }));
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [headers.join(','), ...judges.map((judge) => [
    judge.associationId, judge.firstName, judge.lastName, judge.school, judge.rank, judge.certification,
    judge.expiration, judge.status, judge.dateOfBirth, judge.notes
  ].map(quote).join(','))].join('\r\n') + '\r\n';
  return { csv, judges, priorExperience: pool.priorExperience, date: today };
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = hashText(seed) || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function experienceRole(judge) {
  switch (String(judge.certification || '').trim().toUpperCase()) {
    case 'CORNER': return 'CORNER_JUDGE';
    case 'REGIONAL':
    case 'INTERNATIONAL': return 'CENTER_JUDGE';
    case 'SK_TK': return 'SK_TK';
    default: return null;
  }
}

function localSimulationUrl(base) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
    throw new Error('Experience tools require a local isolated simulation URL, such as http://127.0.0.1:3450.');
  }
  return url;
}

function simulationRequester(url) {
  return async function request(endpoint, options) {
    const response = await fetch(new URL(endpoint, url), options);
    const result = await response.json();
    if (!response.ok) throw new Error(`${endpoint}: ${result.error || response.status}`);
    return result;
  };
}

function selectExperienceJudges(judges, percentage = DEFAULT_EXPERIENCE_PERCENTAGE, seed = DEFAULT_EXPERIENCE_SEED) {
  if (!Array.isArray(judges) || !judges.length) throw new Error('Judge DB has no judges to select from.');
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error('Experience percentage must be greater than 0 and at most 100.');
  }
  if (typeof seed !== 'string' || !seed.trim()) throw new Error('An experience selection seed is required.');

  const seen = new Set();
  for (const judge of judges) {
    const associationId = String(judge.associationId || '').trim().toUpperCase();
    if (!associationId || seen.has(associationId)) throw new Error('Judge DB contains a missing or duplicate Association ID.');
    seen.add(associationId);
  }

  const population = judges.filter((judge) => {
    const certification = String(judge.certification || '').trim().toUpperCase();
    return certification && !['UNKNOWN', 'UNCERTIFIED'].includes(certification);
  });
  const targetCount = Math.round(population.length * percentage / 100);
  const candidates = population.filter((judge) => experienceRole(judge))
    .slice()
    .sort((a, b) => a.associationId.localeCompare(b.associationId));
  if (targetCount > candidates.length) {
    throw new Error(`Cannot select ${targetCount} of ${population.length} judges: only ${candidates.length} have a role-compatible certification.`);
  }

  const random = seededRandom(seed);
  for (let index = candidates.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  return { judgeCount: judges.length, eligibleJudgeCount: population.length,
    selected: candidates.slice(0, targetCount), targetCount };
}

async function setupExperience(base, { percentage = DEFAULT_EXPERIENCE_PERCENTAGE, seed = DEFAULT_EXPERIENCE_SEED } = {}) {
  const request = simulationRequester(localSimulationUrl(base));
  const simulation = await request('/api/simulation');
  if (simulation.format !== 'judge-lifecycle-simulation-v1') throw new Error('Not an isolated judge simulation.');
  const roster = await request('/api/judge-management');
  if (!Array.isArray(roster.judges)) throw new Error('Judge DB did not return its judge roster.');
  const selection = selectExperienceJudges(roster.judges, percentage, seed);
  const selectedProfiles = new Map();
  for (const judge of selection.selected) {
    const profile = await request(`/api/judge-management/profile?associationId=${encodeURIComponent(judge.associationId)}`);
    if (profile.judge.associationId.toUpperCase() !== judge.associationId.toUpperCase() ||
        profile.judge.certification !== judge.certification || !experienceRole(profile.judge)) {
      throw new Error('Judge DB changed during experience setup. Reload and retry.');
    }
    selectedProfiles.set(judge.associationId, profile.judge);
  }

  const eventDateValue = new Date(`${simulation.initialDate || simulation.date}T00:00:00Z`);
  eventDateValue.setUTCDate(eventDateValue.getUTCDate() - 30);
  const eventDate = eventDateValue.toISOString().slice(0, 10);
  if (eventDate > simulation.date) throw new Error('Generated experience date must not be in the future.');
  const eventId = `sim-regional-${eventDate}`;
  const eventName = `SIMULATED Regional ${eventDate}`;
  let added = 0, duplicates = 0;
  for (const judge of selection.selected) {
    const associationId = judge.associationId;
    const profile = await request(`/api/judge-management/profile?associationId=${encodeURIComponent(associationId)}`);
    const expectedJudge = selectedProfiles.get(associationId);
    if (profile.judge.certification !== expectedJudge.certification) {
      throw new Error('Judge certification changed during experience setup. Reload and retry.');
    }
    const role = experienceRole(profile.judge);
    const records = [{ eventId, eventName, eventDate,
      location: 'Fabricated regional venue', role, eventScope: 'REGIONAL', phase: 'P1',
      source: 'SIMULATION', sourceId: `${associationId}:${eventId}:${role}:P1` }];
    const result = await request('/api/judge-management/experience', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ associationId, revision: profile.revision, records }) });
    added += result.added; duplicates += result.duplicates;
  }
  return { judgeCount: selection.judgeCount, eligibleJudgeCount: selection.eligibleJudgeCount,
    selectedCount: selection.targetCount,
    selectedIds: selection.selected.map((judge) => judge.associationId),
    percentage, seed, eventId, eventDate, added, duplicates };
}

function validateExperiencePayload(payload, simulation, judges) {
  if (!Array.isArray(payload) || !payload.length) throw new Error('Experience API payload must be a nonempty array.');
  if (!Array.isArray(judges)) throw new Error('Judge DB did not return its judge roster.');
  if (judges.length !== new Map(judges.map((judge) => [
    String(judge.associationId || '').trim().toUpperCase(), judge
  ])).size) throw new Error('Judge DB contains duplicate Association IDs.');

  const judgesById = new Map(judges.map((judge) => [judge.associationId.trim().toUpperCase(), judge]));
  const associations = new Set(), sourceIds = new Set();
  let eventIdentity = '';
  for (const [index, request] of payload.entries()) {
    const associationId = typeof request?.associationId === 'string' ? request.associationId.trim() : '';
    const key = associationId.toUpperCase();
    if (!key || associations.has(key)) throw new Error(`Payload entry ${index + 1} has a missing or duplicate Association ID.`);
    associations.add(key);
    const judge = judgesById.get(key);
    if (!judge) throw new Error(`Judge ${associationId} is not imported into the isolated Judge DB.`);
    if (!Array.isArray(request.records) || !request.records.length || request.records.length > 200) {
      throw new Error(`Payload entry ${index + 1} must contain 1 to 200 experience records.`);
    }
    const expectedRole = experienceRole(judge);
    if (!expectedRole) throw new Error(`Judge ${associationId} has no experience-compatible certification.`);
    for (const [recordIndex, record] of request.records.entries()) {
      const label = `Experience for ${associationId}, record ${recordIndex + 1}`;
      if (!record || record.source !== 'SIMULATION' || record.logVerified !== false ||
          record.role !== expectedRole || !['REGIONAL', 'NATIONAL', 'WORLD', 'IN_HOUSE'].includes(record.eventScope) ||
          !['', 'P1', 'P2'].includes(record.phase ?? '')) {
        throw new Error(`${label} has an invalid source, verification state, role, scope, or phase.`);
      }
      for (const field of ['eventId', 'eventName', 'location', 'sourceId']) {
        if (typeof record[field] !== 'string' || !record[field].trim() || record[field].length > 200) {
          throw new Error(`${label} has an invalid ${field}.`);
        }
      }
      if (/[<>:"/\\|?*\x00-\x1F]/.test(record.eventName)) throw new Error(`${label} has an invalid event name.`);
      validDate(record.eventDate);
      if (record.eventDate > simulation.date) throw new Error(`${label} is dated after the simulation clock.`);
      if (sourceIds.has(record.sourceId)) throw new Error(`${label} duplicates sourceId ${record.sourceId}.`);
      sourceIds.add(record.sourceId);
      const nextIdentity = JSON.stringify([record.eventId, record.eventName, record.eventDate, record.eventScope]);
      if (eventIdentity && eventIdentity !== nextIdentity) throw new Error('Payload contains inconsistent prior-event identities.');
      eventIdentity = nextIdentity;
    }
  }
  return { requestCount: payload.length, eventIdentity: JSON.parse(eventIdentity) };
}

async function applyExperiencePayload(base, payload) {
  const request = simulationRequester(localSimulationUrl(base));
  const simulation = await request('/api/simulation');
  if (simulation.format !== 'judge-lifecycle-simulation-v1') throw new Error('Not an isolated judge simulation.');
  validDate(simulation.date);
  const roster = await request('/api/judge-management');
  if (roster.simulationMode !== true) throw new Error('Judge Management simulation mode is not enabled.');
  const validated = validateExperiencePayload(payload, simulation, roster.judges);
  let added = 0, duplicates = 0, completed = 0;
  const receipts = [];
  for (const entry of payload) {
    try {
      const profile = await request(`/api/judge-management/profile?associationId=${encodeURIComponent(entry.associationId)}`);
      if (profile.judge.associationId.toUpperCase() !== entry.associationId.toUpperCase() ||
          entry.records.some((record) => experienceRole(profile.judge) !== record.role) ||
          !Number.isSafeInteger(profile.revision)) {
        throw new Error('Judge profile or revision changed. Reload and retry.');
      }
      const result = await request('/api/judge-management/experience', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...entry, revision: profile.revision })
      });
      if (!Number.isSafeInteger(result.added) || !Number.isSafeInteger(result.duplicates)) {
        throw new Error('Experience API returned an invalid receipt.');
      }
      added += result.added;
      duplicates += result.duplicates;
      completed += 1;
      receipts.push({ associationId: entry.associationId, added: result.added, duplicates: result.duplicates });
    } catch (error) {
      throw new Error(`Experience apply stopped after ${completed} of ${validated.requestCount} judges (${added} added, ${duplicates} duplicates): ${error.message}`, { cause: error });
    }
  }
  return {
    requestCount: validated.requestCount,
    eventId: validated.eventIdentity[0],
    eventDate: validated.eventIdentity[2],
    added,
    duplicates,
    receipts
  };
}

async function applyExperienceFile(base, file) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return applyExperiencePayload(base, payload);
}

async function main(args) {
  const [command, ...options] = args;
  if (!['csv', 'experience', 'apply'].includes(command) || options.length % 2) throw new Error('Use csv --date YYYY-MM-DD --output PATH, experience --url http://127.0.0.1:3450 [--percent 30] [--seed NAME], or apply --url http://127.0.0.1:3450 --input experience-api.json.');
  const values = {};
  const allowed = command === 'csv' ? ['--date', '--output']
    : command === 'experience' ? ['--url', '--percent', '--seed'] : ['--url', '--input'];
  for (let i = 0; i < options.length; i += 2) {
    if (!allowed.includes(options[i]) || Object.hasOwn(values, options[i])) throw new Error(`Invalid option: ${options[i]}`);
    values[options[i]] = options[i + 1];
  }
  if (command === 'csv') {
    if (!values['--output']) throw new Error('An output path is required.');
    const dataset = regionalDataset(values['--date']);
    fs.writeFileSync(path.resolve(values['--output']), dataset.csv, { flag: 'wx' });
    console.log('Created 180 fabricated simulation judges; existing files are never overwritten.');
  } else if (command === 'experience') {
    if (!values['--url']) throw new Error('An isolated simulation URL is required.');
    const percentage = values['--percent'] === undefined ? DEFAULT_EXPERIENCE_PERCENTAGE : Number(values['--percent']);
    const seed = values['--seed'] || DEFAULT_EXPERIENCE_SEED;
    const result = await setupExperience(values['--url'], { percentage, seed });
    console.log({ judgeCount: result.judgeCount, eligibleJudgeCount: result.eligibleJudgeCount,
      selectedCount: result.selectedCount,
      added: result.added, duplicates: result.duplicates, eventDate: result.eventDate });
  } else {
    if (!values['--url'] || !values['--input']) throw new Error('An isolated simulation URL and experience API payload file are required.');
    const result = await applyExperienceFile(values['--url'], values['--input']);
    console.log(`Applied experience for ${result.requestCount} judges: ${result.added} added, ${result.duplicates} duplicates (${result.eventDate}).`);
    return result;
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { regionalDataset, experienceRole, selectExperienceJudges, setupExperience,
  validateExperiencePayload, applyExperiencePayload, applyExperienceFile, main };
