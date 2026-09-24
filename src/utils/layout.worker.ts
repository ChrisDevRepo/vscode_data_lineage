import { expose } from 'comlink';
import { runDagre } from '../engine/graphBuilder';

const api = { runDagre };

/** Layout worker surface: Dagre off the UI thread, results seeded into the main-thread cache. */
export type LayoutWorkerApi = typeof api;

expose(api);
