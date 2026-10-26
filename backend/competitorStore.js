const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { assignDivisionNumbers, rebalanceGroupsToSoftMax } = require('./groupDivisionAssignments');
const { validateSpecialNeedsGroups } = require('../assets/division-rules');

function openDatabase(dbFilePath, mode) {
  const resolvedMode = mode == null ? sqlite3.OPEN_READWRITE : mode;
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFilePath, resolvedMode, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function rankUpper(competitor) {
  return String(competitor && competitor.rank ? competitor.rank : '').trim().toUpperCase();
}

function isWeaponsEligible(competitor) {
  if (competitor && (competitor.weaponsEligible === true || competitor.weaponsEligible === 1 || competitor.weaponsEligible === '1')) {
    return true;
  }

  const rank = rankUpper(competitor);
  return rank === 'G2' || rank === 'G1' || rank === 'CDB' || rank === 'D1' || rank === 'D2' || rank === 'D3';
}

function divisionText(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : 'unassigned';
}

function normalizeLookupValue(value) {
  return String(value || '').trim().toLowerCase();
}

function competitorLookupKeys(competitor = {}) {
  const keys = [];
  const associationNumber = String(competitor.associationNumber || '').trim();
  const firstName = normalizeLookupValue(competitor.firstName);
  const lastName = normalizeLookupValue(competitor.lastName);
  const dob = String(competitor.dob || competitor.dobIso || '').trim();
  const email = normalizeLookupValue(competitor.email);

  if (associationNumber) {
    keys.push(`assoc:${associationNumber.toUpperCase()}`);
  }

  if (firstName || lastName || dob) {
    keys.push(`name:${firstName}|${lastName}|${dob}`);
  }

  if (email) {
    keys.push(`email:${email}`);
  }

  return keys;
}

function buildRosterLookup(rows) {
  const lookup = new Map();

  rows.forEach((row) => {
    const competitorId = Number.parseInt(row.id, 10);
    if (!Number.isFinite(competitorId)) return;

    lookup.set(`id:${competitorId}`, competitorId);
    competitorLookupKeys(row).forEach((key) => {
      if (!lookup.has(key)) {
        lookup.set(key, competitorId);
      } else if (lookup.get(key) !== competitorId) {
        lookup.set(key, null);
      }
    });
  });

  return lookup;
}

function resolveCompetitorId(competitor, rosterLookup) {
  const currentId = Number.parseInt(competitor && competitor.id, 10);
  const lookupKeys = competitorLookupKeys(competitor);

  if (rosterLookup) {
    for (const key of lookupKeys) {
      const matchedId = rosterLookup.get(key);
      if (Number.isFinite(matchedId)) {
        return matchedId;
      }
    }

    if (!lookupKeys.length && Number.isFinite(currentId) && rosterLookup.has(`id:${currentId}`)) {
      return rosterLookup.get(`id:${currentId}`);
    }
  }

  return NaN;
}

async function ensureDivisionColumns(db) {
  const rows = await all(db, 'PRAGMA table_info(competitors)');
  const existingColumns = new Set(rows.map((row) => row.name));
  const columnsToAdd = [
    ['groupDivisionId', 'TEXT'],
    ['groupDivisionName', 'TEXT'],
    ['groupDivisionNumber', 'INTEGER'],
    ['competitionDivisionNumber', 'INTEGER']
  ];

  for (const [columnName, columnType] of columnsToAdd) {
    if (!existingColumns.has(columnName)) {
      await run(db, `ALTER TABLE competitors ADD COLUMN ${columnName} ${columnType}`);
    }
  }
}

async function ensureDivisionIndexes(db) {
  const statements = [
    'CREATE INDEX IF NOT EXISTS idx_competitors_first_name ON competitors(firstName)',
    'CREATE INDEX IF NOT EXISTS idx_competitors_last_name ON competitors(lastName)',
    'CREATE INDEX IF NOT EXISTS idx_competitors_association_number ON competitors(associationNumber)',
    'CREATE INDEX IF NOT EXISTS idx_competitors_group_division_number ON competitors(groupDivisionNumber)',
    'CREATE INDEX IF NOT EXISTS idx_competitors_group_division_id ON competitors(groupDivisionId)',
    'CREATE INDEX IF NOT EXISTS idx_competitors_rank ON competitors(rank)'
  ];

  for (const statement of statements) {
    await run(db, statement);
  }
}

function createCompetitorStore(dbFilePath) {
  async function loadCompetitors() {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(dbFilePath)) {
        return resolve([]);
      }

      const db = new sqlite3.Database(dbFilePath, sqlite3.OPEN_READONLY, (err) => {
        if (err) return reject(err);
      });

      db.all('SELECT * FROM competitors', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
        db.close();
      });
    });
  }

  async function saveDivisionAssignments(groups, options = {}) {
    const assignedGroups = assignDivisionNumbers(
      rebalanceGroupsToSoftMax(groups, options),
      options.startingDivisionNumber ?? 20
    );
    if (!fs.existsSync(dbFilePath)) {
      throw new Error(`Database not found: ${dbFilePath}`);
    }

    const db = await openDatabase(dbFilePath, sqlite3.OPEN_READWRITE);
    let transactionStarted = false;
    try {
      await ensureDivisionColumns(db);
      await ensureDivisionIndexes(db);
      const rosterRows = await all(db, 'SELECT * FROM competitors');
      const rosterLookup = buildRosterLookup(rosterRows);
      const rosterById = new Map(rosterRows.map((row) => [row.id, row]));
      validateSpecialNeedsGroups(assignedGroups.map((group) => ({
        ...group,
        competitors: group.competitors.map((competitor) => {
          const row = rosterById.get(resolveCompetitorId(competitor, rosterLookup));
          return row ? { ...competitor, ...row, age: undefined } : competitor;
        })
      })));
      await run(db, 'BEGIN TRANSACTION');
      transactionStarted = true;
      await run(
        db,
        `
          UPDATE competitors
          SET groupDivisionId = NULL,
              groupDivisionName = NULL,
              groupDivisionNumber = NULL,
              competitionDivisionNumber = NULL,
              weaponsDivision = 'unassigned',
              hyungsDivision = 'unassigned',
              sparringDivision = 'unassigned'
        `
      );

      let updatedCompetitors = 0;
      for (const group of assignedGroups) {
        const groupDivisionNumber = Number.parseInt(group.groupDivisionNumber, 10);
        const groupName = String(group.groupDivisionName || group.name || `Division ${Number.isFinite(groupDivisionNumber) ? groupDivisionNumber : ''}`).trim();
        const competitors = Array.isArray(group.competitors) ? group.competitors : [];
        const groupAnchor = Number.isFinite(groupDivisionNumber) ? groupDivisionNumber : null;

        for (const competitor of competitors) {
          const competitorId = resolveCompetitorId(competitor, rosterLookup);
          if (Number.isFinite(competitorId)) {
            competitor.id = String(competitorId);
          }

          const weaponsDivision = isWeaponsEligible(competitor) && competitor.weaponsDivisionNumber != null
            ? String(competitor.weaponsDivisionNumber)
            : 'unassigned';

          const hyungsDivision = competitor.hyungsDivisionNumber != null
            ? String(competitor.hyungsDivisionNumber)
            : divisionText(groupDivisionNumber);

          const sparringDivision = competitor.sparringDivisionNumber != null
            ? String(competitor.sparringDivisionNumber)
            : divisionText(groupDivisionNumber);

          const competitionDivisionNumber = Number.parseInt(
            competitor.competitionDivisionNumber ?? competitor.hyungsDivisionNumber ?? groupDivisionNumber,
            10
          );

          if (!Number.isFinite(competitorId)) {
            throw new Error(`Cannot uniquely match competitor ${competitor.id || '(no id)'} to the current roster in division ${groupAnchor != null ? groupAnchor : 'unknown'}`);
          }
          if (!Number.isFinite(competitionDivisionNumber)) {
            throw new Error(`Cannot persist competition division number for competitor ${competitorId}`);
          }

          const result = await run(
            db,
            `
              UPDATE competitors
              SET groupDivisionId = ?,
                  groupDivisionName = ?,
                  groupDivisionNumber = ?,
                  competitionDivisionNumber = ?,
                  weaponsDivision = ?,
                  hyungsDivision = ?,
                  sparringDivision = ?
              WHERE id = ?
            `,
            [
              null,
              groupName,
              groupAnchor,
              competitionDivisionNumber,
              weaponsDivision,
              hyungsDivision,
              sparringDivision,
              competitorId
            ]
          );

          if (result.changes !== 1) {
            throw new Error(`Failed to update competitor ${competitorId} with division numbers`);
          }

          competitor.groupDivisionName = groupName;
          competitor.groupDivisionId = '';
          competitor.groupDivisionNumber = groupAnchor;
          competitor.competitionDivisionNumber = competitionDivisionNumber;
          competitor.weaponsDivision = weaponsDivision;
          competitor.hyungsDivision = hyungsDivision;
          competitor.sparringDivision = sparringDivision;
          updatedCompetitors += 1;
        }
      }

      await run(db, 'COMMIT');
      return {
        groups: assignedGroups,
        updatedCompetitors
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await run(db, 'ROLLBACK');
        } catch (rollbackError) {
          console.error('Failed to roll back division assignment transaction:', rollbackError);
        }
      }
      throw error;
    } finally {
      await closeDatabase(db);
    }
  }

  return {
    loadCompetitors,
    saveDivisionAssignments
  };
}

module.exports = {
  createCompetitorStore
};
