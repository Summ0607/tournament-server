const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rules = require('../assets/competition-settings');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

function readCompetitionSettings(file, kind) {
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { revision: null, rows: rules.defaults(kind) };
  if (!Array.isArray(data.rows) || data.revision !== null && typeof data.revision !== 'string') throw new Error('Invalid saved settings.');
  const ids = new Set();
  data.rows = data.rows.map((row) => {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Invalid settings row ID.');
    ids.add(row.id);
    return { id: row.id, ...rules.validate(kind, row) };
  });
  return data;
}
function createCompetitionSettingRouter({ eventsRoot, configurationStatus }) {
  const router = express.Router();
  function handle(callback, write = false) {
    return (req, res) => {
      try {
        const name = req.query.eventName, kind = req.params.kind;
        if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[<>:"/\\|?*\x00-\x1F]/.test(name) || ['.', '..'].includes(name)) {
          return res.status(400).json({ error: 'An explicit valid eventName is required.' });
        }
        if (!Object.hasOwn(rules.schemas, kind)) return res.status(404).json({ error: 'Unknown competition settings section.' });
        const dir = path.join(eventsRoot, name);
        if (!fs.existsSync(path.join(dir, 'tournament.db'))) return res.status(404).json({ error: 'Tournament database not found.' });
        const status = configurationStatus(name);
        if (write && status.configurationLocked) return res.status(409).json({ error: status.configurationLockReason || 'Tournament settings are locked. Reset the run before editing.' });
        if (write && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'Settings request details are required.' });
        const file = path.join(dir, `${kind}.json`);
        const data = readCompetitionSettings(file, kind);
        if (write && req.body.revision !== data.revision) return res.status(409).json({ error: 'Settings changed in another session. Reload before saving.' });
        callback(req, res, { kind, data, file, name, status });
      } catch (error) {
        console.error('Unable to access competition settings:', error);
        res.status(500).json({ error: 'Unable to access saved competition settings. Changes have not been saved.' });
      }
    };
  }
  function commit(res, context) {
    if (configurationStatus(context.name).configurationLocked) return res.status(409).json({ error: 'Tournament settings became locked. Changes have not been saved.' });
    context.data.revision = crypto.randomUUID();
    writeJsonAtomicSync(context.file, context.data);
    res.json({ ...context.data, ...context.status, eventName: context.name });
  }
  router.get('/competition-settings/:kind', handle((_req, res, context) => res.json({ ...context.data, ...context.status, eventName: context.name })));
  const save = handle((req, res, context) => {
    let row;
    try { row = rules.validate(context.kind, req.body.row); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const existing = req.params.id ? context.data.rows.find((entry) => entry.id === req.params.id) : null;
    if (req.params.id && !existing) return res.status(404).json({ error: 'Entry not found.' });
    if (context.data.rows.some((entry) => entry.id !== req.params.id && (entry.name.toLowerCase() === row.name.toLowerCase() ||
        context.kind === 'competition-types' && entry.code === row.code))) {
      return res.status(409).json({ error: 'An entry with this name or code already exists.' });
    }
    if (existing) Object.assign(existing, row);
    else context.data.rows.push({ id: crypto.randomUUID(), ...row });
    commit(res, context);
  }, true);
  router.post('/competition-settings/:kind', save);
  router.put('/competition-settings/:kind/:id', save);
  router.post('/competition-settings/:kind/delete', handle((req, res, context) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !context.data.rows.some((row) => row.id === id))) {
      return res.status(400).json({ error: 'Select distinct existing entries to delete.' });
    }
    context.data.rows = context.data.rows.filter((row) => !ids.includes(row.id));
    commit(res, context);
  }, true));
  return router;
}
module.exports = { createCompetitionSettingRouter, readCompetitionSettings };
