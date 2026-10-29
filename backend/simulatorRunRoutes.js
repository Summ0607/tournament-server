const express = require('express');
const fs = require('fs');
const path = require('path');
const { createDayOfSimulator } = require('./dayOfSimulator');
const { createSimulatorResultPacket } = require('./simulatorResultPacket');
const { createResultPacketStore } = require('./resultPacket');
const { TIMING_MODEL_VERSION, estimateDivisionTiming } = require('./simulatorTiming');
const { buildSimulatorAudienceMonitor } = require('./audienceMonitor');
const { normalizeEventName } = require('./simulatorRunStore');
const { buildSimulatorRunTiming, buildSimulatorAssignmentEstimates } = require('./simulatorRunTiming');
const { createEventConfigStore } = require('./eventConfig');
const { writeJsonAtomicSync } = require('./atomicJsonFile');
const { scheduleState, sortDivisionIds } = require('./tournamentSchedule');

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
      typeof simulatorRunStore.listRuns !== 'function' ||
      typeof simulatorRunStore.getRunWorkspace !== 'function' ||
      typeof simulatorRunStore.resetRun !== 'function' ||
      typeof simulatorRunStore.deleteRun !== 'function') {
    throw new Error('simulatorRunStore must implement createRun(), getRun(), listRuns(), getRunWorkspace(), resetRun(), and deleteRun()');
  }
  if (typeof loadGroupsFromDatabase !== 'function') {
    throw new Error('loadGroupsFromDatabase is required');
  }
  if (typeof createRunClient !== 'function') {
    throw new Error('createRunClient is required');
  }

  const router = express.Router();
  const controllers = new Map();
  const { readEventConfig } = createEventConfigStore(eventsRoot);

  function completedLifecycle(runId) {
    const workspace = simulatorRunStore.getRunWorkspace(runId);
    const schedule = scheduleState(workspace.groups, workspace.assignments);
    return schedule.tournamentDays === 2 && !schedule.day2Started ? 'day-break' : 'complete';
  }

  router.get('/simulator/runs', (_req, res) => {
    try {
      return res.json({ runs: simulatorRunStore.listRuns() });
    } catch (error) {
      console.error('Failed to list simulator runs:', error);
      return res.status(500).json({ error: 'Failed to list simulator runs' });
    }
  });

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
        speed: failedManifest.speed || 600,
        runnerPromise: null,
        wakeRunners: new Set(),
        failure: failedManifest.failure,
        wallClockStartedAt: failedManifest.wallClockStartedAt || null,
        wallClockCompletedAt: failedManifest.wallClockCompletedAt || null
      };
      controllers.set(runId, controller);
      return controller;
    }
    if (['complete', 'failed', 'stopped', 'day-break'].includes(workspace.manifest.status)) {
      const controller = {
        manifest: workspace.manifest,
        simulator: null,
        status: workspace.manifest.status,
        speed: workspace.manifest.speed || 600,
        runnerPromise: null,
        wakeRunners: new Set(),
        failure: workspace.manifest.failure || null,
        wallClockStartedAt: workspace.manifest.wallClockStartedAt || null,
        wallClockCompletedAt: workspace.manifest.wallClockCompletedAt || null
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
      }));
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
      speed: Number.isFinite(workspace.manifest.speed) ? workspace.manifest.speed : 600,
      runnerPromise: null,
      wakeRunners: new Set(),
      pendingOperations: new Map(),
      previousDayState: workspace.manifest.previousDayState || null,
      failure: workspace.manifest.failure || null,
      wallClockStartedAt: workspace.manifest.wallClockStartedAt || null,
      wallClockCompletedAt: workspace.manifest.wallClockCompletedAt || null
    };
    controllers.set(runId, controller);
    return controller;
  }

  function persistController(runId, controller) {
    const state = controller.simulator ? controller.simulator.getState() : null;
    if (state && controller.previousDayState) {
      const previous = controller.previousDayState;
      state.events = [...previous.events, ...state.events].map((event, index) => ({ ...event, sequence: index + 1 }));
      state.startedAt = previous.startedAt;
      state.operationCount += previous.operationCount;
    }
    if (state) {
      state.rings = state.rings.map((ring) => {
        const pending = controller.pendingOperations.get(ring.ringId);
        // The remainder is anchored to operationWaitStartedAt; a null timestamp freezes it.
        return {
          ...ring,
          pendingOperationMs: pending ? pending.remainingMs : 0,
          operationWaitStartedAt: pending && pending.startedAt !== null
            ? new Date(pending.startedAt).toISOString() : null,
          operationWaitSpeed: pending ? pending.speed : controller.speed
        };
      });
    }
    if (controller.status === 'complete' && controller.wallClockStartedAt && !controller.wallClockCompletedAt) {
      controller.wallClockCompletedAt = new Date().toISOString();
    }
    simulatorRunStore.updateRun(runId, {
      status: controller.status,
      speed: controller.speed,
      scenarioId: state ? state.scenarioId : undefined,
      scenarioSeed: state ? state.scenarioSeed : undefined,
      startAt: state ? state.startedAt : undefined,
      stepDurationMs: state ? state.stepDurationMs : undefined,
      state: state || undefined,
      failure: controller.failure || undefined,
      wallClockStartedAt: controller.wallClockStartedAt || undefined,
      wallClockCompletedAt: controller.wallClockCompletedAt || undefined
    });
    return state;
  }

  function wait(controller, pending) {
    return new Promise((resolve) => {
      pending.startedAt = Date.now();
      pending.speed = controller.speed;
      const timer = setTimeout(finish, Math.max(10, Math.ceil(pending.remainingMs / pending.speed)));
      function finish() {
        clearTimeout(timer);
        controller.wakeRunners.delete(finish);
        pending.remainingMs = Math.max(0,
          pending.remainingMs - Math.max(0, Date.now() - pending.startedAt) * pending.speed);
        pending.startedAt = null;
        resolve();
      }
      controller.wakeRunners.add(finish);
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
          const queuedGroupNumbers = (assignment.queuedGroupDivisionNumbers || [])
            .map(normalizedGroupNumber).filter(Boolean).slice(0, 1);
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
          return {
            ringId,
            ringLabel: assignment.ringLabel,
            state: stateRing ? stateRing.state : (manifest.status === 'created' ? 'ready' : manifest.status),
            currentGroupNumber: currentGroupNumber || null,
            currentGroup,
            currentPhase: stateRing ? stateRing.currentPhase : assignment.phase,
            currentPhaseProgress: stateRing ? stateRing.currentPhaseProgress : assignment.phaseProgress || 0,
            estimatedDivisionDurationMs: stateRing && stateRing.estimatedDivisionDurationMs || null,
            phaseDurationsMs: stateRing && stateRing.phaseDurationsMs || {},
            queuedGroupNumbers,
            queuedGroups,
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
          schedule: scheduleState(workspace.groups, workspace.assignments),
          status: manifest.status,
          timing: buildSimulatorRunTiming(workspace),
          progress: {
            completedGroupCount,
            totalGroupCount,
            percent: totalGroupCount ? Math.round((completedGroupCount / totalGroupCount) * 100) : 0
          },
          rings,
          availableGroupNumbers: (workspace.assignments.pendingGroupDivisionNumbers || [])
            .map((entry) => normalizedGroupNumber(entry.groupDivisionNumber)),
          availableGroupCount: (workspace.assignments.pendingGroupDivisionNumbers || []).length,
          results,
          virtualTime,
          errors: state && state.errors || (manifest.failure ? [{ message: manifest.failure }] : []),
          runLog: state && state.events || [],
          reproducibility: {
            scenarioId: manifest.scenarioId || state && state.scenarioId || null,
            scenarioSeed: manifest.scenarioSeed || state && state.scenarioSeed || manifest.runId,
            startAt: virtualTime.startedAt,
            stepDurationMs: virtualTime.stepDurationMs,
            timingModelVersion: TIMING_MODEL_VERSION,
            inputSnapshotSha256: manifest.inputSnapshotSha256,
            inputSnapshot: {
              groups: 'groups.json',
              initialAssignments: 'initial-ring-assignments.json'
            }
          }
        };
  }

  function durationText(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
    const seconds = Math.round(milliseconds / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function simulatorHeadTable(workspace) {
    const { manifest, groups, assignments } = workspace;
    const stateByRingId = new Map(((manifest.state && manifest.state.rings) || [])
      .map((ring) => [ring.ringId, ring]));
    const rings = Object.entries(assignments.rings).map(([ringId, assignment]) => {
      const state = stateByRingId.get(ringId);
      const groupDivisionNumber = normalizedGroupNumber(
        state && state.currentGroupNumber || assignment.groupDivisionNumber ||
        assignment.currentGroupDivisionNumber
      );
      const phaseDurationsMs = state && state.phaseDurationsMs || {};
      const phaseOrder = Object.keys(phaseDurationsMs);
      const phases = phaseOrder.map((key) => {
        const currentIndex = phaseOrder.indexOf(state && state.currentPhase);
        const index = phaseOrder.indexOf(key);
        return {
          key,
          label: key === 'setup' ? 'Setup' : key[0].toUpperCase() + key.slice(1),
          state: state && state.currentPhase === 'uploading-report' ? 'complete' : !groupDivisionNumber ? 'upcoming'
            : index < currentIndex ? 'complete'
              : index === currentIndex ? 'active' : 'upcoming',
          progress: state && state.currentPhase === 'uploading-report' ? 100 : groupDivisionNumber && index === currentIndex
            ? Number(state.currentPhaseProgress) || 0
            : index < currentIndex ? 100 : 0
        };
      });
      const phaseTotalCount = assignment.phaseTotalCount || 0;
      const phaseCompletedCount = assignment.phaseCompletedCount || 0;
      const queue = (assignment.queuedGroupDivisionNumbers || []).map(normalizedGroupNumber).filter(Boolean);
      const stateCompleted = state && state.completedGroupNumbers || [];
      const completedGroupDivisionNumbers = [...new Set([
        ...(assignment.completedGroupDivisionNumbers || []),
        ...stateCompleted
      ].map(normalizedGroupNumber).filter(Boolean))];
      const currentIndex = phaseOrder.indexOf(state && state.currentPhase);
      const completedPhaseDuration = phaseOrder
        .slice(0, Math.max(0, currentIndex))
        .reduce((sum, key) => sum + (Number(phaseDurationsMs[key]) || 0), 0);
      const currentPhaseDuration = Number(phaseDurationsMs[state && state.currentPhase]) || 0;
      const simulatedElapsed = completedPhaseDuration + currentPhaseDuration *
        Math.max(0, Math.min(1, (state && state.currentPhaseProgress || 0) / 100));
      return {
        ringId,
        ringLabel: assignment.ringLabel,
        groupDivisionNumber: groupDivisionNumber || '',
        queuedGroupDivisionNumbers: queue.slice(0, 1),
        completedGroupDivisionNumbers,
        tabletLabel: assignment.tabletLabel || '',
        lastHeartbeatAt: assignment.lastHeartbeatAt || '',
        phase: state && state.currentPhase || assignment.phase || 'idle',
        currentPhaseName: ({ 'uploading-report': 'Uploading report', 'loading-division': 'Loading division',
          idle: 'Idle' })[state && state.currentPhase] || state && state.currentPhase || assignment.phase || 'Idle',
        phaseProgress: state && state.currentPhaseProgress || 0,
        phaseCompletedCount,
        phaseTotalCount,
        currentPhaseCompletedCount: phaseCompletedCount,
        currentPhaseTotalCount: phaseTotalCount,
        checkInCount: assignment.checkInCount || 0,
        checkInTotal: assignment.checkInTotal || 0,
        phasePlan: groupDivisionNumber ? { phases } : null,
        queuedPhasePlan: queue.length ? {
          groupDivisionNumber: queue[0],
          phases: (() => {
            const queuedGroup = groups.find((group) => normalizedGroupNumber(
              group.groupDivisionNumber ?? group.id ?? group.groupId
            ) === queue[0]);
            return estimateDivisionTiming(queuedGroup).phases
              .map((key) => ({ key, label: key === 'setup' ? 'Setup' : key[0].toUpperCase() + key.slice(1) }));
          })()
        } : null,
        ringEstimated: durationText(state && state.estimatedDivisionDurationMs),
        currentPhaseEstimated: durationText(phaseDurationsMs[state && state.currentPhase]),
        ringElapsed: durationText(simulatedElapsed),
        currentPhaseElapsed: durationText(phaseDurationsMs[state && state.currentPhase] *
          Math.max(0, Math.min(1, (state && state.currentPhaseProgress || 0) / 100))),
        assignmentStartedAt: manifest.state && manifest.state.simulatedAt || '',
        currentPhaseStartTime: manifest.state && manifest.state.simulatedAt || '',
        assistanceType: '',
        sparringActualBoutCount: null,
        sparringCompletedBoutCount: 0,
        sparringByeCount: null,
        phaseHistory: []
      };
    });
    const assigned = new Set(rings.flatMap((ring) => [
      ring.groupDivisionNumber,
      ...ring.queuedGroupDivisionNumbers,
      ...ring.completedGroupDivisionNumbers
    ]).filter(Boolean).map(normalizedGroupNumber));
    const availableGroupDivisionNumbers = sortDivisionIds((assignments.pendingGroupDivisionNumbers || [])
      .map((entry) => normalizedGroupNumber(entry.groupDivisionNumber))
      .filter((number) => number && !assigned.has(number)), groups);
    return {
      eventName: `SIMULATION · ${manifest.sourceEventName} · ${manifest.runId.slice(0, 8)}`,
      simulatorRunId: manifest.runId,
      simulatorStatus: manifest.status,
      schedule: scheduleState(groups, assignments),
      rings,
      availableGroupDivisionNumbers,
      groups,
      eventStartedAt: manifest.state && manifest.state.startedAt || '',
      heartbeatPolicy: { disconnectAfterSeconds: 90 }
    };
  }

  function startRunner(runId, controller) {
    if (controller.runnerPromise) return controller.runnerPromise;
    controller.status = 'running';
    controller.failure = null;
    if (!controller.wallClockStartedAt) controller.wallClockStartedAt = new Date().toISOString();
    try {
      persistController(runId, controller);
    } catch (error) {
      controller.status = 'failed';
      controller.failure = error.message || String(error);
      throw error;
    }
    controller.runnerPromise = (async () => {
      try {
        const activeRings = controller.simulator.getState().rings.filter((ring) =>
          !['complete', 'failed'].includes(ring.state) || controller.pendingOperations.has(ring.ringId));
        const operations = await Promise.allSettled(activeRings.map(async (ring) => {
          while (controller.status === 'running') {
            const pending = controller.pendingOperations.get(ring.ringId);
            if (pending && pending.remainingMs > 0) {
              const waiting = wait(controller, pending);
              try {
                persistController(runId, controller);
              } catch (error) {
                controller.status = 'failed';
                controller.failure = error.message || String(error);
                for (const wake of controller.wakeRunners) wake();
                await waiting;
                throw error;
              }
              await waiting;
              continue;
            }
            controller.pendingOperations.delete(ring.ringId);
            const currentRing = controller.simulator.getState().rings.find((item) => item.ringId === ring.ringId);
            if (!currentRing || ['complete', 'failed'].includes(currentRing.state)) break;
            try {
              await controller.simulator.step(ring.ringId);
            } catch (error) {
              controller.failure = error.message || String(error);
            }
            const nextRing = controller.simulator.getState().rings.find((item) => item.ringId === ring.ringId);
            if (nextRing && nextRing.state !== 'failed') {
              controller.pendingOperations.set(ring.ringId, {
                remainingMs: nextRing.recommendedDelayMs || 1000,
                startedAt: null,
                speed: controller.speed
              });
            }
            try {
              persistController(runId, controller);
            } catch (error) {
              controller.status = 'failed';
              controller.failure = error.message || String(error);
              for (const wake of controller.wakeRunners) wake();
              throw error;
            }
          }
        }));
        const rejected = operations.find((operation) => operation.status === 'rejected');
        if (rejected) throw rejected.reason;
        if (controller.status === 'running') {
          const finalState = controller.simulator.getState();
          controller.status = finalState.errors.length ? 'failed' : completedLifecycle(runId);
          if (finalState.errors.length) {
            controller.failure = finalState.errors.map((error) => error.message).join('; ');
          }
        }
      } catch (error) {
        controller.status = 'failed';
        controller.failure = error.message || String(error);
      } finally {
        controller.wakeRunners.clear();
        try {
          persistController(runId, controller);
        } catch (error) {
          controller.status = 'failed';
          controller.failure = `Failed to persist simulator run: ${error.message || String(error)}`;
          console.error(`Failed to persist final simulator state ${runId}:`, error);
        } finally {
          controller.runnerPromise = null;
        }
      }
    })();
    return controller.runnerPromise;
  }

  async function stopRunner(controller, status) {
    if (controller.status !== 'complete' && controller.status !== 'failed') {
      controller.status = status;
    }
    for (const wake of controller.wakeRunners) wake();
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
      const run = simulatorRunStore.createRun({ eventName, groups, assignments,
        tournamentDays: readEventConfig(eventName).tournamentDays });
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
      const controller = controllers.get(req.params.runId) ||
        (run.status === 'created' ? null : getController(req.params.runId));
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

  router.get('/simulator/runs/:runId/audience', (req, res) => {
    try {
      const workspace = simulatorRunStore.getRunWorkspace(req.params.runId);
      if (!workspace) return res.status(404).json({ error: 'Simulator run not found' });
      res.set('Cache-Control', 'no-store');
      return res.json(buildSimulatorAudienceMonitor(workspace));
    } catch (error) {
      console.error(`Failed to build simulator audience view ${req.params.runId}:`, error);
      return res.status(500).json({ error: 'Failed to build simulator audience view' });
    }
  });

  router.get('/simulator/runs/:runId/head-table', (req, res) => {
    try {
      let run = simulatorRunStore.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Simulator run not found' });
      const controller = controllers.get(req.params.runId) ||
        (run.status === 'created' ? null : getController(req.params.runId));
      if (controller && controller.simulator) persistController(req.params.runId, controller);
      const workspace = simulatorRunStore.getRunWorkspace(req.params.runId);
      res.set('Cache-Control', 'no-store');
      return res.json(simulatorHeadTable(workspace));
    } catch (error) {
      console.error(`Failed to build simulator Head Table ${req.params.runId}:`, error);
      return res.status(500).json({ error: 'Failed to build simulator Head Table' });
    }
  });

  router.get('/simulator/runs/:runId/ring-assignment', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const workspace = simulatorRunStore.getRunWorkspace(req.params.runId);
      if (!workspace) return res.status(404).json({ error: 'Simulator run not found' });
      const board = simulatorHeadTable(workspace);
      return res.json({
        ...board,
        runId: workspace.manifest.runId,
        ringConfig: workspace.assignments.config,
        eventStartedAt: workspace.manifest.wallClockStartedAt || '',
        estimates: buildSimulatorAssignmentEstimates(workspace, board)
      });
    } catch (error) {
      console.error(`Failed to build simulator Ring Assignment ${req.params.runId}:`, error);
      return res.status(500).json({ error: 'Failed to build simulator Ring Assignment' });
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
      if (!controller.wallClockStartedAt) controller.wallClockStartedAt = new Date().toISOString();
      controller.pendingOperations.delete(ringId);
      const ring = await controller.simulator.step(ringId);
      const state = controller.simulator.getState();
      controller.status = state.errors.length
        ? 'failed'
        : (state.rings.every((item) => item.state === 'complete') ? completedLifecycle(runId) : 'paused');
      persistController(runId, controller);
      return res.json({ ring, state: { ...state, lifecycleStatus: controller.status } });
    } catch (error) {
      console.error(`Failed to step simulator run ${runId}:`, error);
      const controller = controllers.get(runId);
      if (controller && controller.simulator) {
        controller.status = 'failed';
        controller.failure = error.message || String(error);
        try {
          persistController(runId, controller);
        } catch (persistenceError) {
          console.error(`Failed to persist simulator failure ${runId}:`, persistenceError);
        }
      }
      if (!simulatorRunStore.getRunWorkspace(runId)) return res.status(404).json({ error: 'Simulator run not found' });
      return res.status(409).json({ error: error.message || 'Failed to step simulator run' });
    }
  });

  router.post('/simulator/runs/:runId/schedule/day2', async (req, res) => {
    const runId = String(req.params.runId || '');
    try {
      const workspace = simulatorRunStore.getRunWorkspace(runId);
      if (!workspace) return res.status(404).json({ error: 'Simulator run not found' });
      const schedule = scheduleState(workspace.groups, workspace.assignments);
      if (workspace.manifest.status !== 'day-break' || schedule.tournamentDays !== 2 ||
          !schedule.day1Complete || schedule.day2Started) {
        return res.status(409).json({ error: 'Day 2 requires the Day 1 completion checkpoint and can only be started once.' });
      }
      workspace.assignments.day2StartedAt = new Date().toISOString();
      writeJsonAtomicSync(path.join(workspace.runDirectory, 'ring-assignments.json'), workspace.assignments);
      simulatorRunStore.updateRun(runId, {
        status: 'created',
        previousDayState: workspace.manifest.state,
        startAt: workspace.manifest.state && workspace.manifest.state.simulatedAt || DEFAULT_START_AT,
        wallClockCompletedAt: null
      });
      controllers.delete(runId);
      if (typeof createRunClient.invalidateRun === 'function') createRunClient.invalidateRun(runId);
      const controller = getController(runId);
      startRunner(runId, controller);
      return res.status(202).json(simulatorRunStore.getRun(runId));
    } catch (error) {
      console.error(`Failed to start simulator Day 2 ${runId}:`, error);
      return res.status(500).json({ error: 'Failed to start simulator Day 2.' });
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
      for (const wake of controller.wakeRunners) wake();
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
    if (!Number.isFinite(speed) || speed < 1 || speed > 3600) {
      return res.status(400).json({ error: 'speed must be a number from 1 through 3600' });
    }
    const controller = controllers.get(runId);
    if (controller) {
      if (!['created', 'running', 'paused'].includes(controller.status)) {
        return res.status(409).json({ error: `Cannot change speed when simulator run is ${controller.status}` });
      }
      controller.speed = speed;
      for (const wake of controller.wakeRunners) wake();
      persistController(runId, controller);
      return res.json(simulatorRunStore.getRun(runId));
    }
    const workspace = simulatorRunStore.getRunWorkspace(runId);
    if (!workspace) return res.status(404).json({ error: 'Simulator run not found' });
    if (!['created', 'running', 'paused'].includes(workspace.manifest.status)) {
      return res.status(409).json({ error: `Cannot change speed when simulator run is ${workspace.manifest.status}` });
    }
    simulatorRunStore.updateRun(runId, { speed });
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
        try {
          persistController(runId, controller);
        } catch (persistenceError) {
          console.error(`Failed to persist simulator failure ${runId}:`, persistenceError);
        }
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

  router.shutdown = async () => {
    await Promise.all([...controllers.entries()].map(async ([runId, controller]) => {
      if (['running', 'paused'].includes(controller.status)) {
        await stopRunner(controller, 'stopped');
        persistController(runId, controller);
      }
    }));
  };
  return router;
}

module.exports = { createSimulatorRunRouter };
