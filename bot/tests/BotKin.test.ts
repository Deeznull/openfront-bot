import {
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  BotExecution,
  DEFAULT_PARAMS,
} from "@openfront/engine/execution/bot/BotExecution";
import { EmojiExecution } from "@openfront/engine/execution/EmojiExecution";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { flattenedEmojiTable } from "@openfront/engine-api/Schemas";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { DonateTroopsExecution } from "@openfront/engine/execution/DonateTroopExecution";
import { QuickChatExecution } from "@openfront/engine/execution/QuickChatExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

function conquerRect(game: Game, p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
  }
}

const KIN = { ...DEFAULT_PARAMS, kin: 1 };

// Three humans side by side; "me" runs the bot. The game clock is stubbed so
// chat lines can be placed at exact seconds.
async function kinSetup(params = KIN, cfg = {}, tags: (string | null)[] = [null, null, null]) {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me", false, tags[0]);
  const a = new PlayerInfo("a", PlayerType.Human, null, "a", false, tags[1]);
  const b = new PlayerInfo("b", PlayerType.Human, null, "b", false, tags[2]);
  const game = await setup("big_plains", cfg, [me, a, b], undefined, UseRealAttackLogic);
  conquerRect(game, game.player("a"), 0, 0, 60, 200);
  conquerRect(game, game.player("me"), 60, 0, 60, 200);
  conquerRect(game, game.player("b"), 120, 0, 60, 200);
  const bot = new BotExecution("kin", new Nation(undefined, me), params);
  bot.init(game);
  (bot as any).player = game.player("me");
  let clock = 0;
  (game as any).elapsedGameSeconds = () => clock;
  const at = (s: number) => (clock = s);
  // A chat line from `from` to me, as the engine shows it to the recipient.
  const say = (from: string, key: string) => {
    const [cat, k] = key.split(".");
    game.displayChat(k, cat, undefined, "me", true, from);
  };
  return { game, bot, at, say };
}

describe("BotExecution kin handshake", () => {
  test("both lines on time make kin; a late reply or a reply alone does not", async () => {
    const { bot, at, say } = await kinSetup();
    at(4 + 3); // within +-5 s of 0:04
    say("a", "greet.same_team");
    at(10); // too early for b's reply (0:14 +-5 -> from 0:09) but greet is out of window anyway
    say("b", "greet.same_team");
    at(14 + 4);
    say("a", "misc.pr");
    say("b", "misc.pr"); // b's greeting was off time
    expect([...bot.kin]).toEqual(["a"]);
  });

  test("a reply far from 0:14 is ignored", async () => {
    const { bot, at, say } = await kinSetup();
    at(2);
    say("a", "greet.same_team");
    at(30);
    say("a", "misc.pr");
    expect(bot.kin.size).toBe(0);
  });

  test("greets every human at 0:04, replies only to on-time greeters at 0:14", async () => {
    const { game, bot, at, say } = await kinSetup();
    const sent: { to: string; key: string }[] = [];
    const add = game.addExecution.bind(game);
    (game as any).addExecution = (...es: any[]) => {
      for (const e of es) if (e instanceof QuickChatExecution) sent.push({ to: (e as any).recipientID, key: (e as any).quickChatKey });
      return add(...es);
    };
    at(4);
    (bot as any).kinHandshake();
    expect(sent.map((s) => s.to).sort()).toEqual(["a", "b"]);
    expect(sent.every((s) => s.key === "greet.same_team")).toBe(true);
    say("b", "greet.same_team");
    at(14);
    (bot as any).kinHandshake();
    expect(sent.slice(2)).toEqual([{ to: "b", key: "misc.pr" }]);
  });

  test("two bots find each other through the engine's quick chat", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const a = new PlayerInfo("a", PlayerType.Human, null, "a");
    const c = new PlayerInfo("c", PlayerType.Human, null, "c"); // a plain player
    const game = await setup("big_plains", {}, [me, a, c], undefined, UseRealAttackLogic);
    conquerRect(game, game.player("me"), 0, 0, 40, 40);
    conquerRect(game, game.player("a"), 100, 100, 40, 40);
    conquerRect(game, game.player("c"), 160, 0, 40, 40);
    const bots = [me, a].map((p) => {
      const b = new BotExecution(`kin-${p.id}`, new Nation(undefined, p), KIN);
      b.init(game);
      (b as any).player = game.player(p.id);
      return b;
    });
    let clock = 0;
    (game as any).elapsedGameSeconds = () => clock;
    for (const s of [4, 14]) {
      clock = s;
      for (const b of bots) (b as any).kinHandshake();
      // 3 s quick-chat cooldown per recipient: the lines are 10 s apart in game.
      for (let i = 0; i < 35; i++) game.executeNextTick();
    }
    expect([...bots[0].kin]).toEqual(["a"]);
    expect([...bots[1].kin]).toEqual(["me"]);
  });
});

describe("BotExecution clan tag", () => {
  test("players with our clan tag are kin at once", async () => {
    const { bot } = await kinSetup({ ...DEFAULT_PARAMS }, {}, ["BT", "BT", "XY"]);
    (bot as any).clanKin();
    expect([...bot.kin]).toEqual(["a"]);
  });

  test("no clan tag: nobody becomes kin", async () => {
    const { bot } = await kinSetup({ ...DEFAULT_PARAMS }, {}, [null, null, null]);
    (bot as any).clanKin();
    expect(bot.kin.size).toBe(0);
  });

  test("spawns next to an already spawned clan mate", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, "C1", "me", false, "BT");
    const mate = new PlayerInfo("mate", PlayerType.Human, "C2", "mate", false, "BT");
    const game = await setup("big_plains", {}, [me, mate], undefined, UseRealAttackLogic, false);
    const spot = game.ref(150, 150);
    game.addExecution(new SpawnExecution("g", mate, spot));
    for (let i = 0; i < 3; i++) game.executeNextTick();
    expect(game.player("mate").spawnTile()).toBeDefined();
    const bot = new BotExecution("clan", new Nation(undefined, me), { ...DEFAULT_PARAMS });
    bot.init(game);
    const ms = game.player("mate").spawnTile()!;
    for (let k = 0; k < 5; k++) {
      const t = (bot as any).chooseSpawn();
      const d = game.manhattanDist(t, ms);
      expect(d).toBeGreaterThanOrEqual(12);
      expect(d).toBeLessThanOrEqual(2 * DEFAULT_PARAMS.clanR);
    }
  });
});

describe("BotExecution helpFriends", () => {
  async function helpSetup(params: Partial<typeof DEFAULT_PARAMS>) {
    const r = await kinSetup({ ...DEFAULT_PARAMS, teamHelp: 1, ...params }, { donateTroops: true, donateGold: true }, ["BT", "BT", null]);
    const { game, bot } = r;
    const mp = game.player("me");
    const ap = game.player("a");
    const bp = game.player("b");
    conquerRect(game, bp, 0, 190, 60, 10); // b borders a
    (bot as any).clanKin();
    // Kin are allies, so the engine allows donations.
    mp.createAllianceRequest(ap)!.accept();
    const max = game.config().maxTroops(mp);
    mp.setTroops(0.9 * max);
    ap.setTroops(20_000);
    bp.setTroops(game.config().maxTroops(bp));
    const sent: any[] = [];
    const add = game.addExecution.bind(game);
    (game as any).addExecution = (...es: any[]) => {
      for (const e of es) sent.push(e);
      return add(...es);
    };
    return { ...r, mp, ap, bp, sent };
  }

  test("sends troops to a kin ally that an attack would break", async () => {
    const { game, bot, ap, bp, sent } = await helpSetup({});
    game.addExecution(new AttackExecution(60_000, bp, ap.id()));
    game.executeNextTick();
    game.executeNextTick();
    bp.setTroops(10_000); // the attacker kept little home: no danger to us
    expect(ap.incomingAttacks().length).toBeGreaterThan(0);
    (bot as any).helpFriends(game.ticks());
    expect(sent.some((e) => e instanceof DonateTroopsExecution)).toBe(true);
    expect(bot.donations.troops).toBe(1);
  });

  test("a strong enemy on our border: no troops given away", async () => {
    const { game, bot, ap, bp, sent } = await helpSetup({});
    game.addExecution(new AttackExecution(60_000, bp, ap.id()));
    game.executeNextTick();
    game.executeNextTick();
    // b still has more troops than we do: we keep ours.
    expect(bp.troops()).toBeGreaterThan(game.player("me").troops());
    (bot as any).helpFriends(game.ticks());
    expect(sent.some((e) => e instanceof DonateTroopsExecution)).toBe(false);
  });

  test("FFA: no help to kin much bigger than us", async () => {
    const { game, bot, ap, bp, sent } = await helpSetup({});
    conquerRect(game, ap, 180, 0, 20, 200); // a: 60+20 columns vs our 60
    game.addExecution(new AttackExecution(60_000, bp, ap.id()));
    game.executeNextTick();
    game.executeNextTick();
    bp.setTroops(10_000);
    (bot as any).helpFriends(game.ticks());
    expect(sent.some((e) => e instanceof DonateTroopsExecution)).toBe(false);
    expect(bot.donateSkips).toBe(1);
  });

  test("donate 0 (UI toggle off) sends nothing", async () => {
    const { game, bot, ap, bp, sent } = await helpSetup({ donate: 0 });
    game.addExecution(new AttackExecution(60_000, bp, ap.id()));
    game.executeNextTick();
    game.executeNextTick();
    (bot as any).helpFriends(game.ticks());
    expect(sent.some((e) => e instanceof DonateTroopsExecution)).toBe(false);
    expect(bot.donations.troops + bot.donations.gold).toBe(0);
  });

  test("no attack on the friend, no donation", async () => {
    const { game, bot, sent } = await helpSetup({});
    (bot as any).helpFriends(game.ticks());
    expect(sent.some((e) => e instanceof DonateTroopsExecution)).toBe(false);
  });
});

describe("BotExecution emojiMode", () => {
  const id = (e: string) => flattenedEmojiTable.indexOf(e as any);
  async function emojiSetup() {
    const r = await kinSetup({ ...DEFAULT_PARAMS, emojiMode: 1 });
    const { game, bot } = r;
    (bot as any).initializeBehaviors();
    const sent: number[] = [];
    const add = game.addExecution.bind(game);
    (game as any).addExecution = (...es: any[]) => {
      for (const e of es) if (e instanceof EmojiExecution) sent.push((e as any).emoji);
      return add(...es);
    };
    return { ...r, sent, mp: game.player("me"), ap: game.player("a") };
  }

  test("casual emojis: only positive ones, and only some of them", async () => {
    const { game, bot, sent, ap } = await emojiSetup();
    (bot as any).patchEmojis();
    const eb = (bot as any).emojiBehavior;
    for (let i = 0; i < 60; i++) {
      (game as any).ticks = () => 1000 + i * 1000; // no per-player cooldown
      (bot as any).player.canSendEmoji = () => true;
      eb.sendEmoji(ap, [id("🖕"), id("🤡")]);
      eb.sendEmoji(ap, [id("👍")]);
    }
    expect(sent.every((e) => e === id("👍"))).toBe(true);
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.length).toBeLessThan(45); // about 1 in 3 of 60
    expect(bot.emojisSent.dropped).toBeGreaterThan(60);
  });

  test("an alliance ask carries 🤝; asking again and again with a silo carries ☢️", async () => {
    const { game, bot, sent, mp, ap } = await emojiSetup();
    mp.canSendEmoji = () => true;
    const ask = () => {
      game.addExecution(new AllianceRequestExecution(mp, ap.id()));
      game.executeNextTick();
      (bot as any).allyEmojis(game.ticks());
      for (const r of [...ap.incomingAllianceRequests()]) r.reject();
    };
    ask();
    expect(sent).toEqual([id("🤝")]);
    expect((bot as any).askCount.get("a")).toBe(1);
    // The engine's re-ask cooldown is long; count two earlier asks directly.
    (bot as any).askCount.set("a", 2);
    (bot as any).askSeen.clear();
    for (const r of [...mp.outgoingAllianceRequests()]) (bot as any).askSeen.add(r);
    (game as any).ticks = () => 1e6;
    ask();
    expect(sent.at(-1)).toBe(id("🤝")); // 3rd ask, no silo yet
    (bot as any).askCount.set("a", 3);
    mp.buildUnit(UnitType.MissileSilo, game.ref(90, 100), {});
    ask();
    expect(sent.at(-1)).toBe(id("☢️"));
    expect(bot.emojisSent.nuke).toBe(1);
  });
});

describe("BotExecution kin boat landing", () => {
  test("lands in the free shore pocket the kin surrounds, not at their edge", async () => {
    const me = new PlayerInfo("me", PlayerType.Human, null, "me");
    const a = new PlayerInfo("a", PlayerType.Human, null, "a");
    const game = await setup("half_land_half_ocean", {}, [me, a]);
    // Shore tiles of one coast, ordered along it.
    const shore: number[] = [];
    game.forEachTile((t) => {
      if (game.isLand(t) && game.isShore(t)) shore.push(t);
    });
    expect(shore.length).toBeGreaterThan(5);
    const s0 = shore[Math.floor(shore.length / 2)];
    const ap = game.player("a");
    // Kin owns all land within 8 of s0 except s0 itself (a pocket)...
    const x0 = game.x(s0), y0 = game.y(s0);
    for (let dx = -8; dx <= 8; dx++) for (let dy = -8; dy <= 8; dy++) {
      if (!game.isValidCoord(x0 + dx, y0 + dy)) continue;
      const u = game.ref(x0 + dx, y0 + dy);
      if (u !== s0 && game.isLand(u)) ap.conquer(u);
    }
    const bot = new BotExecution("kin", new Nation(undefined, me), { ...DEFAULT_PARAMS, kin: 1 });
    bot.init(game);
    const dst = bot.kinPocket(ap, ap.borderTiles());
    // ...so the pocket wins over free shore at the edge of their land.
    expect(dst).toBe(s0);
  });
});
