import { Nation, PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { BotExecution, DEFAULT_PARAMS } from "@openfront/engine/execution/bot/BotExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";

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
