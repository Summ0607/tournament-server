const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

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

  return {
    loadCompetitors
  };
}

module.exports = {
  createCompetitorStore
};
