import { config } from './config.js';
import { pool } from './db.js';
import { markProductionDatabase, seedDemo } from './demo.js';
import { seedAdmin, seedReferenceData } from './seed.js';

async function main() {
  await seedReferenceData(pool);
  if (config.isProduction) await markProductionDatabase(pool);
  console.log('Reference data ready (trades, facility types, coverage factors, default pricing rules, NZ holidays).');
  if (config.seedAdmin.email && config.seedAdmin.password) {
    const created = await seedAdmin(pool, config.seedAdmin.email, config.seedAdmin.password, config.seedAdmin.name);
    console.log(created ? `Administrator ${config.seedAdmin.email} created.` : 'An administrator already exists; none created.');
  } else {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: no administrator created.');
  }
  if (process.argv.includes('--demo')) {
    const logins = await seedDemo(pool);
    console.log('Demo data loaded. Logins (password: %s):', logins.password);
    for (const [role, email] of Object.entries(logins)) if (role !== 'password') console.log(`  ${role.padEnd(11)} ${email}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
