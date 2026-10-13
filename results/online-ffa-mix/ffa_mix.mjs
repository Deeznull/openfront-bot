// Online regular-FFA lobby mix (v0.34.24 MapPlaylist.rollConfig "ffa"), 30+ player cap only.
// Run from tools/OpenFrontIO-v0.34.24.
import fs from "fs";
const src = fs.readFileSync("src/core/game/Maps.gen.ts", "utf8");
const re = /id: "(\w+)",[\s\S]*?multiplayerFrequency: (-?\d+),\s*ffaFrequency: (-?\d+),[\s\S]*?defaultNationCount: (\d+)/g;
const r5 = (n) => Math.round(n / 5) * 5;
const maps = [];
let m;
while ((m = re.exec(src))) {
  const [, id, mp, ffa, nat] = m;
  const w = +ffa >= 0 ? +ffa : +mp;
  if (w <= 0) continue;
  const man = JSON.parse(fs.readFileSync(`resources/maps/${id.toLowerCase()}/manifest.json`, "utf8"));
  const land = man.map.num_land_tiles;
  const l = Math.max(r5((land / 1e6) * 50), 5), mm = r5(l * 0.75), s = r5(l * 0.5);
  maps.push({ id, w, nat: +nat, land, l, m: mm, s });
}
const W = maps.reduce((a, x) => a + x.w, 0);
let tot30 = 0;
const rows = [];
const cellList = [];
for (const x of maps) {
  const cells = {};
  let p30 = 0;
  for (const [compact, pc] of [[true, 1 / 3], [false, 2 / 3]])
    for (const [trusted, pt] of [[true, 1 / 7], [false, 6 / 7]])
      for (const [b, pb] of [[x.l, 0.3], [x.m, 0.3], [x.s, 0.4]]) {
        let p = Math.min(b, x.l);
        if (compact) p = Math.max(3, Math.floor(p * 0.25));
        p = Math.min(p, 125);
        if (trusted) p = Math.min(p, 25);
        const pr = pc * pt * pb;
        if (p >= 30) {
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
const out = [`maps=${maps.length} sumW=${W}  30+ share of all regular FFA lobbies = ${(tot30 * 100).toFixed(1)}%`,
  "map | %of30+ | P(30+|map) | nations | land | l/m/s | cells(c=compact,n=normal: P within map)"];
for (const r of rows) {
  if (r.share <= 0) continue;
  const c = Object.entries(r.cells).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`).join(" ");
  out.push(`${r.id} | ${((r.share / tot30) * 100).toFixed(2)} | ${(r.p30 * 100).toFixed(0)}% | ${r.nat} | ${r.land} | ${r.l}/${r.m}/${r.s} | ${c}`);
}
out.push("no-30+ maps: " + rows.filter((r) => r.share <= 0).map((r) => r.id).join(", "));
const o = out.join("\n");
fs.writeFileSync(process.argv[2] || "ffa_mix.txt", o);
// Merge identical (map, players, compact) cells; weights = share of all 30+ regular FFA lobbies.
const merged = {};
for (const c of cellList) {
  const k = `${c.map}|${c.players}|${c.compact}`;
  merged[k] = merged[k] ? { ...merged[k], w: merged[k].w + c.w } : { ...c };
}
const cellsOut = Object.values(merged).map((c) => ({ ...c, w: +(c.w / tot30).toFixed(6) })).sort((a, b) => b.w - a.w);
fs.writeFileSync(process.argv[3] || "ffa_cells.json", JSON.stringify(cellsOut));
console.log(o);
