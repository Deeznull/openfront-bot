/**
 * Headless re-simulation of archived game records, with state snapshots.
 *
 * Same pipeline as ReplayGame.ts (deterministic core, recorded hashes checked),
 * but instead of only checking sync it samples every player's tiles and troops
 * every SAMPLE_EVERY turns (30 s), plus Nation spawn cells and the map's land
 * size. Output: one JSON per game in the out directory.
 *
 *   npx tsx tests/replay/Resim.ts <outDir> <list.txt>
 *
 * list.txt holds one record path per line (absolute, or relative to the
 * OpenFrontIO folder). Games already present in outDir are skipped, so the
 * run can be resumed. Troops are raw engine units (display = raw / 10).
 */
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  HashUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { GameStartInfo } from "@openfront/engine-api/Schemas";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { createGame } from "@openfront/engine/game/GameImpl";
import { createNationsForGame } from "@openfront/engine/game/NationCreation";
import { GameRunner } from "@openfront/engine/GameRunner";
import { PlayerInfo } from "@openfront/engine-api/game/GameTypes";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import {
  decompressGameRecord,
  toWireGameStartInfo,
} from "@openfront/shared/SharedUtil";
import { GameRecord } from "@openfront/shared/WireSchemas";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NodeGameMapLoader } from "../perf/fullgame/NodeGameMapLoader";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SAMPLE_EVERY = 300; // turns; 10 turns = 1 s

interface PlayerSample {
  smallID: number;
  clientID: string | null;
  name: string;
  type: string;
  alive: boolean;
  tiles: number;
  troops: number;
}

interface Sample {
  turn: number;
  players: PlayerSample[];
}

async function simulate(recordPath: string): Promise<unknown> {
  const raw = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const record: GameRecord = decompressGameRecord(raw);
  const info = record.info;

  const players = info.players;
  const gameStart: GameStartInfo = toWireGameStartInfo({
    gameID: info.gameID,
    lobbyCreatedAt: info.lobbyCreatedAt,
    config: info.config,
    players,
    tribes: info.tribes,
  });

  const config = new EngineConfig(info.config, false);
  const mapLoader = new NodeGameMapLoader(
    path.join(PROJECT_ROOT, "resources/maps"),
  );
  const terrain = await loadTerrainMap(
    await loadMapFiles(mapLoader, info.config.gameMap, info.config.gameMapSize),
  );
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const humans = gameStart.players.map(
    (p) =>
      new PlayerInfo(
        p.username,
        PlayerType.Human,
        p.clientID,
        random.nextID(),
        p.isLobbyCreator ?? false,
        p.clanTag,
        p.friends ?? [],
        p.teamIndex ?? null,
      ),
  );
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    humans.length,
    random,
  );
  const game = createGame(
    humans,
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    config,
    terrain.teamGameSpawnAreas,
  );

  const nationSpawns = game.nations().map((n) => ({
    name: n.playerInfo.name,
    x: n.spawnCell?.x ?? null,
    y: n.spawnCell?.y ?? null,
  }));

  const computedHashes = new Map<number, number>();
  let fatalError: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(
      game,
      gameStart.gameID,
      undefined,
      gameStart.tribes?.map((t) => t.name),
    ),
    (gu) => {
      if ("errMsg" in gu) {
        fatalError = `${gu.errMsg}\n${gu.stack ?? ""}`;
        return;
      }
      for (const hu of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
        computedHashes.set(hu.tick, hu.hash);
      }
    },
  );
  runner.init();

  const recordedHashes = new Map<number, number>();
  for (const turn of record.turns) {
    if (turn.hash !== null && turn.hash !== undefined) {
      recordedHashes.set(turn.turnNumber, turn.hash);
    }
  }

  const samples: Sample[] = [];
  const snap = (turn: number) => {
    samples.push({
      turn,
      players: game.allPlayers().map((p) => ({
        smallID: p.smallID(),
        clientID: p.clientID(),
        name: p.name(),
        type: String(p.type()),
        alive: p.isAlive(),
        tiles: p.numTilesOwned(),
        troops: p.troops(),
      })),
    });
  };

  let compared = 0;
  let matches = 0;
  let firstMismatch: number | null = null;
  let failed: string | null = null;
  snap(0);
  for (const turn of record.turns) {
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      failed = `tick failed at turn ${turn.turnNumber}: ${fatalError}`;
      break;
    }
    if (turn.turnNumber > 0 && turn.turnNumber % SAMPLE_EVERY === 0) {
      snap(turn.turnNumber);
    }
    const computed = computedHashes.get(turn.turnNumber);
    const recorded = recordedHashes.get(turn.turnNumber);
    if (computed !== undefined && recorded !== undefined) {
      compared++;
      if (computed === recorded) matches++;
      else if (firstMismatch === null) firstMismatch = turn.turnNumber;
    }
  }

  return {
    gameID: info.gameID,
    map: info.config.gameMap,
    mapSize: info.config.gameMapSize,
    mode: info.config.gameMode,
    winner: info.winner ?? null,
    numLandTiles: game.numLandTiles(),
    nationSpawns,
    hashes: { compared, matches, firstMismatch },
    failed,
    samples,
  };
}

async function main(): Promise<void> {
  const [outDir, listFile] = process.argv.slice(2);
  if (outDir === undefined || listFile === undefined) {
    console.error("usage: tsx tests/replay/Resim.ts <outDir> <list.txt>");
    process.exit(1);
  }
  console.debug = () => {}; // silence per-tick debug logging
  fs.mkdirSync(outDir, { recursive: true });
  const list = fs
    .readFileSync(listFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");

  for (const line of list) {
    const recordPath = path.isAbsolute(line)
      ? line
      : path.resolve(PROJECT_ROOT, line);
    const id = path.basename(recordPath, ".json");
    const outPath = path.join(outDir, `${id}.json`);
    if (fs.existsSync(outPath)) continue;
    const start = performance.now();
    try {
      const out = await simulate(recordPath);
      fs.writeFileSync(outPath, JSON.stringify(out));
      const secs = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`done ${id} in ${secs}s`);
    } catch (err) {
      console.log(`error ${id}: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
