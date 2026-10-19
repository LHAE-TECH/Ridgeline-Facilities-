import { startWorker } from './worker.js';

console.log('Ridgeline background worker started');
startWorker(Number(process.env.WORKER_INTERVAL_MS ?? 60000));
