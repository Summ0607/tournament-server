const fs = require('node:fs');
const path = require('node:path');
const { validDate } = require('./tournamentAge');

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

async function setupExperience(base, associationIds) {
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
  if (!Array.isArray(associationIds) || !associationIds.length ||
      associationIds.some((id) => !/^SIM-R-(?:00[1-9]|0[1-9]\d|1\d\d|200)$/.test(id)) ||
      new Set(associationIds).size !== associationIds.length) throw new Error('Select distinct fabricated regional IDs SIM-R-001 through SIM-R-200.');
  // Preflight every selected identity before creating any experience.
  for (const associationId of associationIds) {
    await request(`/api/judge-management/profile?associationId=${encodeURIComponent(associationId)}`);
  }
  let added = 0, duplicates = 0;
  for (const associationId of associationIds) {
    const profile = await request(`/api/judge-management/profile?associationId=${encodeURIComponent(associationId)}`);
    if (['UNKNOWN', 'UNCERTIFIED'].includes(profile.judge.certification)) continue;
    const number = Number(associationId.slice(-3));
    const count = number % 4;
    if (!count) continue;
    const records = Array.from({ length: count }, (_, index) => {
      const eventDate = new Date(`${simulation.initialDate || simulation.date}T00:00:00Z`);
      eventDate.setUTCDate(eventDate.getUTCDate() - 30 * (index + 1));
      const date = eventDate.toISOString().slice(0, 10);
      const eventId = `sim-regional-${date}`;
      const role = ['REGIONAL', 'INTERNATIONAL'].includes(profile.judge.certification) ? 'CENTER_JUDGE' :
        profile.judge.certification === 'CORNER' ? 'CORNER_JUDGE' : 'SCOREKEEPER';
      return { eventId, eventName: `SIMULATED Regional ${date}`, eventDate: date,
        location: 'Fabricated regional venue', role, eventScope: 'REGIONAL', phase: 'P1',
        source: 'SIMULATION', sourceId: `${associationId}:${eventId}:${role}:P1` };
    });
    const result = await request('/api/judge-management/experience', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ associationId, revision: profile.revision, records }) });
    added += result.added; duplicates += result.duplicates;
  }
  return { added, duplicates };
}

async function main(args) {
  const [command, ...options] = args;
  if (!['csv', 'experience'].includes(command) || options.length % 2) throw new Error('Use csv --date YYYY-MM-DD --output PATH, or experience --url http://127.0.0.1:3450 --ids SIM-R-001,SIM-R-002 (omit --ids for all 200).');
  const values = {};
  const allowed = command === 'csv' ? ['--date', '--output'] : ['--url', '--ids'];
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
    const ids = values['--ids'] ? values['--ids'].split(',').map((id) => id.trim()) :
      Array.from({ length: 200 }, (_, i) => `SIM-R-${String(i + 1).padStart(3, '0')}`);
    console.log(await setupExperience(values['--url'], ids));
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { regionalDataset, setupExperience };
