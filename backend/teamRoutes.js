const express = require('express');
const fs = require('fs');
const path = require('path');
const { createTeamStore } = require('./teamStore');

function createTeamRouter({ eventsRoot, configurationStatus }) {
  const router = express.Router();
  function scope(req) {
    const eventName = req.query.eventName;
    if (typeof eventName !== 'string' || !eventName.trim() || eventName !== eventName.trim() ||
        /[<>:"/\\|?*\x00-\x1F]/.test(eventName) || ['.', '..'].includes(eventName)) {
      throw Object.assign(new Error('An explicit valid eventName is required.'), { statusCode: 400 });
    }
    const dbPath = path.join(eventsRoot, eventName, 'tournament.db');
    if (!fs.existsSync(dbPath)) throw Object.assign(new Error('Selected tournament database not found.'), { statusCode: 404 });
    const assertWritable = () => {
      const status = configurationStatus(eventName);
      if (status.configurationLocked) throw Object.assign(new Error(status.configurationLockReason ||
        'Event configuration is locked. Stop tablet activity, then reset the run before editing teams or settings.'), { statusCode: 409 });
    };
    return { eventName, store: createTeamStore(dbPath, { assertWritable }) };
  }
  function handle(callback) {
    return async (req, res) => {
      try {
        const scoped = scope(req);
        res.json(await callback(req, scoped));
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to access tournament teams.' });
      }
    };
  }
  router.get('/teams', handle(async (req, { eventName, store }) => ({
    eventName, ...await store.load(), ...configurationStatus(eventName)
  })));
  router.post('/teams', handle((req, { store }) => store.save(req.body || {})));
  router.put('/teams/settings', handle((req, { store }) => store.saveSettings(req.body)));
  router.put('/teams/:id', handle((req, { store }) => store.save(req.body || {}, Number(req.params.id))));
  router.delete('/teams/:id', handle((req, { store }) => store.delete(Number(req.params.id))));
  return router;
}
module.exports = { createTeamRouter };
