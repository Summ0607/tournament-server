const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_DB_PATH = path.join(__dirname, 'tournament.db');

function ensureCompetitorColumns(db) {
  return new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(competitors)', (infoErr, rows) => {
      if (infoErr) {
        reject(infoErr);
        return;
      }

      const existingColumns = new Set((rows || []).map((row) => row.name));
      const columnsToAdd = [
        ['groupDivisionId', 'TEXT'],
        ['groupDivisionName', 'TEXT'],
        ['groupDivisionNumber', 'INTEGER'],
        ['competitionDivisionNumber', 'INTEGER']
      ];

      const missingColumns = columnsToAdd.filter(([columnName]) => !existingColumns.has(columnName));

      const addNext = (index) => {
        if (index >= missingColumns.length) {
          resolve();
          return;
        }

        const [columnName, columnType] = missingColumns[index];
        db.run(`ALTER TABLE competitors ADD COLUMN ${columnName} ${columnType}`, (alterErr) => {
          if (alterErr) {
            reject(alterErr);
            return;
          }
          addNext(index + 1);
        });
      };

      addNext(0);
    });
  });
}

function ensureCompetitorIndexes(db) {
  return new Promise((resolve, reject) => {
    const statements = [
      'CREATE INDEX IF NOT EXISTS idx_competitors_first_name ON competitors(firstName)',
      'CREATE INDEX IF NOT EXISTS idx_competitors_last_name ON competitors(lastName)',
      'CREATE INDEX IF NOT EXISTS idx_competitors_association_number ON competitors(associationNumber)',
      'CREATE INDEX IF NOT EXISTS idx_competitors_group_division_number ON competitors(groupDivisionNumber)',
      'CREATE INDEX IF NOT EXISTS idx_competitors_group_division_id ON competitors(groupDivisionId)',
      'CREATE INDEX IF NOT EXISTS idx_competitors_rank ON competitors(rank)'
    ];

    const runNext = (index) => {
      if (index >= statements.length) {
        resolve();
        return;
      }

      db.run(statements[index], (err) => {
        if (err) {
          reject(err);
          return;
        }
        runNext(index + 1);
      });
    };

    runNext(0);
  });
}

function initializeDatabase(targetDbPath = DEFAULT_DB_PATH) {
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

      db.serialize(() => {
        db.run(`
          CREATE TABLE IF NOT EXISTS competitors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            firstName TEXT,
            lastName TEXT,
            parentFirstName TEXT,
            parentLastName TEXT,
            email TEXT,
            phone TEXT,
            dob TEXT,
            associationNumber TEXT,
            gender TEXT,
            rank TEXT,
            studio TEXT,
            specialNeeds INTEGER,
            height INTEGER,

            weaponsDivision TEXT DEFAULT 'unassigned',
            hyungsDivision TEXT DEFAULT 'unassigned',
            sparringDivision TEXT DEFAULT 'unassigned',
            ringAssignment TEXT DEFAULT 'unassigned',
            groupDivisionId TEXT,
            groupDivisionName TEXT,
            groupDivisionNumber INTEGER,
            competitionDivisionNumber INTEGER
          )
        `, (createErr) => {
          if (createErr) {
            db.close();
            reject(createErr);
            return;
          }

          ensureCompetitorColumns(db).then(() => {
            ensureCompetitorIndexes(db).then(() => {
              db.close((closeErr) => {
                if (closeErr) {
                  reject(closeErr);
                  return;
                }
                resolve(targetDbPath);
              });
            }).catch((indexErr) => {
              db.close(() => {
                reject(indexErr);
              });
            });
          }).catch((migrationErr) => {
            db.close(() => {
              reject(migrationErr);
            });
          });
        });
      });
    });
  });
}

if (require.main === module) {
  initializeDatabase().catch((err) => {
    console.error('Failed to initialize default tournament database:', err);
    process.exitCode = 1;
  });
}

module.exports = initializeDatabase;