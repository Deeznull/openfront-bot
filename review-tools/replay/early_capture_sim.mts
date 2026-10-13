/**
 * Early-capture sim: re-simulates one v34 FFA replay (engine commit 3f5633b9, hash-checked) and writes, for every human:
 *   cp     at 3/5/7/10 min (ticks 1800/3000/4200/6000): engine stats units.city|port index 0 (built), 2 (captured),
 *          3 (lost), plus currently owned City/Port (active, not under construction), tiles, alive flag.
 *   caps   every City/Port owner change in the first 10 min: turn, type, capturer (to), victim (from) and its type
 *          (HUMAN / NATION / BOT = bot or tribe), and held = 1 if the capturer still owned the same unit 3 min later,
 *          0 if not (lost, destroyed or taken again), -1 if the game ended before that check.
 *   final  engine stats at the last tick, and rec = the record's own end-of-game stats (sanity check only).
 * Structure ownership is tracked from the Unit update stream (same events UnitImpl.setOwner produces).
 * Run (cwd OF34):  npx tsx ..\replay_tools\early_capture_sim.mts <replay.json> <out.json>
 * The replay JSON is treated as data (JSON.parse only). Engine is read-only.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Config } from "../OF34/src/core/configuration/Config";
import { Executor } from "../OF34/src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType } from "../OF34/src/core/game/Game";
import { createGame } from "../OF34/src/core/game/GameImpl";
import { GameUpdateType } from "../OF34/src/core/game/GameUpdates";
import { createNationsForGame } from "../OF34/src/core/game/NationCreation";
import { loadTerrainMap } from "../OF34/src/core/game/TerrainMapLoader";
import { GameRunner } from "../OF34/src/core/GameRunner";
import { PseudoRandom } from "../OF34/src/core/PseudoRandom";
import { GameRecordSchema, GameStartInfo } from "../OF34/src/core/Schemas";
import { decompressGameRecord, simpleHash, toWireGameStartInfo } from "../OF34/src/core/Util";
import { NodeGameMapLoader } from "../OF34/tests/perf/fullgame/NodeGameMapLoader";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CPS = [1800, 3000, 4200, 6000]; // 3, 5, 7, 10 min at 10 ticks per second
const HOLD = 1800; // 3 min
const CAP_END = 6000; // captures are recorded for the first 10 min only
const DEATH_EVERY = 10; // death check every 1 s
const CS = new Set<string>([UnitType.City, UnitType.Port]);
const UCODE: Record<string, string> = { [UnitType.City]: "C", [UnitType.Port]: "P" };

async function main() {
  const [src, out] = process.argv.slice(2);
  console.debug = () => {};
  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.warn = () => {};
  console.log = () => {};
  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const parsed = GameRecordSchema.safeParse(raw);
  const record = decompressGameRecord(parsed.success ? parsed.data : raw); // fills sparse turns with empty ones
  const info = record.info;
  const gameStart: GameStartInfo = toWireGameStartInfo({
    gameID: info.gameID, lobbyCreatedAt: info.lobbyCreatedAt, config: info.config, players: info.players, tribes: info.tribes,
  });
  const config = new Config(info.config, null, false);
  const mapLoader = new NodeGameMapLoader(path.join(HERE, "..", "OF34", "resources/maps"));
  const terrain = await loadTerrainMap(info.config.gameMap, info.config.gameMapSize, mapLoader, false);
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const humans = gameStart.players.map(
    (p) => new PlayerInfo(p.username, PlayerType.Human, p.clientID, random.nextID(), p.isLobbyCreator ?? false, p.clanTag, p.friends ?? [], p.teamIndex ?? null),
  );
  const nations = createNationsForGame(gameStart, terrain.nations, terrain.additionalNations, humans.length, random);
  const game = createGame(humans, nations, terrain.gameMap, terrain.miniGameMap, config, terrain.teamGameSpawnAreas);

  let cur = 0; // turn currently executing (the callback runs synchronously inside executeNextTick)
  const owner = new Map<number, number>(); // City/Port unit id -> owner small id (active units only)
  const caps: any[] = [];
  const pendingAt = new Map<number, number[]>(); // check turn -> capture indices
  const computed = new Map<number, number>();
  let fatal: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, undefined, gameStart.tribes?.map((t) => t.name)),
    (gu: any) => {
      if ("errMsg" in gu) { fatal = `${gu.errMsg}\n${gu.stack ?? ""}`; return; }
      for (const hu of gu.updates[GameUpdateType.Hash]) computed.set(hu.tick, hu.hash);
      for (const u of gu.updates[GameUpdateType.Unit]) {
        if (!CS.has(u.unitType)) continue;
        if (!u.isActive) { owner.delete(u.id); continue; }
        const prev = owner.get(u.id);
        if (prev !== undefined && prev !== u.ownerID && cur <= CAP_END) {
          const v = game.playerBySmallID(prev) as any;
          const idx = caps.length;
          caps.push({
            t: cur, uid: u.id, u: UCODE[u.unitType], lvl: u.level, to: u.ownerID, from: prev,
            fromType: v ? String(v.type()) : "", x: u.pos % game.width(), y: Math.floor(u.pos / game.width()), held: -1,
          });
          const due = pendingAt.get(cur + HOLD) ?? [];
          due.push(idx);
          pendingAt.set(cur + HOLD, due);
        }
        owner.set(u.id, u.ownerID);
      }
    },
  );
  runner.init();

  const recorded = new Map<number, number>();
  for (const turn of record.turns) if (turn.hash !== null && turn.hash !== undefined) recorded.set(turn.turnNumber, turn.hash);

  const hp = game.allPlayers().filter((p) => p.type() === PlayerType.Human) as any[];
  const deathTick = new Map<number, number>(); // small id -> first turn seen dead
  const cp: Record<string, any[]> = {};
  const snap = (p: any) => {
    const st: any = game.stats().getPlayerStats(p) ?? {};
    const U: any = st.units ?? {};
    const g = (k: string, i: number) => Number((U[k] ?? [])[i] ?? 0);
    const ownedC = p.units(UnitType.City).filter((u: any) => u.isActive() && !u.isUnderConstruction()).length;
    const ownedP = p.units(UnitType.Port).filter((u: any) => u.isActive() && !u.isUnderConstruction()).length;
    // [small, builtC, builtP, capC, capP, lostC, lostP, ownedC, ownedP, tiles, alive]
    return [p.smallID(), g("city", 0), g("port", 0), g("city", 2), g("port", 2), g("city", 3), g("port", 3),
      ownedC, ownedP, p.numTilesOwned(), p.isAlive() ? 1 : 0];
  };

  let compared = 0, matches = 0, firstMismatch: number | null = null;
  let lastTurn = -1;
  for (const turn of record.turns) {
    const tn = turn.turnNumber;
    cur = tn;
    runner.addTurn(turn);
    if (!runner.executeNextTick()) { origErr(`tick failed at ${tn}: ${fatal}`); break; }
    lastTurn = tn;
    const c = computed.get(tn), r = recorded.get(tn);
    if (c !== undefined && r !== undefined) { compared++; if (c === r) matches++; else if (firstMismatch === null) firstMismatch = tn; }
    const due = pendingAt.get(tn);
    if (due) {
      for (const i of due) {
        const cap = caps[i];
        cap.held = owner.get(cap.uid) === cap.to ? 1 : 0;
      }
      pendingAt.delete(tn);
    }
    if (tn % DEATH_EVERY === 0) for (const p of hp) if (!deathTick.has(p.smallID()) && !p.isAlive()) deathTick.set(p.smallID(), tn);
    if (CPS.includes(tn)) cp[String(tn)] = hp.map(snap);
  }
  const final = hp.map(snap);
  const winnerCid = Array.isArray(info.winner) && info.winner[0] === "player" ? info.winner[1] : null;
  const recStats: Record<string, any> = {};
  for (const p of info.players as any[]) {
    const u = p.stats?.units ?? {};
    const pick = (k: string) => (u[k] ?? []).map((x: any) => Number(x ?? 0));
    recStats[p.clientID] = { city: pick("city"), port: pick("port"), tiles: Number(p.stats?.finalTiles ?? 0) };
  }
  const res = {
    gid: info.gameID, map: info.config.gameMap, size: info.config.gameMapSize, commit: record.gitCommit,
    nPlayers: info.players.length, nHumans: hp.length, lastTurn, numTurnsRec: record.turns.length,
    compared, matches, firstMismatch, sync: compared > 0 && matches === compared && firstMismatch === null,
    unresolved: [...pendingAt.values()].reduce((s, a) => s + a.length, 0),
    winnerCid,
    humans: hp.map((p: any) => ({ small: p.smallID(), cid: p.clientID(), name: p.name(), deathTick: deathTick.get(p.smallID()) ?? null })),
    cp, caps, final, rec: recStats,
  };
  fs.writeFileSync(out, JSON.stringify(res));
  console.log = origLog; console.warn = origWarn;
  console.log(`${info.gameID} turns=${lastTurn + 1} hashes ${matches}/${compared} mismatch@${firstMismatch} caps=${caps.length} unresolved=${res.unresolved}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
