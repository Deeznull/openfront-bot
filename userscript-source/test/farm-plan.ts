// npx tsx test/farm-plan.ts — pure farm planner logic (XP ledger, map pick).
import assert from "node:assert/strict";
import {
  FARM_MAP_ORDER,
  FARM_TRIES,
  coinsOf,
  emptyLedger,
  pickMap,
  rates,
  settle,
  summary,
  xpOf,
  type FarmGame,
  type FarmLedger,
} from "../src/farm-plan";

const me = (xp: number | null, soft: number | null, rewards: any[] = []) => ({
  user: {},
  player: {
    ...(soft === null ? {} : { currency: { soft, hard: 5 } }),
    rewards,
    ...(xp === null ? {} : { progress: { prestige: 0, level: 9, xpInLevel: 0, xpForNext: 130, lifetimeXp: xp } }),
  },
});

// xpOf / coinsOf: lifetime XP; soft balance plus unclaimed soft rewards.
assert.equal(xpOf(me(910, 0)), 910);
assert.equal(xpOf(me(null, 0)), null);
assert.equal(xpOf(null), null);
assert.equal(
  coinsOf(
    me(0, 120, [
      { id: "a", currencyType: "soft", amount: "50", reason: "level_up", note: "Reached level 9" },
      { id: "b", currencyType: "hard", amount: "3", reason: "x" },
    ]),
  ),
  170,
);
assert.equal(coinsOf(me(0, null)), null);

// settle: nothing pending → null; a start without an end → dropped on final.
const l: FarmLedger = emptyLedger();
assert.equal(settle(l, 0, me(0, 0)), null);
l.pending = { map: "Onion", diff: "Easy", at: 0, xp: 100, coins: 100 };
assert.equal(settle(l, 60_000, me(150, 150), false), null);
assert.notEqual(l.pending, null);
assert.equal(settle(l, 60_000, me(150, 150)), null);
assert.equal(l.pending, null);
assert.equal(l.games.length, 0);

// settle: XP not scored yet (delta 0) stays open until final.
l.pending = { map: "Onion", diff: "Easy", at: 0, xp: 100, coins: 100, won: true };
assert.equal(settle(l, 30_000, me(100, 100), false), null);
assert.notEqual(l.pending, null);
const g = settle(l, 90_000, me(240, 150), false)!;
assert.deepEqual(g, { map: "Onion", diff: "Easy", won: true, sec: 90, xp: 140, coins: 50 });
// Final settle records a zero-XP game; unknown values → null; never negative.
l.pending = { map: "Onion", diff: "Easy", at: 0, xp: 100, coins: 200, won: false };
assert.deepEqual(settle(l, 30_000, me(100, 150))!, { map: "Onion", diff: "Easy", won: false, sec: 30, xp: 0, coins: 0 });
l.pending = { map: "Onion", diff: "Easy", at: 0, xp: null, coins: null, won: false };
const u = settle(l, 30_000, me(100, 150))!;
assert.equal(u.xp, null);
assert.equal(u.coins, null);

// rates: wins/hour until any XP seen, then XP/hour; per difficulty.
const game = (map: string, won: boolean, sec: number, xp: number | null, diff = "Easy"): FarmGame => ({
  map, diff, won, sec, xp, coins: null,
});
const w: FarmLedger = emptyLedger();
w.games.push(game("Onion", true, 1800, null));
assert.equal(rates(w, "Easy").get("Onion")!.perHour, 2);
w.games.push(game("Hawaii", true, 1800, 150));
assert.equal(rates(w, "Easy").get("Hawaii")!.perHour, 300);
assert.equal(rates(w, "Easy").get("Onion")!.perHour, 0);
assert.equal(rates(w, "Medium").size, 0);

// pickMap: explores each candidate FARM_TRIES times in order first.
const p: FarmLedger = emptyLedger();
assert.equal(pickMap(p, "Easy", null), FARM_MAP_ORDER[0]);
// Maps the site doesn't list are skipped; none listed → World.
assert.equal(pickMap(p, "Easy", new Set(["Hawaii", "World"])), "Hawaii");
assert.equal(pickMap(p, "Easy", new Set()), "World");
for (let i = 0; i < FARM_TRIES; i++) p.games.push(game(FARM_MAP_ORDER[0], true, 400, 100));
assert.equal(pickMap(p, "Easy", null), FARM_MAP_ORDER[1]);
// World is slow but pays more XP per hour here: XP/hour decides, not speed.
for (const m of FARM_MAP_ORDER.slice(1))
  for (let i = 0; i < FARM_TRIES; i++) p.games.push(game(m, true, m === "World" ? 700 : 400, m === "World" ? 300 : 100));
assert.equal(pickMap(p, "Easy", null), "World");
// Every 10th game revisits the least-played candidate.
while (p.games.length % 10 !== 9) p.games.push(game("World", true, 700, 300));
assert.notEqual(pickMap(p, "Easy", null), "World");
// Another difficulty starts its own exploration.
assert.equal(pickMap(p, "Medium", null), FARM_MAP_ORDER[0]);

// summary: totals and per hour.
const s = emptyLedger();
s.games.push({ ...game("Onion", true, 1800, 200), coins: 50 }, game("Onion", false, 1800, 100));
assert.deepEqual(summary(s), { games: 2, wins: 1, xp: 300, coins: 50, xpPerHour: 300, coinsPerHour: 50 });
assert.equal(summary(emptyLedger()).xpPerHour, 0);

console.log("farm-plan ok");
