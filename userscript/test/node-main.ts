// Headless-test helpers for the monorepo engine (aliased as `ofengine-node`).
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import path from "node:path";
import { NodeGameMapLoader } from "ofrepo/tests/perf/fullgame/NodeGameMapLoader";
import type { MapSource } from "ofengine";

export {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";

export async function nodeMapSource(repo: string, gameMap: any, size: any): Promise<MapSource> {
  const loader = new NodeGameMapLoader(path.join(repo, "resources/maps"));
  return { files: await loadMapFiles(loader, gameMap, size) };
}
