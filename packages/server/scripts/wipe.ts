// Deletes the SQLite database (and its -wal/-shm files) after the owner types WIPE.
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.ts';

const dbPath = loadConfig().dbPath;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Type WIPE to delete ${dbPath}: `);
rl.close();

if (answer === 'WIPE') {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  console.log(`Deleted ${dbPath}`);
} else {
  console.log('Aborted');
}
