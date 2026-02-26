import { parentPort } from 'node:worker_threads';
import { config } from '../core/config.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { MlService } from './ml-service.js';

const db = new StateDb(config.db.path);
const logger = new Logger('ml-worker');
const mlService = new MlService(db, logger, config);

const shutdown = () => {
  db.close();
};

process.on('beforeExit', shutdown);
process.on('SIGTERM', shutdown);

parentPort?.on('message', async (message: { type?: string; id?: number; paperWindow?: Record<string, unknown> }) => {
  if (!message || message.type !== 'retrain' || typeof message.id !== 'number') return;
  try {
    const result = await mlService.retrain(message.paperWindow as any);
    parentPort?.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({ id: message.id, ok: false, error: String(error) });
  }
});
