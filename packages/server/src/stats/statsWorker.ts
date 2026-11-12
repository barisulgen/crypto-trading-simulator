// The stats worker thread: reads the record through its own read-only connection, computes the
// report and sends it back as JSON, one request at a time. Started by WorkerStats through
// statsWorker.mjs.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { statsJson } from './loadStats.ts';
import { decodeStatsRequest } from './statsService.ts';
import type { StatsReply } from './statsService.ts';

const { dbPath } = workerData as { dbPath: string };
// The engine's connection keeps the database in WAL mode, so this one reads beside its writes.
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

parentPort!.on('message', (text: string) => {
  let reply: StatsReply;
  try {
    reply = { json: statsJson(db, decodeStatsRequest(text)) };
  } catch (e) {
    reply = { error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply);
});
