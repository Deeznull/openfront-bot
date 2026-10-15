import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Nation, PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { BotExecution, DEFAULT_PARAMS } from "@openfront/engine/execution/bot/BotExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";

function conquerRect(game: Game, p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
}

async function capSetup(params: Partial<typeof DEFAULT_PARAMS>) {
  const infos = ["me", "a", "far"].map((n) => new PlayerInfo(n, PlayerType.Human, null, n));
  const game = await setup("big_plains", { difficulty: "Impossible" as any }, infos);
  const me = game.player("me"), a = game.player("a"), far = game.player("far");
  conquerRect(game, a, 0, 0, 20, 50);
  conquerRect(game, me, 20, 0, 20, 50);
  conquerRect(game, far, 150, 150, 20, 20); // no shared border
  const bot = new BotExecution("cap", new Nation(undefined, infos[0]), { ...DEFAULT_PARAMS, ...params });
  bot.init(game);
  (bot as any).player = me;
  return { game, bot, me, a, far };
}

describe("BotExecution capLand", () => {
  test("a strong player we don't border no longer freezes our send cap", async () => {
    const { bot, me, a, far } = await capSetup({ capLand: 1 });
    me.setTroops(100_000);
    a.setTroops(20_000);
    far.setTroops(500_000);
    (me as any).nearby = () => [a, far];
    const ab: any = { neighborTroopCap: () => 0 };
    (bot as any).patchCapLand(ab);
    expect(ab.neighborTroopCap()).toBe(100_000 - 18_000);
  });
});

describe("BotExecution stall tracker", () => {
  test("stalled only after 30 s at >= 95% of max troops without land gain", async () => {
    const { game, bot, me } = await capSetup({});
    let clock = 100;
    (game as any).elapsedGameSeconds = () => clock;
    const max = game.config().maxTroops(me);
    me.setTroops(0.5 * max);
    (bot as any).trackStall(me);
    me.setTroops(0.97 * max);
    clock = 120;
    (bot as any).trackStall(me);
    expect(bot.stalled).toBe(false);
    clock = 131;
    (bot as any).trackStall(me);
    expect(bot.stalled).toBe(true);
    me.setTroops(0.5 * max);
    (bot as any).trackStall(me);
    expect(bot.stalled).toBe(false);
  });
});

describe("BotExecution earlyCity", () => {
  async function early() {
    const { game, bot, me } = await capSetup({ earlyCity: 3, earlyCityMin: 5 });
    const built: string[] = [];
    const owned: Record<string, number> = {};
    (me as any).unitsOwned = (t: string) => owned[t] ?? 0;
    const sb: any = {
      player: me,
      doHandleStructures: () => { built.push("orig"); return true; },
      maybeSpawnStructure: (t: string) => { built.push(t); return true; },
    };
    (bot as any).patchEarlyCity(sb);
    return { game, sb, built, owned };
  }

  test("builds cities first, one port after the first city when coastal", async () => {
    const { game, sb, built, owned } = await early();
    let ticks = 100;
    (game as any).ticks = () => ticks;
    (game as any).sharedWaterComponents = () => new Set([1]);
    sb.doHandleStructures();
    owned[UnitType.City] = 1;
    sb.doHandleStructures();
    owned[UnitType.Port] = 1;
    sb.doHandleStructures();
    expect(built).toEqual([UnitType.City, UnitType.Port, UnitType.City]);
  });

  test("landlocked: no port; engine order after the target or the time limit", async () => {
    const { game, sb, built, owned } = await early();
    let ticks = 100;
    (game as any).ticks = () => ticks;
    (game as any).sharedWaterComponents = () => null;
    owned[UnitType.City] = 1;
    sb.doHandleStructures();
    owned[UnitType.City] = 3;
    sb.doHandleStructures();
    owned[UnitType.City] = 1;
    ticks = 5 * 600;
    sb.doHandleStructures();
    expect(built).toEqual([UnitType.City, "orig", "orig"]);
  });
});

describe("BotExecution defSum", () => {
  test("the defense floor counts the other bordering hostiles' troops", async () => {
    const { game, bot, me, a } = await capSetup({ defK: 1, defCap: 0.9, defSum: 0.5, reserve: 0 });
    const infos = new PlayerInfo("b", PlayerType.Human, null, "b");
    const b = game.addPlayer(infos);
    conquerRect(game, b, 40, 0, 10, 50);
    const maxT = game.config().maxTroops(me);
    a.setTroops(0.2 * maxT);
    b.setTroops(0.1 * maxT);
    (bot as any).updateDefenseFloor();
    expect((bot as any).reserveRatio).toBeCloseTo(0.25, 5);
    (bot as any).params.defSum = 0;
    (bot as any).updateDefenseFloor();
    expect((bot as any).reserveRatio).toBeCloseTo(0.2, 5);
  });
});

describe("BotExecution capBot", () => {
  async function capBot(stalled: boolean) {
    const { bot, me, a } = await capSetup({ capBot: 0.3 });
    me.setTroops(100_000);
    bot.stalled = stalled;
    const barb: any = { isPlayer: () => true, type: () => PlayerType.Bot };
    const ab: any = {
      troopSendCap: () => 0,
      calculateAttackTroops(target: any) {
        return this.troopSendCap(target);
      },
    };
    (bot as any).patchCapBot(ab);
    return { ab, barb, a };
  }

  test("stalled: barbarian sends may use capBot x our troops", async () => {
    const { ab, barb, a } = await capBot(true);
    expect(ab.calculateAttackTroops(barb)).toBe(30_000);
    expect(ab.calculateAttackTroops(a)).toBe(0); // humans keep the cap
    expect(ab.troopSendCap()).toBe(0); // flag cleared after the call
  });

  test("not stalled: cap unchanged", async () => {
    const { ab, barb } = await capBot(false);
    expect(ab.calculateAttackTroops(barb)).toBe(0);
  });
});

describe("BotExecution nukeGate", () => {
  test("blocks unprovoked nukes at a much stronger player only", async () => {
    const { bot, me, a } = await capSetup({ nukeGate: 0.9 });
    me.setTroops(100_000);
    const sent: number[] = [];
    const nb: any = { sendNuke: (_t: any, _y: any, target: Player) => sent.push(target.troops()) };
    let incoming: any[] = [];
    (me as any).incomingAttacks = () => incoming;
    (bot as any).patchNukeGate(nb, me);
    a.setTroops(220_000);
    nb.sendNuke(0, UnitType.AtomBomb, a);
    expect(sent).toEqual([]);
    incoming = [{ attacker: () => a }];
    nb.sendNuke(0, UnitType.AtomBomb, a); // retaliation still allowed
    (bot as any).params.nukeProv = 1;
    nb.sendNuke(0, UnitType.AtomBomb, a); // ...unless nukeProv
    (bot as any).params.nukeProv = 0;
    incoming = [];
    a.setTroops(80_000);
    nb.sendNuke(0, UnitType.AtomBomb, a);
    expect(sent).toEqual([220_000, 80_000]);
  });
});

describe("BotExecution allyHStrong", () => {
  test("asks only bordering humans that are strong or attacking us", async () => {
    const { bot, me, a, far } = await capSetup({ allyHStrong: 1 });
    me.setTroops(100_000);
    far.setTroops(500_000);
    const ask = (o: Player) => (bot as any).askHuman(me, o);
    a.setTroops(90_000);
    expect(ask(a)).toBe(true); // strong, bordering
    expect(ask(far)).toBe(false); // strong but no border
    a.setTroops(50_000);
    expect(ask(a)).toBe(false);
    (me as any).incomingAttacks = () => [{ attacker: () => a }];
    expect(ask(a)).toBe(true); // attacking us
    (bot as any).params.allyHStrong = 0;
    expect(ask(a)).toBe(false);
  });
});

describe("BotExecution allyVid", () => {
  async function vid(params: Partial<typeof DEFAULT_PARAMS>) {
    const s = await capSetup({ allySelect: 1, boxFront: 0, ...params });
    const asked: string[] = [];
    (s.game as any).addExecution = (e: any) => {
      if (e.constructor.name === "AllianceRequestExecution") asked.push(e.recipientID ?? e.recipient ?? "?");
    };
    (s.me as any).canSendAllianceRequest = () => true;
    s.me.setTroops(100_000);
    s.a.setTroops(60_000); // "ok" bordering human
    s.far.setTroops(60_000); // not near
    return { ...s, asked };
  }

  test("asks a bordering human; base allySelect does not ask humans", async () => {
    const on = await vid({ allyVid: 1 });
    (on.bot as any).choosyDiplomacy(on.me, 20);
    expect(on.asked.length).toBe(1);
    const off = await vid({});
    (off.bot as any).choosyDiplomacy(off.me, 20);
    expect(off.asked.length).toBe(0);
  });

  test("a far human at war with someone else is asked too (AL-016)", async () => {
    const s = await vid({ allyVid: 1 });
    (s.far as any).incomingAttacks = () => [{ attacker: () => s.a }];
    (s.bot as any).choosyDiplomacy(s.me, 20);
    expect(s.asked.length).toBe(2);
  });

  test("re-asks after 30 s, then 60 s", async () => {
    const s = await vid({ allyVid: 1 });
    (s.bot as any).choosyDiplomacy(s.me, 20);
    (s.bot as any).choosyDiplomacy(s.me, 300);
    expect(s.asked.length).toBe(1);
    (s.bot as any).choosyDiplomacy(s.me, 320);
    expect(s.asked.length).toBe(2);
    (s.bot as any).choosyDiplomacy(s.me, 900);
    expect(s.asked.length).toBe(2);
    (s.bot as any).choosyDiplomacy(s.me, 920);
    expect(s.asked.length).toBe(3);
  });

  test("no ask to a top-2 human after 5:00 (AL-018)", async () => {
    const s = await vid({ allyVid: 1 });
    (s.game as any).elapsedGameSeconds = () => 400;
    (s.bot as any).choosyDiplomacy(s.me, 20);
    expect(s.asked.length).toBe(0); // a and far are the only other players, so both are top 2
  });
});

describe("BotExecution earlySilo", () => {
  async function silo(gold: number) {
    const { game, bot, me } = await capSetup({ earlySilo: 7 });
    const built: string[] = [];
    let can = false;
    (me as any).unitsOwned = () => 0;
    (me as any).gold = () => BigInt(gold);
    const sb: any = {
      player: me,
      doHandleStructures: () => { built.push("orig"); return true; },
      maybeSpawnStructure: (t: string) => { if (!can) return false; built.push(t); return true; },
    };
    (bot as any).patchSilo(sb);
    let ticks = 6 * 600;
    (game as any).ticks = () => ticks;
    return { game, sb, built, setTicks: (t: number) => (ticks = t), setCan: (c: boolean) => (can = c), me };
  }

  test("engine order before the minute, then a silo when affordable", async () => {
    const s = await silo(10_000_000);
    expect(s.sb.doHandleStructures()).toBe(true);
    s.setTicks(7 * 600);
    s.setCan(true);
    s.sb.doHandleStructures();
    expect(s.built).toEqual(["orig", UnitType.MissileSilo]);
  });

  test("saves for the silo once half-affordable, else keeps building", async () => {
    const cost = 1_000_000;
    const rich = await silo(0.6 * cost);
    (rich.game as any).unitInfo = () => ({ cost: () => BigInt(cost) });
    rich.setTicks(7 * 600);
    expect(rich.sb.doHandleStructures()).toBe(false);
    expect(rich.built).toEqual([]);
    const poor = await silo(0.2 * cost);
    (poor.game as any).unitInfo = () => ({ cost: () => BigInt(cost) });
    poor.setTicks(7 * 600);
    poor.sb.doHandleStructures();
    expect(poor.built).toEqual(["orig"]);
  });
});

describe("BotExecution counterNuke", () => {
  test("a nuke aimed at our land gets one nuke back at its owner, bypassing nukeGate", async () => {
    const { game, bot, me, a, far } = await capSetup({ counterNuke: 1, nukeGate: 0.9, nukeProv: 1 });
    me.setTroops(100_000);
    a.setTroops(500_000);
    const targets: Player[] = [];
    const nb: any = {
      atomBombsLaunched: 0,
      findBestNukeTarget: () => far,
      sendNuke: (_t: any, _y: any, target: Player) => { targets.push(target); nb.atomBombsLaunched++; },
      maybeSendNuke() { this.sendNuke(0, UnitType.AtomBomb, this.findBestNukeTarget()); },
    };
    (bot as any).patchNukeGate(nb, me);
    (bot as any).nukeBehavior = nb;
    (me as any).unitCount = () => 1;
    const nukes = [
      { id: () => 1, owner: () => a, targetTile: () => game.ref(30, 25) }, // our land
      { id: () => 2, owner: () => far, targetTile: () => game.ref(155, 155) }, // far's own land
    ];
    (game as any).units = () => nukes;
    (bot as any).counterNukeTick(100);
    (bot as any).counterNukeTick(110);
    expect(targets).toEqual([a]);
    expect((bot as any).counterNukes).toBe(1);
    expect(nb.findBestNukeTarget()).toBe(far); // normal target pick restored
    a.setTroops(500_000);
    nb.sendNuke(0, UnitType.AtomBomb, a); // outside a counter the gate still blocks it
    expect(targets).toEqual([a]);
  });
});

describe("BotExecution lapseStrike", () => {
  test("hits a weaker bordering ex-ally once when the alliance lapses", async () => {
    const { game, bot, me, a } = await capSetup({ lapseStrike: 0.8 });
    me.setTroops(100_000);
    a.setTroops(40_000);
    const sent: any[] = [];
    (game as any).addExecution = (e: any) => sent.push(e);
    let allies: Player[] = [a];
    (me as any).alliances = () => allies.map((o) => ({ other: () => o }));
    (bot as any).lapseStrikeTick(10);
    expect(sent.length).toBe(0);
    allies = [];
    (bot as any).lapseStrikeTick(20);
    (bot as any).lapseStrikeTick(30);
    expect(sent.length).toBe(1);
    expect(sent[0].constructor.name).toBe("AttackExecution");
    expect((bot as any).lapseStrikes).toBe(1);
  });

  test("no strike on a stronger ex-ally", async () => {
    const { game, bot, me, a } = await capSetup({ lapseStrike: 0.8 });
    me.setTroops(100_000);
    a.setTroops(90_000);
    const sent: any[] = [];
    (game as any).addExecution = (e: any) => sent.push(e);
    let allies: Player[] = [a];
    (me as any).alliances = () => allies.map((o) => ({ other: () => o }));
    (bot as any).lapseStrikeTick(10);
    allies = [];
    (bot as any).lapseStrikeTick(20);
    expect(sent.length).toBe(0);
  });
});

describe("BotExecution betrayOk", () => {
  async function bt() {
    const s = await capSetup({ betray: 0, betrayOk: 0.5, betrayMin: 10 });
    s.me.setTroops(100_000);
    const broke: Player[] = [];
    (s.me as any).isAlliedWith = () => true;
    (s.me as any).allianceWith = (o: Player) => ({ o });
    (s.me as any).breakAlliance = (al: any) => broke.push(al.o);
    let ticks = 11 * 600;
    (s.game as any).ticks = () => ticks;
    const al: any = {};
    (s.bot as any).patchBetrayOk(al);
    return { ...s, al, broke, setTicks: (t: number) => (ticks = t) };
  }

  test("betrays a much weaker, smaller ally late; not early, not a strong one", async () => {
    const s = await bt();
    s.a.setTroops(30_000); // a: 1000 tiles vs our 1000 -> too big
    expect(s.al.maybeBetray(s.a)).toBe(false);
    (s.a as any).numTilesOwned = () => 500;
    expect(s.al.maybeBetray(s.a)).toBe(true);
    expect(s.broke).toEqual([s.a]);
    s.setTicks(5 * 600);
    expect(s.al.maybeBetray(s.a)).toBe(false); // too early
    s.setTicks(11 * 600);
    s.a.setTroops(60_000);
    expect(s.al.maybeBetray(s.a)).toBe(false); // not weak enough
  });

  test("graded: the victim's bordering helpers and a big non-ally threat block it", async () => {
    const s = await bt();
    (s.bot as any).params.betrayGrade = 1;
    (s.me as any).allianceWith = (o: Player) => ({ o, expiresAt: () => 1e9, agreedToExtend: () => true });
    (s.me as any).isAlliedWith = (o: Player) => o === s.a;
    s.a.setTroops(30_000);
    (s.a as any).numTilesOwned = () => 500;
    s.far.setTroops(50_000);
    (s.a as any).allies = () => [s.far];
    (s.me as any).sharesBorderWith = () => true;
    (s.me as any).nearby = () => [s.a];
    expect(s.al.maybeBetray(s.a)).toBe(false); // 30k + 25k >= 0.5 x 100k
    (s.a as any).allies = () => [];
    expect(s.al.maybeBetray(s.a)).toBe(true);
    s.far.setTroops(300_000);
    (s.me as any).nearby = () => [s.a, s.far];
    expect(s.al.maybeBetray(s.a)).toBe(false); // far: 300k > 2.5x ours
  });

  test("never betrays a tribe", async () => {
    const s = await bt();
    (s.a as any).type = () => PlayerType.Bot;
    s.a.setTroops(1_000);
    (s.a as any).numTilesOwned = () => 10;
    expect(s.al.maybeBetray(s.a)).toBe(false);
  });
});

describe("BotExecution traitorK", () => {
  async function ts(k = 1) {
    const s = await capSetup({ traitorK: k, reserve: 0 });
    (s.game as any).isSpawnImmunityActive = () => false;
    s.me.setTroops(100_000);
    const sent: any[] = [];
    (s.game as any).addExecution = (e: any) => sent.push(e);
    const traitor = (p: Player) => {
      (p as any).isTraitor = () => true;
      (p as any).getTraitorRemainingTicks = () => 250;
    };
    return { ...s, sent, traitor };
  }

  test("hits a bordering traitor under the gate once per window; not a clean or strong one", async () => {
    const s = await ts(1);
    s.a.setTroops(90_000);
    (s.bot as any).traitorStrikeTick(10);
    expect(s.sent.length).toBe(0); // a is no traitor
    s.traitor(s.a);
    (s.bot as any).traitorStrikeTick(20);
    expect(s.sent.length).toBe(1);
    expect(s.sent[0].constructor.name).toBe("AttackExecution");
    (s.bot as any).traitorStrikeTick(30);
    expect(s.sent.length).toBe(1); // one hit per debuff window
    s.a.setTroops(120_000);
    (s.bot as any).traitorStrikeTick(400);
    expect(s.sent.length).toBe(1); // above 1.0x our available troops
    expect((s.bot as any).traitorStrikes).toBe(1);
  });

  test("traitorK 1.5 loosens the gate; others' attacks on the traitor loosen it too", async () => {
    const s = await ts(1.5);
    s.traitor(s.a);
    s.a.setTroops(140_000);
    (s.bot as any).traitorStrikeTick(10);
    expect(s.sent.length).toBe(1);
    const t = await ts(1);
    t.traitor(t.a);
    t.a.setTroops(150_000);
    (t.bot as any).traitorStrikeTick(10);
    expect(t.sent.length).toBe(0);
    (t.a as any).incomingAttacks = () => [{ attacker: () => t.far, troops: () => 150_000 }];
    (t.bot as any).traitorStrikeTick(20);
    expect(t.sent.length).toBe(1); // busy: 150k x 0.5 < 100k
  });

  test("holds while under attack, near the debuff end, or a stronger hostile borders us", async () => {
    const s = await ts(1);
    s.traitor(s.a);
    s.a.setTroops(50_000);
    (s.me as any).incomingAttacks = () => [{ troops: () => 40_000 }];
    (s.bot as any).traitorStrikeTick(10);
    expect(s.sent.length).toBe(0);
    (s.me as any).incomingAttacks = () => [];
    (s.a as any).getTraitorRemainingTicks = () => 50;
    (s.bot as any).traitorStrikeTick(20);
    expect(s.sent.length).toBe(0);
    (s.a as any).getTraitorRemainingTicks = () => 250;
    s.far.setTroops(300_000);
    (s.me as any).nearby = () => [s.a, s.far];
    (s.me as any).sharesBorderWith = () => true;
    (s.bot as any).traitorStrikeTick(30);
    expect(s.sent.length).toBe(0); // 300k > 2.5x ours
    (s.far as any).outgoingAttacks = () => [{ troops: () => 300_000 }];
    (s.bot as any).traitorStrikeTick(40);
    expect(s.sent.length).toBe(1); // busy attacking others: 150k
  });

  test("the traitor's allies that border us or are strong add to its strength", async () => {
    const s = await ts(1);
    s.traitor(s.a);
    s.a.setTroops(60_000);
    (s.a as any).allies = () => [s.far];
    s.far.setTroops(200_000);
    (s.bot as any).traitorStrikeTick(10);
    expect(s.sent.length).toBe(0); // 60k + 0.25 x 200k (strong, far) = 110k > 100k
    s.far.setTroops(90_000);
    (s.bot as any).traitorStrikeTick(20);
    expect(s.sent.length).toBe(1); // a weak far ally doesn't count
    const t = await ts(1);
    t.traitor(t.a);
    t.a.setTroops(60_000);
    t.far.setTroops(90_000);
    (t.a as any).allies = () => [t.far];
    (t.me as any).sharesBorderWith = () => true;
    (t.bot as any).traitorStrikeTick(10);
    expect(t.sent.length).toBe(0); // bordering ally: 60k + 45k > 100k
  });

  test("threat guard: allies don't count; a pressured neighbour counts half", async () => {
    const s = await ts(1);
    s.traitor(s.a);
    s.a.setTroops(50_000);
    s.far.setTroops(300_000);
    (s.me as any).nearby = () => [s.a, s.far];
    (s.me as any).sharesBorderWith = () => true;
    (s.me as any).isAlliedWith = (o: Player) => o === s.far;
    (s.bot as any).traitorStrikeTick(10);
    expect(s.sent.length).toBe(1); // far is our ally
    const t = await ts(1);
    t.traitor(t.a);
    t.a.setTroops(50_000);
    t.far.setTroops(300_000);
    const big = { isPlayer: () => true, type: () => PlayerType.Human, troops: () => 400_000 };
    (t.me as any).nearby = () => [t.a, t.far];
    (t.me as any).sharesBorderWith = () => true;
    (t.far as any).isFriendly = () => false;
    (t.bot as any).traitorStrikeTick(10);
    expect(t.sent.length).toBe(0);
    (t.far as any).nearby = () => [big];
    (t.bot as any).traitorStrikeTick(20);
    expect(t.sent.length).toBe(1); // far is pressed by a 400k: counts 150k
  });

  test("an ally who betrayed someone else is dropped for free, then hit", async () => {
    const s = await ts(1);
    s.a.setTroops(50_000);
    s.me.createAllianceRequest(s.a)?.accept();
    s.a.createAllianceRequest(s.far)?.accept();
    expect(s.me.isAlliedWith(s.a)).toBe(true);
    s.a.breakAlliance(s.a.allianceWith(s.far)!);
    expect(s.a.isTraitor()).toBe(true);
    (s.bot as any).traitorStrikeTick(10);
    expect(s.me.isAlliedWith(s.a)).toBe(false);
    expect(s.me.isTraitor()).toBe(false); // breaking with a traitor is free
    expect(s.sent.length).toBe(1);
  });

  test("a strong traitor ally is kept; a tribe is never hit; AFK uses the same gate", async () => {
    const s = await ts(1);
    s.a.setTroops(150_000);
    s.me.createAllianceRequest(s.a)?.accept();
    s.a.createAllianceRequest(s.far)?.accept();
    s.a.breakAlliance(s.a.allianceWith(s.far)!);
    (s.bot as any).traitorStrikeTick(10);
    expect(s.me.isAlliedWith(s.a)).toBe(true);
    expect(s.sent.length).toBe(0);
    const t = await ts(1);
    t.traitor(t.a);
    t.a.setTroops(1_000);
    (t.a as any).type = () => PlayerType.Bot;
    (t.bot as any).traitorStrikeTick(10);
    expect(t.sent.length).toBe(0);
    const u = await ts(1);
    (u.a as any).isDisconnected = () => true;
    u.a.setTroops(120_000);
    (u.bot as any).traitorStrikeTick(10);
    expect(u.sent.length).toBe(0);
    u.a.setTroops(80_000);
    (u.bot as any).traitorStrikeTick(20);
    expect(u.sent.length).toBe(1);
  });

  test("expiry: a bordering ally that doesn't renew is hit at expiry under 0.8x; a renewing one is not", async () => {
    const s = await ts(1);
    s.a.setTroops(70_000);
    let allied = true;
    let agreed = false;
    (s.game as any).ticks = () => 1000;
    (s.me as any).isAlliedWith = (o: Player) => allied && o === s.a;
    (s.me as any).isFriendly = (o: Player) => o === s.me || (allied && o === s.a);
    (s.me as any).allianceWith = (o: Player) =>
      allied && o === s.a ? { expiresAt: () => 1100, agreedToExtend: () => agreed } : null;
    (s.bot as any).traitorStrikeTick(1000);
    expect(s.sent.length).toBe(0); // still allied
    allied = false;
    (s.bot as any).traitorStrikeTick(1110);
    expect(s.sent.length).toBe(1); // 70k < 0.8 x 100k
    const t = await ts(1);
    t.a.setTroops(70_000);
    let allied2 = true;
    (t.game as any).ticks = () => 1000;
    (t.me as any).isAlliedWith = (o: Player) => allied2 && o === t.a;
    (t.me as any).isFriendly = (o: Player) => o === t.me || (allied2 && o === t.a);
    (t.me as any).allianceWith = (o: Player) =>
      allied2 && o === t.a ? { expiresAt: () => 1100, agreedToExtend: () => true } : null;
    (t.bot as any).traitorStrikeTick(1000);
    allied2 = false;
    (t.bot as any).traitorStrikeTick(1110);
    expect(t.sent.length).toBe(0); // it had agreed to renew: not pre-armed
  });

  test("a leaving ally of ours counts as a threat; a target's leaving ally adds no strength", async () => {
    const s = await ts(1);
    s.traitor(s.a);
    s.a.setTroops(50_000);
    s.far.setTroops(300_000);
    (s.game as any).ticks = () => 1000;
    (s.me as any).nearby = () => [s.a, s.far];
    (s.me as any).sharesBorderWith = () => true;
    (s.me as any).isAlliedWith = (o: Player) => o === s.far;
    (s.me as any).isFriendly = (o: Player) => o === s.me || o === s.far;
    (s.me as any).allianceWith = (o: Player) => (o === s.far ? { expiresAt: () => 1100, agreedToExtend: () => false } : null);
    (s.bot as any).traitorStrikeTick(1000);
    expect(s.sent.length).toBe(0); // far is leaving: 300k > 2.5x ours
    const t = await ts(1);
    t.traitor(t.a);
    t.a.setTroops(60_000);
    t.far.setTroops(200_000);
    (t.game as any).ticks = () => 1000;
    (t.a as any).allies = () => [t.far];
    (t.a as any).allianceWith = (o: Player) => (o === t.far ? { expiresAt: () => 1100, agreedToExtend: () => false } : null);
    (t.bot as any).traitorStrikeTick(1000);
    expect(t.sent.length).toBe(1); // far is leaving a: no help counted
  });
});

describe("BotExecution final gap arms", () => {
  async function arm(params: Partial<typeof DEFAULT_PARAMS>) {
    const s = await capSetup({ reserve: 0, ...params });
    (s.game as any).isSpawnImmunityActive = () => false;
    (s.game as any).inSpawnPhase = () => false;
    s.me.setTroops(100_000);
    const sent: any[] = [];
    (s.game as any).addExecution = (e: any) => sent.push(e);
    return { ...s, sent };
  }

  test("fixGap: a nuke aim whose outer blast holds our boat or warship is refused", async () => {
    const s = await arm({ fixGap: 1 });
    const outer = s.game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
    let land = false;
    const nb: any = { blastHitsFriendlyLand: () => land };
    (s.bot as any).patchShipGuard(nb, s.me);
    (s.me as any).units = () => [{ tile: () => s.game.ref(100, 100) }];
    expect(nb.blastHitsFriendlyLand(s.game.ref(100 + outer - 1, 100), UnitType.AtomBomb)).toBe(true);
    expect(nb.blastHitsFriendlyLand(s.game.ref(100 + outer + 2, 100), UnitType.AtomBomb)).toBe(false);
    land = true;
    expect(nb.blastHitsFriendlyLand(s.game.ref(100 + outer + 2, 100), UnitType.AtomBomb)).toBe(true);
  });

  test("defPost: a post on the front of a strong non-ally, up to ceil(threat/ours); none when poor or weak", async () => {
    const s = await arm({ defPost: 1 });
    (s.me as any).nearby = () => [s.a];
    s.me.addGold(1_000_000n);
    s.a.setTroops(50_000);
    (s.bot as any).defPostTick();
    expect(s.sent.length).toBe(0); // weak neighbour, no attack
    s.a.setTroops(150_000);
    (s.bot as any).defPostTick();
    expect(s.sent.length).toBe(1);
    expect(s.sent[0].constructor.name).toBe("ConstructionExecution");
    // two posts already near that front: ceil(1.5) = 2 is enough
    const near = { tile: () => s.game.ref(20, 10) };
    (s.me as any).units = (t: any) => (t === UnitType.DefensePost ? [near, near] : []);
    (s.bot as any).defPostTick();
    expect(s.sent.length).toBe(1);
    (s.me as any).units = () => [];
    (s.me as any).gold = () => 1n;
    (s.bot as any).defPostTick();
    expect(s.sent.length).toBe(1); // can't keep half our gold
    expect((s.bot as any).defPosts).toBe(1);
  });

  test("defPost: a land attack >= 0.25x ours triggers a post even from a weaker neighbour", async () => {
    const s = await arm({ defPost: 1 });
    (s.me as any).nearby = () => [s.a];
    s.me.addGold(1_000_000n);
    s.a.setTroops(50_000);
    (s.me as any).incomingAttacks = () => [{ attacker: () => s.a, sourceTile: () => null, troops: () => 30_000 }];
    (s.bot as any).defPostTick();
    expect(s.sent.length).toBe(1);
  });

  test("richTarget: from 5:00 a much richer gate-passing neighbour is taken; a rich silo owner is vetoed", async () => {
    const s = await arm({ pvpRatio: 1.2, richTarget: 1 });
    let ticks = 4000;
    (s.game as any).ticks = () => ticks;
    (s.me as any).nearby = () => [s.a, s.far];
    (s.me as any).sharesBorderWith = () => true;
    (s.me as any).gold = () => 0n;
    s.a.setTroops(60_000);
    s.far.setTroops(60_000);
    let aGold = 0n, farGold = 5_000_000n;
    (s.a as any).gold = () => aGold;
    (s.far as any).gold = () => farGold;
    const ab: any = { sendAttack: (t: Player) => t };
    (s.bot as any).patchPvp(ab);
    expect(ab.sendAttack(s.a)).toBe(s.far);
    farGold = 50_000n;
    expect(ab.sendAttack(s.a)).toBe(s.a); // bonus gap below richW
    ticks = 2000;
    farGold = 5_000_000n;
    expect(ab.sendAttack(s.a)).toBe(s.a); // before 5:00
    ticks = 4000;
    aGold = 20_000_000n;
    farGold = 0n;
    (s.a as any).unitCount = (t: any) => (t === UnitType.MissileSilo ? 1 : 0);
    expect(ab.sendAttack(s.a)).toBe(s.far); // veto, any gate-passing neighbour instead
    s.far.setTroops(90_000);
    expect(ab.sendAttack(s.a)).toBe(false); // veto, no alternative passes the gate
    s.a.setTroops(40_000);
    expect(ab.sendAttack(s.a)).toBe(s.a); // 2x its troops: no veto
    expect((s.bot as any).richVetoes).toBe(1);
  });

  test("mirvBank: MIRV the leader when rich and safe, then land-attack after impact; 60 s cooldown", async () => {
    const s = await arm({ mirvBank: 1 });
    const fired: Player[] = [];
    (s.bot as any).mirvBehavior = { maybeSendMIRV: (p: Player) => fired.push(p) };
    (s.me as any).unitCount = (t: any) => (t === UnitType.MissileSilo ? 1 : 0);
    (s.me as any).gold = () => 100_000_000n;
    (s.me as any).canBuild = (_t: any, tile: any) => tile;
    let live: any[] = [];
    (s.me as any).units = () => live;
    s.a.setTroops(50_000);
    (s.bot as any).mirvBankTick(1000);
    expect(fired.length).toBe(0); // before 15:00 with a small land share
    (s.me as any).incomingAttacks = () => [{ attacker: () => s.far, troops: () => 30_000, sourceTile: () => null }];
    (s.bot as any).mirvBankTick(9000);
    expect(fired.length).toBe(0); // under attack
    (s.me as any).incomingAttacks = () => [];
    (s.bot as any).mirvBankTick(9000);
    expect(fired).toEqual([s.a]);
    live = [{}];
    (s.bot as any).mirvBankTick(9050);
    expect(s.sent.length).toBe(0); // warheads in flight
    live = [];
    (s.bot as any).mirvBankTick(9060);
    expect(s.sent.length).toBe(1);
    expect(s.sent[0].constructor.name).toBe("AttackExecution");
    (s.bot as any).mirvBankTick(9100);
    expect(fired.length).toBe(1); // cooldown
    expect((s.bot as any).mirvStrikes).toBe(1);
  });

  test("boatChain: one boat 10-30 s into a land attack on a weaker player; once per 60 s", async () => {
    const s = await arm({ boatChain: 1 });
    (s.me as any).outgoingAttacks = () => [{ sourceTile: () => null, target: () => s.a }];
    (s.bot as any).chainLanding = () => s.game.ref(5, 5);
    s.a.setTroops(50_000);
    (s.bot as any).boatChainTick(10);
    expect(s.sent.length).toBe(0); // just opened
    (s.bot as any).boatChainTick(120);
    expect(s.sent.length).toBe(1);
    expect(s.sent[0].constructor.name).toBe("TransportShipExecution");
    (s.bot as any).boatChainTick(200);
    expect(s.sent.length).toBe(1); // once per 60 s
    s.a.setTroops(90_000);
    (s.bot as any).boatChainTick(800);
    expect(s.sent.length).toBe(1); // too strong (and past 30 s)
  });

  test("boatChain: no landing on a landlocked target", async () => {
    const s = await arm({ boatChain: 1 });
    expect((s.bot as any).chainLanding(s.me, s.a)).toBe(null);
  });
});

describe("BotExecution port arms", () => {
  async function arm(params: Partial<typeof DEFAULT_PARAMS>) {
    const s = await capSetup({ reserve: 0, ...params });
    (s.game as any).isSpawnImmunityActive = () => false;
    (s.game as any).inSpawnPhase = () => false;
    s.me.setTroops(100_000);
    const sent: any[] = [];
    (s.game as any).addExecution = (e: any) => sent.push(e);
    return { ...s, sent };
  }

  test("renewLead: renewal waits until renewLead s are left; off = as soon as the 30 s window opens", async () => {
    const off = await arm({});
    const lead = await arm({ renewLead: 26 });
    const a = { expiresAt: () => 1000 };
    expect((off.bot as any).renewDue(a, 700)).toBe(true);
    expect((off.bot as any).renewDue(a, 699)).toBe(false);
    expect((lead.bot as any).renewDue(a, 720)).toBe(false);
    expect((lead.bot as any).renewDue(a, 740)).toBe(true);
  });

  test("humanAccept: refuse a weak traitor or a small bordering human; a strong one is always welcome", async () => {
    const s = await arm({ humanAccept: 1 });
    const no = (o: Player, k: string) => (s.bot as any).humanNo(s.me, o, k, null);
    expect(no(s.a, "ok")).toBe(false); // same size neighbour
    (s.a as any).numTilesOwned = () => 400;
    expect(no(s.a, "ok")).toBe(true); // bordering, under half our land
    expect(no(s.a, "strong")).toBe(false);
    expect(no(s.far, "ok")).toBe(false); // small but not bordering
    (s.far as any).isTraitor = () => true;
    expect(no(s.far, "ok")).toBe(true);
    expect(no(s.far, "strong")).toBe(false);
    const off = await arm({});
    (off.far as any).isTraitor = () => true;
    expect((off.bot as any).humanNo(off.me, off.far, "ok", null)).toBe(false);
  });

  test("natWin: the Nation ask limit lasts the difficulty's early-accept window (Impossible 1:00 after spawn)", async () => {
    const s = await arm({ natWin: 1 });
    const spawn = s.game.config().numSpawnPhaseTurns();
    let t = spawn + 599;
    (s.game as any).ticks = () => t;
    expect((s.bot as any).natEarly(0)).toBe(true);
    t = spawn + 600;
    expect((s.bot as any).natEarly(2)).toBe(false);
    const off = await arm({});
    expect((off.bot as any).natEarly(2)).toBe(true);
    expect((off.bot as any).natEarly(3)).toBe(false);
  });

  test("holdWin: before holdWin minutes and within holdGap of the win line, no new land attacks or boats of ours", async () => {
    const s = await arm({ holdWin: 32, holdGap: 8 });
    let sec = 600;
    let tiles = 700;
    (s.game as any).elapsedGameSeconds = () => sec;
    (s.game as any).numLandTiles = () => 1000;
    (s.game as any).numTilesWithFallout = () => 0;
    (s.me as any).numTilesOwned = () => tiles;
    const bot = s.bot as any;
    expect(bot.holdOn(s.me)).toBe(false); // 70% < 80 - 8
    tiles = 720;
    expect(bot.holdOn(s.me)).toBe(true);
    const atk = Object.assign(Object.create(AttackExecution.prototype), { _owner: s.me });
    const boat = Object.assign(Object.create(TransportShipExecution.prototype), { attacker: s.me });
    const theirs = Object.assign(Object.create(AttackExecution.prototype), { _owner: s.a });
    bot.holding = true;
    expect(bot.held(s.me, atk)).toBe(true);
    expect(bot.held(s.me, boat)).toBe(true);
    expect(bot.held(s.me, theirs)).toBe(false);
    expect(bot.held(s.me, {})).toBe(false);
    bot.holding = false;
    expect(bot.held(s.me, atk)).toBe(false);
    sec = 32 * 60;
    expect(bot.holdOn(s.me)).toBe(false); // past holdWin: win freely
    (s.game as any).numTilesWithFallout = () => 100; // fallout shrinks the land
    sec = 600;
    tiles = 650;
    expect(bot.holdOn(s.me)).toBe(true); // 650 >= 900 x 72%
    const off = await arm({});
    (off.me as any).numTilesOwned = () => 1_000_000;
    expect((off.bot as any).holdOn(off.me)).toBe(false);
  });

  test("doomAware: under the coming bar we grab free land; nothing as leader, above the bar or with the clock off", async () => {
    const s = await arm({ doomAware: 1 });
    let enabled = false;
    (s.game.config() as any).doomsdayClockConfig = () => ({ enabled, speed: "normal" });
    let bar = 5000;
    BotExecution.doomReq = () => bar;
    try {
      (s.far as any).numTilesOwned = () => 3000; // the leader
      (s.bot as any).doomTick(1000);
      expect(s.sent.length).toBe(0); // clock off
      enabled = true;
      (s.bot as any).doomTick(1000);
      expect(s.sent.length).toBe(1);
      expect(s.sent[0].constructor.name).toBe("AttackExecution");
      expect((s.sent[0] as any)._targetID).toBe(null); // free land first
      expect((s.sent[0] as any).startTroops).toBe(50_000); // half the spare, not yet flagged
      (s.bot as any).doomTick(1010);
      expect(s.sent.length).toBe(1); // 3 s between doom attacks
      bar = 500;
      (s.bot as any).doomTick(2000);
      expect(s.sent.length).toBe(1); // safely above the bar
      bar = 5000;
      (s.far as any).numTilesOwned = () => 100;
      (s.bot as any).doomTick(3000);
      expect(s.sent.length).toBe(1); // we lead: never doomed
    } finally {
      BotExecution.doomReq = null;
    }
  });

  test("doomAware: once flagged (no bar function) all troops above 0.3x max go, at the weakest beatable neighbour when no land is free", async () => {
    const s = await arm({ doomAware: 1 });
    (s.game.config() as any).doomsdayClockConfig = () => ({ enabled: true, speed: "normal" });
    (s.far as any).numTilesOwned = () => 3000;
    (s.me as any).inDoomsdayClock = () => true;
    (s.game as any).hasOwner = () => true; // no free land
    (s.me as any).nearby = () => [s.a, s.far];
    s.a.setTroops(1000);
    s.me.setTroops(Math.floor(0.3 * s.game.config().maxTroops(s.me)) + 10_000);
    (s.bot as any).doomTick(1000);
    expect(s.sent.length).toBe(1);
    expect((s.sent[0] as any)._targetID).toBe(s.a.id());
    expect(Math.abs((s.sent[0] as any).startTroops - 10_000)).toBeLessThanOrEqual(1);
    expect((s.bot as any).doomAttacks).toBe(1);
  });
});
