// Evaluate one or more param sets on N seeds in parallel; prints a summary per set.
// Usage: node tests/bot/Eval.mjs --difficulty Impossible --seeds 12 --maxMin 30 \
//          --sets '[{"distCap":400},{"distCap":400,"defK":0.75,"defMin":0.15}]' [--tag x]
//        [--extra "--roulette --bot us --autoplay"]   (extra BotGame flags, space-separated)
// Seeds are shared by every set (common random numbers: paired comparison).
// fit = win + finalShare + 0.2*survived  (shaped score; win dominates).
// Phase tests (short games, same real lobbies): --maxMin 12 = early game,
// --maxMin 30 = mid game. Then compare phaseFit = alive * (finalShare*10 +
// (1 - rankPct)), rankPct = finalRank / majors in the lobby (0 = top).
// --hopeless: stop hopeless games (BotGame strict rule; they count as losses).
// --audit K (default 4): with --hopeless, every K-th seed still plays uncut; the
// summary's badCuts = wins the rule would have cut (must stay 0, else loosen it).
//
// Method v2 (2026-10-12):
// - Paired stats: every set after the first (the control, --control i) gets the
//   per-seed difference of --metric (default phaseFit) vs the control: mean, 95%
//   bootstrap CI, sign test (W/L/T and two-sided p). Adopt a change only when the
//   CI is above 0 (or p < 0.05), never on the raw mean alone.
// - Racing: --batch B plays seeds in batches of B (default: all at once); after each
//   batch, sets whose CI upper bound is < 0 vs the control are dropped (clearly
//   worse), and the run stops early when every remaining set is decided.
// - Cache: every game is stored in ../bot_runs/games_cache.jsonl keyed by
//   (params, seed, difficulty, maxMin, flags, cut, hash of the bot code). A re-run
//   (control re-used across evals, interrupted run) plays only the missing games.
//   --noCache disables it. Code edits change the hash, so stale games never mix in.
// - Branching: --branchAt M plays each seed once with the branch set (--branchSet
//   JSON, default the control set) to minute M and snapshots it
//   (~/openfront_snaps, gzipped); every set then resumes from that shared state with fresh
//   bot/stand-in executions (BotGame --fromSnap). Removes the early-game noise
//   from mid/late-game tests and skips re-simulating minutes 0..M. Seeds where
//   the bot is dead/cut before M are skipped (no branch to compare).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { METRICS, majors, pairedStats } from "./stats.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DIFF = arg("difficulty", "Impossible");
// --seedList "516,519,...": explicit seed indices (with --seedPrefix) instead of a range.
const SEED_LIST = arg("seedList", "").split(",").filter(Boolean).map(Number);
const SEEDS = SEED_LIST.length || +arg("seeds", "12");
const MAXMIN = arg("maxMin", "30");
const JOBS = +arg("jobs", String(Math.max(1, os.cpus().length - 2)));
const SETS = JSON.parse(arg("sets", "[{}]"));
const TAG = arg("tag", "eval");
const SEED_PREFIX = arg("seedPrefix", "e");
const SEED_START = +arg("seedStart", "0");
const EARLY = ["--earlyMin", arg("earlyMin", "0"), "--earlyShare", arg("earlyShare", "0.01")];
const EXTRA = arg("extra", "").split(" ").filter(Boolean);
const HOPELESS = process.argv.includes("--hopeless");
const AUDIT = +arg("audit", "4");
const CONTROL = +arg("control", "0");
const METRIC = arg("metric", "phaseFit");
const BATCH = +arg("batch", String(SEEDS));
const USE_CACHE = !process.argv.includes("--noCache");
const BRANCH = +arg("branchAt", "0");
const BRANCH_SET = JSON.parse(arg("branchSet", "null")) ?? SETS[CONTROL];
const OUT = path.resolve("..", "bot_runs", `eval_${TAG}.jsonl`);
// Snapshots are a regenerable cache (~2 MB each, gzipped): kept outside the project folder.
const SNAPS = arg("snapDir", path.join(os.homedir(), "openfront_snaps"));
const CACHE = path.resolve("..", "bot_runs", "games_cache.jsonl");

// Hash of the code that decides a game's outcome for the bot/stand-ins.
const CODE_FILES = [
  "packages/engine/src/execution/bot/BotExecution.ts",
  "tests/bot/BotGame.ts",
  "tests/bot/StandIn.ts", "engine-v0.35.0",
];
const CODE = crypto.createHash("sha1")
  .update(CODE_FILES.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : f)).join("\0"))
  .digest("hex").slice(0, 12);

const cache = new Map();
if (USE_CACHE && fs.existsSync(CACHE)) {
  for (const l of fs.readFileSync(CACHE, "utf8").split("\n")) {
    if (!l) continue;
    try { const o = JSON.parse(l); cache.set(o.k, o.r); } catch { /* torn line */ }
  }
}

const sorted = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));
const metric = METRICS[METRIC];
if (!metric) throw new Error(`unknown --metric ${METRIC}; one of ${Object.keys(METRICS)}`);

function runGame(p, seed, more) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/bot/BotGame.ts", "--seed", seed, "--difficulty", DIFF,
        "--maxMin", MAXMIN, "--params", JSON.stringify(p), "--fast", ...EARLY, ...EXTRA, ...more],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ seed, outcome: "error", finalShare: 0, maxShare: 0 }); }
    });
  });
}

const NL = String.fromCharCode(10);
const cutFor = (i) => (HOPELESS && !(AUDIT > 0 && i % AUDIT === 0) ? ["--hopeless"] : []);

async function play(p, seed, i, more = []) {
  const cut = cutFor(i);
  const key = [CODE, sorted(p), seed, DIFF, MAXMIN, EARLY.join(" "), EXTRA.join(" "), cut.join(""),
    ...more.map((x) => path.basename(String(x)))].join("|");
  if (USE_CACHE && cache.has(key)) {
    const r = { ...cache.get(key), set: p, cached: true };
    fs.appendFileSync(OUT, JSON.stringify(r) + NL);
    return r;
  }
  const r = await runGame(p, seed, [...cut, ...more]);
  if (USE_CACHE && r.outcome !== "error") {
    cache.set(key, r);
    fs.appendFileSync(CACHE, JSON.stringify({ k: key, r }) + NL);
  }
  r.set = p;
  fs.appendFileSync(OUT, JSON.stringify(r) + NL);
  return r;
}

// Branch snapshots: one per (code, branch set, flags, seed, minute). null = no branch
// (the bot died or was cut before M).
const snapOf = new Map();
async function ensureSnap(i) {
  const seed = `${SEED_PREFIX}${i}`;
  const h = crypto.createHash("sha1").update([CODE, sorted(BRANCH_SET), DIFF, EARLY.join(" "),
    EXTRA.join(" "), cutFor(i).join("")].join("|")).digest("hex").slice(0, 10);
  const f = path.join(SNAPS, `${h}_${seed}_${BRANCH}.snap`);
  const none = f + ".none";
  if (fs.existsSync(f)) return snapOf.set(i, f);
  if (fs.existsSync(none)) return snapOf.set(i, null);
  fs.mkdirSync(SNAPS, { recursive: true });
  const r = await runGame(BRANCH_SET, seed, [...cutFor(i), "--snapAt", String(BRANCH), "--snapOut", f]);
  if (r.outcome === "snap" && fs.existsSync(f)) snapOf.set(i, f);
  else {
    fs.writeFileSync(none, JSON.stringify(r));
    snapOf.set(i, null);
  }
}

const results = []; // { si, i, r }
let alive = SETS.map((_, si) => si);
const verdict = SETS.map(() => "open");

async function pool(n, jobs) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(JOBS, n) }, async () => {
    while (next < n) await jobs(next++);
  }));
}

async function runBatch(seedIdx) {
  if (BRANCH > 0) {
    await pool(seedIdx.length, (k) => ensureSnap(seedIdx[k]));
    const skipped = seedIdx.filter((i) => !snapOf.get(i));
    if (skipped.length) console.error(`[branch] no branch (dead/cut before ${BRANCH}m): seeds ${skipped.join(",")}`);
    seedIdx = seedIdx.filter((i) => snapOf.get(i));
  }
  const more = (i) => (BRANCH > 0 ? ["--fromSnap", snapOf.get(i)] : []);
  const tasks = alive.flatMap((si) => seedIdx.map((i) => ({ si, i })));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(JOBS, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      results.push({ si: t.si, i: t.i, r: await play(SETS[t.si], `${SEED_PREFIX}${t.i}`, t.i, more(t.i)) });
    }
  }));
}

function diffs(si) {
  const by = (s) => new Map(results.filter((x) => x.si === s).map((x) => [x.i, metric(x.r)]));
  const c = by(CONTROL);
  const t = by(si);
  return [...t.keys()].filter((i) => c.has(i)).sort((a, b) => a - b).map((i) => t.get(i) - c.get(i));
}

const ALL_IDX = SEED_LIST.length ? SEED_LIST : Array.from({ length: SEEDS }, (_, k) => SEED_START + k);
for (let b = 0; b < ALL_IDX.length; b += BATCH) {
  const idx = ALL_IDX.slice(b, b + BATCH);
  await runBatch(idx);
  if (SETS.length < 2 || BATCH >= SEEDS) continue;
  for (const si of alive) {
    if (si === CONTROL) continue;
    const s = pairedStats(diffs(si));
    if (s && s.n >= 12 && s.hi < 0) verdict[si] = "dropped";
    else if (s && s.n >= 12 && s.lo > 0) verdict[si] = "better";
  }
  alive = alive.filter((si) => verdict[si] !== "dropped");
  console.error(`[race] seeds ${ALL_IDX[0]}..${idx[idx.length - 1]}: ` +
    SETS.map((_, si) => `${si}:${verdict[si]}`).join(" "));
  if (alive.every((si) => si === CONTROL || verdict[si] !== "open")) break;
}

SETS.forEach((p, si) => {
  const rs = results.filter((x) => x.si === si).map((x) => x.r);
  const n = rs.length;
  if (n === 0) return;
  const cnt = (o) => rs.filter((r) => r.outcome === o).length;
  const avg = (f) => +(rs.reduce((a, r) => a + (f(r) ?? 0), 0) / n).toFixed(3);
  const s = si === CONTROL ? null : pairedStats(diffs(si));
  console.log(JSON.stringify({
    set: p, n, win: cnt("win"), dead: cnt("dead"), timeout: cnt("timeout"), lost: cnt("lost"),
    avgDeathMin: +(rs.filter((r) => r.deathMin != null).reduce((a, r) => a + r.deathMin, 0) / Math.max(1, cnt("dead"))).toFixed(1),
    share10: avg(METRICS.share10), finalShare: avg((r) => r.finalShare), maxShare: avg((r) => r.maxShare),
    avgRank: avg((r) => r.finalRank),
    rankPct: avg((r) => r.finalRank / majors(r)),
    phaseFit: avg(METRICS.phaseFit),
    badCuts: rs.filter((r) => r.outcome === "win" && r.hopelessAt != null).length,
    fit: avg(METRICS.fit),
    cached: rs.filter((r) => r.cached).length,
    ...(si === CONTROL ? { control: true } : { vsControl: { metric: METRIC, ...s,
      verdict: verdict[si] !== "open" ? verdict[si] : s && s.lo > 0 ? "better" : s && s.hi < 0 ? "worse" : "open" } }),
  }));
});
