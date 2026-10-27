const express = require('express');
const fs = require('fs');
const path = require('path');
const { createDayOfSimulator } = require('./dayOfSimulator');
const { createSimulatorResultPacket } = require('./simulatorResultPacket');
const { createResultPacketStore } = require('./resultPacket');
const { normalizeEventName } = require('./simulatorRunStore');

const DEFAULT_START_AT = '2000-01-01T00:00:00.000Z';
const DEFAULT_STEP_DURATION_MS = 60_000;

function normalizedGroupNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? String(parsed) : String(value || '').trim();
}

function createSimulatorRunRouter({
  eventsRoot,
  simulatorRunStore,
  loadGroupsFromDatabase,
  createRunClient,
  buildResultPacket = createSimulatorResultPacket
}) {
  if (!eventsRoot) throw new Error('eventsRoot is required');
  if (!simulatorRunStore || typeof simulatorRunStore.createRun !== 'function' ||
      typeof simulatorRunStore.getRun !== 'function' ||
      typeof simulatorRunStore.getRunWorkspace !== 'function' ||
      typeof simulatorRunStore.resetRun !== 'function' ||
      typeof simulatorRunStore.deleteRun !== 'function') {
    throw new Error('simulatorRunStore must implement createRun(), getRun(), getRunWorkspace(), resetRun(), and deleteRun()');
  }
  if (typeof loadGroupsFromDatabase !== 'function') {
    throw new Error('loadGroupsFromDatabase is required');
  }
  if (typeof createRunClient !== 'function') {
    throw new Error('createRunClient is required');
  }

  const router = express.Router();
  const controllers = new Map();

  function getController(runId, options = {}) {
    if (controllers.has(runId)) return controllers.get(runId);
    const workspace = simulatorRunStore.getRunWorkspace(runId);
    if (!workspace) return null;
    if (['running', 'paused'].includes(workspace.manifest.status)) {
      const failedManifest = simulatorRunStore.updateRun(runId, {
        status: 'failed',
        failure: 'Server restarted before this simulator run finished; reset the run to start again.'
      });
      const controller = {
        manifest: failedManifest,
        simulator: null,
        status: 'failed',
        speed: failedManifest.speed || 10,
        runnerPromise: null,
        wakeRunner: null,
        failure: failedManifest.failure
      };
      controllers.set(runId, controller);
      return controller;
    }
    if (['complete', 'failed', 'stopped'].includes(workspace.manifest.status)) {
      const controller = {
        manifest: workspace.manifest,
        simulator: null,
        status: workspace.manifest.status,
        speed: workspace.manifest.speed || 10,
        runnerPromise: null,
        wakeRunner: null,
        failure: workspace.manifest.failure || null
      };
      controllers.set(runId, controller);
      return controller;
    }

    const rings = Object.entries(workspace.assignments.rings)
      .map(([ringId, ring]) => ({
        ringId,
        ringLabel: ring.ringLabel,
        groupDivisionNumbers: [
          ring.groupDivisionNumber || ring.currentGroupDivisionNumber,
          ...(ring.queuedGroupDivisionNumbers || [])
        ].filter(Boolean)
      }))
      .filter((ring) => ring.groupDivisionNumbers.length > 0);
    const groups = Object.fromEntries(workspace.groups.map((group) => [
      String(group.groupDivisionNumber ?? group.id ?? group.groupId),
      group
    ]));
    const simulator = createDayOfSimulator({
      runId: workspace.manifest.runId,
      eventName: workspace.manifest.sourceEventName,
      rings,
      groups,
      createRingClient: createRunClient,
      buildResultPacket,
      scenarioSeed: options.scenarioSeed ?? workspace.manifest.scenarioSeed ?? workspace.manifest.runId,
      scenarioId: options.scenarioId ?? workspace.manifest.scenarioId,
      startAt: options.startAt ?? workspace.manifest.startAt ?? DEFAULT_START_AT,
      stepDurationMs: options.stepDurationMs ?? workspace.manifest.stepDurationMs
    });
    const controller = {
      simulator,
      status: workspace.manifest.status || 'created',
      speed: Number.isFinite(workspace.manifest.speed) ? workspace.manifest.speed : 10,
      runnerPromise: null,
      wakeRunner: null,
      failure: workspace.manifest.failure || null
    };
    controllers.set(runId, controller);
    return controller;
  }

  function persistController(runId, controller) {
    const state = controller.simulator ? controller.simulator.getState() : null;
    simulatorRunStore.updateRun(runId, {
      status: controller.status,
      speed: controller.speed,
      scenarioId: state ? state.scenarioId : undefined,
      scenarioSeed: state ? state.scenarioSeed : undefined,
      startAt: state ? state.startedAt : undefined,
      stepDurationMs: state ? state.stepDurationMs : undefined,
      state: state || undefined,
      failure: controller.failure || undefined
    });
    return state;
  }

  function wait(controller, milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      function finish() {
        clearTimeout(timer);
        controller.wakeRunner = null;
        resolve();
      }
      controller.wakeRunner = finish;
    });
  }

  function runDiagnostics(workspace) {
        const manifest = workspace.manifest;
        const state = manifest.state || null;
        const stateByRingId = new Map((state && state.rings || []).map((ring) => [ring.ringId, ring]));
        const groupByNumber = new Map(workspace.groups.map((group) => [
          normalizedGroupNumber(group.groupDivisionNumber ?? group.id ?? group.groupId),
          group
        ]));
        const resultStore = createResultPacketStore({
          getResultsDirectory: () => path.join(workspace.runDirectory, 'results')
        });
        const results = resultStore.listSummaries();
        const resultByGroup = new Map(results.map((result) => [
          normalizedGroupNumber(result.groupDivisionNumber ?? result.groupId),
          result
        ]));
        let completedGroupCount = 0;
        const rings = Object.entries(workspace.assignments.rings).map(([ringId, assignment]) => {
          const stateRing = stateByRingId.get(ringId);
          const currentGroupNumber = normalizedGroupNumber(
            assignment.groupDivisionNumber || assignment.currentGroupDivisionNumber
          );
          const queuedGroupNumbers = (assignment.queuedGroupDivisionNumbers || []).map(normalizedGroupNumber).filter(Boolean);
          const completedGroupNumbers = (assignment.completedGroupDivisionNumbers || []).map(normalizedGroupNumber).filter(Boolean);
          const stateCompleted = stateRing ? stateRing.completedGroupNumbers : [];
          const completedNumbers = [...new Set([...completedGroupNumbers, ...stateCompleted.map(normalizedGroupNumber)])];
          completedGroupCount += completedNumbers.length;
          const totalGroupCount = stateRing
            ? stateRing.totalGroupCount
            : queuedGroupNumbers.length + completedNumbers.length + (currentGroupNumber ? 1 : 0);
          const currentGroup = groupByNumber.get(currentGroupNumber) || null;
          const queuedGroups = queuedGroupNumbers.map((number) => ({
            groupDivisionNumber: number,
            group: groupByNumber.get(number) || null
          }));
          const completedGroups = completedNumbers.map((number) => ({
            groupDivisionNumber: number,
            group: groupByNumber.get(number) || null,
            result: resultByGroup.get(number) || null
          }));
          const pendingGroupNumbers = stateRing
            ? stateRing.pendingGroupNumbers.map(normalizedGroupNumber)
            : [];
          return {
            ringId,
            ringLabel: assignment.ringLabel,
            state: stateRing ? stateRing.state : (manifest.status === 'created' ? 'ready' : manifest.status),
            currentGroupNumber: currentGroupNumber || null,
            currentGroup,
            currentPhase: stateRing ? stateRing.currentPhase : assignment.phase,
            queuedGroupNumbers,
            queuedGroups,
            pendingGroupNumbers,
            pendingGroups: pendingGroupNumbers.map((number) => ({
              groupDivisionNumber: number,
              group: groupByNumber.get(number) || null
            })),
            completedGroupNumbers: completedNumbers,
            completedGroups,
            completedCount: completedNumbers.length,
            totalGroupCount,
            progressPercent: totalGroupCount ? Math.round((completedNumbers.length / totalGroupCount) * 100) : 0,
            error: stateRing && stateRing.error || null
          };
        });
        const totalGroupCount = manifest.assignedGroupCount;
        const virtualTime = {
          startedAt: state && state.startedAt || manifest.startAt || DEFAULT_START_AT,
          simulatedAt: state && state.simulatedAt || manifest.startAt || DEFAULT_START_AT,
          stepDurationMs: state && state.stepDurationMs || manifest.stepDurationMs || DEFAULT_STEP_DURATION_MS,
          operationCount: state && state.operationCount || 0
        };
        return {
          runId: manifest.runId,
          status: manifest.status,
          progress: {
            completedGroupCount,
            totalGroupCount,
            percent: totalGroupCount ? Math.round((completedGroupCount / totalGroupCount) * 100) : 0
          },
          rings,
          results,
          virtualTime,
          errors: state && state.errors || (manifest.failure ? [{ message: manifest.failure }] : []),
          runLog: state && state.events || [],
          reproducibility: {
            scenarioId: manifest.scenarioId || state && state.scenarioId || null,
            scenarioSeed: manifest.scenarioSeed || state && state.scenarioSeed || manifest.runId,
            startAt: virtualTime.startedAt,
            stepDurationMs: virtualTime.stepDurationMs,
            inputSnapshotSha256: manifest.inputSnapshotSha256,
            inputSnapshot: {
              groups: 'groups.json',
              initialAssignments: 'initial-ring-assignments.json'
            }
          }
        };
  }

  function startRunner(runId, controller) {
    if (controller.runnerPromise) return controller.runnerPromise;
    controller.status = 'running';
    controller.failure = null;
    persistController(runId, controller);
    controller.runnerPromise = (async () => {
      try {
        while (controller.status === 'running') {
          const currentState = controller.simulator.getState();
          const activeRings = currentState.rings.filter((ring) =>
            !['complete', 'failed'].includes(ring.state));
          if (!activeRings.length) break;

          for (const ring of activeRings) {
            if (controller.status !== 'running') break;
            try {
              await controller.simulator.step(ring.ringId);
            } catch (error) {
              controller.failure = error.message || String(error);
            }
            persistController(runId, controller);
            if (controller.status === 'running') {
              await wait(controller, Math.max(1, Math.round(100 / controller.speed)));
            }
          }
        }
        if (controller.status === 'running') {
          const finalState = controller.simulator.getState();
          controller.status = finalState.errors.length ? 'failed' : 'complete';
          if (finalState.errors.length) {
            controller.failure = finalState.errors.map((error) => error.message).join('; ');
          }
        }
      } catch (error) {
        controller.status = 'failed';
        controller.failure = error.message || String(error);
      } finally {
        controller.wakeRunner = null;
        persistController(runId, controller);
        controller.runnerPromise = null;
      }
    })();
    return controller.runnerPromise;
  }

  async function stopRunner(controller, status) {
    if (controller.status !== 'complete' && controller.status !== 'failed') {
      controller.status = status;
    }
    if (controller.wakeRunner) controller.wakeRunner();
    if (controller.runnerPromise) await controller.runnerPromise;
  }

  router.post('/simulator/runs', async (req, res) => {
    try {
      const eventName = normalizeEventName(req.body && req.body.eventName);
      if (!fs.existsSync(eventsRoot)) {
        return res.status(404).json({ error: `Event database not found: ${eventName}` });
      }
      const canonicalEventsRoot = fs.realpathSync(eventsRoot);
      const eventDir = path.join(canonicalEventsRoot, eventName);
      if (!fs.existsSync(eventDir) || !fs.statSync(eventDir).isDirectory()) {
        return res.status(404).json({ error: `Event database not found: ${eventName}` });
      }
      const actualEventDir = fs.realpathSync(eventDir);
      const eventRelativePath = path.relative(canonicalEventsRoot, actualEventDir);
      if (!eventRelativePath || eventRelativePath.startsWith('..') || path.isAbsolute(eventRelativePath)) {
        return res.status(400).json({ error: 'eventName must identify an event directory' });
      }
      const dbPath = path.join(eventDir, 'tournament.db');
      const assignmentsPath = path.join(eventDir, 'ring-assignments.json');
      if (!fs.statSync(actualEventDir).isDirectory() ||
          !fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
        return res.status(404).json({ error: `Event database not found: ${eventName}` });
      }
      if (!fs.existsSync(assignmentsPath) || !fs.statSync(assignmentsPath).isFile()) {
        return res.status(409).json({ error: `Saved ring assignments not found: ${eventName}` });
      }
      const actualDbPath = fs.realpathSync(dbPath);
      const actualAssignmentsPath = fs.realpathSync(assignmentsPath);
      for (const sourcePath of [actualDbPath, actualAssignmentsPath]) {
        const relativePath = path.relative(actualEventDir, sourcePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          return res.status(400).json({ error: 'Event source files must remain inside the selected event directory' });
        }
      }
      const assignments = JSON.parse(fs.readFileSync(actualAssignmentsPath, 'utf8'));
      const groups = await loadGroupsFromDatabase(actualDbPath);
      const run = simulatorRunStore.createRun({ eventName, groups, assignments });
      return res.status(201).json(run);
    } catch (error) {
      console.error('Failed to create simulator run:', error);
      return res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : 'Failed to create simulator run'
      });
    }
  });

  router.get('/simulator/runs/:runId', (req, res) => {
    try {
      let run = simulatorRunStore.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Simulator run not found' });
      const controller = getController(req.params.runId);
      if (controller && controller.simulator) {
        persistController(req.params.runId, controller);
      }
      run = simulatorRunStore.getRun(req.params.runId);
      const workspace = simulatorRunStore.getRunWorkspace(req.params.runId);
      return res.json({ ...run, diagnostics: runDiagnostics(workspace) });
    } catch (error) {
      console.error('Failed to read simulator run:', error);
      return res.status(500).json({ error: 'Failed to read simulator run' });
    }
  });

  router.get('/simulator/runs/:runId/log', (req, res) => {
    try {
      const workspace = simulatorRunStore.getRunWorkspace(req.params.runId);
      if (!workspace) return res.status(404).json({ error: 'Simulator run not found' });
      return res.json({
        runId: workspace.manifest.runId,
        events: workspace.manifest.state && workspace.manifest.state.events || [],
        errors: workspace.manifest.state && workspace.manifest.state.errors ||
          (workspace.manifest.failure ? [{ message: workspace.manifest.failure }] : [])
      });
    } catch (error) {
      console.error(`Failed to read simulator run log ${req.params.runId}:`, error);
      return res.status(500).json({ error: 'Failed to read simulator run log' });
    }
  });

  router.get('/simulator/runs/:runId/results', (req, res) => {
    try {
      const workspace = simulatorRunStore.getRunWorkspace(req.params.runId);
      if (!workspace) return res.status(404).json({ error: 'Simulator run not found' });
      const resultStore = createResultPacketStore({
        getResultsDirectory: () => path.join(workspace.runDirectory, 'results')
      });
      return res.json({ runId: workspace.manifest.runId, results: resultStore.listSummaries() });
    } catch (error) {
      console.error(`Failed to read simulator run results ${req.params.runId}:`, error);
      return res.status(500).json({ error: 'Failed to read simulator run results' });
    }
  });

  router.post('/simulator/runs/:runId/step', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const ringId = String(req.body && req.body.ringId || '').trim();
      if (!ringId) return res.status(400).json({ error: 'ringId is required' });
      const controller = getController(runId, req.body || {});
      if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
      if (!controller.simulator) return res.status(409).json({ error: `Simulator run is ${controller.status}` });
      if (!['created', 'paused'].includes(controller.status)) {
        return res.status(409).json({ error: `Cannot step a simulator run that is ${controller.status}` });
      }
      const workspace = simulatorRunStore.getRunWorkspace(runId);
      if (!workspace.assignments.rings[ringId]) {
        return res.status(400).json({ error: `Unknown simulator ring: ${ringId}` });
      }
      const ring = await controller.simulator.step(ringId);
      const state = controller.simulator.getState();
      controller.status = state.errors.length
        ? 'failed'
        : (state.rings.every((item) => item.state === 'complete') ? 'complete' : 'paused');
      persistController(runId, controller);
      return res.json({ ring, state: { ...state, lifecycleStatus: controller.status } });
    } catch (error) {
      console.error(`Failed to step simulator run ${runId}:`, error);
      const controller = controllers.get(runId);
      if (controller && controller.simulator) {
        controller.status = 'failed';
        controller.failure = error.message || String(error);
        persistController(runId, controller);
      }
      if (!simulatorRunStore.getRunWorkspace(runId)) return res.status(404).json({ error: 'Simulator run not found' });
      return res.status(409).json({ error: error.message || 'Failed to step simulator run' });
    }
  });

  router.post('/simulator/runs/:runId/start', (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = getController(runId, req.body || {});
      if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
      if (!controller.simulator) return res.status(409).json({ error: `Simulator run is ${controller.status}` });
      if (controller.status === 'running') return res.status(202).json(simulatorRunStore.getRun(runId));
      if (controller.status !== 'created') {
        return res.status(409).json({ error: `Cannot start a simulator run that is ${controller.status}` });
      }
      startRunner(runId, controller);
      return res.status(202).json(simulatorRunStore.getRun(runId));
    } catch (error) {
      console.error(`Failed to start simulator run ${runId}:`, error);
      return res.status(409).json({ error: error.message || 'Failed to start simulator run' });
    }
  });

  router.post('/simulator/runs/:runId/pause', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = getController(runId);
      if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
      if (controller.status === 'paused') return res.json(simulatorRunStore.getRun(runId));
      if (controller.status !== 'running') {
        return res.status(409).json({ error: `Cannot pause a simulator run that is ${controller.status}` });
      }
      controller.status = 'paused';
      if (controller.wakeRunner) controller.wakeRunner();
      persistController(runId, controller);
      if (controller.runnerPromise) await controller.runnerPromise;
      return res.json(simulatorRunStore.getRun(runId));
    } catch (error) {
      console.error(`Failed to pause simulator run ${runId}:`, error);
      return res.status(409).json({ error: error.message || 'Failed to pause simulator run' });
    }
  });

  router.post('/simulator/runs/:runId/resume', (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = getController(runId, req.body || {});
      if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
      if (!controller.simulator) return res.status(409).json({ error: `Simulator run is ${controller.status}` });
      if (controller.status !== 'paused') {
        return res.status(409).json({ error: `Cannot resume a simulator run that is ${controller.status}` });
      }
      startRunner(runId, controller);
      return res.status(202).json(simulatorRunStore.getRun(runId));
    } catch (error) {
      console.error(`Failed to resume simulator run ${runId}:`, error);
      return res.status(409).json({ error: error.message || 'Failed to resume simulator run' });
    }
  });

  router.post('/simulator/runs/:runId/speed', (req, res) => {
    const runId = String(req.params.runId || '');
    const speed = req.body && req.body.speed;
    if (!Number.isFinite(speed) || speed < 0.1 || speed > 100) {
      return res.status(400).json({ error: 'speed must be a number from 0.1 through 100' });
    }
    const controller = getController(runId);
    if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
    if (!['created', 'running', 'paused'].includes(controller.status)) {
      return res.status(409).json({ error: `Cannot change speed when simulator run is ${controller.status}` });
    }
    controller.speed = speed;
    if (controller.wakeRunner) controller.wakeRunner();
    persistController(runId, controller);
    return res.json(simulatorRunStore.getRun(runId));
  });

  router.post('/simulator/runs/:runId/stop', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = getController(runId);
      if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
      if (!['complete', 'failed'].includes(controller.status)) {
        await stopRunner(controller, 'stopped');
      }
      persistController(runId, controller);
      return res.json(simulatorRunStore.getRun(runId));
    } catch (error) {
      console.error(`Failed to stop simulator run ${runId}:`, error);
      return res.status(409).json({ error: error.message || 'Failed to stop simulator run' });
    }
  });

  router.post('/simulator/runs/:runId/run', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = getController(runId, req.body || {});
      if (!controller) return res.status(404).json({ error: 'Simulator run not found' });
      if (controller.status === 'complete') {
        return res.json(simulatorRunStore.getRun(runId).state);
      }
      if (!controller.simulator) return res.status(409).json({ error: `Simulator run is ${controller.status}` });
      if (controller.status === 'created') startRunner(runId, controller);
      else if (controller.status !== 'running') {
        return res.status(409).json({ error: `Cannot run a simulator that is ${controller.status}` });
      }
      if (controller.runnerPromise) await controller.runnerPromise;
      if (controller.status === 'failed') {
        return res.status(409).json({ error: controller.failure || 'Simulator run failed' });
      }
      if (controller.status !== 'complete') {
        return res.status(409).json({ error: `Simulator run stopped before completion (${controller.status})` });
      }
      return res.json(simulatorRunStore.getRun(runId).state);
    } catch (error) {
      console.error(`Failed to run simulator ${runId} to completion:`, error);
      const controller = controllers.get(runId);
      if (controller && controller.simulator) {
        controller.status = 'failed';
        controller.failure = error.message || String(error);
        persistController(runId, controller);
      }
      if (!simulatorRunStore.getRunWorkspace(runId)) return res.status(404).json({ error: 'Simulator run not found' });
      return res.status(409).json({ error: error.message || 'Failed to run simulator to completion' });
    }
  });

  router.post('/simulator/runs/:runId/reset', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = controllers.get(runId);
      if (controller) await stopRunner(controller, 'stopped');
      const reset = simulatorRunStore.resetRun(runId);
      if (!reset) return res.status(404).json({ error: 'Simulator run not found' });
      controllers.delete(runId);
      if (typeof createRunClient.invalidateRun === 'function') createRunClient.invalidateRun(runId);
      return res.json(reset);
    } catch (error) {
      console.error(`Failed to reset simulator run ${runId}:`, error);
      return res.status(500).json({ error: 'Failed to reset simulator run' });
    }
  });

  router.delete('/simulator/runs/:runId', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const controller = controllers.get(runId);
      if (controller) await stopRunner(controller, 'stopped');
      if (!simulatorRunStore.deleteRun(runId)) {
        return res.status(404).json({ error: 'Simulator run not found' });
      }
      controllers.delete(runId);
      if (typeof createRunClient.invalidateRun === 'function') createRunClient.invalidateRun(runId);
      return res.json({ ok: true, runId });
    } catch (error) {
      console.error(`Failed to delete simulator run ${runId}:`, error);
      return res.status(500).json({ error: 'Failed to delete simulator run' });
    }
  });

  return router;
}

module.exports = { createSimulatorRunRouter };
