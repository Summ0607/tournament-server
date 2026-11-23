const { regionalDataset, selectExperienceJudges, experienceRole } = require('./judgeSimulationData');

const scopes = new Set(['REGIONAL', 'NATIONAL', 'WORLD', 'IN_HOUSE']);

function buildSimulatorJudgeExperience(manifest) {
  const { runId, sourceEventName, tournamentDate } = manifest || {};
  const scope = String(manifest?.tournamentScope || 'REGIONAL').toUpperCase().replace(/-/g, '_');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(runId || '')) ||
      typeof sourceEventName !== 'string' || !sourceEventName.trim() ||
      !scopes.has(scope)) {
    throw new Error('A valid simulator run identity, event name, and event type are required to create simulated judge experience.');
  }
  const dataset = regionalDataset(tournamentDate);
  const selection = selectExperienceJudges(dataset.judges, 70, runId);
  const eventName = `SIMULATED ${scope.replace(/_/g, ' ')} ${sourceEventName} ${runId}`;
  const eventId = runId;
  const records = selection.selected.flatMap((judge) => {
    const role = experienceRole(judge);
    return ['P1', 'P2'].map((phase) => ({
      associationId: judge.associationId,
      judgeName: `${judge.firstName} ${judge.lastName}`,
      rank: judge.rank,
      certification: judge.certification,
      eventId,
      eventName,
      eventDate: tournamentDate,
      location: 'Fabricated simulation venue',
      role,
      eventScope: scope,
      phase,
      source: 'SIMULATION',
      sourceId: `${judge.associationId}:${eventId}:${role}:${phase}`,
      logVerified: false
    }));
  });
  return { eventId, eventName, eventDate: tournamentDate, eventScope: scope, records };
}

module.exports = { buildSimulatorJudgeExperience };
