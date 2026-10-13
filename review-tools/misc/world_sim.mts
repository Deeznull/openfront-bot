/**
 * Headless re-simulation of one archived OpenFront replay (commit 3f5633b9 = the v34 build the public servers ran),
 * adapted from OF34/tests/replay/ReplayGame.ts. Extracts what the replay JSON alone cannot give:
 *   - sender troops / tiles / max troops at every attack and boat intent (-> % of troops sent)
 *   - tiles + troops of every human every 5 s (-> when the winner first held #1)
 *   - structure creation events (what really got built, and when), alliance request/reply/break events
 * Checks the recorded hash checkpoints; the output carries `sync` so unsynced games can be dropped.
 * Run (from tools\OF34):  npx tsx ..\world_sim.mts <replay.json> <out.json>
 * The replay JSON is treated as data (JSON.parse only).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Config } from "./OF34/src/core/configuration/Config";
import { Executor } from "./OF34/src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType } from "./OF34/src/core/game/Game";
import { createGame } from "./OF34/src/core/game/GameImpl";
import { GameUpdateType } from "./OF34/src/core/game/GameUpdates";
import { createNationsForGame } from "./OF34/src/core/game/NationCreation";
import { loadTerrainMap } from "./OF34/src/core/game/TerrainMapLoader";
import { GameRunner } from "./OF34/src/core/GameRunner";
import { PseudoRandom } from "./OF34/src/core/PseudoRandom";
import { GameRecordSchema, GameStartInfo } from "./OF34/src/core/Schemas";
import { decompressGameRecord, simpleHash, toWireGameStartInfo } from "./OF34/src/core/Util";
import { NodeGameMapLoader } from "./OF34/tests/perf/fullgame/NodeGameMapLoader";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = 50; // ticks (5 s)
const KEEP_UNITS = new Set<string>([
  UnitType.City, UnitType.Port, UnitType.Factory, UnitType.DefensePost, UnitType.MissileSilo, UnitType.SAMLauncher,
  UnitType.Warship, UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV, UnitType.TransportShip,
]);

async function main() {
  const [src, out] = process.argv.slice(2);
  console.debug = () => {};
  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.warn = () => {}; // engine chatter ("cannot build ...")
  console.log = () => {};
  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const parsed = GameRecordSchema.safeParse(raw);
  const record = decompressGameRecord(parsed.success ? parsed.data : raw);
  const info = record.info;
  const gameStart: GameStartInfo = toWireGameStartInfo({
    gameID: info.gameID, lobbyCreatedAt: info.lobbyCreatedAt, config: info.config, players: info.players, tribes: info.tribes,
  });
  const config = new Config(info.config, null, false);
  const mapLoader = new NodeGameMapLoader(path.join(HERE, "OF34", "resources/maps"));
  const terrain = await loadTerrainMap(info.config.gameMap, info.config.gameMapSize, mapLoader, false);
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const humans = gameStart.players.map(
    (p) => new PlayerInfo(p.username, PlayerType.Human, p.clientID, random.nextID(), p.isLobbyCreator ?? false, p.clanTag, p.friends ?? [], p.teamIndex ?? null),
  );
  const nations = createNationsForGame(gameStart, terrain.nations, terrain.additionalNations, humans.length, random);
  const game = createGame(humans, nations, terrain.gameMap, terrain.miniGameMap, config, terrain.teamGameSpawnAreas);

  const computed = new Map<number, number>();
  const events: any = { alliance: [], unit: [], broke: [], reply: [], conquest: [] };
  const seenUnit = new Map<number, number>();
  let fatal: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, undefined, gameStart.tribes?.map((t) => t.name)),
    (gu: any) => {
      if ("errMsg" in gu) { fatal = `${gu.errMsg}\n${gu.stack ?? ""}`; return; }
      const t = gu.tick;
      for (const hu of gu.updates[GameUpdateType.Hash]) computed.set(hu.tick, hu.hash);
      for (const a of gu.updates[GameUpdateType.AllianceRequest]) events.alliance.push([t, a.requestorID, a.recipientID]);
      for (const a of gu.updates[GameUpdateType.AllianceRequestReply]) events.reply.push([t, a.request.requestorID, a.request.recipientID, a.accepted ? 1 : 0]);
      for (const a of gu.updates[GameUpdateType.BrokeAlliance]) events.broke.push([t, a.traitorID, a.betrayedID]);
      for (const a of gu.updates[GameUpdateType.ConquestEvent]) events.conquest.push([t, a.conquerorId, a.conqueredId]);
      for (const u of gu.updates[GameUpdateType.Unit]) {
        if (!KEEP_UNITS.has(u.unitType)) continue;
        const uc = !!u.underConstruction, act = !!u.isActive;
        const prev = seenUnit.get(u.id); // 0 = built & active, 1 = under construction, 2 = gone
        const now = !act ? 2 : uc ? 1 : 0;
        if (prev === undefined || prev !== now) {
          events.unit.push([t, u.id, u.ownerID, u.unitType, now]);
          seenUnit.set(u.id, now);
        }
      }
    },
  );
  runner.init();

  const recorded = new Map<number, number>();
  for (const turn of record.turns) if (turn.hash !== null && turn.hash !== undefined) recorded.set(turn.turnNumber, turn.hash);

  const hp = game.allPlayers().filter((p) => p.type() === PlayerType.Human);
  const smallMap: Record<string, any> = {};
  for (const p of game.allPlayers()) smallMap[p.smallID()] = { id: p.id(), cid: p.clientID(), type: p.type(), name: p.name() };
  const samples: number[][] = []; // [tick, topNationTiles, topBotTiles, h0tiles, h0troops, h0gold, ...]
  const att: any[] = [];
  const boats: any[] = [];
  const misc: any[] = []; // spawn, builds (intent-time snapshot)
  let compared = 0, matches = 0, firstMismatch: number | null = null;
  const nonHuman = game.allPlayers().filter((p) => p.type() !== PlayerType.Human);
  const nations_ = nonHuman.filter((p) => p.type() === PlayerType.Nation);
  const bots_ = nonHuman.filter((p) => p.type() === PlayerType.Bot);

  for (const turn of record.turns) {
    const tn = turn.turnNumber;
    for (const it of turn.intents as any[]) {
      const p = game.playerByClientID(it.clientID);
      if (!p) continue;
      if (it.type === "attack") {
        let tt = "wild", tT = 0, tTiles = 0, tid = -1;
        if (it.targetID !== null && game.hasPlayer(it.targetID)) {
          const o = game.player(it.targetID);
          tt = o.type() === PlayerType.Human ? "human" : o.type() === PlayerType.Nation ? "nation" : "bot";
          tT = o.troops(); tTiles = o.numTilesOwned(); tid = o.smallID();
        }
        att.push([tn, p.smallID(), tt, it.troops, Math.round(p.troops()), p.numTilesOwned(), Math.round(config.maxTroops(p)), Math.round(tT), tTiles, tid]);
      } else if (it.type === "boat") {
        boats.push([tn, p.smallID(), it.troops, Math.round(p.troops()), p.numTilesOwned(), Math.round(config.maxTroops(p))]);
      } else if (it.type === "spawn") {
        misc.push([tn, "spawn", p.smallID(), it.tile]);
      } else if (it.type === "build_unit" || it.type === "upgrade_structure") {
        misc.push([tn, it.type, p.smallID(), it.unit, Number(p.gold())]);
      }
    }
    runner.addTurn(turn);
    if (!runner.executeNextTick()) { origErr(`tick failed at ${tn}: ${fatal}`); break; }
    const c = computed.get(tn), r = recorded.get(tn);
    if (c !== undefined && r !== undefined) { compared++; if (c === r) matches++; else if (firstMismatch === null) firstMismatch = tn; }
    if (tn % SAMPLE === 0) {
      let tn_ = 0, tb = 0;
      for (const p of nations_) tn_ = Math.max(tn_, p.numTilesOwned());
      for (const p of bots_) tb = Math.max(tb, p.numTilesOwned());
      const row = [tn, tn_, tb];
      for (const p of hp) row.push(p.numTilesOwned(), Math.round(p.troops()), Math.round(Number(p.gold())), Math.round(config.maxTroops(p)));
      samples.push(row);
    }
  }
  const res = {
    gid: info.gameID, commit: record.gitCommit, compared, matches, firstMismatch,
    humans: hp.map((p) => ({ cid: p.clientID(), small: p.smallID(), name: p.name() })), smallMap,
    ticks: game.ticks(), samples, att, boats, misc, ev: events,
  };
  fs.writeFileSync(out, JSON.stringify(res));
  console.log = origLog; console.warn = origWarn;
  console.log(`${info.gameID} ticks=${game.ticks()} hashes ${matches}/${compared} mismatch@${firstMismatch}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
