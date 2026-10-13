// Evolutionary tuner for BotParams. Runs BotGame.ts games in parallel child
// processes (CPU only, no LLM). Resumable: results append to a JSONL file and
// already-played (params, seed) games are reused.
//
// Usage (from tools/OpenFrontIO):
//   node tests/bot/Tune.mjs --name imp1 --difficulty Impossible --gens 10 \
//     --pop 12 --seeds 4 --maxMin 45 --jobs 14
//     [--extra "--roulette --bot us --autoplay"]  extra BotGame flags (online FFA lobby mode)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const NAME = arg("name", "tune");
const DIFF = arg("difficulty", "Impossible");
const GENS = +arg("gens", "10");
const POP = +arg("pop", "12");
const SEEDS = +arg("seeds", "4");
const MAXMIN = +arg("maxMin", "45");
const JOBS = +arg("jobs", String(Math.max(1, os.cpus().length - 2)));
const EXTRA = arg("extra", "").split(" ").filter(Boolean);
const OUT = path.resolve("..", "bot_runs", `tune_${NAME}.jsonl`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const RANGES = {
  trigger: [0.3, 0.95],
  reserve: [0.05, 0.6],
  expand: [0.0, 0.45],
  rate: [5, 60],
  wDist: [0, 2],
  wLand: [0, 2],
  wTribe: [0, 2],
  distCap: [100, 600],
  defK: [0, 1.5],
  defMin: [0, 0.4],
  allyRange: [80, 500],
  defCap: [0.3, 0.9],
  cExtra: [0, 1.5],
  counterMax: [0.3, 0.9],
  cFloor: [0.1, 0.6],
  cPart: [0, 1.5],
  dumpAt: [0.6, 1],
  dumpKeep: [0.2, 0.7],
  dumpRel: [0.3, 4],
};
// Fixed (not tuned) params passed to every game, e.g. --fixed '{"ally":1,"betray":0}'
const FIXED = JSON.parse(arg("fixed", "{}"));
const BASE = { trigger: 0.55, reserve: 0.35, expand: 0.15, rate: 40, wDist: 2, wLand: 1, wTribe: 0.5,
  distCap: 400, defK: 0.75, defMin: 0.15, allyRange: 250, defCap: 0.6, cExtra: 0.5, counterMax: 0.6, cFloor: 0,
  cPart: 0.75, dumpAt: 0.9, dumpKeep: 0.5, dumpRel: 2 };
// --base file.json: start from a saved best set (only tuned keys are taken).
if (arg("base", "")) {
  const b = JSON.parse(fs.readFileSync(arg("base", ""), "utf8"));
  for (const k of Object.keys(RANGES)) if (b[k] !== undefined) BASE[k] = b[k];
}

let rngState = 12345 + GENS;
const rand = () => ((rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const clip = (k, v) => Math.min(RANGES[k][1], Math.max(RANGES[k][0], v));
const round = (p) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === "rate" || k === "distCap" || k === "allyRange" ? Math.round(v) : +v.toFixed(3)]));
const key = (p) => JSON.stringify({ ...round(p), ...FIXED });
const randomParams = () =>
  round(Object.fromEntries(Object.keys(RANGES).map((k) => [k, RANGES[k][0] + rand() * (RANGES[k][1] - RANGES[k][0])])));
const mutate = (p, s) =>
  round(Object.fromEntries(Object.keys(RANGES).map((k) => [k, clip(k, p[k] + gauss() * s * (RANGES[k][1] - RANGES[k][0]))])));

// Cache of finished games: key|seed -> result
const cache = new Map();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      cache.set(`${JSON.stringify({ ...r.tuned, ...(r.fixed ?? {}) })}|${r.seed}`, r);
    } catch {}
  }
}

function play(p, seed) {
  const k = `${key(p)}|${seed}`;
  if (cache.has(k)) return Promise.resolve(cache.get(k));
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/bot/BotGame.ts", "--seed", seed, "--difficulty", DIFF,
        "--maxMin", String(MAXMIN), "--params", JSON.stringify({ ...p, ...FIXED }), "--fast",
        "--earlyMin", arg("earlyMin", "0"), "--earlyShare", arg("earlyShare", "0.01"), ...EXTRA],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        r = { seed, outcome: "error", finalShare: 0, maxShare: 0, checkpoints: {} };
      }
      r.tuned = round(p);
      r.fixed = FIXED;
      fs.appendFileSync(OUT, JSON.stringify(r) + "\n");
      cache.set(k, r);
      resolve(r);
    });
  });
}

async function pool(tasks) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

// Fitness: wins dominate, then how much land we hold and how early.
function gameScore(r) {
  if (r.outcome === "win") return 3 + Math.max(0, (MAXMIN - r.minutes) / MAXMIN);
  const s10 = r.checkpoints?.["10m"]?.share ?? r.finalShare;
  const dead = r.outcome === "dead" ? 0.5 : 0;
  return 2 * r.finalShare + r.maxShare + s10 - dead;
}

const seedsFor = (gen) => Array.from({ length: SEEDS }, (_, i) => `t${gen}_${i}`);

let pop = [round(BASE)];
while (pop.length < POP) pop.push(pop.length < POP / 2 ? mutate(BASE, 0.15) : randomParams());

for (let gen = 0; gen < GENS; gen++) {
  // Fresh seeds per generation (avoid overfitting to maps/spawns), shared by all candidates.
  const seeds = seedsFor(gen);
  const tasks = pop.flatMap((p) => seeds.map((s) => () => play(p, s)));
  const t0 = Date.now();
  const res = await pool(tasks);
  const scored = pop.map((p, i) => {
    const rs = res.slice(i * SEEDS, (i + 1) * SEEDS);
    return {
      p,
      fit: rs.reduce((a, r) => a + gameScore(r), 0) / SEEDS,
      wins: rs.filter((r) => r.outcome === "win").length,
      deaths: rs.filter((r) => r.outcome === "dead").length,
      share: +(rs.reduce((a, r) => a + r.finalShare, 0) / SEEDS).toFixed(3),
    };
  });
  scored.sort((a, b) => b.fit - a.fit);
  const summary = {
    gen,
    minutes: +((Date.now() - t0) / 60000).toFixed(1),
    best: scored[0],
    top: scored.slice(0, 4).map((s) => ({ fit: +s.fit.toFixed(3), wins: s.wins, deaths: s.deaths, share: s.share })),
  };
  console.log(JSON.stringify(summary));
  fs.appendFileSync(path.resolve("..", "bot_runs", `tune_${NAME}_gens.jsonl`), JSON.stringify(summary) + "\n");
  const elite = scored.slice(0, Math.max(2, Math.floor(POP / 3))).map((s) => s.p);
  const sigma = Math.max(0.04, 0.15 * (1 - gen / GENS));
  pop = [...elite];
  while (pop.length < POP) pop.push(mutate(elite[pop.length % elite.length], sigma));
}
