const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createVolunteerRouter, headers, validateVolunteer } = require('../backend/volunteerRoutes');
const { createRingJudgeRouter } = require('../backend/ringJudgeRoutes');
const { create } = require('../tournament-management/volunteers');
const { judgeRankOptions, certificationLevels } = require('../db/judgeCertification');
const volunteer = { firstName: 'Jane', lastName: 'Doe', dob: '2000-01-09', associationNumber: 'D100', school: 'School',
  rank: 'D2', certification: 'Regional', primaryType: 'setup', secondaryType: 'judging', parentName: 'Guardian' };
const csvRow = (association = 'D100', first = 'Jane') => `${first},Doe,2000-01-09,${association},School,D2,,Setup,Judging`;
const csvText = (...rows) => Object.keys(headers).join(',') + '\n' + rows.join('\n');
test('volunteer CRUD, CSV atomic upsert, type references, scope, revision and operational locks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'volunteers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['A', 'B']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'tournament.db'), '');
    fs.writeFileSync(path.join(root, name, 'event-config.json'), JSON.stringify({ date: '2027-01-09' }));
  }
  let locked = false;
  const options = { eventsRoot: root, configurationStatus: () => ({ configurationLocked: locked }) };
  const app = express(); app.use(express.json({ limit: '3mb' }));
  app.use('/api', createVolunteerRouter(options)); app.use('/api', createRingJudgeRouter(options));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (name = 'A') => (await (await fetch(`${base}/volunteers?eventName=${name}`)).json());
  const write = (route, body, method = 'POST') => fetch(`${base}/${route}?eventName=A`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/volunteers`)).status, 400);
  assert.equal((await fetch(`${base}/volunteers?eventName=..`)).status, 400);
  let data = await get();
  assert.deepEqual(data.types.map((r) => r.name), ['Setup', 'Teardown', 'Judging', 'Security']);
  assert.deepEqual(data.rankOptions, judgeRankOptions());
  assert.equal(fs.existsSync(path.join(root, 'A', 'volunteers.json')), false);
  fs.writeFileSync(path.join(root, 'A', 'event-config.json'), JSON.stringify({ date: '2027-01-09', scope: 'in-house' }));
  let inHouse = await write('volunteers/import', { revision: null,
    csv: csvText('Young,Doe,2016-01-09,IH1,School,G5,SK/TK,Judging,').replace('\n', ',Parent/Guardian Name\n') + ',Guardian' });
  assert.equal(inHouse.status, 200);
  data = await inHouse.json();
  let corner = await write('volunteers', { revision: data.revision,
    volunteer: { ...volunteer, associationNumber: 'IH2', dob: '2012-01-09', certification: 'Corner', primaryType: 'judging', secondaryType: '' } });
  assert.equal(corner.status, 200);
  data = await corner.json();
  for (const [certification, dob] of [['SK/TK', '2017-01-09'], ['Corner', '2013-01-09']]) {
    assert.equal((await write('volunteers', { revision: data.revision,
      volunteer: { ...volunteer, associationNumber: '', dob, certification } })).status, 400);
  }
  const populated = await write('ring-judges/populate-volunteers', { revision: null });
  assert.equal(populated.status, 200);
  const inHouseJudges = await populated.json();
  assert.equal(inHouseJudges.added, 2);
  assert.equal((await write('ring-judges/delete', { revision: inHouseJudges.revision,
    ids: inHouseJudges.judges.map((row) => row.id) })).status, 200);
  fs.unlinkSync(path.join(root, 'A', 'ring-judges.json'));
  data = await (await write('volunteers/delete', { revision: data.revision,
    ids: data.volunteers.map((row) => row.id) })).json();
  fs.writeFileSync(path.join(root, 'A', 'event-config.json'), JSON.stringify({ date: '2027-01-09' }));
  const response = await write('volunteers', { revision: data.revision, volunteer });
  assert.equal(response.status, 200); data = await response.json();
  assert.equal(data.volunteers[0].age, 27);
  assert.equal(data.volunteers[0].ageAsOf, '2027-01-09');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'A', 'volunteers.json'), 'utf8'), /"dob"/i);
  const originalId = data.volunteers[0].id;
  const extendedCsv = csvText(csvRow('D100')).replace('\n', ',Parent/Guardian Name,Contact Number,Gender,Email\n') + ',Guardian,+44 (20) 1234 5678 ext 2, Female , judge@example.test ';
  let updated = await write('volunteers/import', { revision: data.revision, csv: extendedCsv });
  assert.equal(updated.status, 200); data = await updated.json();
  assert.equal(data.volunteers[0].contactNumber, '+44 (20) 1234 5678 ext 2');
  assert.equal(data.volunteers[0].parentName, 'Guardian');
  assert.equal(data.volunteers[0].gender, 'Female');
  assert.equal(data.volunteers[0].email, 'judge@example.test');
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'A', 'volunteers.json'), 'utf8')).volunteers[0];
  assert.equal(persisted.gender, 'Female');
  assert.equal(persisted.email, 'judge@example.test');
  const beforeInvalid = data.revision;
  const badMinor = csvText(csvRow('D200'), 'Minor,Doe,2012-01-09,M100,School,G5,,Setup,Judging');
  updated = await write('volunteers/import', { revision: data.revision, csv: badMinor });
  assert.equal(updated.status, 400);
  assert.match((await updated.json()).error, /CSV row 3: Parent\/guardian/);
  assert.equal((await get()).revision, beforeInvalid);
  for (const change of [{ rank: '' }, { dob: '' }, { dob: '2000-02-30' }, { secondaryType: 'setup' }, { primaryType: 'missing' },
    { certification: 'bogus' }, { certification: 'Corner', rank: 'G3' }]) {
    assert.equal((await write('volunteers', { revision: data.revision, volunteer: { ...volunteer, associationNumber: '', ...change } })).status, 400);
  }
  for (const [rank, age] of [['G5', 15], ['CDB', 13]]) {
    const response = await write('volunteers', { revision: data.revision, volunteer: {
      ...volunteer, associationNumber: '', rank, certification: 'SK/TK', age, ageAsOf: '2027-01-09', dob: undefined
    } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /SK\/TK certification requires age/);
  }
  for (const [rank, age] of [['G5', 16], ['CDB', 14]]) {
    const response = await write('volunteers', { revision: data.revision, volunteer: {
      ...volunteer, associationNumber: `SK${rank}`, rank, certification: 'SK/TK', age, ageAsOf: '2027-01-09', dob: undefined
    } });
    assert.equal(response.status, 200);
    data = await response.json();
  }
  assert.equal((await write('volunteers', { revision: null, volunteer })).status, 409);
  assert.equal((await write('volunteer-types/delete', { revision: data.revision, ids: ['judging'] })).status, 409);
  let imported = await write('volunteers/import', { revision: data.revision, csv: csvText(csvRow('d100', 'Updated'), csvRow('', 'Blank')) });
  assert.equal(imported.status, 200); data = await imported.json();
  assert.equal(data.added, 1); assert.equal(data.updated, 1); assert.equal(data.volunteers[0].id, originalId);
  assert.equal(data.volunteers[0].contactNumber, '+44 (20) 1234 5678 ext 2');
  assert.equal(data.volunteers[0].parentName, 'Guardian');
  const unchanged = JSON.stringify(data.volunteers);
  assert.equal(data.volunteers[0].gender, 'Female');
  assert.equal(data.volunteers[0].email, 'judge@example.test');
  for (const text of [csvText(csvRow('D200'), csvRow('d200')), csvText(csvRow('D200'), csvRow('D201').replace('Setup', 'Unknown')), 'Bad,Headers\nA,B', csvText(),
    csvText(csvRow('D202').replace(',D2,,', ',G3,Corner,')),
    csvText('Young,Doe,2011-01-10,D203,School,G5,SK/TK,Setup,Judging')]) {
    assert.equal((await write('volunteers/import', { revision: data.revision, csv: text })).status, 400);
    assert.equal(JSON.stringify((await get()).volunteers), unchanged);
  }
  const concurrent = await Promise.all([
    write('volunteers/import', { revision: data.revision, csv: csvText(csvRow('D100', 'Updated')) }),
    write('volunteers/import', { revision: data.revision, csv: csvText(csvRow('D100', 'Updated')) })
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  data = await get();
  const unrecognizedImport = await write('volunteers/import', { revision: data.revision, csv: csvText('Jane,Doe,2000-01-09,D100,School,D2,Master Judge,Setup,Judging') });
  assert.equal(unrecognizedImport.status, 200); data = await unrecognizedImport.json();
  assert.equal(data.unrecognizedCertifications, 1);
  assert.equal(data.volunteers.find((row) => row.associationNumber === 'D100').certification, 'UNKNOWN');
  const { dob, ...ageOnly } = volunteer;
  data = await (await write(`volunteers/${originalId}`, { revision: data.revision, volunteer: {
    ...ageOnly, age: 27, ageAsOf: '2027-01-09', parentName: '', contactNumber: ' +1 (555) 0100 ext 4 '
  } }, 'PUT')).json();
  assert.equal(data.volunteers[0].age, 27);
  assert.equal((await get()).volunteers[0].contactNumber, '+1 (555) 0100 ext 4');
  assert.equal((await get()).volunteers[0].parentName, '');
  assert.equal((await get()).volunteers[0].gender, 'Female');
  assert.equal((await get()).volunteers[0].email, 'judge@example.test');
  const blankContactCsv = csvText(csvRow('D100').replace(',D2,,', ',D2,Regional,')).replace('\n', ',Gender,Email\n') + ',,';
  const clearedContacts = await write('volunteers/import', { revision: data.revision, csv: blankContactCsv });
  assert.equal(clearedContacts.status, 200);
  data = await clearedContacts.json();
  assert.equal(data.volunteers[0].gender, '');
  assert.equal(data.volunteers[0].email, '');
  assert.equal((await write('volunteers', { revision: data.revision, volunteer: { ...ageOnly, associationNumber: '', age: 27, ageAsOf: '2028-01-09' } })).status, 400);
  data = await (await write('volunteer-types', { revision: data.revision, name: 'Hospitality' })).json();
  const type = data.types.at(-1);
  data = await (await write(`volunteer-types/${type.id}`, { revision: data.revision, name: 'Welcome' }, 'PUT')).json();
  data = await (await write('volunteer-types/delete', { revision: data.revision, ids: [type.id] })).json();
  for (const name of ['Medical', 'Operations Mgmt']) {
    const response = await write('volunteer-types', { revision: data.revision, name });
    assert.equal(response.status, 200);
    data = await response.json();
  }
  const medical = data.types.find((row) => row.name === 'Medical');
  const operations = data.types.find((row) => row.name === 'Operations Mgmt');
  const customImport = await write('volunteers/import', { revision: data.revision,
    csv: csvText('Custom,Doe,2000-01-09,CUSTOM,School,D2,,medical,OPERATIONS MGMT') });
  assert.equal(customImport.status, 200);
  data = await customImport.json();
  const customVolunteer = data.volunteers.find((row) => row.associationNumber === 'CUSTOM');
  assert.equal(customVolunteer.primaryType, medical.id);
  assert.equal(customVolunteer.secondaryType, operations.id);
  const customEdit = await write(`volunteers/${customVolunteer.id}`, { revision: data.revision,
    volunteer: { ...volunteer, associationNumber: 'CUSTOM', primaryType: operations.id, secondaryType: medical.id } }, 'PUT');
  assert.equal(customEdit.status, 200);
  data = await customEdit.json();
  assert.equal(data.volunteers.find((row) => row.id === customVolunteer.id).primaryType, operations.id);
  assert.deepEqual((await get('B')).volunteers, []);
  let judges = await (await write('ring-judges/populate-volunteers', { revision: null })).json();
  assert.equal(judges.added, 4);
  assert.equal(judges.judges.find((row) => row.associationNumber === 'D100').volunteerId, originalId);
  assert.equal(judges.judges.find((row) => row.associationNumber === 'D100').certification, 'REGIONAL');
  judges = await (await write('ring-judges/populate-volunteers', { revision: judges.revision })).json();
  assert.equal(judges.added, 0); assert.equal(judges.skipped, 4);
  data = await (await write('volunteers', { revision: data.revision, volunteer: { ...volunteer, associationNumber: 'D300', dob: '2010-01-01' } })).json();
  data = await (await write('volunteers', { revision: data.revision, volunteer: { ...volunteer, associationNumber: 'G300', rank: 'G1', certification: 'SK/TK' } })).json();
  judges = await (await write('ring-judges/populate-volunteers', { revision: judges.revision })).json();
  assert.equal(judges.added, 1);
  assert.equal(judges.judges.find((row) => row.associationNumber === 'G300').certification, 'SK_TK');
  assert.equal(judges.judges.find((row) => row.associationNumber === 'G300').rank, 'G1');
  judges = await (await write('ring-judges/populate-volunteers', { revision: judges.revision })).json();
  assert.equal(judges.added, 0);
  locked = true;
  for (const route of ['volunteers', 'volunteers/import', 'volunteers/delete', 'volunteer-types', 'volunteer-types/delete']) {
    assert.equal((await write(route, { revision: data.revision, volunteer, ids: [originalId] })).status, 409);
  }
  assert.equal((await write('ring-judges/populate-volunteers', { revision: judges.revision })).status, 409);
  locked = false;
  data = await (await write('volunteers/delete', { revision: data.revision, ids: [originalId] })).json();
  assert.equal(data.volunteers.some((r) => r.id === originalId), false);
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(path.join(root, 'A', 'volunteers.json'), '{bad');
  assert.equal((await fetch(`${base}/volunteers?eventName=A`)).status, 500);
});
test('volunteer editor switches types, protects drafts, filters and surfaces import errors', async () => {
  const nodes = new Map(), requests = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', files: [], handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; },
      setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
    return nodes.get(id);
  };
  let allowed = false, failure = false;
  const data = { revision: null, rankOptions: judgeRankOptions(), certificationLevels: certificationLevels(),
    types: [{ id: 'setup', name: 'Setup' }, { id: 'judging', name: 'Judging' },
      { id: 'medical', name: 'Medical' }, { id: 'operations', name: 'Operations Mgmt' }],
    volunteers: [{ id: 'one', ...volunteer }] };
  const workspace = create({ document: { getElementById: node }, selectedEvent: () => 'A', confirm: () => allowed, request: async (url, options) => {
    requests.push({ url, options }); if (failure) throw new Error('Import failed'); return data;
  } });
  await workspace.load('volunteers'); node('vmAdd').handlers.click();
  for (const field of ['vm-primaryType', 'vm-secondaryType']) {
    for (const type of data.types) assert.ok(node(field).innerHTML.includes(`value="${type.id}">${type.name}`));
    assert.equal(node(field).disabled, false);
  }
  assert.match(node('vm-secondaryType').innerHTML, /value="">None/);
  for (const [code, label] of [['G5', '5th Gup'], ['D1', 'Cho Dan'], ['D2', 'E Dan'], ['D7', 'Chil Dan']]) {
    assert.ok(node('vm-rank').innerHTML.includes(`value="${code}">${label}`));
  }
  assert.doesNotMatch(node('vm-rank').innerHTML, /value="G6"|value="D8"/);
  for (const level of certificationLevels()) assert.ok(node('vm-certification').innerHTML.includes(`value="${level.code}">${level.label}`));
  assert.equal(node('vm-rank').disabled, false);
  assert.equal(node('vm-certification').disabled, false);
  node('vm-firstName').value = 'New';
  assert.equal(workspace.canLeave(), false);
  assert.equal(workspace.dirty(), true);
  allowed = true; node('vmCancel').handlers.click();
  node('vmSearch').value = 'absent'; node('vmSearchForm').handlers.submit({ preventDefault() {} });
  assert.match(node('vmBody').innerHTML, /No matching/);
  node('vmCsv').files = [{ size: 100, text: async () => csvText(csvRow()) }];
  failure = true; await node('vmImport').handlers.click();
  assert.match(node('vmNotice').textContent, /Import failed/);
  assert.equal(workspace.busy(), false);
  failure = false; await workspace.load('volunteer-types');
  node('vmAdd').handlers.click();
  assert.equal(node('vm-firstName').disabled, true);
  assert.equal(node('vm-typeName').disabled, false);
  node('vm-typeName').value = 'Welcome';
  await node('vmForm').handlers.submit({ preventDefault() {} });
  assert.equal(requests.at(-1).url, '/api/volunteer-types?eventName=A');
  assert.equal(JSON.parse(requests.at(-1).options.body).name, 'Welcome');
});

test('volunteer contact and guardian validation preserves legacy reads and enforces minor saves', () => {
  const types = [{ id: 'setup' }, { id: 'judging' }], date = '2027-01-09';
  const minor = { ...volunteer, dob: '2010-01-10', parentName: '', certification: '' };
  assert.throws(() => validateVolunteer(minor, types, date), /Parent\/guardian name is required/);
  assert.equal(validateVolunteer({ ...minor, parentName: ' Guardian ' }, types, date).parentName, 'Guardian');
  assert.equal(validateVolunteer({ ...minor, dob: '2009-01-09' }, types, date).parentName, '');
  const legacy = validateVolunteer({ ...minor, parentName: undefined, contactNumber: undefined }, types, date, true);
  assert.equal(legacy.parentName, '');
  assert.equal(legacy.contactNumber, '');
  assert.equal(legacy.age, 16);
  assert.equal(Object.hasOwn(legacy, 'dob'), false);
  assert.throws(() => validateVolunteer({ ...volunteer, contactNumber: 123 }, types, date), /contact number/);
  assert.throws(() => validateVolunteer({ ...volunteer, parentName: 'x'.repeat(201) }, types, date), /parent\/guardian/);
  assert.throws(() => validateVolunteer({ ...volunteer, gender: 123 }, types, date), /gender/);
  assert.throws(() => validateVolunteer({ ...volunteer, email: 'x'.repeat(255) }, types, date), /email/);
});

test('volunteer column filters combine, reset selections, and print all matching rows without private guardian details', async () => {
  const nodes = new Map(), requests = [], classes = new Set(), reports = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, handlers: {}, innerHTML: '',
      addEventListener(key, fn) { this.handlers[key] = fn; }, setAttribute() {}, showModal() {}, close() {}, focus() {} });
    return nodes.get(id);
  };
  let event = 'Tournament <One>', printFailure = false;
  const data = { revision: 'v1', tournamentDate: '2027-01-09', configurationLocked: false,
    certificationLevels: [{ code: 'SK_TK', label: 'SK/TK' }, { code: 'UNKNOWN', label: 'Unknown' }],
    types: [{ id: 'setup', name: 'Setup' }, { id: 'judging', name: 'Judging' }],
    volunteers: [
      { ...volunteer, id: 'one', firstName: 'Alex', lastName: '<One>', age: 16, rank: 'G5', certification: 'SK_TK',
        parentName: 'Private Guardian', contactNumber: '+44 123', school: 'East', primaryType: 'judging', secondaryType: 'setup' },
      { ...volunteer, id: 'two', firstName: 'Alex', lastName: 'Two', age: 18, rank: 'G5', certification: 'SK_TK',
        contactNumber: '+44 456', school: 'East', primaryType: 'judging', secondaryType: 'setup' },
      { ...volunteer, id: 'three', firstName: 'Other', lastName: 'Three', age: 45, rank: 'D1', certification: 'UNKNOWN',
        school: 'West', contactNumber: '', primaryType: 'setup', secondaryType: '' }
    ] };
  const workspace = create({ document: { getElementById: node, body: { classList: {
    add: (value) => classes.add(value), remove: (value) => classes.delete(value)
  } } }, selectedEvent: () => event, confirm: () => true,
  request: async (url, options) => { requests.push({ url, options }); return data; },
  print: () => { assert.equal(classes.has('vm-printing'), true); reports.push(node('vmPrintReport').innerHTML); if (printFailure) throw new Error('Printer unavailable'); } });
  await workspace.load();
  const filter = (key, value) => {
    const element = node(`vmFilter-${key}`); element.value = value;
    (element.handlers.input || element.handlers.change)();
  };
  const search = (value) => { node('vmSearch').value = value; node('vmSearchForm').handlers.submit({ preventDefault() {} }); };
  for (const [key, value] of Object.entries({
    school: 'East', rank: 'G5', primaryType: 'judging', secondaryType: 'setup', certification: 'SK_TK' })) filter(key, value);
  search('Alex');
  assert.match(node('vmCount').textContent, /^2 of 3 volunteers/);
  node('vmAll').checked = true; node('vmAll').handlers.change();
  assert.match(node('vmCount').textContent, /2 selected/);
  search('+44 123');
  assert.match(node('vmCount').textContent, /^1 of 3 volunteers.*0 selected/);
  assert.match(node('vmBody').innerHTML, /&lt;One&gt;/);
  assert.doesNotMatch(node('vmBody').innerHTML, /Private Guardian/);
  search('D100');
  assert.match(node('vmCount').textContent, /^2 of 3 volunteers/);
  search('Alex <One>');
  assert.match(node('vmCount').textContent, /^1 of 3 volunteers/);
  search('Alex');
  node('vmBody').handlers.change({ target: { checked: true, getAttribute: () => 'one' } });
  node('vmPrint').handlers.click();
  assert.match(reports[0], /Tournament &lt;One&gt; - Volunteers/);
  assert.match(reports[0], /2 volunteers/);
  assert.match(reports[0], /&lt;One&gt;, Alex/);
  assert.match(reports[0], /Two, Alex/);
  assert.match(reports[0], /First choice: Judging/);
  assert.match(reports[0], /\+44 123/);
  assert.match(reports[0], /SK\/TK/);
  assert.doesNotMatch(reports[0], /Private Guardian|Three/);
  assert.equal(node('vmPrintReport').innerHTML, '');
  assert.equal(classes.size, 0);
  search('no match');
  assert.equal(node('vmPrint').disabled, true);
  node('vmPrint').handlers.click(); assert.equal(reports.length, 1);
  node('vmClearFilters').handlers.click();
  assert.match(node('vmCount').textContent, /^3 of 3 volunteers.*0 selected/);
  filter('school', 'West');
  node('vmPrint').handlers.click(); assert.match(reports[1], /Three, Other/); assert.doesNotMatch(reports[1], /Two, Alex/);
  printFailure = true; node('vmPrint').handlers.click();
  assert.match(node('vmNotice').textContent, /Unable to print volunteers: Printer unavailable/);
  assert.equal(classes.size, 0);
  assert.equal(node('vmPrintReport').innerHTML, '');
  filter('school', 'East'); search('Alex'); await workspace.load();
  assert.equal(node('vmFilter-school').value, 'East');
  assert.equal(node('vmSearch').value, 'Alex');
  assert.match(node('vmCount').textContent, /^2 of 3 volunteers/);
  assert.match(node('vmFilter-school').innerHTML, /West/);
  node('vmClearFilters').handlers.click();
  node('vmAdd').handlers.click();
  node('vm-age').value = '17'; node('vm-age').handlers.input();
  assert.equal(node('vm-parentName').required, true);
  node('vm-age').value = '18'; node('vm-age').handlers.input();
  assert.equal(node('vm-parentName').required, false);
  data.configurationLocked = true; await workspace.load();
  assert.equal(node('vmPrint').disabled, false);
  event = 'Different tournament'; node('vmPrint').handlers.click();
  assert.equal(reports.length, 3);
  await workspace.load();
  assert.equal(node('vmFilter-school').value, '');
  assert.equal(node('vmSearch').value, '');
  await workspace.load('volunteer-types');
  assert.equal(node('vmPrint').hidden, true);
  assert.equal(node('vmColumnFilters').hidden, true);
  assert.equal(requests.some(({ options }) => options), false);
});
