import { pool } from './db.js';
import { migrate } from './migrate.js';

migrate(pool)
  .then((applied) => {
    console.log(applied.length ? `${applied.length} migration(s) applied` : 'Database is up to date');
    return pool.end();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
