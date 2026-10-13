import { GameType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameStartInfo } from "@openfront/engine-api/Schemas";
import { autoplayExecutions } from "@openfront/engine/GameRunner";
import { describe, expect, test } from "vitest";
import { playerInfo, setup } from "./util/Setup";

function start(config: Partial<GameStartInfo["config"]>): GameStartInfo {
  return {
    gameID: "autoplay1",
    lobbyCreatedAt: 0,
    players: [],
    config: { gameType: GameType.Singleplayer, ...config },
  } as GameStartInfo;
}

describe("solo bot autoplay", () => {
  const human = playerInfo("me", PlayerType.Human);

  test("is off unless asked for, and only in singleplayer", () => {
    expect(autoplayExecutions(start({}), [human])).toHaveLength(0);
    expect(
      autoplayExecutions(
        start({ botAutoplay: true, gameType: GameType.Public }),
        [human],
      ),
    ).toHaveLength(0);
    expect(
      autoplayExecutions(start({ botAutoplay: true }), [human]),
    ).toHaveLength(1);
  });

  test("the bot spawns the human and expands on its own", async () => {
    const game = await setup("plains", {}, [human], undefined, undefined, false);
    game.addExecution(
      ...autoplayExecutions(start({ botAutoplay: true }), [human]),
    );
    let spawnedTiles = 0;
    for (let i = 0; i < 1500; i++) {
      game.executeNextTick();
      const me = game.player(human.id);
      if (spawnedTiles === 0 && me.numTilesOwned() > 0) {
        spawnedTiles = me.numTilesOwned();
      }
    }
    const me = game.player(human.id);
    expect(spawnedTiles).toBeGreaterThan(0);
    expect(game.inSpawnPhase()).toBe(false);
    expect(me.isAlive()).toBe(true);
    expect(me.numTilesOwned()).toBeGreaterThan(spawnedTiles);
  });
});
