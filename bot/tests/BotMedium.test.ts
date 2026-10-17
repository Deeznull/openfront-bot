import { Nation, PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { BotExecution, DEFAULT_PARAMS } from "@openfront/engine/execution/bot/BotExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";

function conquerRect(game: Game, p: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) p.conquer(game.ref(x, y));
}

// me borders nation n (a real PlayerType.Nation) and human h.
async function medSetup(difficulty: string, params: Partial<typeof DEFAULT_PARAMS>) {
  const infos = [
    new PlayerInfo("me", PlayerType.Human, null, "me"),
    new PlayerInfo("n", PlayerType.Nation, null, "n"),
    new PlayerInfo("h", PlayerType.Human, null, "h"),
  ];
  const game = await setup("big_plains", { difficulty: difficulty as any }, infos);
  const me = game.player("me"), n = game.player("n"), h = game.player("h");
  conquerRect(game, n, 0, 0, 20, 50);
  conquerRect(game, me, 20, 0, 20, 50);
  conquerRect(game, h, 40, 0, 20, 50);
  const bot = new BotExecution("med", new Nation(undefined, infos[0]), { ...DEFAULT_PARAMS, ...params });
  bot.init(game);
  (bot as any).player = me;
  (game as any).inSpawnPhase = () => false;
  const sent: AttackExecution[] = [];
  (game as any).addExecution = (...e: any[]) => sent.push(...e.filter((x) => x instanceof AttackExecution));
  return { game, bot, me, n, h, sent };
}

describe("BotExecution medDef", () => {
  test("Medium: a bordering Nation under its trigger/reserve ratios weighs less", async () => {
    const { game, bot, n, h } = await medSetup("Medium", { medDef: 0.6 });
    const maxN = game.config().maxTroops(n);
    n.setTroops(0.4 * maxN);
    expect((bot as any).medWeight(n)).toBeCloseTo(0.6);
    n.setTroops(0.2 * maxN);
    expect((bot as any).medWeight(n)).toBeCloseTo(0.3);
    n.setTroops(0.7 * maxN);
    expect((bot as any).medWeight(n)).toBe(1);
    h.setTroops(0.2 * game.config().maxTroops(h));
    expect((bot as any).medWeight(h)).toBe(1); // humans never
  });

  test("Impossible/Hard nations are never discounted, and off by default", async () => {
    for (const d of ["Impossible", "Hard"]) {
      const { game, bot, n } = await medSetup(d, { medDef: 0.6 });
      n.setTroops(0.2 * game.config().maxTroops(n));
      expect((bot as any).medWeight(n)).toBe(1);
    }
    const { game, bot, n } = await medSetup("Medium", {});
    n.setTroops(0.2 * game.config().maxTroops(n));
    expect((bot as any).medWeight(n)).toBe(1);
  });
});

describe("BotExecution medBreak", () => {
  async function breakCase(difficulty: string, nRatio: number, myTroops: number) {
    const c = await medSetup(difficulty, { medBreak: 2.5, medR: 0.4 });
    const maxN = c.game.config().maxTroops(c.n);
    c.n.setTroops(nRatio * maxN);
    c.h.setTroops(1000);
    c.me.setTroops(myTroops);
    (c.bot as any).medBreak(1000);
    return { ...c, nTroops: nRatio * maxN };
  }

  test("Medium: hits a bordering Nation under medR with up to medBreak x its troops", async () => {
    const { sent, bot, nTroops, game, me } = await breakCase("Medium", 0.2, 0);
    const max = game.config().maxTroops(me);
    me.setTroops(max);
    (bot as any).medBreak(1000);
    expect(sent.length).toBe(1);
    expect(bot.medBreaks).toBe(1);
    const troops = (sent[0] as any).startTroops ?? (sent[0] as any).troops;
    expect(troops).toBeGreaterThanOrEqual(1.5 * nTroops);
    expect(troops).toBeLessThanOrEqual(2.5 * nTroops + 1);
    (bot as any).medBreak(1010); // cooldown: no second send within 50 ticks
    expect(sent.length).toBe(1);
  });

  test("no send above medR, without enough troops, or on Impossible", async () => {
    const hi = await breakCase("Medium", 0.6, 0);
    hi.me.setTroops(hi.game.config().maxTroops(hi.me));
    (hi.bot as any).medBreak(1000);
    expect(hi.sent.length).toBe(0);
    const poor = await breakCase("Medium", 0.2, 10);
    expect(poor.sent.length).toBe(0);
    const imp = await breakCase("Impossible", 0.2, 0);
    imp.me.setTroops(imp.game.config().maxTroops(imp.me));
    (imp.bot as any).medBreak(1000);
    expect(imp.sent.length).toBe(0);
  });
});
