const fs = require('node:fs');
const path = require('node:path');
const { validDate } = require('./tournamentAge');

const DEFAULT_EXPERIENCE_PERCENTAGE = 70;
const DEFAULT_EXPERIENCE_SEED = 'spring-2027-experience-70-v1';

function regionalDataset(today) {
  validDate(today);
  const offset = (days) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const headers = ['idNumber', 'firstName', 'lastName', 'studioName', 'rank', 'level', 'judgingLevelExpDate', 'status', 'DOB', 'notes'];
  const judges = Array.from({ length: 200 }, (_, index) => {
    const number = index + 1;
    const certification = number <= 8 ? 'INTERNATIONAL' : number <= 40 ? 'REGIONAL' :
      number <= 140 ? 'CORNER' : number <= 188 ? 'SK_TK' : 'UNCERTIFIED';
    const rank = number <= 8 ? 'D5' : number <= 40 ? 'D3' : number <= 140 ? 'D1' :
      number % 3 === 0 ? 'CDB' : number % 3 === 1 ? 'G5' : 'D1';
    const years = number <= 140 ? 25 + number % 25 : rank === 'CDB' ? 14 + number % 8 : 16 + number % 12;
    const birth = new Date(`${today}T00:00:00Z`);
    birth.setUTCFullYear(birth.getUTCFullYear() - years);
    const expired = number >= 137 && number <= 140 || number >= 185 && number <= 188;
    return { associationId: `SIM-R-${String(number).padStart(3, '0')}`,
      firstName: `Test${number}`, lastName: `Regional${String(number).padStart(3, '0')}`,
      school: `Simulation School ${1 + index % 12}`, rank, certification,
      expiration: certification === 'UNCERTIFIED' ? '' : offset(expired ? -1 : 365 * 4),
      status: 'Active', dateOfBirth: birth.toISOString().slice(0, 10),
      notes: `FABRICATED regional member${number <= 8 ? '; arbitrator candidate (not an assignment)' : ''}` };
  });
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [headers.join(','), ...judges.map((judge) => [
    judge.associationId, judge.firstName, judge.lastName, judge.school, judge.rank, judge.certification,
    judge.expiration, judge.status, judge.dateOfBirth, judge.notes
  ].map(quote).join(','))].join('\r\n') + '\r\n';
  return { csv, judges, date: today };
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
    case 'SK_TK': return hashText(judge.associationId) % 2 ? 'TIMEKEEPER' : 'SCOREKEEPER';
    default: return null;
  }
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
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
    throw new Error('Experience setup requires a local isolated simulation URL, such as http://127.0.0.1:3450.');
  }
  async function request(endpoint, options) {
    const response = await fetch(new URL(endpoint, url), options);
    const result = await response.json();
    if (!response.ok) throw new Error(`${endpoint}: ${result.error || response.status}`);
    return result;
  }
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

async function main(args) {
  const [command, ...options] = args;
  if (!['csv', 'experience'].includes(command) || options.length % 2) throw new Error('Use csv --date YYYY-MM-DD --output PATH, or experience --url http://127.0.0.1:3450 [--percent 70] [--seed NAME].');
  const values = {};
  const allowed = command === 'csv' ? ['--date', '--output'] : ['--url', '--percent', '--seed'];
  for (let i = 0; i < options.length; i += 2) {
    if (!allowed.includes(options[i]) || Object.hasOwn(values, options[i])) throw new Error(`Invalid option: ${options[i]}`);
    values[options[i]] = options[i + 1];
  }
  if (command === 'csv') {
    if (!values['--output']) throw new Error('An output path is required.');
    const dataset = regionalDataset(values['--date']);
    fs.writeFileSync(path.resolve(values['--output']), dataset.csv, { flag: 'wx' });
    console.log('Created 200 fabricated regional judges; existing files are never overwritten.');
  } else {
    if (!values['--url']) throw new Error('An isolated simulation URL is required.');
    const percentage = values['--percent'] === undefined ? DEFAULT_EXPERIENCE_PERCENTAGE : Number(values['--percent']);
    const seed = values['--seed'] || DEFAULT_EXPERIENCE_SEED;
    const result = await setupExperience(values['--url'], { percentage, seed });
    console.log({ judgeCount: result.judgeCount, eligibleJudgeCount: result.eligibleJudgeCount,
      selectedCount: result.selectedCount,
      added: result.added, duplicates: result.duplicates, eventDate: result.eventDate });
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { regionalDataset, experienceRole, selectExperienceJudges, setupExperience };
