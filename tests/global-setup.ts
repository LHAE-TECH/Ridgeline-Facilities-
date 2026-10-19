import pg from 'pg';

/** Rebuilds the test database schema from migrations before the suite runs. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://ridgeline:ridgeline@localhost:5432/ridgeline_test';
  process.env.DATABASE_URL = url;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const { pool } = await import('../src/db.js');
  const { migrate } = await import('../src/migrate.js');
  const { seedReferenceData } = await import('../src/seed.js');
  await migrate(pool, () => undefined);
  await seedReferenceData(pool);
  await pool.end();
}
