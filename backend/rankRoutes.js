const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('./atomicJsonFile');

const initialRanks = [
  ['TTLD', 'Tiny Tigers / Little Dragons', '', 'TT/LD', 120],
  ['SD', 'Special Dragons', '', 'Special Needs', 113],
  ['TT', 'Tiny Tigers', '', '', 118],
  ['LD', 'Little Dragons', '', 'Little Dragon/Yellow Belt', 117],
  ...[
    ['White', '10th Gup White Belt'], ['White/Orange', '9th Gup Sr. White Belt'],
    ['Orange', '8th Gup Orange Belt'], ['Orange/Green', '7th Gup Sr. Orange Belt'],
    ['Green', '6th Gup Green Belt'], ['Green/Brown', '5th Gup Sr. Green Belt'],
    ['Brown', '4th Gup Brown Belt'], ['Brown/Red', '3rd Gup Sr. Brown Belt'],
    ['Red', '2nd Gup Red Belt'], ['Red/Blue', '1st Gup Sr. Red Belt']
  ].map(([belt, alt], index) => [`G${10 - index}`, `${10 - index}${index === 9 ? 'st' : index === 8 ? 'nd' : index === 7 ? 'rd' : 'th'} Gup`, belt, alt, 110 - index * 5]),
  ['CDB', 'Cho Dan Bo', 'Blue', '', 60],
  ['D1', 'Cho Dan', 'Black, 1 stripe', '1st Degree Black Belt', 50],
  ['D2', 'E Dan', 'Black, 2 stripes', '2nd Degree Black Belt', 45],
  ['D3', 'Sam Dan', 'Black, 3 stripes', '3rd Degree Black Belt', 40],
  ['D3', 'Sam Dan (Candidate)', 'Black, 3 stripes', 'Master Candidate', 37],
  ['D4', 'Sah Dan', 'Black, 4 stripes', '4th Degree Black Belt', 35],
  ['D4', 'Sah Dan Master', 'Black, red stripe', '4th Degree Master', 35],
  ['D5', 'Oh Dan', 'Black, 4 stripes', '5th Degree Black Belt', 30],
  ['D5', 'Oh Dan Master', 'Black, red stripe', '5th Degree Master', 30],
  ['D6', 'Yuk Dan Master', 'Black, 2 red stripes', '6th Degree Master', 25],
  ['D7', 'Chil Dan Master', 'Black, 2 red stripes', '7th Degree Master', 20],
  ['D8', 'Pal Dan Grandmaster', 'White and Red Blocks', '8th Degree Grandmaster', 15],
  ['D9', 'Ku Dan Grandmaster', 'Black and Red Blocks', '9th Degree Grandmaster', 10],
  ['', 'Ko Dan Ja', 'Black', '', 2],
  ['', 'Grandmaster', 'Black', '', 1]
].map(([code, name, belt, alternateNames, sortWeight], index) =>
  ({ id: `rank-${index + 1}`, code, name, belt, alternateNames, sortWeight }));

function validateRank(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Rank details are required.');
  const rank = {};
  for (const [key, max] of [['name', 200], ['code', 10], ['belt', 200], ['alternateNames', 1000]]) {
    if (typeof input[key] !== 'string' || input[key].trim().length > max || key === 'name' && !input[key].trim()) {
      throw new Error(`Invalid ${key}; use text of at most ${max} characters${key === 'name' ? ' and a nonempty rank name' : ''}.`);
    }
    rank[key] = input[key].trim();
  }
  rank.code = rank.code.toUpperCase();
  if (rank.code && !/^(TTLD|TT|LD|SD|CDB|G(?:10|[1-9])|D(?:10|[1-9]))$/.test(rank.code)) {
    throw new Error('Code must be TTLD, TT, LD, SD, CDB, G1-G10, D1-D10, or blank for a title without a defined level.');
  }
  if (!Number.isSafeInteger(input.sortWeight) || input.sortWeight < 0 || input.sortWeight > 10000) {
    throw new Error('Sort weight must be a whole number from 0 to 10000.');
  }
  return { ...rank, sortWeight: input.sortWeight };
}
function createRankRouter(filePath) {
  const router = express.Router();
  function read() {
    if (!fs.existsSync(filePath)) writeJsonAtomicSync(filePath, { ranks: initialRanks });
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(saved.ranks)) throw new Error('Invalid saved rank directory.');
    const ids = new Set();
    return { ranks: saved.ranks.map((rank) => {
      if (typeof rank.id !== 'string' || !rank.id || ids.has(rank.id)) throw new Error('Invalid saved rank ID.');
      ids.add(rank.id);
      return { id: rank.id, ...validateRank(rank) };
    }).sort((a, b) => b.sortWeight - a.sortWeight || a.name.localeCompare(b.name)) };
  }
  function handle(callback) {
    return (req, res) => {
      try { callback(req, res); }
      catch (error) {
        console.error('Unable to access rank directory:', error);
        res.status(500).json({ error: 'Unable to access the saved rank directory. Changes have not been saved.' });
      }
    };
  }
  router.get('/ranks', handle((_req, res) => res.json(read())));
  const save = handle((req, res) => {
    let rank;
    try { rank = validateRank(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const data = read();
    const existing = req.params.id ? data.ranks.find((row) => row.id === req.params.id) : null;
    if (req.params.id && !existing) return res.status(404).json({ error: 'Rank not found. Reload the directory.' });
    if (data.ranks.some((row) => row.id !== req.params.id && row.name.toLowerCase() === rank.name.toLowerCase())) {
      return res.status(409).json({ error: 'A rank with this name already exists.' });
    }
    if (existing) Object.assign(existing, rank);
    else data.ranks.push({ id: crypto.randomUUID(), ...rank });
    writeJsonAtomicSync(filePath, data);
    res.status(existing ? 200 : 201).json(data);
  });
  router.post('/ranks', save);
  router.put('/ranks/:id', save);
  router.post('/ranks/delete', handle((req, res) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Select distinct rank IDs to delete.' });
    }
    const data = read();
    if (ids.some((id) => !data.ranks.some((rank) => rank.id === id))) return res.status(409).json({ error: 'Rank directory changed. Reload before deleting.' });
    data.ranks = data.ranks.filter((rank) => !ids.includes(rank.id));
    writeJsonAtomicSync(filePath, data);
    res.json(data);
  }));
  return router;
}
module.exports = { createRankRouter, initialRanks, validateRank };
