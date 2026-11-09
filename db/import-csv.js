const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();
const { normalizeRank } = require('./rankNormalization');
const { ageOnDate, validDate, lockAgeDate } = require('../backend/tournamentAge');
const { resolveMemberPerson, deleteOrphanPeople } = require('../backend/eventPeople');

const defaultDbPath = path.join(__dirname, 'tournament.db');
const weaponsEligibleRanks = new Set(['G2', 'G1', 'CDB', 'D1', 'D2', 'D3']);

function normalizeHeader(header) {
  return header ? header.replace(/^\uFEFF/, '').trim() : header;
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function normalizeGender(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return 'Unknown';
  }
  if (normalized === 'male') return 'Male';
  if (normalized === 'female') return 'Female';
  if (normalized === 'unknown') return 'Unknown';
  return 'Unknown';
}


function normalizeHeight(value) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSpecialNeeds(value) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return 0;
  }

  const lower = trimmed.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(lower)) {
    return 1;
  }
  if (['false', '0', 'no', 'n'].includes(lower)) {
    return 0;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? (parsed ? 1 : 0) : 0;
}

function readRawCompetitorId(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') {
    return '';
  }

  const candidateKeys = ['id', 'competitorId', 'competitorID', 'competitor_id', 'Competitor ID', 'CompetitorId'];
  for (const key of candidateKeys) {
    const value = rawRow[key];
    if (value !== null && value !== undefined && normalizeString(value) !== '') {
      return normalizeString(value);
    }
  }

  return '';
}

function normalizeCompetitorRow(rawRow, generatedSequence = 1, tournamentDate) {
  const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
  const firstName = normalizeString(row.firstName);
  const lastName = normalizeString(row.lastName);
  const parentFirstName = normalizeString(row.parentFirstName);
  const parentLastName = normalizeString(row.parentLastName);
  const email = normalizeString(row.email);
  const phone = normalizeString(row.phone);
  const age = ageOnDate(row.dob, tournamentDate);
  const associationNumber = normalizeString(row.associationNumber);
  if (!associationNumber) throw new Error('Association ID is required for every competitor.');
  const gender = normalizeGender(row.gender);
  const rankResult = normalizeRank(row.rank);
  const rank = rankResult.code;
  const studio = normalizeString(row.studio) || 'Unknown Studio';
  const specialNeeds = normalizeSpecialNeeds(row.specialNeeds);
  const height = normalizeHeight(row.height);
  const rawId = readRawCompetitorId(row);
  const competitorId = rawId || `competitor-${generatedSequence}`;
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const weaponsEligible = weaponsEligibleRanks.has(rank);

  return {
    id: competitorId,
    competitorId,
    firstName,
    lastName,
    parentFirstName,
    parentLastName,
    email,
    phone,
    ageAsOf: tournamentDate,
    associationNumber,
    gender,
    rank,
    studio,
    specialNeeds,
    height,
    age,
    fullName,
    weaponsEligible,
    rankWarning: !rankResult.recognized
      ? { rawRank: rankResult.raw, reason: rankResult.reason, storedRank: '' }
      : (/^D(\d{1,2})$/.test(rank) && Number(rank.slice(1)) >= 4
        ? { rawRank: rankResult.raw, reason: 'rank not eligible to compete', storedRank: rank }
        : null)
  };
}

function importCSV(csvFilePath, targetDbPath = defaultDbPath, options = {}) {
  const { clearExisting = false, tournamentDate } = options;
  try { validDate(tournamentDate); } catch (error) { return Promise.reject(Object.assign(error, { statusCode: 400 })); }

  if (!fs.existsSync(csvFilePath)) {
    return Promise.reject(new Error(`CSV file not found: ${csvFilePath}`));
  }

  const directory = path.dirname(targetDbPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(targetDbPath, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      const normalizedCompetitors = [];
      const rankWarnings = [];
      const seenAssociationIds = new Set();
      let generatedSequence = 1;
      let csvLineNumber = 1;

      const finish = () => {
        db.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve({ csvFilePath, targetDbPath, imported: true, normalizedCompetitors, rankWarnings });
        });
      };

      const runImport = () => {
        const rows = [];

        const parser = csv({
            mapHeaders: ({ header }) => normalizeHeader(header)
          });
        const source = fs.createReadStream(csvFilePath);
        source.on('error', (error) => parser.destroy(error));
        source.pipe(parser)
          .on('data', (row) => {
            const mapped = {
              firstName: row['First Name'],
              lastName: row['Last Name'],
              parentFirstName: row['Parent First Name'],
              parentLastName: row['Parent Last Name'],
              email: row['Email'],
              phone: row['Phone'],
              dob: row['DOB'],
              associationNumber: row['Association Number'],
              gender: row['Gender'],
              rank: row['Current Rank'],
              studio: row['Studio'],
              specialNeeds: row['Special Needs'] ?? row['Special Needs (Y|N)'],
              height: row['Height'],
              id: row['ID'] ?? row['Competitor ID'] ?? row['CompetitorId'] ?? row['Competitor_ID'] ?? row.id ?? row.competitorId
            };

            let normalized;
            try { normalized = normalizeCompetitorRow(mapped, generatedSequence, tournamentDate); }
            catch (error) { parser.destroy(Object.assign(new Error(`CSV row ${csvLineNumber + 1}: ${error.message}`), { statusCode: 400 })); return; }
            const associationKey = normalized.associationNumber.toUpperCase();
            if (seenAssociationIds.has(associationKey)) {
              parser.destroy(Object.assign(new Error(`CSV row ${csvLineNumber + 1}: Duplicate Association ID ${normalized.associationNumber}.`), { statusCode: 400 }));
              return;
            }
            seenAssociationIds.add(associationKey);
            if (!readRawCompetitorId(mapped)) {
              generatedSequence += 1;
            }
            csvLineNumber += 1;
            if (normalized.rankWarning) {
              const warning = {
                csvLine: csvLineNumber,
                competitorId: normalized.id,
                name: normalized.fullName,
                ...normalized.rankWarning
              };
              rankWarnings.push(warning);
              console.warn(
                `[import-csv] Rank flagged for review on CSV line ${warning.csvLine} (${warning.name || warning.competitorId}): ` +
                `"${warning.rawRank}" (${warning.reason}); stored as ${warning.storedRank ? `"${warning.storedRank}"` : 'blank rank'} for review.`
              );
            }

            normalizedCompetitors.push(normalized);
            rows.push({ normalized, values: [
              normalized.firstName,
              normalized.lastName,
              normalized.parentFirstName,
              normalized.parentLastName,
              normalized.email,
              normalized.phone,
              normalized.age,
              normalized.ageAsOf,
              normalized.associationNumber,
              normalized.gender,
              normalized.rank,
              normalized.studio,
              normalized.specialNeeds,
              normalized.height
            ] });
          })
          .on('error', (err) => {
            source.destroy();
            db.close((closeError) => reject(closeError || err));
          })
          .on('end', async () => {
            const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
            const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
            let transaction = false;
            try {
              await run('PRAGMA foreign_keys = ON');
              await run('BEGIN IMMEDIATE'); transaction = true;
              if (clearExisting) {
                const table = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='teams'");
                if (table && (await get('SELECT COUNT(*) AS count FROM teams')).count) {
                  throw Object.assign(new Error('Teams exist. Delete all teams before replacing the competitor roster.'), { statusCode: 409 });
                }
                await run('DELETE FROM competitors');
                await deleteOrphanPeople(db);
              }
              for (const { normalized, values } of rows) {
                const personId = await resolveMemberPerson(db, normalized);
                if (await get('SELECT id FROM competitors WHERE personId = ?', [personId])) {
                  throw Object.assign(new Error(`Association ID ${normalized.associationNumber} already has a competitor record.`), { statusCode: 409 });
                }
                normalized.personId = personId;
                await run(`
                INSERT INTO competitors (
                  firstName, lastName, parentFirstName, parentLastName,
                  email, phone, age, ageAsOf, associationNumber, gender, rank,
                  studio, specialNeeds, height, personId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [...values, personId]);
              }
              if (rows.length) lockAgeDate(path.dirname(targetDbPath), tournamentDate);
              await run('COMMIT'); transaction = false; finish();
            } catch (error) {
              if (transaction) await run('ROLLBACK');
              db.close((closeError) => reject(closeError || error));
            }
          });
      };

      runImport();
    });
  });
}

module.exports = Object.assign(importCSV, { normalizeCompetitorRow });