const path = require('node:path');
const { verifyJudgeDatabase } = require('./judgeManagement');

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node db\\verifyJudgeDatabase.js <database-path>');
  const file = path.resolve(process.argv[2]);
  await verifyJudgeDatabase(file);
  console.log(`Judge Management database verified: ${file}`);
}

main().catch((error) => {
  console.error(`Judge Management database verification failed: ${error.message}`);
  process.exitCode = 1;
});
