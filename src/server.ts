import { createApp } from './app.js';
import { config, integrationStatus } from './config.js';
import { pool } from './db.js';
import { markProductionDatabase } from './demo.js';
import { refreshAllSiteAreas } from './services/sla.js';
import { startWorker } from './worker.js';

if (config.isProduction) {
  markProductionDatabase(pool, config.deploymentEnvironment).catch((err) => console.error('Could not mark database as production', err));
}
// Site SLA areas are cached on each site; re-resolve them against the current sla_areas setting at start-up.
refreshAllSiteAreas(pool).catch((err) => console.error('Could not refresh site SLA areas', err));
const app = createApp();
app.listen(config.port, () => {
  console.log(`Ridgeline Facilities listening on port ${config.port} (${config.env})`);
  for (const [name, s] of Object.entries(integrationStatus())) console.log(`  ${name.padEnd(18)} ${s.mode.padEnd(13)} ${s.detail}`);
  if (config.runWorkerInProcess) {
    startWorker(Number(process.env.WORKER_INTERVAL_MS ?? 60000));
    console.log('  background worker running in-process');
  }
});
