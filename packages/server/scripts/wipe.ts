// Deletes the SQLite database (and its -wal/-shm files) after the owner types WIPE.
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.ts';

const dbPath = loadConfig().dbPath;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Type WIPE to delete ${dbPath}: `);
rl.close();

if (answer === 'WIPE') {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  if (!files.some((f) => existsSync(f))) {
    console.log('Nothing to delete');
  } else {
    try {
      for (const f of files) rmSync(f, { force: true });
      console.log(`Deleted ${dbPath}`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw e;
      console.error('Database is in use — stop the server first');
      process.exit(1);
    }
  }
} else {
  console.log('Aborted');
}
