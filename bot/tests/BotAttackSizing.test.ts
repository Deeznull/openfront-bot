import {
  Nation,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  BotExecution,
  DEFAULT_PARAMS,
} from "@openfront/engine/execution/bot/BotExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test } from "vitest";
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
