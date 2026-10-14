import {
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import {
  BotExecution,
  DEFAULT_PARAMS,
} from "@openfront/engine/execution/bot/BotExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test, vi } from "vitest";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

function conquerRect(game: Game, p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
  }
}

// A 60x60 tribe (3600 tiles) next to us on plains. killSend must be enough to
// take it below 100 tiles (annexed) with little slack: 80% of it stalls.
async function attackTribe(sendScale: number) {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me");
  const tribe = new PlayerInfo("tribe", PlayerType.Bot, null, "tribe");
  const game = await setup("big_plains", {}, [me, tribe], undefined, UseRealAttackLogic);
  const mp = game.player("me");
  const tp = game.player("tribe");
  conquerRect(game, tp, 0, 0, 60, 60);
  conquerRect(game, mp, 60, 0, 60, 120);
  tp.setTroops(40_000);

  const bot = new BotExecution("killsend", new Nation(undefined, me), {
    ...DEFAULT_PARAMS,
    tribeKill: 1,
  });
  bot.init(game);
  const send = bot.killSend(tp);
  mp.setTroops(send * sendScale + 1000);
  game.addExecution(new AttackExecution(send * sendScale, mp, tp.id()));
  game.executeNextTick();
  for (let i = 0; i < 3000 && mp.outgoingAttacks().length > 0; i++) {
    game.executeNextTick();
  }
  return { send, tribeAlive: tp.isAlive(), tribeTiles: tp.numTilesOwned() };
}

describe("BotExecution.killSend", () => {
  test("the kill-sized attack kills a big thin tribe", async () => {
    const r = await attackTribe(1);
    // The 4x-troops rule of the Nation AI would send 160K; the land needs less here.
    expect(r.send).toBeGreaterThan(40_000 / 0.6);
    expect(r.tribeAlive).toBe(false);
  });

  test("a send 20% short or less stalls inside the tribe", async () => {
    const r = await attackTribe(0.5);
    expect((await attackTribe(0.8)).tribeAlive).toBe(true);
    expect(r.tribeAlive).toBe(true);
    expect(r.tribeTiles).toBeGreaterThan(99);
  });
});

// Us in the middle (x 60-119), a stronger human on the left (x 0-59).
async function defenseSetup(params: Partial<typeof DEFAULT_PARAMS>) {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me");
  const foe = new PlayerInfo("foe", PlayerType.Human, null, "foe");
  const game = await setup("big_plains", {}, [me, foe], undefined, UseRealAttackLogic);
  const mp = game.player("me");
  const fp = game.player("foe");
  conquerRect(game, fp, 0, 0, 60, 200);
  conquerRect(game, mp, 60, 0, 60, 200);
  const bot = new BotExecution("defense", new Nation(undefined, me), {
    ...DEFAULT_PARAMS,
    ...params,
  });
  bot.init(game);
  const b = bot as any;
  b.initializeBehaviors();
  const maxT = game.config().maxTroops(mp);
  mp.setTroops(0.5 * maxT);
  fp.setTroops(0.8 * maxT);
  return { game, mp, fp, b };
}

describe("BotExecution defense floor and pvp gate", () => {
  test("openCap caps the floor only while free land borders us", async () => {
    const { game, fp, b } = await defenseSetup({ defK: 1, defCap: 0.9, openCap: 0.3 });
    b.updateDefenseFloor();
    expect(b.expandRatio).toBeCloseTo(0.3);
    conquerRect(game, fp, 120, 0, 80, 200); // no free land left
    b.updateDefenseFloor();
    expect(b.expandRatio).toBeCloseTo(0.8);
  });

  test("pvpRatio skips Nation-AI attacks on a player we don't outnumber", async () => {
    const { mp, fp, b } = await defenseSetup({ pvpRatio: 1.6 });
    b.updateDefenseFloor();
    expect(b.attackBehavior.sendAttack(fp)).toBe(false);
    expect(b.pvpSkips).toBe(1);
    mp.setTroops(2 * fp.troops());
    b.attackBehavior.sendAttack(fp);
    expect(b.pvpSkips).toBe(1);
  });
});

// boatPick: random boat targets go free land > tribe > weak player; never a
// player that isn't weak (its troops x1.5 > the 20% boat).
describe("BotExecution boatPick", () => {
  test("prefers free land, then tribes, and skips strong players", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const tribe = new PlayerInfo("tribe", PlayerType.Bot, null, "tribe");
    const foe = new PlayerInfo("foe", PlayerType.Human, null, "foe");
    const game = await setup("big_plains", {}, [me, tribe, foe], undefined, UseRealAttackLogic);
    const mp = game.player("me");
    const tp = game.player("tribe");
    const fp = game.player("foe");
    conquerRect(game, mp, 0, 0, 20, 20);
    conquerRect(game, tp, 40, 0, 10, 10);
    conquerRect(game, fp, 80, 0, 10, 10);
    mp.setTroops(100_000);
    const free = game.ref(150, 150);
    const tribeTile = game.ref(41, 1);
    const foeTile = game.ref(81, 1);
    const bot = new BotExecution("boat", new Nation(undefined, me), { ...DEFAULT_PARAMS, boatPick: 1 });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    let script: number[] = [];
    const ab: any = { findRandomBoatTarget: () => (script.length ? { tile: script.shift(), launch: 0 } : null) };
    b.patchBoatPick(ab);

    script = [tribeTile, free];
    expect(ab.findRandomBoatTarget(0, [], true).tile).toBe(free);
    script = [tribeTile, tribeTile, tribeTile];
    expect(ab.findRandomBoatTarget(0, [], true).tile).toBe(tribeTile);

    fp.setTroops(50_000); // boat = 20K: 1.5 x 50K is far more
    script = [foeTile];
    expect(ab.findRandomBoatTarget(0, [], false)).toBeNull();
    fp.setTroops(10_000); // 15K <= 20K: weak, land there
    script = [foeTile];
    expect(ab.findRandomBoatTarget(0, [], false).tile).toBe(foeTile);
    expect(b.boatPicks).toEqual({ free: 1, tribe: 1, player: 1, skipped: 1 });
  });
});

describe("BotExecution exposedV2", () => {
  test("a busy giant with its army out is exposed only under the old rule", async () => {
    const run = async (exposedV2: number) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const foe = new PlayerInfo("foe", PlayerType.Human, null, "foe");
      const third = new PlayerInfo("third", PlayerType.Human, null, "third");
      const game = await setup("big_plains", {}, [me, foe, third], undefined, UseRealAttackLogic);
      const fp = game.player("foe");
      conquerRect(game, fp, 0, 0, 60, 200);
      conquerRect(game, game.player("third"), 60, 0, 60, 200);
      conquerRect(game, game.player("me"), 120, 0, 60, 200);
      const max = game.config().maxTroops(fp);
      fp.setTroops(max * 0.9);
      game.addExecution(new AttackExecution(max * 0.6, fp, "third"));
      game.executeNextTick();
      game.executeNextTick();
      const bot = new BotExecution("exp", new Nation(undefined, me), { ...DEFAULT_PARAMS, exposedV2 });
      bot.init(game);
      const away = fp.outgoingAttacks().reduce((s, a) => s + a.troops(), 0);
      return { exposed: (bot as any).exposed(fp), home: fp.troops(), away };
    };
    const old = await run(0);
    expect(old.away).toBeGreaterThan(old.home); // army out > home
    expect(old.exposed).toBe(true);
    expect((await run(0.3)).exposed).toBe(false);
  });
});

describe("BotExecution snipeGate", () => {
  test("a small poke on a strong player makes it a snipe target only without the gate", async () => {
    const run = async (snipeGate: number, hitShare: number) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const foe = new PlayerInfo("foe", PlayerType.Human, null, "foe");
      const third = new PlayerInfo("third", PlayerType.Human, null, "third");
      const game = await setup("big_plains", {}, [me, foe, third], undefined, UseRealAttackLogic);
      const fp = game.player("foe");
      const tp = game.player("third");
      conquerRect(game, fp, 0, 0, 60, 200);
      conquerRect(game, tp, 60, 0, 60, 200);
      conquerRect(game, game.player("me"), 120, 0, 60, 200);
      fp.setTroops(100_000);
      tp.setTroops(1_000_000);
      game.addExecution(new AttackExecution(100_000 * hitShare, tp, "foe"));
      game.executeNextTick();
      game.executeNextTick();
      const bot = new BotExecution("sg", new Nation(undefined, me), { ...DEFAULT_PARAMS, snipeWeak: 0, snipeGate });
      bot.init(game);
      expect(fp.incomingAttacks().length).toBe(1);
      return bot.snipeLosing(game.player("me"), fp, 50_000, false);
    };
    expect(await run(0, 0.05)).toBe(true); // any incoming attack counts
    expect(await run(0.5, 0.05)).toBe(false); // a poke is not pressure
    expect(await run(0.5, 1.5)).toBe(true); // a real invasion is
  });
});

describe("BotExecution pvpNat", () => {
  test("a Nation at 1.3x our troops is attacked under pvpNat 1.22, skipped under pvpRatio 1.6 alone", async () => {
    const run = async (pvpNat: number) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const nat = new PlayerInfo("nat", PlayerType.Nation, null, "nat");
      const game = await setup("big_plains", {}, [me, nat], undefined, UseRealAttackLogic);
      const mp = game.player("me");
      const np = game.player("nat");
      conquerRect(game, np, 0, 0, 60, 200);
      conquerRect(game, mp, 60, 0, 60, 200);
      const b = new BotExecution("pn", new Nation(undefined, me), { ...DEFAULT_PARAMS, pvpRatio: 1.6, pvpNat }) as any;
      b.init(game);
      b.initializeBehaviors();
      np.setTroops(100_000);
      mp.setTroops(130_000);
      b.updateDefenseFloor();
      b.attackBehavior.sendAttack(np);
      return b.pvpSkips;
    };
    expect(await run(0)).toBe(1);
    expect(await run(1.22)).toBe(0);
  });
  test("a gated attack on a strong human is redirected to a beatable Nation neighbour", async () => {
    const run = async (pvpNat: number) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const hum = new PlayerInfo("hum", PlayerType.Human, null, "hum");
      const nat = new PlayerInfo("nat", PlayerType.Nation, null, "nat");
      const game = await setup("big_plains", {}, [me, hum, nat], undefined, UseRealAttackLogic);
      const mp = game.player("me");
      const hp = game.player("hum");
      const np = game.player("nat");
      conquerRect(game, hp, 0, 0, 60, 200);
      conquerRect(game, mp, 60, 0, 60, 200);
      conquerRect(game, np, 120, 0, 60, 200);
      const b = new BotExecution("pr", new Nation(undefined, me), { ...DEFAULT_PARAMS, pvpRatio: 1.6, pvpNat }) as any;
      b.init(game);
      b.initializeBehaviors();
      const max = game.config().maxTroops(mp);
      mp.setTroops(max * 0.9);
      hp.setTroops((max * 0.9) / 1.3); // gate: 1.3x < pvpRatio 1.6
      np.setTroops((max * 0.9) / 2); // a Nation we beat at 2x
      b.updateDefenseFloor();
      b.attackBehavior.sendAttack(hp);
      game.executeNextTick();
      game.executeNextTick();
      return mp.outgoingAttacks().map((a) => a.target()).filter((t) => t.isPlayer()).map((t) => (t as any).name());
    };
    expect(await run(0)).toEqual([]);
    expect(await run(1.22)).toEqual(["nat"]);
  });
});

describe("BotExecution homeK", () => {
  test("own raids keep homeK x the strongest other bordering player at home", async () => {
    const run = async (homeK: number) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const big = new PlayerInfo("big", PlayerType.Human, null, "big");
      const prey = new PlayerInfo("prey", PlayerType.Human, null, "prey");
      const game = await setup("big_plains", {}, [me, big, prey], undefined, UseRealAttackLogic);
      const mp = game.player("me");
      const bp = game.player("big");
      const pp = game.player("prey");
      conquerRect(game, bp, 0, 0, 60, 200);
      conquerRect(game, mp, 60, 0, 60, 200);
      conquerRect(game, pp, 120, 0, 60, 200);
      mp.setTroops(1_000_000);
      bp.setTroops(800_000);
      pp.setTroops(900_000);
      const b = new BotExecution("hk", new Nation(undefined, me), { ...DEFAULT_PARAMS, homeK });
      b.init(game);
      return { prey: b.homeRoom(mp, pp), big: b.homeRoom(mp, bp), none: b.homeRoom(mp, null) };
    };
    expect((await run(0)).prey).toBe(Infinity);
    const r = await run(0.9);
    expect(r.prey).toBeCloseTo(1_000_000 - 0.9 * 800_000); // the target itself doesn't count
    expect(r.big).toBeCloseTo(1_000_000 - 0.9 * 900_000);
    expect(r.none).toBeCloseTo(1_000_000 - 0.9 * 900_000);
  });
  test("a counter top-up is capped by homeK but still cancels the incoming attack", async () => {
    const run = async (homeK: number) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const big = new PlayerInfo("big", PlayerType.Human, null, "big");
      const foe = new PlayerInfo("foe", PlayerType.Human, null, "foe");
      const game = await setup("big_plains", {}, [me, big, foe], undefined, UseRealAttackLogic);
      const mp = game.player("me");
      const bp = game.player("big");
      const fp = game.player("foe");
      conquerRect(game, bp, 0, 0, 60, 200);
      conquerRect(game, mp, 60, 0, 60, 200);
      conquerRect(game, fp, 120, 0, 60, 200);
      mp.setTroops(1_000_000);
      bp.setTroops(800_000);
      fp.setTroops(320_000);
      game.addExecution(new AttackExecution(20_000, fp, "me"));
      game.executeNextTick();
      game.executeNextTick();
      const b = new BotExecution("hc", new Nation(undefined, me), {
        ...DEFAULT_PARAMS, homeK, counter: 1, cExtra: 1.407, counterMax: 0.526, cFloor: 0.1, cPart: 0,
      }) as any;
      b.init(game);
      const before = mp.troops();
      b.counterAttacks(100_000);
      game.executeNextTick();
      return before - mp.troops();
    };
    const full = await run(0);
    const capped = await run(0.9);
    expect(full).toBeGreaterThan(400_000); // incoming + 1.4 x their home
    expect(capped).toBeLessThan(full);
    expect(capped).toBeGreaterThanOrEqual(20_000);
  });
});


// tribeFinish (user live report 2026-10-14): finish tribes we attacked, steal
// kills from anyone hitting a bordering tribe (allies too), hunt early.
async function finishSetup(params: Partial<typeof DEFAULT_PARAMS> = {}) {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me");
  const tribe = new PlayerInfo("tribe", PlayerType.Bot, null, "tribe");
  const friend = new PlayerInfo("friend", PlayerType.Human, null, "friend");
  const game = await setup("big_plains", {}, [me, tribe, friend], undefined, UseRealAttackLogic);
  const mp = game.player("me");
  const tp = game.player("tribe");
  const fp = game.player("friend");
  conquerRect(game, tp, 0, 0, 60, 60);
  conquerRect(game, mp, 60, 0, 60, 120);
  conquerRect(game, fp, 0, 60, 60, 60);
  tp.setTroops(40_000);
  const bot = new BotExecution("fin", new Nation(undefined, me), { ...DEFAULT_PARAMS, tribeFinish: 1, ...params });
  bot.init(game);
  const b = bot as any;
  b.player = mp;
  b.reserveRatio = 0.8; // early defense floor (strong neighbours)
  return { game, mp, tp, fp, b };
}
const runOut = (game: Game, mp: Player) => {
  for (let i = 0; i < 3000 && mp.outgoingAttacks().length > 0; i++) game.executeNextTick();
};

describe("BotExecution tribeFinish", () => {
  test("a half-sized attack on a tribe is topped up and the tribe dies", async () => {
    const { game, mp, tp, b } = await finishSetup();
    const need = b.killSend(tp);
    const maxT = game.config().maxTroops(mp);
    mp.setTroops(Math.min(maxT, need * 0.4 + 0.48 * maxT + need));
    game.addExecution(new AttackExecution(need * 0.4, mp, tp.id()));
    game.executeNextTick();
    game.executeNextTick();
    b.tribeFinish(game.ticks());
    expect(b.fin.topup).toBe(1);
    runOut(game, mp);
    expect(tp.isAlive()).toBe(false);
  });

  test("an ally hitting a bordering tribe makes us steal it; the hunt waits for the full kill", async () => {
    const { game, mp, tp, fp, b } = await finishSetup();
    mp.createAllianceRequest(fp)?.accept();
    expect(mp.isFriendly(fp)).toBe(true);
    const need = b.killSend(tp);
    const maxT = game.config().maxTroops(mp);
    // Budget (troops - 0.48 maxT) covers 70% of the kill: a hunt waits, a steal goes.
    mp.setTroops(0.48 * maxT + 0.7 * need);
    b.tribeFinish(game.ticks());
    expect(b.fin.hunt + b.fin.steal).toBe(0);
    fp.setTroops(1_000_000);
    game.addExecution(new AttackExecution(20_000, fp, tp.id()));
    game.executeNextTick();
    b.tribeFinish(game.ticks());
    expect(b.fin.steal).toBe(1);
    game.executeNextTick();
    expect(mp.outgoingAttacks().some((a) => a.target() === tp)).toBe(true);
  });

  test("hunts a bordering tribe once the kill fits above the floor, not while hit hard", async () => {
    const { game, mp, tp, fp, b } = await finishSetup();
    const need = b.killSend(tp);
    const maxT = game.config().maxTroops(mp);
    mp.setTroops(0.48 * maxT + need + 1000);
    fp.setTroops(1_000_000);
    game.addExecution(new AttackExecution(0.4 * mp.troops(), fp, mp.id()));
    game.executeNextTick();
    b.tribeFinish(game.ticks());
    expect(b.fin.hunt).toBe(0);
    for (const a of mp.incomingAttacks()) a.delete();
    mp.setTroops(0.48 * maxT + need + 1000);
    b.tribeFinish(game.ticks() + 100);
    expect(b.fin.hunt).toBe(1);
    game.executeNextTick();
    runOut(game, mp);
    expect(tp.isAlive()).toBe(false);
  });
});

// structTarget (user live report 2026-10-14): a neighbour with cities our
// attack can reach beats an equally beatable empty one. v2: no fixed range;
// a structure fades with the attack cost to reach it (distance, terrain,
// defense posts) against how far half our army can push.
async function structSetup() {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me");
  const a = new PlayerInfo("empty", PlayerType.Human, null, "empty");
  const c = new PlayerInfo("rich", PlayerType.Human, null, "rich");
  const game = await setup("big_plains", {}, [me, a, c], undefined, UseRealAttackLogic);
  const mp = game.player("me");
  const ap = game.player("empty");
  const cp = game.player("rich");
  conquerRect(game, ap, 0, 0, 60, 100);
  conquerRect(game, mp, 60, 0, 60, 200);
  conquerRect(game, cp, 0, 100, 60, 100);
  mp.setTroops(300_000);
  ap.setTroops(50_000);
  cp.setTroops(55_000);
  const bot = new BotExecution("st", new Nation(undefined, me), { ...DEFAULT_PARAMS, pvpRatio: 1.6, structTarget: 0.5 });
  bot.init(game);
  const b = bot as any;
  b.player = mp;
  const val = () => {
    b.structCache.clear();
    return b.structEval(mp, cp) as { value: number; front: number };
  };
  return { game, mp, ap, cp, b, val };
}

describe("BotExecution structTarget", () => {
  test("redirects to the neighbour whose structures our attack can reach", async () => {
    const { game, ap, cp, mp, b, val } = await structSetup();
    expect(b.structPick(mp, ap)).toBe(ap); // no structures anywhere
    cp.buildUnit(UnitType.City, game.ref(55, 150), {}); // 5 tiles past our border
    expect(val().value).toBeGreaterThan(0.95);
    expect(b.structPick(mp, ap)).toBe(cp);
    cp.setTroops(200_000); // fails the 1.6x ratio gate: keep the original
    b.structCache.clear();
    expect(b.structPick(mp, ap)).toBe(ap);
  });

  test("a structure fades with distance, our strength, terrain and defense posts (no fixed cutoff)", async () => {
    const { game, mp, cp, val } = await structSetup();
    cp.buildUnit(UnitType.City, game.ref(5, 150), {}); // 55 tiles deep
    const far = val().value;
    expect(far).toBeGreaterThan(0.2); // the old 40-tile cutoff gave 0
    expect(far).toBeLessThan(0.9);
    mp.setTroops(60_000); // a weak army cannot push 55 tiles
    expect(val().value).toBeLessThan(0.05);
    mp.setTroops(300_000);
    const orig = game.terrainType.bind(game);
    (game as any).terrainType = (t: number) => (game.x(t) < 55 ? TerrainType.Mountain : orig(t));
    const mountain = val().value;
    expect(mountain).toBeLessThan(far);
    (game as any).terrainType = orig;
    expect(val().front).toBe(1);
    cp.buildUnit(UnitType.DefensePost, game.ref(40, 150), {}); // covers the line and the front
    const posted = val();
    expect(posted.value).toBeLessThan(mountain);
    expect(posted.front).toBeGreaterThan(1.5); // front tiles within 30 of the post cost x5
  });
});

// regenKeep (owner report 2026-10-14: "ultra aggressive against bots, not
// leaving optimal troop regen rate and some reserve"): tribe attacks keep
// regenKeep x maxTroops at home even when the defense floor is low.
describe("BotExecution regenKeep", () => {
  test("tribeFinish holds a hunt that would drop us under the regen floor", async () => {
    const run = async (regenKeep: number) => {
      const { game, mp, tp, b } = await finishSetup({ reserve: 0.13, regenKeep });
      b.reserveRatio = 0.13; // late game, weak neighbours
      const need = b.killSend(tp);
      const maxT = game.config().maxTroops(mp);
      mp.setTroops(0.25 * maxT + need);
      b.tribeFinish(game.ticks());
      return b.fin.hunt;
    };
    expect(await run(0)).toBe(1);
    expect(await run(0.35)).toBe(0);
  });

  test("Nation AI tribe sends are capped at troops - regenKeep x max", async () => {
    const { game, mp, tp, b } = await finishSetup({ regenKeep: 0.35 });
    const maxT = game.config().maxTroops(mp);
    mp.setTroops(0.6 * maxT);
    const ab: any = { calculateBotAttackTroops: (_t: Player, m: number) => m, botAttackTroopsSent: 0.1 * maxT };
    b.patchRegenKeep(ab);
    expect(ab.calculateBotAttackTroops(tp, maxT)).toBeCloseTo(0.15 * maxT, 0);
    expect(ab.calculateBotAttackTroops(tp, 0.05 * maxT)).toBeCloseTo(0.05 * maxT, 0);
  });
});

// wWater (owner 2026-10-14: spawn near water rather than a mid-game water push;
// "the box doesnt have any water so do not make bot bug out in that map").
describe("BotExecution wWater spawn", () => {
  const spawnOn = async (map: string, wWater: number, id: string) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const game = await setup(map, {}, [me]);
    const bot = new BotExecution(id, new Nation(undefined, me), { ...DEFAULT_PARAMS, wWater });
    bot.init(game);
    return { game, t: (bot as any).chooseSpawn() as number | null };
  };
  const waterWithin = (game: Game, t: number, r: number) => {
    const x0 = game.x(t), y0 = game.y(t);
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const x = x0 + dx, y = y0 + dy;
      if (x >= 0 && y >= 0 && x < game.width() && y < game.height() && !game.isLand(game.ref(x, y))) return true;
    }
    return false;
  };

  test("a water weight puts the spawn next to the coast", async () => {
    for (const id of ["w1", "w2", "w3"]) {
      const { game, t } = await spawnOn("world", 3, id);
      expect(t).not.toBeNull();
      expect(game.isLand(t!)).toBe(true);
      expect(waterWithin(game, t!, 9)).toBe(true);
    }
  });

  test("a map without water spawns exactly as without the weight", async () => {
    const a = await spawnOn("big_plains", 0, "box");
    const b = await spawnOn("big_plains", 3, "box");
    expect(a.t).not.toBeNull();
    expect(b.t).toBe(a.t);
  });
});

// snipeSmall (owner 2026-10-14: "when port sniping always make bot send
// little, maybe 1% troop boats"): the landing conquers the port tile itself.
describe("BotExecution snipeSmall", () => {
  const snipeSetup = async (snipeSmall: number) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const isle = new PlayerInfo("isle", PlayerType.Bot, null, "isle");
    const game = await setup("ocean_and_land", {}, [me, isle], undefined, UseRealAttackLogic);
    const mp = game.player("me");
    const ip = game.player("isle");
    conquerRect(game, mp, 0, 0, 8, 16);
    conquerRect(game, ip, 14, 6, 2, 3);
    const port = ip.buildUnit(UnitType.Port, game.ref(14, 7), {});
    ip.setTroops(10_000); // dense island: the spreading send is ~200K
    game.addExecution(new PlayerExecution(ip)); // hands captured structures to the tile owner
    const bot = new BotExecution("ss", new Nation(undefined, me), {
      ...DEFAULT_PARAMS, snipe: 1, snipeSmall, snipeHome: 0, snipeAlly: 0,
    });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    mp.setTroops(50_000);
    return { game, mp, port, b };
  };

  test("a 1% boat lands on the port tile and takes the port", async () => {
    const { game, mp, port, b } = await snipeSetup(0.01);
    b.snipe(game.ticks());
    game.executeNextTick();
    const boats = mp.units(UnitType.TransportShip);
    expect(boats.length).toBe(1);
    expect(boats[0].troops()).toBe(500);
    for (let i = 0; i < 300 && mp.units(UnitType.TransportShip).length > 0; i++) game.executeNextTick();
    game.executeNextTick(); // the owner's PlayerExecution hands the port over
    expect(port.owner()).toBe(mp);
  });

  test("without it the dense island is too costly to snipe", async () => {
    const { game, mp, b } = await snipeSetup(0);
    b.snipe(game.ticks());
    game.executeNextTick();
    expect(mp.units(UnitType.TransportShip).length).toBe(0);
  });
});

// trigMax / sendKeep (owner 2026-10-14: "why bot waits exactly 100 percent to
// send boats ... makes bot to sit for minutes", "0.9 is high it can be 0.7",
// "consider if its ally or non ally (including ally which rejects ally renew)").
async function keepSetup(params: Record<string, number>) {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me");
  const f = new PlayerInfo("foe", PlayerType.Human, null, "foe");
  const game = await setup("big_plains", { difficulty: Difficulty.Impossible }, [me, f]);
  const mp = game.player("me");
  const fp = game.player("foe");
  conquerRect(game, mp, 0, 0, 60, 100);
  conquerRect(game, fp, 60, 0, 60, 100);
  const bot = new BotExecution("kp", new Nation(undefined, me), { ...DEFAULT_PARAMS, ...params });
  bot.init(game);
  const b = bot as any;
  b.player = mp;
  return { game, mp, fp, b };
}

describe("BotExecution trigMax", () => {
  test("a huge bordering threat no longer pushes the trigger to ~90%", async () => {
    const run = async (trigMax: number) => {
      const { game, mp, fp, b } = await keepSetup({ defK: 1.054, defCap: 0.816, trigger: 0.494, reserve: 0.13, trigMax });
      fp.setTroops(10 * game.config().maxTroops(mp));
      b.updateDefenseFloor();
      return { trig: b.triggerRatio as number, res: b.reserveRatio as number };
    };
    const off = await run(0);
    expect(off.trig).toBeCloseTo(0.896, 3);
    const on = await run(0.7);
    expect(on.trig).toBeCloseTo(0.7, 5);
    expect(on.res).toBeCloseTo(0.62, 5);
  });
});

describe("BotExecution sendKeep", () => {
  test("keeps sendKeep x the strongest non-ally home; an ally counts again once it lets the alliance run out", async () => {
    const { game, mp, fp, b } = await keepSetup({ sendKeep: 0.7 });
    mp.setTroops(100_000);
    fp.setTroops(50_000);
    const ab: any = { neighborTroopCap: () => 123 };
    b.patchSendKeep(ab);
    expect(ab.neighborTroopCap()).toBe(100_000 - 35_000); // engine: 0.9 x 50K
    expect(ab.neighborTroopCap(fp)).toBe(Infinity); // the retaliation target is ignored
    mp.createAllianceRequest(fp)?.accept();
    expect(mp.isFriendly(fp)).toBe(true);
    expect(ab.neighborTroopCap()).toBe(Infinity);
    (mp.allianceWith(fp) as any).expiresAt_ = game.ticks() + 100; // inside allyWarn, nobody renewed
    expect(ab.neighborTroopCap()).toBe(65_000);
  });

  test("v0.34 troopSendCap keeps the incoming-attack allowance; Medium is untouched", async () => {
    const { game, mp, fp, b } = await keepSetup({ sendKeep: 0.7 });
    mp.setTroops(100_000);
    fp.setTroops(50_000);
    const ab: any = { troopSendCap: () => 7 };
    b.patchSendKeep(ab);
    expect(ab.troopSendCap()).toBe(65_000);
    game.addExecution(new AttackExecution(80_000, fp, mp.id()));
    game.executeNextTick();
    expect(ab.troopSendCap()).toBeGreaterThanOrEqual(70_000);
    (game.config().gameConfig() as any).difficulty = Difficulty.Medium;
    expect(ab.troopSendCap()).toBe(7);
  });
});

// foodAll / humansOnly (owner 2026-10-14: "allying with much weaker players
// doesnt benefit at all", "never ally with non-players").
describe("BotExecution ally choice", () => {
  const kinds = async (params: Record<string, number>) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const far = new PlayerInfo("far", PlayerType.Human, null, "far");
    const nat = new PlayerInfo("nat", PlayerType.Nation, null, "nat");
    const game = await setup("big_plains", {}, [me, far, nat]);
    const mp = game.player("me");
    const fp = game.player("far");
    const np = game.player("nat");
    conquerRect(game, mp, 0, 0, 40, 40);
    conquerRect(game, fp, 150, 150, 20, 20); // no shared border: boat range only
    conquerRect(game, np, 40, 0, 20, 40);
    mp.setTroops(500_000);
    fp.setTroops(40_000);
    np.setTroops(1_000_000);
    const bot = new BotExecution("ac", new Nation(undefined, me), { ...DEFAULT_PARAMS, potW: 0, ...params });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    return { far: b.allyKind(mp, fp), nat: b.allyKind(mp, np) };
  };

  test("farAlly: a far player is allyable only on a combined far threat", async () => {
    const run = async (params: Record<string, number>, setupFar: (game: any, mp: any, fp: any) => void) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const far = new PlayerInfo("far", PlayerType.Human, null, "far");
      const game = await setup("big_plains", {}, [me, far]);
      const mp = game.player("me");
      const fp = game.player("far");
      conquerRect(game, mp, 0, 0, 40, 40);
      conquerRect(game, fp, 150, 150, 20, 20);
      mp.setTroops(500_000);
      fp.setTroops(200_000);
      const bot = new BotExecution("fa", new Nation(undefined, me), { ...DEFAULT_PARAMS, potW: 0, ...params });
      bot.init(game);
      const b = bot as any;
      b.player = mp;
      const theirPort = fp.buildUnit(UnitType.Port, game.ref(155, 155), {});
      const ships = [0, 1].map((i) => mp.buildUnit(UnitType.TradeShip, game.ref(100 + i, 100), { targetUnit: theirPort }));
      b.trackPiracy(mp, game.ticks());
      setupFar(game, mp, fp);
      for (const s of ships) if (s.owner() !== mp) b.trackPiracy(mp, game.ticks());
      b.trackPiracy(mp, game.ticks());
      return b.allyKind(mp, fp);
    };
    const none = () => {};
    const silo = (game: any, _mp: any, fp: any) => fp.buildUnit(UnitType.MissileSilo, game.ref(160, 160), {});
    const ships = (n: number) => (_g: any, mp: any, fp: any) => {
      for (const s of mp.units(UnitType.TradeShip).slice(0, n)) fp.captureUnit(s);
    };
    expect(await run({}, none)).toBe("ok");
    expect(await run({ farAlly: 1 }, none)).toBe("food");
    // One factor alone is no reason: a bare silo, or one captured ship.
    expect(await run({ farAlly: 1 }, silo)).toBe("food");
    expect(await run({ farAlly: 1 }, ships(1))).toBe("food");
    // Combined: a silo with gold for a hydrogen bomb, or repeated piracy.
    expect(await run({ farAlly: 1 }, (g, mp, fp) => { silo(g, mp, fp); fp.addGold(100_000_000n); })).toBe("ok");
    expect(await run({ farAlly: 1 }, ships(2))).toBe("ok");
    // An embargo on us weighs like a silo: alone no reason, together one.
    expect(await run({ farAlly: 1 }, (_g, mp, fp) => fp.addEmbargo(mp, false))).toBe("food");
    expect(await run({ farAlly: 1 }, (g, mp, fp) => { silo(g, mp, fp); fp.addEmbargo(mp, false); })).toBe("ok");
  });

  test("humansOnly never allies a Nation, however strong", async () => {
    expect((await kinds({})).nat).toBe("strong");
    expect((await kinds({ humansOnly: 1 })).nat).toBe("food");
  });

  test("humansOnly is off in a solo game (no other human)", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const nat = new PlayerInfo("nat", PlayerType.Nation, null, "nat");
    const game = await setup("big_plains", {}, [me, nat]);
    const mp = game.player("me");
    const np = game.player("nat");
    conquerRect(game, mp, 0, 0, 40, 40);
    conquerRect(game, np, 40, 0, 20, 40);
    mp.setTroops(500_000);
    np.setTroops(1_000_000);
    const bot = new BotExecution("so", new Nation(undefined, me), { ...DEFAULT_PARAMS, potW: 0, humansOnly: 1 });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    expect(b.allyKind(mp, np)).toBe("strong");
  });
});

describe("BotExecution mirvSave", () => {
  const make = async (perTick: number) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const big = new PlayerInfo("big", PlayerType.Human, null, "big");
    const game = await setup("big_plains", {}, [me, big]);
    const mp = game.player("me");
    const bp = game.player("big");
    conquerRect(game, mp, 0, 0, 30, 30);
    conquerRect(game, bp, 30, 0, 100, 170); // ~42% of the land, below the win bar
    mp.setTroops(100_000);
    bp.setTroops(1_000_000);
    mp.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    const bot = new BotExecution("ms", new Nation(undefined, me), { ...DEFAULT_PARAMS, potW: 0, mirvSave: 2 });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    b.goldPrev = Number(mp.gold());
    b.goldGains = Array(60).fill(perTick * 10);
    return { game, mp, bp, b };
  };

  test("banks for a MIRV only when income affords it before the leader wins", async () => {
    // A 25M MIRV within 0.8 x 20 min needs >= ~1.6M/min: 3M/min saves, 30K/min doesn't.
    const rich = await make(5_000);
    rich.b.mirvSaveTick(rich.mp, rich.game.ticks());
    expect(rich.b.mirvSaving).toBe(rich.bp);
    const poor = await make(50);
    poor.b.mirvSaveTick(poor.mp, poor.game.ticks());
    expect(poor.b.mirvSaving).toBe(null);
  });

  test("no saving against an ally or a player not far ahead", async () => {
    const a = await make(5_000);
    vi.spyOn(a.b, "holdsAlly").mockReturnValue(true);
    a.b.mirvSaveTick(a.mp, a.game.ticks());
    expect(a.b.mirvSaving).toBe(null);
    const c = await make(5_000);
    c.b.params = { ...c.b.params, mirvSave: 100 };
    c.b.mirvSaveTick(c.mp, c.game.ticks());
    expect(c.b.mirvSaving).toBe(null);
  });

  test("the lock stops AI builds, warships and nukes while saving", async () => {
    const { b, bp } = await make(5_000);
    let built = 0;
    const self: any = {
      structureBehavior: { player: { unitCount: () => 1 }, handleStructures: () => { built++; return true; } },
      warshipBehavior: { maybeSpawnWarship: () => { built++; return true; } },
      nukeBehavior: { maybeSendNuke: () => { built++; } },
    };
    b.patchMirvLock(self);
    b.mirvSaving = bp;
    self.structureBehavior.handleStructures();
    self.warshipBehavior.maybeSpawnWarship();
    self.nukeBehavior.maybeSendNuke();
    expect(built).toBe(0);
    b.mirvSaving = null;
    self.structureBehavior.handleStructures();
    expect(built).toBe(1);
  });

  test("mirvRich: piled-up gold MIRVs the biggest non-ally, graded by gold and its size", async () => {
    const run = async (goldX: number, w: number, ally = false) => {
      const me = new PlayerInfo("me", PlayerType.Human, null, "me");
      const op = new PlayerInfo("op", PlayerType.Human, null, "op");
      const game = await setup("big_plains", {}, [me, op]);
      const mp = game.player("me");
      const o = game.player("op");
      conquerRect(game, mp, 0, 0, 30, 30);
      conquerRect(game, o, 100, 100, w, 30); // far, not a runaway
      mp.setTroops(100_000);
      o.setTroops(100_000);
      mp.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
      const bot = new BotExecution("mr", new Nation(undefined, me), { ...DEFAULT_PARAMS, potW: 0, mirvSave: 2, mirvRich: 1.5 });
      bot.init(game);
      const b = bot as any;
      b.player = mp;
      if (ally) vi.spyOn(b, "holdsAlly").mockReturnValue(true);
      const cost = Number(game.unitInfo(UnitType.MIRV).cost(game, mp));
      mp.addGold(BigInt(Math.ceil(goldX * cost)) - mp.gold());
      let fired: any = null;
      b.mirvBehavior = { maybeSendMIRV: (t: any) => { fired = t; } };
      b.mirvSaveTick(mp, 3000);
      return fired === o;
    };
    expect(await run(2, 30)).toBe(true); // 2x the cost, same size: 2 >= 1.5
    expect(await run(1.1, 30)).toBe(false); // 1.1 x 1 < 1.5
    expect(await run(1.1, 45)).toBe(true); // 1.1 x 1.5 >= 1.5
    expect(await run(5, 15)).toBe(false); // half our land: never worth it
    expect(await run(2, 30, true)).toBe(false); // ally
    expect(await run(0.5, 60)).toBe(false); // can't afford
  });
});

describe("BotExecution wildSize", () => {
  test("an AI boat to a small wilderness carries only what the land costs", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const other = new PlayerInfo("other", PlayerType.Human, null, "other");
    const game = await setup("big_plains", {}, [me, other]);
    const mp = game.player("me");
    const op = game.player("other");
    const W = game.width(), H = game.height();
    conquerRect(game, mp, 0, 0, W, 100);
    conquerRect(game, op, 0, 100, W, H - 100);
    // a 10x10 wilderness inside our land
    for (let x = 50; x < 60; x++) for (let y = 40; y < 50; y++) mp.relinquish(game.ref(x, y));
    const run = async (params: Record<string, number>, tx = 55, ty = 45) => {
      const bot = new BotExecution("ws", new Nation(undefined, me), { ...DEFAULT_PARAMS, ...params });
      bot.init(game);
      const b = bot as any;
      b.player = mp;
      const sent: any[] = [];
      const spy = vi.spyOn(Object.getPrototypeOf(BotExecution.prototype), "tick").mockImplementation(() => {
        const e = new TransportShipExecution(mp, game.ref(tx, ty), 100_000);
        const o = new TransportShipExecution(mp, game.ref(10, 50), 100_000); // our own tile: untouched
        sent.push(e, o);
        game.addExecution(e, o);
      });
      b.sizedTick(mp, game.ticks());
      spy.mockRestore();
      return sent.map((e) => e.troops);
    };
    const land = (() => { let c = 0; for (let x = 50; x < 60; x++) for (let y = 40; y < 50; y++) c += game.map().terrainType(game.ref(x, y)) === 2 ? 24 : game.map().terrainType(game.ref(x, y)) === 1 ? 20 : 16; return c; })();
    expect(await run({ wildSize: 1.5 })).toEqual([Math.max(200, Math.ceil(1.5 * land)), 100_000]);
    // A wilderness over 4000 tiles keeps the AI size.
    for (let x = 0; x < W; x++) for (let y = 100; y < H; y++) op.relinquish(game.ref(x, y));
    expect((await run({ wildSize: 1.5 }, 10, 150))[0]).toBe(100_000);
  });
});


describe("BotExecution homeKeep", () => {
  async function world() {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const other = new PlayerInfo("other", PlayerType.Human, null, "other");
    const tribe = new PlayerInfo("tribe", PlayerType.Bot, null, "tribe");
    const game = await setup("big_plains", {}, [me, other, tribe]);
    const mp = game.player("me");
    const op = game.player("other");
    const tp = game.player("tribe");
    conquerRect(game, mp, 0, 0, 100, 100);
    conquerRect(game, op, 100, 0, 50, 100);
    conquerRect(game, tp, 0, 100, 10, 10);
    const bot = new BotExecution("hk", new Nation(undefined, me), { ...DEFAULT_PARAMS, homeKeep: 0.3 });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    b.reserveRatio = 0.13;
    const maxT = game.config().maxTroops(mp);
    mp.setTroops(0.8 * maxT);
    op.setTroops(0.5 * maxT);
    tp.setTroops(0.3 * maxT);
    // one tick of our logic issuing `sends`; returns what reached the game
    const tick = (sends: () => any[]) => {
      const got: any[] = [];
      const add = vi.spyOn(game as any, "addExecution").mockImplementation((...ex: any[]) => { got.push(...ex); });
      const body = vi.spyOn(b, "tickBody").mockImplementation(() => { game.addExecution(...sends()); });
      bot.tick(game.ticks());
      body.mockRestore();
      add.mockRestore();
      return got.map((e) => Math.round(e.startTroops ?? e.troops));
    };
    return { game, mp, op, tp, b, maxT, tick };
  }

  test("sends in one tick add up and never dip under the regen keep", async () => {
    const { mp, op, tp, b, maxT, tick } = await world();
    const s = Math.round(0.4 * maxT);
    // .8 - .4 = .4 >= .3 keep: first goes; the second would leave 0: held
    expect(tick(() => [new AttackExecution(s, mp, op.id()), new AttackExecution(s, mp, tp.id())])).toEqual([s]);
    expect(b.homeHeld).toBe(1);
    // .6 max asked, .5 above the keep: trimmed to it
    expect(tick(() => [new AttackExecution(Math.round(0.6 * maxT), mp, op.id())])).toEqual([Math.floor(mp.troops() - 0.3 * maxT)]);
    expect(b.homeTrimmed).toBe(1);
    // the defense floor wins when higher
    b.reserveRatio = 0.6;
    expect(tick(() => [new AttackExecution(Math.round(0.15 * maxT), mp, op.id())])).toEqual([Math.round(0.15 * maxT)]);
    expect(tick(() => [new AttackExecution(Math.round(0.4 * maxT), mp, op.id())])).toEqual([]);
  });

  test("troops attacking us stay home, unless we hit that attacker back", async () => {
    const { game, mp, op, tp, maxT, tick } = await world();
    void maxT;
    game.addExecution(new AttackExecution(Math.round(0.2 * maxT), op, mp.id()));
    game.executeNextTick();
    game.executeNextTick();
    const inc = mp.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    expect(inc).toBeGreaterThan(0);
    const s = Math.round(0.4 * maxT);
    const avail = mp.troops() - 0.3 * game.config().maxTroops(mp);
    // at the tribe: the incoming troops are kept on top of the regen keep
    const toTribe = tick(() => [new AttackExecution(s, mp, tp.id())]);
    const left = avail - inc;
    expect(toTribe).toEqual(left >= s ? [s] : left >= 0.5 * s ? [Math.floor(left)] : []);
    expect(toTribe[0] ?? 0).toBeLessThan(s);
    // at the attacker: our attack cancels its attack 1:1, nothing extra kept
    expect(tick(() => [new AttackExecution(s, mp, op.id())])).toEqual([s]);
  });

  test("a kill may go down to the reserve; boats count too; off by default", async () => {
    const { mp, tp, maxT, tick, b } = await world();
    tp.setTroops(0.1 * maxT);
    const s = Math.round(0.6 * maxT); // >= 2x the tribe, tribe < 20% of our land
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([s]);
    tp.setTroops(0.4 * maxT);
    expect(tick(() => [new TransportShipExecution(mp, (tp as any).tiles().values().next().value, s)])).toEqual([Math.floor(mp.troops() - 0.3 * maxT)]);
    b.params = { ...b.params, homeKeep: 0 };
    const big = Math.round(0.8 * maxT);
    expect(tick(() => [new AttackExecution(big, mp, tp.id())])).toEqual([big]);
  });

  test("minKeep: never below 20% of max troops, kills included, also without homeKeep", async () => {
    const { mp, tp, maxT, tick, b } = await world();
    tp.setTroops(0.1 * maxT);
    const s = Math.round(0.7 * maxT); // a kill: homeKeep alone would let it go down to the .13 reserve
    b.params = { ...b.params, minKeep: 0.2 };
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([Math.floor(mp.troops() - 0.2 * maxT)]);
    b.params = { ...b.params, homeKeep: 0 };
    expect(tick(() => [new AttackExecution(Math.round(0.8 * maxT), mp, tp.id())])).toEqual([Math.floor(mp.troops() - 0.2 * maxT)]);
  });

  test("minKeep: sends still on their way to the game count as spent", async () => {
    const { mp, tp, maxT, tick, b } = await world();
    tp.setTroops(0.1 * maxT);
    b.params = { ...b.params, minKeep: 0.2, homeKeep: 0 };
    const inflight = Math.round(0.3 * maxT);
    const s = Math.round(0.3 * maxT);
    b.inflightTroops = 0;
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([s]);
    b.inflightTroops = inflight;
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([Math.floor(mp.troops() - inflight - 0.2 * maxT)]);
    b.inflightTroops = mp.troops();
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([]);
  });

  test("minKeep: an enemy bomb on its way to our land raises the floor (it may land before the send)", async () => {
    const { game, mp, op, tp, maxT, tick, b } = await world();
    tp.setTroops(0.1 * maxT);
    b.params = { ...b.params, minKeep: 0.2, homeKeep: 0 };
    const s = Math.round(0.2 * maxT);
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([s]);
    op.buildUnit(UnitType.AtomBomb, game.ref(120, 50), { targetTile: game.ref(50, 50) });
    // the test config shrinks blasts to 1 tile; use the real atom bomb's
    vi.spyOn(game.config(), "nukeMagnitudes").mockReturnValue({ inner: 12, outer: 30 });
    const m = game.config().nukeMagnitudes(UnitType.AtomBomb);
    const q = 1 - (Math.PI * (m.inner ** 2 + m.outer ** 2)) / 2 / mp.numTilesOwned();
    const keep = q ** 5;
    const T = mp.troops();
    const avail = Math.min(T * keep - 0.2 * maxT, T - (0.2 * maxT) / keep);
    expect(avail).toBeGreaterThan(0.5 * s);
    expect(avail).toBeLessThan(s);
    // after the blast (before or after the send) at least 20% of max stays home
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([Math.floor(avail)]);
    // our own bombs don't count
    const mine = game.units(UnitType.AtomBomb)[0];
    mine.delete(false);
    mp.buildUnit(UnitType.AtomBomb, game.ref(50, 50), { targetTile: game.ref(60, 50) });
    expect(tick(() => [new AttackExecution(s, mp, tp.id())])).toEqual([s]);
  });
});

describe("BotExecution defPost spacing", () => {
  test("a new post never sits in an existing post's cover", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const other = new PlayerInfo("other", PlayerType.Human, null, "other");
    const game = await setup("big_plains", {}, [me, other]);
    const mp = game.player("me");
    const op = game.player("other");
    conquerRect(game, mp, 0, 0, 100, 200);
    conquerRect(game, op, 100, 0, 100, 200);
    mp.setTroops(100_000);
    op.setTroops(300_000);
    mp.addGold(100_000_000n);
    const R = game.config().defensePostRange();
    mp.buildUnit(UnitType.DefensePost, game.ref(95, 100), {});
    const bot = new BotExecution("dp", new Nation(undefined, me), { ...DEFAULT_PARAMS, defPost: 1 });
    bot.init(game);
    (bot as any).player = mp;
    const placed: number[] = [];
    for (let i = 0; i < 3; i++) {
      const add = vi.spyOn(game as any, "addExecution").mockImplementation((...ex: any[]) => {
        for (const e of ex) if (e.tile !== undefined) placed.push(e.tile);
      });
      (bot as any).defPostTick();
      add.mockRestore();
      // pretend it got built
      if (placed.length > i) mp.buildUnit(UnitType.DefensePost, placed[i], {});
    }
    expect(placed.length).toBeGreaterThan(0);
    const all = [game.ref(95, 100), ...placed];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(game.euclideanDistSquared(all[i], all[j])).toBeGreaterThanOrEqual((1.5 * R) ** 2);
  });
});

describe("BotExecution postSpread", () => {
  test("the Nation AI's post spots inside an existing post's cover are dropped", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const game = await setup("big_plains", {}, [me]);
    const mp = game.player("me");
    conquerRect(game, mp, 0, 0, 200, 200);
    mp.buildUnit(UnitType.DefensePost, game.ref(100, 100), {});
    const R = game.config().defensePostRange();
    const spots = [game.ref(100 + R, 100), game.ref(100 + Math.ceil(1.5 * R), 100), game.ref(10, 10)];
    const bot = new BotExecution("ps", new Nation(undefined, me), { ...DEFAULT_PARAMS, postSpread: 1.5 });
    bot.init(game);
    const sb: any = { player: mp, sampleTilesNearFront: () => [...spots] };
    (bot as any).patchPostSpread(sb);
    expect(sb.sampleTilesNearFront([], 25, UnitType.DefensePost)).toEqual(spots.slice(1));
    expect(sb.sampleTilesNearFront([], 25, UnitType.City)).toEqual(spots);
  });
});

// boatStrike (owner 2026-10-14: "ignoring overseas traitor targets"; attacks
// "must depend on enemys max troops and if its attacked by another nation too").
describe("BotExecution boatStrike", () => {
  const strikeSetup = async (isleTroops: (avail: number) => number, traitor = false, params: Record<string, number> = {}) => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const isle = new PlayerInfo("isle", PlayerType.Human, null, "isle");
    const game = await setup("ocean_and_land", {}, [me, isle], undefined, UseRealAttackLogic);
    const mp = game.player("me");
    const ip = game.player("isle");
    conquerRect(game, mp, 0, 0, 8, 16);
    conquerRect(game, ip, 14, 6, 2, 3);
    const bot = new BotExecution("bs", new Nation(undefined, me), {
      ...DEFAULT_PARAMS, boatStrike: 2, homeKeep: 0.3, ...params,
    });
    bot.init(game);
    const b = bot as any;
    b.player = mp;
    b.reserveRatio = 0.13;
    const maxT = game.config().maxTroops(mp);
    mp.setTroops(Math.floor(0.9 * maxT));
    const avail = mp.troops() - 0.3 * maxT;
    ip.setTroops(Math.floor(isleTroops(avail)));
    if (traitor) ip.markTraitor();
    return { game, mp, ip, b, avail };
  };
  const boats = (game: Game, mp: Player) => {
    game.executeNextTick();
    return mp.units(UnitType.TransportShip).map((u) => u.troops());
  };

  test("a weak far player gets one boat sized to beat its troops plus regen, from troops above homeKeep", async () => {
    const { game, mp, ip, b, avail } = await strikeSetup((a) => 0.2 * a);
    b.boatStrikeTick(game.ticks());
    const sent = boats(game, mp);
    expect(sent.length).toBe(1);
    expect(sent[0]).toBeGreaterThan(1.3 * ip.troops());
    expect(sent[0]).toBeLessThanOrEqual(avail);
    // 60 s cooldown per target
    b.boatStrikeTick(game.ticks());
    expect(boats(game, mp).length).toBe(1);
  });

  test("boatStrike 1 skips a clean far player but strikes a traitor", async () => {
    const clean = await strikeSetup((a) => 0.2 * a, false, { boatStrike: 1 });
    clean.b.boatStrikeTick(clean.game.ticks());
    expect(boats(clean.game, clean.mp).length).toBe(0);
    const tr = await strikeSetup((a) => 0.2 * a, true, { boatStrike: 1 });
    tr.b.boatStrikeTick(tr.game.ticks());
    expect(boats(tr.game, tr.mp).length).toBe(1);
  });

  test("a far player too strong for our spare troops is left alone", async () => {
    const { game, mp, b } = await strikeSetup((a) => 0.9 * a);
    b.boatStrikeTick(game.ticks());
    expect(boats(game, mp).length).toBe(0);
  });

  test("a traitor (debuffed) is struck at a strength a clean player is not", async () => {
    const clean = await strikeSetup((a) => 0.9 * a);
    clean.b.boatStrikeTick(clean.game.ticks());
    expect(boats(clean.game, clean.mp).length).toBe(0);
    const tr = await strikeSetup((a) => 0.9 * a, true);
    tr.b.boatStrikeTick(tr.game.ticks());
    expect(boats(tr.game, tr.mp).length).toBe(1);
  });

  test("others attacking the target ease it; under attack ourselves or off, no boat", async () => {
    const hit = await strikeSetup((a) => 0.9 * a);
    vi.spyOn(hit.ip, "incomingAttacks").mockReturnValue([{ attacker: () => ({}), troops: () => hit.ip.troops() }] as any);
    hit.b.boatStrikeTick(hit.game.ticks());
    expect(boats(hit.game, hit.mp).length).toBe(1);
    const busy = await strikeSetup((a) => 0.2 * a);
    vi.spyOn(busy.mp, "incomingAttacks").mockReturnValue([{ attacker: () => busy.ip, troops: () => busy.mp.troops() }] as any);
    busy.b.boatStrikeTick(busy.game.ticks());
    expect(boats(busy.game, busy.mp).length).toBe(0);
    const off = await strikeSetup((a) => 0.2 * a, false, { boatStrike: 0 });
    for (let i = 0; i < 40; i++) off.b.tickBody(off.game.ticks() + i);
    expect(off.mp.units(UnitType.TransportShip).length).toBe(0);
  });
});
