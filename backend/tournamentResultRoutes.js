const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const rules = require('../assets/competition-settings');
const { normalizeEventName } = require('./simulatorRunStore');
const { aggregate } = require('./tournamentResults');
const { readCompetitionSettings } = require('./competitionSettingRoutes');

function readRoster(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => {
      if (error) return reject(error);
      db.all('SELECT id, gender, age, ageAsOf, associationNumber FROM competitors', (error, rows) => {
        db.close((closeError) => error || closeError ? reject(error || closeError) : resolve(rows));
      });
    });
  });
}
function createTournamentResultRouter({ eventsRoot, runsRoot }) {
  const router = express.Router();
  router.get('/tournament-results', async (req, res) => {
    try {
      if (typeof req.query.eventName !== 'string') return res.status(400).json({ error: 'An explicit eventName is required.' });
      const name = normalizeEventName(req.query.eventName), eventDir = path.join(eventsRoot, name);
      if (!fs.existsSync(path.join(eventDir, 'tournament.db'))) return res.status(404).json({ error: 'Tournament database not found.' });
      const sources = [{ id: 'live', label: 'Live tournament', simulation: false }];
      for (const id of fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []) {
        const file = path.join(runsRoot, id, 'manifest.json');
        if (!fs.existsSync(file)) continue;
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (manifest.sourceEventName === name) sources.push({ id, label: `Simulation — ${manifest.status} — ${manifest.createdAt}`, simulation: true });
      }
      const sourceId = req.query.source || 'live', source = sources.find((row) => row.id === sourceId);
      if (!source) return res.status(404).json({ error: 'Result source not found for this tournament.' });
      const dir = source.simulation ? path.join(runsRoot, source.id) : eventDir;
      const settings = {};
      for (const kind of Object.keys(rules.schemas)) {
        const file = path.join(eventDir, `${kind}.json`);
        settings[kind] = readCompetitionSettings(file, kind).rows;
      }
      const packets = new Map(), resultDir = path.join(dir, 'results');
      for (const file of fs.existsSync(resultDir) ? fs.readdirSync(resultDir).filter((f) => f.endsWith('.json')).sort() : []) {
        const raw = JSON.parse(fs.readFileSync(path.join(resultDir, file), 'utf8'));
        const record = raw.packetBlock || raw;
        if (raw.status && raw.status !== 'ACCEPTED') continue;
        if (record.eventName !== name || !Array.isArray(record.participants) || !record.disciplines || !record.overallAwards) throw new Error(`Invalid result record: ${file}.`);
        const key = record.groupDivisionNumber ?? record.groupId;
        if (key === undefined || !Number.isFinite(Date.parse(record.completedAt))) throw new Error(`Invalid division result: ${file}.`);
        const previous = packets.get(String(key));
        if (!previous || Date.parse(record.completedAt) > Date.parse(previous.completedAt)) packets.set(String(key), record);
      }
      const roster = source.simulation ? JSON.parse(fs.readFileSync(path.join(dir, 'groups.json'), 'utf8')).flatMap((group) => group.competitors) :
        await readRoster(path.join(eventDir, 'tournament.db'));
      const date = source.simulation
        ? JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).tournamentDate
        : JSON.parse(fs.readFileSync(path.join(eventDir, 'event-config.json'), 'utf8')).date;
      res.json({ eventName: name, source, sources, ...aggregate({ packets: [...packets.values()], roster, settings, date, simulation: source.simulation }) });
    } catch (error) {
      console.error('Unable to load tournament results:', error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : `Unable to calculate tournament results: ${error.message}` });
    }
  });
  return router;
}
module.exports = { createTournamentResultRouter };
