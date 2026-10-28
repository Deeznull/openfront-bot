/**
 * Rank badges: each human player's ofstats.io skill rank ("Top 12%") next to
 * their name on the hover card and in the in-game leaderboard.
 * Adapted from devdanetra/openfront-pro (MIT, Copyright (c) 2026 devdanetra):
 * matchName / fetchStats / the caching in src/background.js, the scoring in
 * src/scoring.js and the badge placement in src/content.js. See NOTICE.
 *
 * ofstats sends no CORS headers, so the requests go through the userscript
 * loader's GM_xmlhttpRequest bridge (gm.ts), which only fetches
 * https://api.ofstats.io/ and only while this aid is on. Answers are cached
 * (memory + localStorage), requests are spaced out, and every failure just
 * leaves the name without a badge.
 */
import { type Aid, call, every, gameView, inGame } from "./core";
import { gmGet, gmSwitch } from "./gm";

const API = "https://api.ofstats.io";
const SELECTORS: [string, "card" | "board"][] = [
  ["player-info-overlay span.font-mono.inline-block", "card"],
  ["player-stats .stats-table-row .stats-table-cell span.truncate", "board"],
];
const CLS = "ofbot-rk";

// ---- scoring (openfront-pro src/scoring.js) ---------------------------------
// Skill = wins against what an average player would have won in the same
// lobbies (ofstats' per-map expectedWins), shrunk toward parity by SHRINK_K.
const SHRINK_K = 3;
const MIN_RATED_GAMES = 3;
const PERCENTILE_TABLE: [number, number][] = [
  [0.43, 95], [0.54, 90], [0.75, 75], [0.87, 60], [0.97, 50], [1.11, 40], [1.21, 30], [1.28, 25],
  [1.34, 20], [1.43, 15], [1.62, 10], [1.78, 5], [2.05, 3], [2.2, 1.5], [2.6, 1], [3.2, 0.5],
];
function topPercent(ratio: number): number {
  const t = PERCENTILE_TABLE;
  if (ratio <= t[0][0]) return 99;
  if (ratio >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    const [hr, hp] = t[i];
    if (ratio > hr) continue;
    const [lr, lp] = t[i - 1];
    const f = (Math.log(ratio) - Math.log(lr)) / (Math.log(hr) - Math.log(lr));
    return lp + f * (hp - lp);
  }
  return t[t.length - 1][1];
}
const band = (pct: number) => (pct <= 5 ? "elite" : pct <= 15 ? "strong" : pct <= 35 ? "good" : pct <= 60 ? "average" : "low");
const fmtPct = (pct: number) => (pct < 1 ? "<1" : String(Math.round(pct)));

// ---- lookups ------------------------------------------------------------------
type Result =
  | { s: "rank"; pct: number; games: number; clear: boolean }
  | { s: "wr"; wr: number; games: number; clear: boolean }
  | { s: "new" | "shared" | "err" };

const HIT_TTL = 10 * 60e3;
const MISS_TTL = 30 * 60e3;
const ERR_TTL = 60e3;
const STORE = "ofbot.ranks.v1";
const STORE_CAP = 400;
const GAP_MS = 400; // between two requests
const PARALLEL = 2; // lookups at once (each is 1-3 requests)
const QUEUE_CAP = 40;
const SHARED_NAME_ACCOUNTS = 1000;
const CLEAR_SHARE = 0.6;
const PLAYER_ID = /^[A-Za-z0-9]{6,16}$/;

let cache: Map<string, { v: Result; exp: number }> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const queue: { key: string; name: string; anyTag: boolean }[] = [];
const busy = new Set<string>();
let active = 0;
let nextAt = 0;
let gen = 0; // bumped on stop: lookups still running drop their answers

function loadCache() {
  if (cache) return cache;
  cache = new Map();
  try {
    const now = Date.now();
    for (const [k, e] of Object.entries(JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, any>)) {
      if (e && e.exp > now && e.v && typeof e.v.s === "string") cache.set(k, e);
    }
  } catch {
    /* empty cache */
  }
  return cache;
}
function saveCache() {
  saveTimer = null;
  if (!cache) return;
  const now = Date.now();
  const live = [...cache].filter(([, e]) => e.exp > now).sort((a, b) => b[1].exp - a[1].exp).slice(0, STORE_CAP);
  try {
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(live)));
  } catch {
    /* storage full or blocked: memory only */
  }
}
function cacheGet(key: string): Result | undefined {
  const e = loadCache().get(key);
  if (!e) return undefined;
  if (e.exp > Date.now()) return e.v;
  cache!.delete(key);
  return undefined;
}
function cacheSet(key: string, v: Result) {
  const ttl = v.s === "rank" || v.s === "wr" ? HIT_TTL : v.s === "err" ? ERR_TTL : MISS_TTL;
  loadCache().set(key, { v, exp: Date.now() + ttl });
  saveTimer ??= setTimeout(saveCache, 2000);
}

/** One rate-limited GET; JSON body, 404 as `null`, anything else failing throws. */
async function getJson(url: string): Promise<any> {
  const wait = nextAt - Date.now();
  nextAt = Math.max(Date.now(), nextAt) + GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = await gmGet(url);
  if (!r) throw new Error("no answer");
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.text);
}

const lower = (s: unknown) => String(s ?? "").toLowerCase();
function split(name: string) {
  const m = /^\[([A-Za-z0-9]{1,5})\]\s*(.+)$/.exec(name);
  return m ? { tag: m[1], base: m[2] } : { tag: null as string | null, base: name };
}
function greatest<T>(list: T[], at: (x: T) => number): T | null {
  let best: T | null = null;
  for (const x of list) if (!best || at(x) > at(best)) best = x;
  return best;
}

/** Display name ("[TAG] name" or bare) -> ofstats account id (openfront-pro matchName). */
async function matchName(name: string, anyTag: boolean): Promise<{ id: string; clear: boolean } | Result> {
  const { tag, base } = split(name);
  const loose = anyTag && !tag;
  const d = await getJson(`${API}/names/${encodeURIComponent(base)}`);
  if (!d) return { s: "new" };
  if (!tag && d.accountCount >= SHARED_NAME_ACCOUNTS) return { s: "shared" };
  const shown = (u: unknown) => (loose ? split(String(u ?? "")).base : String(u ?? ""));
  const want = loose ? base : name;
  const fits = (u: unknown) => lower(shown(u)) === lower(want);
  const games = (Array.isArray(d.games) ? d.games : []).filter((g: any) => PLAYER_ID.test(g?.publicId ?? "") && fits(g.username));
  const listed = (Array.isArray(d.accounts) ? d.accounts : []).filter((a: any) => PLAYER_ID.test(a?.publicId ?? "") && fits(a.username));
  const seen = new Set<string>([...games.map((g: any) => g.publicId), ...listed.map((a: any) => a.publicId)]);
  const same = games.filter((g: any) => shown(g.username) === want);
  let id: string | null = greatest<any>(same.length ? same : games, (g) => Number(g.date) || 0)?.publicId ?? null;
  if (!id && listed.length) id = greatest<any>(listed, (a) => Date.parse(a.lastSeen) || 0).publicId;
  if (!id && base.length >= 2) {
    const f = await getJson(`${API}/search?q=${encodeURIComponent(base)}`);
    const people = (Array.isArray(f?.people) ? f.people : []).filter(
      (p: any) => PLAYER_ID.test(p?.publicId ?? "") && lower(p.name) === lower(base) && (loose || lower(p.clanTag) === lower(tag)),
    );
    for (const p of people) seen.add(p.publicId);
    id = greatest<any>(people, (p) => Number(p.score) || 0)?.publicId ?? null;
  }
  if (!id) return { s: "new" };
  seen.delete(id);
  const share = games.length ? games.filter((g: any) => g.publicId === id).length / games.length : 0;
  return { id, clear: seen.size === 0 || share >= CLEAR_SHARE };
}

/** Account id -> rank (openfront-pro fetchStats + scoring.ranked). */
async function stats(id: string, clear: boolean): Promise<Result> {
  const d = await getJson(`${API}/players/${encodeURIComponent(id)}?limit=1`);
  const games = Number(d?.gamesPlayed) || 0;
  if (!d || games < 1) return { s: "new" };
  const rows: any[] = Array.isArray(d.maps?.rows) ? d.maps.rows : [];
  const won = rows.reduce((s, r) => s + (Number(r.wins) || 0), 0);
  const exp = rows.reduce((s, r) => s + (Number(r.expectedWins) || 0), 0);
  const rated = rows.reduce((s, r) => s + (Number(r.games) || 0), 0);
  if (exp > 0 && rated >= MIN_RATED_GAMES) {
    return { s: "rank", pct: topPercent((won + SHRINK_K) / (exp + SHRINK_K)), games, clear };
  }
  return { s: "wr", wr: (100 * (Number(d.wins) || 0)) / games, games, clear };
}

async function lookup(name: string, anyTag: boolean): Promise<Result> {
  try {
    const m = await matchName(name, anyTag);
    return "id" in m ? await stats(m.id, m.clear) : m;
  } catch {
    return { s: "err" };
  }
}

function enqueue(key: string, name: string, anyTag: boolean, first: boolean) {
  if (busy.has(key) || queue.some((q) => q.key === key)) return;
  if (first) queue.unshift({ key, name, anyTag });
  else if (queue.length < QUEUE_CAP) queue.push({ key, name, anyTag });
  pump();
}
function pump() {
  while (active < PARALLEL && queue.length) {
    const q = queue.shift()!;
    const g = gen;
    active++;
    busy.add(q.key);
    lookup(q.name, q.anyTag)
      .then((v) => {
        if (g === gen) cacheSet(q.key, v);
      })
      .finally(() => {
        busy.delete(q.key);
        if (g !== gen) return;
        active--;
        pump();
      });
  }
}

// ---- badges -------------------------------------------------------------------
const CSS = `
.${CLS}{display:inline-block;margin:0 0 0 5px;padding:0 4px;border:1px solid currentColor;border-radius:4px;
  font:700 10px/14px system-ui,sans-serif;white-space:nowrap;vertical-align:middle;background:rgba(0,0,0,.35);cursor:help}
.${CLS}[data-pre]{margin:0 4px 0 0}
.${CLS}[data-b=elite]{color:#facc15}.${CLS}[data-b=strong]{color:#4ade80}.${CLS}[data-b=good]{color:#60a5fa}
.${CLS}[data-b=average]{color:#cbd5e1}.${CLS}[data-b=low]{color:#9ca3af}
.${CLS}[data-b=wr]{color:#9ca3af;border-style:dotted}.${CLS}[data-b=new]{color:#6b7280;border-style:dashed;font-weight:500}
`;
let style: HTMLStyleElement | null = null;
let stopTick: (() => void) | null = null;

/** Name text of a cell (its own text nodes; our badge is an element). */
function cellName(el: Element): string | null {
  let raw = "";
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) raw += n.textContent;
  raw = raw.replace(/\s+/g, " ").trim();
  return raw || null;
}

function badgeFor(r: Result, where: "card" | "board"): { text: string; b: string; tip: string } | null {
  const likely = "clear" in r && !r.clear ? "≈ " : "";
  const note = likely ? "\n≈ matched by name; other accounts also play under it" : "";
  if (r.s === "rank") {
    const p = fmtPct(r.pct);
    return {
      text: where === "board" ? `${likely}${p}%` : `${likely}Top ${p}%`,
      b: band(r.pct),
      tip: `ofstats.io skill rank: top ${p}% (wins vs expected, ${r.games} games)${note}`,
    };
  }
  if (r.s === "wr") {
    const wr = r.games < 20 ? Math.round(r.wr) : r.wr.toFixed(1);
    return { text: where === "board" ? `${likely}${wr}%` : `${likely}${wr}% WR`, b: "wr", tip: `ofstats.io: ${wr}% win rate over ${r.games} games (too few rated games for a rank)${note}` };
  }
  if (r.s === "new" && where === "card") return { text: "new", b: "new", tip: "No public games on ofstats.io under this name" };
  return null; // shared names, errors, "new" in the leaderboard: no badge
}

function setBadge(el: Element, key: string | null, r: Result | undefined, where: "card" | "board") {
  let badge = [...el.children].find((c) => c.classList.contains(CLS)) as HTMLElement | undefined;
  const f = key && r ? badgeFor(r, where) : null;
  if (!f) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = CLS;
    if (where === "board") {
      badge.dataset.pre = "1"; // in front: the cell truncates its end
      el.insertBefore(badge, el.firstChild);
    } else el.appendChild(badge);
  }
  if (badge.dataset.k === key && badge.textContent === f.text) return;
  badge.dataset.k = key!;
  badge.dataset.b = f.b;
  badge.textContent = f.text;
  badge.title = f.tip;
}

function scan() {
  const g = inGame() ? gameView() : null;
  const cfg = g ? (call(call(g, "config"), "gameConfig") ?? {}) : {};
  // Names replaced by the game (anonymized lobbies) cannot be looked up.
  if (!g || cfg.anonymizeNames === true) return clearBadges();
  // Humans only (no nations or bots): bare name -> { name, clan }.
  const humans = new Map<string, { base: string; clan: string | null }>();
  for (const p of call(g, "playerViews") ?? []) {
    if (String(call(p, "type") ?? "") !== "HUMAN") continue;
    const nm = String(call(p, "name") ?? "");
    const sp = split(nm);
    const clan = (call(p, "clanTag") as string | null) || sp.tag;
    if (sp.base) humans.set(lower(sp.base), { base: sp.base, clan });
    const dn = String(call(p, "displayName") ?? "");
    if (dn) humans.set(lower(split(dn).base), { base: split(dn).base, clan: clan ?? split(dn).tag });
  }
  for (const [sel, where] of SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const raw = cellName(el);
      const h = raw ? humans.get(lower(split(raw).base)) : undefined;
      if (!h) {
        setBadge(el, null, undefined, where);
        continue;
      }
      const name = h.clan ? `[${h.clan}] ${h.base}` : h.base;
      const anyTag = !h.clan && cfg.disableClanTags === true;
      const key = `${anyTag ? "~" : ""}${lower(name)}`;
      const r = cacheGet(key);
      if (r === undefined) enqueue(key, name, anyTag, where === "card");
      setBadge(el, key, r, where);
    }
  }
}

function clearBadges() {
  for (const b of document.querySelectorAll(`.${CLS}`)) b.remove();
}

export const ranksAid: Aid = {
  key: "ranks",
  label: "Rank badges (ofstats.io)",
  title:
    "Shows each human player's ofstats.io skill rank next to their name on the hover card and the in-game leaderboard. " +
    "Sends player names (and the matching ofstats player ids) to api.ofstats.io; answers are cached for 10-30 minutes.",
  def: false,
  start(api) {
    gen++;
    active = 0;
    if (!gmSwitch(true)) {
      api.note("Rank badges: the userscript manager gave no GM_xmlhttpRequest, so ofstats can't be reached");
    }
    style = document.createElement("style");
    style.textContent = CSS;
    (document.head ?? document.documentElement).appendChild(style);
    stopTick = every(800, scan);
  },
  stop() {
    gen++;
    queue.length = 0;
    busy.clear();
    active = 0;
    gmSwitch(false);
    stopTick?.();
    stopTick = null;
    clearBadges();
    style?.remove();
    style = null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveCache();
    }
  },
};
