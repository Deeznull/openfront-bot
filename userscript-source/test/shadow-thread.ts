// The shadow in its own worker thread (headless test), like the browser's
// blob worker. Engines with module-level caches (v0.34's TerrainMapLoader
// keeps one mutable map per process) would otherwise share state with the
// test's "real" game. `init` carries `nodeRepo` and the map is loaded here;
// every message is answered with {t:"done"} so the test can run in lockstep.
import { parentPort } from "node:worker_threads";
import { nodeMapSource } from "ofengine-node";
import { createShadow } from "../src/shadow";

const port = parentPort!;
const handle = createShadow((m) => port.postMessage(m));
let chain = Promise.resolve();
port.on("message", (m: any) => {
  chain = chain.then(async () => {
    if (m.t === "init" && m.nodeRepo) {
      const cfg = m.gameStartInfo.config;
      m = { ...m, mapSource: await nodeMapSource(m.nodeRepo, cfg.gameMap, cfg.gameMapSize) };
    }
    handle(m);
    port.postMessage({ t: "done" });
  });
});
