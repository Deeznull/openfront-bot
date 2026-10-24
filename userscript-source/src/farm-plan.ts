/**
 * Farm planner: which map the next solo farm game is on, and the ledger that
 * decides it. Owner 2026-10-15: the farm is for XP per hour, not win rate or
 * medals. Coins (Caps) come only from level-ups (public progression config:
 * 50 per level for levels 2-25, 100 / 150 / 200 for 26-50 / 51-75 / 76-100,
 * 2500 per prestige); medals pay nothing. XP is scored server-side (played,
 * time, placement, win, firstGame, feats; daily cap), so the ledger measures
 * it: the account's lifetime XP before a game and after the next homepage
 * load. Coins (soft balance plus unclaimed soft rewards) are logged too.
 *
 * Only the map and difficulty change; every other solo option stays default
 * (custom settings void the game's XP).
 */

/**
 * Maps (GameMapType values, e.g. "Faroe Islands") by headless Easy win time with the farm profile,
 * fastest first (sweep 2026-10-15, BOT_PROGRESS.md). Maps the live site
 * doesn't list are skipped. Whether short games pay the most XP per hour is
 * what the ledger finds out (time XP may favour longer ones).
 */
export const FARM_MAP_ORDER: string[] = ["Onion", "Oceania", "Faroe Islands", "Japan", "Hawaii", "World"];

/** How many maps the farm tries, and games each before it settles. */
export const FARM_CANDIDATES = 6;
export const FARM_TRIES = 2;
export const FARM_LEDGER_MAX = 300;

export interface FarmGame {
  map: string;
  diff: string;
  won: boolean;
  sec: number; // wall time from the start click to the next homepage load
  xp: number | null; // null: unknown (signed out, or progression off)
  coins: number | null;
}

export interface FarmPending {
  map: string;
  diff: string;
  at: number; // Date.now() at the start click
  xp: number | null; // lifetime XP before the game
  coins: number | null; // balance before the game
  won?: boolean; // set when the game ends; unset = never played
}

export interface FarmLedger {
  games: FarmGame[];
  pending: FarmPending | null;
}

export function emptyLedger(): FarmLedger {
  return { games: [], pending: null };
}

const playerOf = (userMe: any) => userMe?.player ?? userMe;

/** Lifetime XP in a /users/@me response. */
export function xpOf(userMe: any): number | null {
  const xp = Number(playerOf(userMe)?.progress?.lifetimeXp);
  return Number.isFinite(xp) ? xp : null;
}

/** Coins in a /users/@me response: soft balance plus unclaimed soft rewards. */
export function coinsOf(userMe: any): number | null {
  const p = playerOf(userMe);
  const soft = Number(p?.currency?.soft);
  if (!Number.isFinite(soft)) return null;
  let unclaimed = 0;
  for (const r of p?.rewards ?? []) {
    if (r?.currencyType === "soft" && Number.isFinite(Number(r.amount))) unclaimed += Number(r.amount);
  }
  return soft + unclaimed;
}

const delta = (before: number | null, after: number | null) =>
  before !== null && after !== null ? Math.max(0, after - before) : null;

/**
 * Closes the pending game once the next balance is known. The XP of a game is
 * scored after it ends, so a homepage load can come before it: a zero XP
 * delta stays open (returns null) until `final`, the next start click.
 */
export function settle(l: FarmLedger, now: number, userMe: any, final = true): FarmGame | null {
  const p = l.pending;
  if (!p) return null;
  // A start that never led to a game (no end seen) is dropped.
  if (p.won === undefined) {
    if (final) l.pending = null;
    return null;
  }
  const xp = delta(p.xp, xpOf(userMe));
  if (!final && xp === 0) return null;
  l.pending = null;
  const g: FarmGame = {
    map: p.map,
    diff: p.diff,
    won: p.won,
    sec: Math.max(1, Math.round((now - p.at) / 1000)),
    xp,
    coins: delta(p.coins, coinsOf(userMe)),
  };
  l.games.push(g);
  if (l.games.length > FARM_LEDGER_MAX) l.games.splice(0, l.games.length - FARM_LEDGER_MAX);
  return g;
}

/** What a game earned: XP when known, else 1 per win. */
const gain = (g: FarmGame, useXp: boolean) => (useXp ? (g.xp ?? 0) : g.won ? 1 : 0);

export interface MapRate {
  map: string;
  games: number;
  wins: number;
  xp: number;
  perHour: number; // XP per hour, or wins per hour while no XP was seen
}

/** Per-map rates for one difficulty. XP/hour once any game paid XP. */
export function rates(l: FarmLedger, diff: string): Map<string, MapRate> {
  const games = l.games.filter((g) => g.diff === diff);
  const useXp = games.some((g) => (g.xp ?? 0) > 0);
  const acc = new Map<string, { games: number; wins: number; xp: number; got: number; sec: number }>();
  for (const g of games) {
    const a = acc.get(g.map) ?? { games: 0, wins: 0, xp: 0, got: 0, sec: 0 };
    a.games++;
    a.wins += g.won ? 1 : 0;
    a.xp += g.xp ?? 0;
    a.got += gain(g, useXp);
    a.sec += g.sec;
    acc.set(g.map, a);
  }
  const out = new Map<string, MapRate>();
  for (const [map, a] of acc) {
    out.set(map, { map, games: a.games, wins: a.wins, xp: a.xp, perHour: (a.got * 3600) / Math.max(1, a.sec) });
  }
  return out;
}

/**
 * The next map: each candidate (that the site lists) gets FARM_TRIES games
 * first, then the best measured rate. Every 10th game goes to the
 * least-played candidate, so a map that got unlucky early isn't written off.
 */
export function pickMap(l: FarmLedger, diff: string, available: Set<string> | null): string {
  const cands = FARM_MAP_ORDER.filter((m) => !available || available.has(m)).slice(0, FARM_CANDIDATES);
  if (cands.length === 0) return "World";
  const r = rates(l, diff);
  const played = (m: string) => r.get(m)?.games ?? 0;
  const fresh = cands.find((m) => played(m) < FARM_TRIES);
  if (fresh) return fresh;
  const n = l.games.filter((g) => g.diff === diff).length;
  if (n % 10 === 9) return cands.reduce((a, b) => (played(b) < played(a) ? b : a));
  return cands.reduce((a, b) => ((r.get(b)?.perHour ?? 0) > (r.get(a)?.perHour ?? 0) ? b : a));
}

/** Totals for the panel. */
export function summary(l: FarmLedger): {
  games: number;
  wins: number;
  xp: number;
  coins: number;
  xpPerHour: number;
  coinsPerHour: number;
} {
  const g = l.games;
  const hours = Math.max(1, g.reduce((a, x) => a + x.sec, 0)) / 3600;
  const xp = g.reduce((a, x) => a + (x.xp ?? 0), 0);
  const coins = g.reduce((a, x) => a + (x.coins ?? 0), 0);
  return {
    games: g.length,
    wins: g.filter((x) => x.won).length,
    xp,
    coins,
    xpPerHour: xp / hours,
    coinsPerHour: coins / hours,
  };
}
