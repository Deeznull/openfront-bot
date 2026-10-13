// Paired comparison of sets already stored in an eval_*.jsonl file (no games played).
// Usage: node tests/bot/Paired.mjs ../bot_runs/eval_pvp2.jsonl [--metric phaseFit] [--control 0]
// Sets are ordered by first appearance; set 0 is the control unless --control i.
import fs from "node:fs";
import { METRICS, pairedStats } from "./stats.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const file = process.argv[2];
const metric = METRICS[arg("metric", "phaseFit")];
const CONTROL = +arg("control", "0");
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const keys = [];
const by = new Map();
for (const r of rows) {
  const k = JSON.stringify(r.set ?? {});
  if (!by.has(k)) { by.set(k, new Map()); keys.push(k); }
  by.get(k).set(r.seed, metric(r));
}
const c = by.get(keys[CONTROL]);
keys.forEach((k, si) => {
  const t = by.get(k);
  const mean = [...t.values()].reduce((a, x) => a + x, 0) / t.size;
  const d = [...t.keys()].filter((s) => c.has(s)).map((s) => t.get(s) - c.get(s));
  const cs = JSON.parse(keys[CONTROL]);
  const ts = JSON.parse(k);
  const delta = Object.fromEntries(Object.keys({ ...cs, ...ts }).filter((x) => JSON.stringify(cs[x]) !== JSON.stringify(ts[x])).map((x) => [x, ts[x]]));
  console.log(si, JSON.stringify(delta), "n", t.size, "mean", mean.toFixed(3),
    si === CONTROL ? "CONTROL" : JSON.stringify(pairedStats(d)));
});
