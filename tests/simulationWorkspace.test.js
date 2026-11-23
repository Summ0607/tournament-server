const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const { createSimulationWorkspaceRouter } = require('../backend/simulationWorkspaceRoutes');

async function serve(router) {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, endpoint, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}

test('GUI workspace creation isolates and loads a full simulation, then recovers after service restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simulation-workspaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let router = createSimulationWorkspaceRouter({ root });
  let apiServer;
  try {
    let service = await serve(router);
    apiServer = service.server;
    const invalid = await call(service.base, '/api/simulation-workspaces', 'POST', {
      name: 'Unsafe/Name', eventDate: '2040-01-15', competitorCount: 130,
      scope: 'regional', tournamentDays: 1
    });
    assert.equal(invalid.status, 400);
    const oldDate = await call(service.base, '/api/simulation-workspaces', 'POST', {
      name: 'Too Early', eventDate: '2019-12-31', competitorCount: 130,
      scope: 'regional', tournamentDays: 1
    });
    assert.equal(oldDate.status, 400);

    const created = await call(service.base, '/api/simulation-workspaces', 'POST', {
      name: 'GUI Regional', eventDate: '2040-01-15', competitorCount: 600,
      scope: 'regional', tournamentDays: 1
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.workspace.ringCount, 20);
    assert.equal(created.data.workspace.judgeCount, 180);
    assert.equal(created.data.workspace.competitorCount, 600);
    assert.equal(created.data.workspace.judgeRequirementCount, 140);
    assert.equal(created.data.workspace.judgeTargetCount, 168);
    assert.equal(created.data.workspace.competitorJudgeCount, 46);
    assert.equal(created.data.workspace.judgingVolunteerCount, 122);
    assert.ok(created.data.workspace.supportVolunteerCount >= 30);
    assert.ok(created.data.workspace.supportVolunteerCount <= 33);
    assert.ok(created.data.workspace.volunteerCount >= 152);
    assert.ok(created.data.workspace.volunteerCount <= 155);
    const supportRoles = created.data.workspace.supportRoleCounts;
    assert.ok(supportRoles.setup >= 3 && supportRoles.setup <= 6);
    assert.ok(supportRoles.teardown >= 3 && supportRoles.teardown <= 6);
    assert.equal(supportRoles.setupTeardownUnique,
      supportRoles.setup + supportRoles.teardown - supportRoles.setupTeardownOverlap);
    assert.ok(supportRoles.setupTeardownUnique <= 9);
    assert.equal(supportRoles.security, 10);
    assert.equal(supportRoles.operations, 10);
    assert.equal(supportRoles.awards, 2);
    assert.equal(supportRoles.medical, 2);
    assert.equal(created.data.workspace.running, true);

    const judgeResponse = await fetch(`${created.data.url}api/judge-management`);
    const judges = await judgeResponse.json();
    assert.equal(judges.judges.length, 180);
    assert.equal(judges.experience.length, 54);
    const participationResponse = await fetch(
      `${created.data.url}api/simulation/participation?eventName=GUI%20Regional`);
    const participation = await participationResponse.json();
    assert.equal(participation.competitors.length, 600);
    assert.equal(participation.volunteers.length, created.data.workspace.volunteerCount);
    assert.ok(participation.competitors.every((person) => !Object.hasOwn(person, 'dob')));

    await router.closeSimulationServers();
    await new Promise((resolve) => apiServer.close(resolve));
    apiServer = null;
    router = createSimulationWorkspaceRouter({ root });
    service = await serve(router);
    apiServer = service.server;
    const listed = await call(service.base, '/api/simulation-workspaces');
    assert.equal(listed.status, 200);
    assert.equal(listed.data.workspaces.length, 1);
    assert.equal(listed.data.workspaces[0].running, false);
    const opened = await call(service.base,
      `/api/simulation-workspaces/${created.data.workspace.id}/open`, 'POST', {});
    assert.equal(opened.status, 200, JSON.stringify(opened.data));
    const recovered = await fetch(`${opened.data.url}api/simulation/participation?eventName=GUI%20Regional`);
    const recoveredRoster = await recovered.json();
    assert.equal(recoveredRoster.competitors.length, 600);
    assert.equal(recoveredRoster.volunteers.length, created.data.workspace.volunteerCount);
    const stopped = await call(service.base,
      `/api/simulation-workspaces/${created.data.workspace.id}/stop`, 'POST', {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.stopped, true);
    assert.equal((await call(service.base, '/api/simulation-workspaces')).data.workspaces[0].running, false);
  } finally {
    await router.closeSimulationServers();
    if (apiServer?.listening) await new Promise((resolve) => apiServer.close(resolve));
  }
});
