const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

const initialSchools = [
  { name: 'Vaughns Dojang I - Phoenixville', alternateNames: '', chiefInstructor: 'Master David Painter' },
  { name: 'Vaughns Dojang II - Spring Valley', alternateNames: '', chiefInstructor: 'Mr. Ryan Clark' },
  { name: 'Vaughns Dojang IV - Audubon', alternateNames: '', chiefInstructor: 'GM Charles Vaughn' }
].map((school, index) => ({ id: `vaughns-${index + 1}`, ...school, archived: false }));
function validateSchool(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('School details are required.');
  const result = {};
  for (const [key, label, max, required] of [
    ['name', 'School name', 200, true], ['alternateNames', 'Alternate names', 1000, false],
    ['chiefInstructor', 'Chief instructor', 200, false]
  ]) {
    if (typeof input[key] !== 'string' || input[key].trim().length > max || required && !input[key].trim()) {
      throw new Error(`${label}${required ? ' is required and' : ''} must be text of at most ${max} characters.`);
    }
    result[key] = input[key].trim();
  }
  if (typeof input.archived !== 'boolean') throw new Error('Archived must be true or false.');
  return { ...result, archived: input.archived };
}
function createSchoolRouter(filePath) {
  const router = express.Router();
  function read() {
    if (!fs.existsSync(filePath)) writeJsonAtomicSync(filePath, { schools: initialSchools });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(data.schools)) throw new Error('Invalid saved school directory.');
    const ids = new Set();
    const schools = data.schools.map((school) => {
      if (typeof school.id !== 'string' || !school.id || ids.has(school.id)) throw new Error('Invalid saved school ID.');
      ids.add(school.id);
      return { id: school.id, ...validateSchool(school) };
    });
    return { schools };
  }
  router.get('/schools', (_req, res) => {
    try { res.json(read()); }
    catch (error) {
      console.error('Unable to read school directory:', error);
      res.status(500).json({ error: 'Unable to read the saved school directory.' });
    }
  });
  function save(req, res) {
    let school;
    try { school = validateSchool(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const data = read();
      const existing = req.params.id ? data.schools.find((row) => row.id === req.params.id) : null;
      if (req.params.id && !existing) return res.status(404).json({ error: 'School not found. Reload the directory.' });
      if (data.schools.some((row) => row.id !== req.params.id && row.name.toLowerCase() === school.name.toLowerCase())) {
        return res.status(409).json({ error: 'A school with this name already exists.' });
      }
      if (existing) Object.assign(existing, school);
      else data.schools.push({ id: crypto.randomUUID(), ...school });
      writeJsonAtomicSync(filePath, data);
      res.status(existing ? 200 : 201).json(data);
    } catch (error) {
      console.error('Unable to save school:', error);
      res.status(500).json({ error: 'Unable to save school. Your changes have not been saved.' });
    }
  }
  router.post('/schools', save);
  router.put('/schools/:id', save);
  router.post('/schools/delete', (req, res) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Select distinct school IDs to delete.' });
    }
    try {
      const data = read();
      if (ids.some((id) => !data.schools.some((school) => school.id === id))) {
        return res.status(409).json({ error: 'School directory changed. Reload before deleting.' });
      }
      data.schools = data.schools.filter((school) => !ids.includes(school.id));
      writeJsonAtomicSync(filePath, data);
      res.json(data);
    } catch (error) {
      console.error('Unable to delete schools:', error);
      res.status(500).json({ error: 'Unable to delete schools. Your changes have not been saved.' });
    }
  });
  return router;
}
module.exports = { createSchoolRouter, validateSchool, initialSchools };
