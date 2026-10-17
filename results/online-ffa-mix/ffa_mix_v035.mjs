// Online regular-FFA lobby mix, rules of OpenFront v0.35.0 (src/server/MapPlaylist.ts),
// 30+ player lobbies only. Adapted from results/online-ffa-mix/ffa_mix.mjs (v0.34.24).
//
// Reads everything from the git repo with `git show <ref>:<path>`, so the working
// tree (which has local mods) is never touched.
//
// Usage:
//   node ffa_mix_v035.mjs [--repo DIR] [--ref REF] [--cap N|none] [--txt FILE] [--cells FILE]
// Defaults: --repo ../../tools/OpenFrontIO  --ref v0.35.0  --cap none
//           --txt ffa_mix_v035.txt  --cells ffa_cells_v035.json  (written next to this script)
// Reproduce the old model with: --ref v0.34.24 --cap 125 (must match online-ffa-mix/ffa_cells.json).
//
// Rules modelled (line numbers at v0.35.0 unless noted):
//   map pool     MapPlaylist.ts:738-742  freq = ffaFrequency >= 0 ? ffaFrequency : multiplayerFrequency; 0 = out
//   map choice   playlist of freq-proportional copies, shuffled, no map twice in 5 (MapPlaylist.ts:673-724)
//                -> P(map) = freq / sum(freq) (the "ffa" queue; the API weight overrides are NOT modelled)
//   compact      MapPlaylist.ts:178-179  playlists[ffa].length % 3 === 0 -> ~1/3 of lobbies, independent of map
//   trusted      MapPlaylist.ts:37,155-156  every 7th scheduled game (global counter) -> ~1/7 of ffa lobbies
//   base size    calculateMapPlayerCounts MapPlaylist.ts:1013-1020: l = max(round5(land/1e6*50),5), m = round5(0.75 l), s = round5(0.5 l)
//                lobbyMaxPlayers MapPlaylist.ts:944-959: base = l (30%), m (30%), s (40%); p = min(base, l)
//   compact cut  MapPlaylist.ts:955-957  p = max(3, floor(p * 0.25))
//   cap          v0.34.24 only: MAX_PLAYER_COUNT = 125 applied after compact. v0.35.0 has none (--cap none).
//   trusted cap  MapPlaylist.ts:41,189-194  p = min(p, 25)
//   land tiles   resources/maps/<enum key lowercased>/manifest.json -> map.num_land_tiles (MapFiles.ts mapDirName)
//   frequencies  Maps.gen.ts  (packages/engine-api/src/game/Maps.gen.ts at v0.35.0; src/core/game/Maps.gen.ts at v0.34.24)
//
// Output weights: each cell = P(map) * P(compact) * P(trusted) * P(base) (conditional on regular ffa), then
// renormalised over the 30+ lobbies, exactly as ffa_mix.mjs does.

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith("--")) throw new Error(`bad arg ${k}`);
    o[k.slice(2)] = argv[i + 1];
  }
  return o;
}

const opt = parseArgs(process.argv.slice(2));
const REPO = path.resolve(opt.repo ?? path.join(here, "../../tools/OpenFrontIO"));
const REF = opt.ref ?? "v0.35.0";
const CAP = opt.cap === undefined || opt.cap === "none" ? Infinity : Number(opt.cap);
const TXT = path.resolve(opt.txt ?? path.join(here, "ffa_mix_v035.txt"));
const CELLS = path.resolve(opt.cells ?? path.join(here, "ffa_cells_v035.json"));

const MIN_PLAYERS = 30;
const P_COMPACT = 1 / 3;
const P_TRUSTED = 1 / 7;
const TRUSTED_CAP = 25;
const BASES = [["l", 0.3], ["m", 0.3], ["s", 0.4]];

const gitShow = (p, quiet = false) =>
  execFileSync("git", ["-C", REPO, "show", `${REF}:${p}`], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  });

// Maps.gen.ts moved with the monorepo split; try both layouts.
function mapsGenPath() {
  for (const p of ["packages/engine-api/src/game/Maps.gen.ts", "src/core/game/Maps.gen.ts"]) {
    try {
      gitShow(p, true);
      return p;
    } catch {}
  }
  throw new Error(`no Maps.gen.ts at ${REF}`);
}

const genPath = mapsGenPath();
const src = gitShow(genPath);
const body = src.slice(src.indexOf("export const maps"));
// Every map object in the array: "  {\n    id: \"X\", ... \n  },"
const blocks = [...body.matchAll(/\n  \{\n    id: "(\w+)",([\s\S]*?)\n  \},?(?=\n)/g)];
const idCount = (body.match(/\n    id: "/g) || []).length;
if (blocks.length !== idCount) {
  throw new Error(`parsed ${blocks.length} of ${idCount} map entries in ${genPath}`);
}

const num = (block, field) => {
  const m = block.match(new RegExp(`\\b${field}: (-?\\d+)`));
  return m ? Number(m[1]) : undefined;
};

const r5 = (n) => Math.round(n / 5) * 5;
const landCache = new Map();
function landTiles(key) {
  if (landCache.has(key)) return landCache.get(key);
  const dir = key.toLowerCase();
  const man = JSON.parse(gitShow(`resources/maps/${dir}/manifest.json`));
  const v = man.map.num_land_tiles;
  landCache.set(key, v);
  return v;
}

const all = [];
for (const [, id, block] of blocks) {
  const typeKey = block.match(/type: GameMapType\.(\w+)/);
  const key = typeKey ? typeKey[1] : id;
  if (key !== id) throw new Error(`enum key ${key} != id ${id}`);
  const mp = num(block, "multiplayerFrequency");
  const ffa = num(block, "ffaFrequency");
  const nat = num(block, "defaultNationCount");
  const w = ffa !== undefined && ffa >= 0 ? ffa : mp; // MapPlaylist.ts:738-742
  all.push({ id, w, nat, mp, ffa });
}

const maps = [];
for (const x of all) {
  if (!(x.w > 0)) continue;
  const land = landTiles(x.id);
  const l = Math.max(r5((land / 1e6) * 50), 5);
  const m = r5(l * 0.75);
  const s = r5(l * 0.5);
  maps.push({ ...x, land, l, m, s });
}
const W = maps.reduce((a, x) => a + x.w, 0);

let tot30 = 0;
const rows = [];
const cellList = [];
for (const x of maps) {
  const cells = {};
  let p30 = 0;
  for (const [compact, pc] of [
    [true, P_COMPACT],
    [false, 1 - P_COMPACT],
  ])
    for (const [trusted, pt] of [
      [true, P_TRUSTED],
      [false, 1 - P_TRUSTED],
    ])
      for (const [b, pb] of BASES.map(([k, p]) => [x[k], p])) {
        let p = Math.min(b, x.l);
        if (compact) p = Math.max(3, Math.floor(p * 0.25));
        p = Math.min(p, CAP);
        if (trusted) p = Math.min(p, TRUSTED_CAP);
        const pr = pc * pt * pb;
        if (p >= MIN_PLAYERS) {
          p30 += pr;
          const k = `${compact ? "c" : "n"}${p}`;
          cellList.push({ map: x.id, players: p, compact, w: (x.w / W) * pr });
          cells[k] = (cells[k] || 0) + pr;
        }
      }
  const share = (x.w / W) * p30;
  tot30 += share;
  rows.push({ ...x, p30, share, cells });
}

rows.sort((a, b) => b.share - a.share);
const capLabel = CAP === Infinity ? "none" : CAP;
const out = [
  `ref=${REF} genfile=${genPath} cap=${capLabel} maps=${maps.length} sumW=${W}  30+ share of all regular FFA lobbies = ${(tot30 * 100).toFixed(1)}%`,
  "map | %of30+ | P(30+|map) | nations | land | l/m/s | cells(c=compact,n=normal: P within map)",
];
for (const r of rows) {
  if (r.share <= 0) continue;
  const c = Object.entries(r.cells)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
    .join(" ");
  out.push(
    `${r.id} | ${((r.share / tot30) * 100).toFixed(2)} | ${(r.p30 * 100).toFixed(0)}% | ${r.nat} | ${r.land} | ${r.l}/${r.m}/${r.s} | ${c}`,
  );
}
out.push(
  "no-30+ maps: " +
    rows
      .filter((r) => r.share <= 0)
      .map((r) => r.id)
      .join(", "),
);
fs.writeFileSync(TXT, out.join("\n"));

// Merge identical (map, players, compact) cells; weights = share of all 30+ regular FFA lobbies.
const merged = {};
for (const c of cellList) {
  const k = `${c.map}|${c.players}|${c.compact}`;
  merged[k] = merged[k] ? { ...merged[k], w: merged[k].w + c.w } : { ...c };
}
const cellsOut = Object.values(merged)
  .map((c) => ({ ...c, w: +(c.w / tot30).toFixed(6) }))
  .sort((a, b) => b.w - a.w);
// Rounding to 6 decimals leaves a residual of ~1e-5; give it to the largest cell so the weights sum to 1.
const resid = +(1 - cellsOut.reduce((a, c) => a + c.w, 0)).toFixed(6);
cellsOut[0].w = +(cellsOut[0].w + resid).toFixed(6);
fs.writeFileSync(CELLS, JSON.stringify(cellsOut));

// Machine-readable per-map table for the report (not part of the cells format).
const perMap = rows.map((r) => ({
  map: r.id,
  w: r.w,
  land: r.land,
  l: r.l,
  m: r.m,
  s: r.s,
  nations: r.nat,
  p30: +r.p30.toFixed(6),
  share30: +((r.share / tot30) * 100).toFixed(4),
}));
const sidecar = CELLS.replace(/\.json$/, ".permap.json");
fs.writeFileSync(sidecar, JSON.stringify(perMap, null, 1));

console.log(out.join("\n"));
console.log(`cells -> ${CELLS} (${cellsOut.length} rows, sum w = ${cellsOut.reduce((a, c) => a + c.w, 0).toFixed(6)})`);
