// Starts the fake Binance and a server against it, prints the server's process id and its
// directory, then exits at once without any cleanup: the harness must still take the server down
// with it, and the test removes the directory once it has (see harness.e2e.ts).
import { FakeBinance } from './fakeBinance.ts';
import { ServerProcess, tempDir } from './harness.ts';

const fake = new FakeBinance();
await fake.start();
const tmp = tempDir();
const server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath });
console.log(`PID ${server.child.pid}`);
console.log(`DIR ${tmp.dir}`);
process.exit(0);
