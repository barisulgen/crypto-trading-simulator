// The stats worker's entry point. A worker thread does not inherit the TypeScript loader its parent
// runs under (tsx, from `npm start`, `npm run dev` or `node --import tsx/esm`), so it registers
// tsx itself before loading the worker's code.
import { register } from 'tsx/esm/api';

register();
await import('./statsWorker.ts');
