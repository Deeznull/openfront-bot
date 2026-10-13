/** Shadow bundle entry: in a worker, serve the shadow; on a page, export it. */
import { createShadow, runInWorker } from "./shadow";

const g = globalThis as any;
if (typeof g.WorkerGlobalScope !== "undefined" && g instanceof g.WorkerGlobalScope) {
  runInWorker(g);
} else {
  g.__ofbotCreateShadow = createShadow;
}
