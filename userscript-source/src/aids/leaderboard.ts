/**
 * Live standings: players by land share, team totals in team games, and a
 * feed of eliminations (nations and humans; fallen tribes are left out).
 * Adapted from devdanetra/openfront-pro (MIT, Copyright (c) 2026 devdanetra):
 * casterReduce / casterView in src/observer-core.js and casterFeed in
 * src/page-probe.js. See NOTICE.
 */
import { type Aid, type Box, call, every, gameView, inGame, makeBox } from "./core";

interface Row {
  sid: number;
  name: string;
  team: string | null;
  tiles: number;
  alive: boolean;
  type: string;
  rgb: string | null;
  me: boolean;
}

const LIMIT = 10;
const FEED = 5;
let box: Box | null = null;
let stopTick: (() => void) | null = null;
let gameId = "";
let lastTick = 0;
let was = new Map<number, Row>(); // alive last time
let feed: { at: number; name: string; rgb: string | null }[] = [];

function rows(g: any): Row[] {
  const me = call(g, "myPlayer");
  const out: Row[] = [];
  for (const p of call(g, "playerViews") ?? []) {
    const sid = call(p, "smallID");
    const type = String(call(p, "type") ?? "");
    const alive = call(p, "isAlive") === true;
    const tiles = Number(call(p, "numTilesOwned")) || 0;
    if (type === "BOT" && !(alive && tiles > 0)) continue;
    const c = call(call(p, "territoryColor"), "toRgb");
    out.push({
      sid,
      name: String(call(p, "displayName") ?? call(p, "name") ?? "").slice(0, 32),
      team: call(p, "team") ?? null,
      tiles,
      alive: alive && tiles > 0,
      type,
      rgb: c && Number.isFinite(c.r) ? `rgb(${c.r},${c.g},${c.b})` : null,
      me: !!me && call(me, "smallID") === sid,
    });
  }
  return out.sort((a, b) => b.tiles - a.tiles);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const dot = (rgb: string | null) => `<i style="background:${rgb ?? "#6b7280"}"></i>`;

function tick() {
  const g = gameView();
  if (!box) return;
  if (!g || !inGame()) return box.show(false);
  box.show(true);
  const id = String(call(g, "gameID") ?? "");
  const t = Number(call(g, "ticks")) || 0;
  if (id !== gameId || t < lastTick) {
    gameId = id;
    was = new Map();
    feed = [];
  }
  lastTick = t;
  const secs = Number(call(g, "elapsedGameSeconds")) || t / 10;
  const all = rows(g);
  const land = Math.max(1, Number(call(g, "numLandTiles")) || 1);
  const now = new Map(all.filter((r) => r.alive).map((r) => [r.sid, r]));
  for (const [sid, r] of was) {
    if (!now.has(sid) && r.type !== "BOT") feed.push({ at: secs, name: r.name, rgb: r.rgb });
  }
  feed = feed.slice(-30);
  was = now;

  const alive = all.filter((r) => r.alive);
  const lead = Math.max(1, alive[0]?.tiles ?? 1);
  const list = alive.slice(0, LIMIT);
  const meRow = alive.find((r) => r.me);
  let html = `<div class="sub">${alive.length} alive</div>`;
  const line = (r: Row, place: number) =>
    `<div class="r${r.me ? " me" : ""}"><b>${place}</b>${dot(r.rgb)}<span>${esc(r.name)}</span>` +
    `<em>${((r.tiles / land) * 100).toFixed(1)}%</em><u style="width:${Math.max(2, (r.tiles / lead) * 100)}%"></u></div>`;
  list.forEach((r, i) => (html += line(r, i + 1)));
  if (meRow && !list.includes(meRow)) html += line(meRow, alive.indexOf(meRow) + 1);

  const teams = new Map<string, { share: number; alive: number }>();
  for (const r of alive) {
    if (!r.team || r.team === "Bot") continue;
    const tm = teams.get(r.team) ?? { share: 0, alive: 0 };
    tm.share += r.tiles / land;
    tm.alive++;
    teams.set(r.team, tm);
  }
  if (teams.size > 1) {
    html += `<div class="sub">Teams</div>`;
    for (const [name, tm] of [...teams].sort((a, b) => b[1].share - a[1].share)) {
      html += `<div class="r"><span>${esc(name)} (${tm.alive})</span><em>${(tm.share * 100).toFixed(1)}%</em></div>`;
    }
  }
  if (feed.length) {
    html += `<div class="sub">Eliminated</div>`;
    for (const f of feed.slice(-FEED).reverse()) html += `<div class="r f">${dot(f.rgb)}<span>${esc(f.name)}</span><em>${clock(f.at)}</em></div>`;
  }
  box.body.innerHTML = html;
}

const CSS = `
  .w{width:210px}
  .sub{color:#93c5fd;margin:3px 0 2px;font-size:11px}
  .r{position:relative;display:flex;gap:5px;align-items:center;white-space:nowrap;padding:1px 0}
  .r span{flex:1;overflow:hidden;text-overflow:ellipsis}.r em{font-style:normal;color:#cbd5e1}
  .r b{width:16px;color:#9ca3af;font-weight:400;text-align:right}
  .r i{width:8px;height:8px;border-radius:2px;flex:none}
  .r u{position:absolute;left:0;bottom:0;height:2px;background:#3b82f6;opacity:.6;text-decoration:none}
  .me span{color:#fde047;font-weight:600}.f{color:#9ca3af}
`;

export const leaderboard: Aid = {
  key: "board",
  label: "Live standings + eliminations",
  title: "A box with players by land share, team totals and recent eliminations (drag by its header, – to fold).",
  def: false,
  start() {
    box = makeBox("board", "Standings", 8, 260, CSS);
    stopTick = every(1000, tick);
    tick();
  },
  stop() {
    stopTick?.();
    box?.remove();
    box = stopTick = null;
  },
};
