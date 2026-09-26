const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();
const { normalizeRank } = require('./rankNormalization');

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


function normalizeDob(value) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return { dob: '', age: 0 };
  }

  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
  const slashMatch = /^\d{1,2}\/\d{1,2}\/\d{4}$/.exec(trimmed);

  let date;
  if (isoMatch) {
    const [year, month, day] = trimmed.split('-').map((part) => Number(part));
    date = new Date(year, month - 1, day);
  } else if (slashMatch) {
    const [month, day, year] = trimmed.split('/').map((part) => Number(part));
    date = new Date(year, month - 1, day);
  }

  if (!date || Number.isNaN(date.getTime())) {
    return { dob: trimmed, age: 0 };
  }

  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDiff = today.getMonth() - date.getMonth();
  const dayDiff = today.getDate() - date.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  return {
    dob: trimmed,
    age: Math.max(0, age)
  };
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

function normalizeCompetitorRow(rawRow, generatedSequence = 1) {
  const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
  const firstName = normalizeString(row.firstName);
  const lastName = normalizeString(row.lastName);
  const parentFirstName = normalizeString(row.parentFirstName);
  const parentLastName = normalizeString(row.parentLastName);
  const email = normalizeString(row.email);
  const phone = normalizeString(row.phone);
  const dobInfo = normalizeDob(row.dob);
  const associationNumber = normalizeString(row.associationNumber) || null;
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
    dob: dobInfo.dob,
    associationNumber,
    gender,
    rank,
    studio,
    specialNeeds,
    height,
    age: dobInfo.age,
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
  const { clearExisting = false } = options;

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

        fs.createReadStream(csvFilePath)
          .pipe(csv({
            mapHeaders: ({ header }) => normalizeHeader(header)
          }))
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
              specialNeeds: row['Special Needs'],
              height: row['Height'],
              id: row['ID'] ?? row['Competitor ID'] ?? row['CompetitorId'] ?? row['Competitor_ID'] ?? row.id ?? row.competitorId
            };

            const normalized = normalizeCompetitorRow(mapped, generatedSequence);
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
            rows.push([
              normalized.firstName,
              normalized.lastName,
              normalized.parentFirstName,
              normalized.parentLastName,
              normalized.email,
              normalized.phone,
              normalized.dob,
              normalized.associationNumber,
              normalized.gender,
              normalized.rank,
              normalized.studio,
              normalized.specialNeeds,
              normalized.height
            ]);
          })
          .on('error', (err) => {
            db.close();
            reject(err);
          })
          .on('end', () => {
            if (clearExisting) {
              db.run('DELETE FROM competitors', (deleteErr) => {
                if (deleteErr) {
                  db.close();
                  reject(deleteErr);
                  return;
                }
                insertRows(normalizedCompetitors);
              });
              return;
            }

            insertRows(normalizedCompetitors);
          });

        const insertRows = () => {
          if (!rows.length) {
            finish();
            return;
          }

          db.serialize(() => {
            rows.forEach((values) => {
              db.run(`
                INSERT INTO competitors (
                  firstName, lastName, parentFirstName, parentLastName,
                  email, phone, dob, associationNumber, gender, rank,
                  studio, specialNeeds, height
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, values);
            });
          });

          finish();
        };
      };

      runImport();
    });
  });
}

module.exports = Object.assign(importCSV, { normalizeCompetitorRow });