import { Nation, PlayerInfo, PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { BotExecution, DEFAULT_PARAMS } from "@openfront/engine/execution/bot/BotExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";

function conquerRect(game: Game, p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++)
    for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
}

describe("BotExecution mirvSpend", () => {
  const make = async (mirvSpend: number) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const big = new PlayerInfo("big", PlayerType.Human, null, "big");
    const game = await setup("big_plains", {}, [me, big]);
    const mp = game.player("me");
    const bp = game.player("big");
    conquerRect(game, mp, 0, 0, 30, 30);
    conquerRect(game, bp, 30, 0, 100, 170);
    mp.setTroops(100_000);
    bp.setTroops(1_000_000);
    mp.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    const bot = new BotExecution("ms", new Nation(undefined, me), { ...DEFAULT_PARAMS, potW: 0, mirvSave: 2, mirvSpend });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    b.goldPrev = Number(mp.gold());
    b.goldGains = Array(60).fill(50_000); // 3M/min
    return { game, mp, bp, b };
  };

  test("the reserve is fixed to a deadline and climbs to the full cost", async () => {
    const { game, mp, bp, b } = await make(0.5);
    const t0 = game.ticks();
    b.mirvSaveTick(mp, t0);
    expect(b.mirvSaving).toBe(bp);
    const mirv = Number(game.unitInfo(UnitType.MIRV).cost(game, mp));
    const r0 = b.mirvReserve;
    expect(r0).toBeLessThan(mirv);
    expect(b.mirvDeadline).toBeGreaterThan(t0);
    const end = b.mirvDeadline;
    // 5 min on, the deadline stays and the reserve rose by ~0.5 x 3M x 5.
    b.mirvSaveTick(mp, t0 + 3000);
    expect(b.mirvDeadline).toBe(end);
    expect(b.mirvReserve).toBeGreaterThan(r0 + 6_000_000);
    // At the deadline the whole MIRV is kept.
    b.mirvSaveTick(mp, end);
    expect(b.mirvReserve).toBeGreaterThanOrEqual(mirv);
    // Threat gone: no reserve.
    b.mirvSaving = null;
    b.params = { ...b.params, mirvSave: 100 };
    b.mirvSaveTick(mp, end + 10);
    expect(b.mirvSaving).toBe(null);
    expect(b.mirvReserve).toBe(0);

  });

  test("the lock lets the AI build only with the gold above the reserve", async () => {
    const run = async (mirvSpend: number, reserve: number) => {
      const { b, bp } = await make(mirvSpend);
      class P { gold() { return 30_000_000n; } unitCount() { return 1; } }
      const player = new P();
      const seen: bigint[] = [];
      const self: any = { structureBehavior: { player, handleStructures: () => { seen.push(player.gold()); return true; } } };
      b.patchMirvLock(self);
      b.mirvSaving = bp;
      b.mirvReserve = reserve;
      const r = self.structureBehavior.handleStructures();
      expect(player.gold()).toBe(30_000_000n); // restored
      expect(Object.prototype.hasOwnProperty.call(player, "gold")).toBe(false);
      return { r, seen };
    };
    expect(await run(0, 0)).toEqual({ r: false, seen: [] });
    expect(await run(0.5, 20_000_000)).toEqual({ r: true, seen: [10_000_000n] });
    expect(await run(0.5, 29_950_000)).toEqual({ r: false, seen: [] });
  });
});

describe("BotExecution stackUp", () => {
  const make = async (stackUp: number, gold: number) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const game = await setup("big_plains", {}, [me]);
    const mp = game.player("me");
    conquerRect(game, mp, 0, 0, 160, 160);
    mp.setTroops(100_000);
    const near = mp.buildUnit(UnitType.City, game.ref(20, 20), {});
    const far = mp.buildUnit(UnitType.City, game.ref(150, 150), {});
    mp.buildUnit(UnitType.SAMLauncher, game.ref(25, 25), {});
    mp.addGold(BigInt(gold) - mp.gold());
    const bot = new BotExecution("st", new Nation(undefined, me), { ...DEFAULT_PARAMS, stackUp });
    bot.init(game);
    const b = bot as any;
    let orig = 0;
    const sb: any = { player: mp, maybeSpawnStructure: () => { orig++; return false; } };
    b.patchStack(sb);
    return { game, mp, near, far, b, sb, calls: () => orig };
  };
  const upgradeTarget = (game: Game) => {
    const ex = (game as any).unInitExecs as any[];
    const u = ex.filter((e) => e.constructor.name === "UpgradeStructureExecution");
    return u.map((e) => e.unitId);
  };

  test("a City under our SAM is upgraded instead of placing a new one", async () => {
    const { game, near, b, sb, calls } = await make(3, 1_000_000);
    expect(sb.maybeSpawnStructure(UnitType.City)).toBe(true);
    expect(calls()).toBe(0);
    expect(upgradeTarget(game)).toEqual([near.id()]);
    expect(b.stackUps).toBe(1);
  });

  test("no SAM cover and not rich: the AI places a new one; if that fails, any city is upgraded", async () => {
    const { game, mp, b, sb, calls } = await make(3, 1_000_000);
    for (const s of mp.units(UnitType.SAMLauncher)) s.delete(false);
    expect(sb.maybeSpawnStructure(UnitType.City)).toBe(true);
    expect(calls()).toBe(1);
    expect(upgradeTarget(game).length).toBe(1);
    expect(b.stackUps).toBe(1);
  });

  test("other types and too little gold go to the AI", async () => {
    const { game, sb, calls } = await make(3, 1_000);
    expect(sb.maybeSpawnStructure(UnitType.City)).toBe(false);
    expect(sb.maybeSpawnStructure(UnitType.Port)).toBe(false);
    expect(calls()).toBe(2);
    expect(upgradeTarget(game)).toEqual([]);
  });
});
