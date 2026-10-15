import { Difficulty, Nation, PlayerInfo, PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { BotExecution, DEFAULT_PARAMS } from "@openfront/engine/execution/bot/BotExecution";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";

async function run(selfDiff: number) {
  const me = new PlayerInfo("me", PlayerType.Human, null, "me", false, null);
  const game = await setup("big_plains", { difficulty: Difficulty.Easy }, [me]);
  const bot = new BotExecution("sd", new Nation(undefined, me), { ...DEFAULT_PARAMS, selfDiff });
  bot.init(game);
  return { game, bot: bot as any };
}

describe("BotExecution selfDiff", () => {
  test("inherited behaviours see Impossible; the bot's own game keeps the lobby difficulty", async () => {
    const { game, bot } = await run(1);
    expect(game.config().gameConfig().difficulty).toBe(Difficulty.Easy);
    expect(bot.botGame.config().gameConfig().difficulty).toBe(Difficulty.Easy);
    expect(bot.mg.config().gameConfig().difficulty).toBe(Difficulty.Impossible);
    // Same object stable across calls, everything else forwarded to the real game.
    expect(bot.mg.config().gameConfig()).toBe(bot.mg.config().gameConfig());
    expect(bot.mg.config().gameConfig().gameMap).toBe(game.config().gameConfig().gameMap);
    expect(bot.mg.player("me")).toBe(game.player("me"));
    expect(bot.mg.ticks()).toBe(game.ticks());
    expect(bot.mg.config().isUnitDisabled(UnitType.City)).toBe(game.config().isUnitDisabled(UnitType.City));
    expect(bot.player).toBe(game.player("me"));
  });

  test("off: behaviours see the lobby difficulty", async () => {
    const { bot } = await run(0);
    expect(bot.mg.config().gameConfig().difficulty).toBe(Difficulty.Easy);
  });
});
