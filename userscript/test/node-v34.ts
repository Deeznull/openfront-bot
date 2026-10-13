// Headless-test helpers for the v0.34 engine (aliased as `ofengine-node`).
import path from "node:path";
import { NodeGameMapLoader } from "ofrepo/tests/perf/fullgame/NodeGameMapLoader";
import type { MapSource } from "ofengine";

export {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "ofrepo/src/core/game/Game";

export async function nodeMapSource(repo: string, _gameMap: any, _size: any): Promise<MapSource> {
  return { loader: new NodeGameMapLoader(path.join(repo, "resources/maps")) };
}
