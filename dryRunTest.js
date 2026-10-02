const { buildDivisions } = require('./backend/groupBuilder');
const { createCompetitorStore } = require('./backend/competitorStore');
const path = require('path');

async function runDryTest() {
  console.log("==========================================");
  console.log("  STARTING TWO-PASS ENGINE DRY RUN");
  console.log("==========================================");

  try {
    // 1. Initialize store using your factory pattern
    // (Adjust the DB file path if your database is stored elsewhere, e.g., './data/tournaments.db')
    const dbPath = path.join(__dirname, 'db', 'tournament.db');
    const store = createCompetitorStore(dbPath);

    console.log("Loading competitors from database...");
    const competitors = await store.loadCompetitors();

    console.log(`Loaded ${competitors.length} competitors from store.`);

    if (!competitors || competitors.length === 0) {
      console.log("⚠️ No competitors found. Please check your database path or add test competitors.");
      return;
    }

    // 2. Execute legacy engine for baseline comparison
    console.log("\n--- Running Legacy Engine ---");
    const startTimeLegacy = Date.now();
    const legacyGroups = buildDivisions(competitors, { useNewEngine: false });
    const legacyTime = Date.now() - startTimeLegacy;
    console.log(`Legacy Groups Created: ${legacyGroups.length} (in ${legacyTime}ms)`);

    // 3. Execute new Two-Pass Bucket & Cluster engine
    console.log("\n--- Running New Two-Pass Engine ---");
    const startTimeNew = Date.now();
    const newGroups = buildDivisions(competitors, { useNewEngine: true });
    const newTime = Date.now() - startTimeNew;
    console.log(`New Groups Created: ${newGroups.length} (in ${newTime}ms)`);

    // 4. Print Summary Comparison
    console.log("\n==========================================");
    console.log("  DRY RUN SUMMARY");
    console.log("==========================================");
    console.log(`Legacy Count: ${legacyGroups.length} groups`);
    console.log(`New Engine Count: ${newGroups.length} groups`);

    if (newGroups.length > 0) {
      console.log("\nSample Group from New Engine:");
      console.log(JSON.stringify(newGroups[0], null, 2));
    }

    console.log("\n✅ Dry run completed successfully without triggering fallback!");

  } catch (error) {
    console.error("❌ Dry run encountered a fatal error:", error);
  }
}

runDryTest();