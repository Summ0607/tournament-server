const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { defaults, validate } = require('../assets/visual-definitions');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

function createVisualDefinitionRouter(filePath) {
  const router = express.Router();
  function read() {
    if (!fs.existsSync(filePath)) return { revision: null, values: defaults() };
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof saved.revision !== 'string' || !saved.revision) throw new Error('Invalid saved visual definition revision.');
    return { revision: saved.revision, values: validate(saved.values) };
  }
  router.get('/visual-definitions', (_req, res) => {
    try { res.json(read()); }
    catch (error) {
      console.error('Unable to read visual definitions:', error);
      res.status(500).json({ error: 'Unable to read saved visual definitions. The saved file may need repair.' });
    }
  });
  router.put('/visual-definitions', (req, res) => {
    let values;
    try { values = validate(req.body && req.body.values); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      if (req.body.revision !== read().revision) {
        return res.status(409).json({ error: 'Visual definitions changed in another session. Reload the saved definitions before saving.' });
      }
      const saved = { revision: crypto.randomUUID(), values };
      writeJsonAtomicSync(filePath, saved);
      res.json(saved);
    } catch (error) {
      console.error('Unable to save visual definitions:', error);
      res.status(500).json({ error: 'Unable to save visual definitions. Your edits have not been saved.' });
    }
  });
  return router;
}
module.exports = { createVisualDefinitionRouter };
