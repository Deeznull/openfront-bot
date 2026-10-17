/**
 * Headless bot game: one bot-driven Human player vs Nations + tribes, solo FFA.
 * No LLM involved; plays a full game on CPU and prints one JSON line of metrics.
 *
 * Usage (from tools/OpenFrontIO):
 *   npx tsx tests/bot/BotGame.ts --seed s1 --difficulty Impossible \
 *     [--params '{"trigger":0.55,...}'] [--maxMin 40] [--map World]
 *
 * Online-lobby mode (--roulette, or --map X --players N [--compact]): a real
 * public FFA lobby. Global difficulty Medium (the map's default Nations play as
 * Medium, like online), 400 tribes (100 compact), overtime on, and every other
 * human slot is a StandInExecution (Human-type player driven by the Impossible
 * Nation AI). --roulette draws (map, players, compact) from the online 30+ FFA
 * mix (results/online-ffa-mix/ffa_cells_v035.json, v0.35 playlist) by seed. --bot us uses the
 * userscript bot (packages/engine/src/execution/bot) instead of tests/bot.
 *
 * Branching (mid/late-game tests from one shared state; needs --fast):
 *   --snapAt M --snapOut f.snap   play to minute M, write the game snapshot, stop
 *                                 (outcome "snap"; dead before M = normal result).
 *   --fromSnap f.snap             resume that game (same --seed/lobby flags) with
 *                                 --params; our bot and every stand-in get FRESH
 *                                 executions (BotExecution / StandIn), since a
 *                                 snapshot restores them as plain Nations. The real
 *                                 Nations continue exactly. Checkpoints before M
 *                                 are absent; maxMin stays absolute game time.
 */
import {
  Cell,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig, GameStartInfo } from "@openfront/engine-api/Schemas";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { createGame } from "@openfront/engine/game/GameImpl";
import { restoreGame, snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { createNationsForGame } from "@openfront/engine/game/NationCreation";
import { GameRunner } from "@openfront/engine/GameRunner";
import { PlayerImpl } from "@openfront/engine/game/PlayerImpl";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import path from "path";
import { fileURLToPath } from "url";
import { NodeGameMapLoader } from "../perf/fullgame/NodeGameMapLoader";
import fs from "fs";
import zlib from "zlib";
import type { Player } from "@openfront/engine/game/Game";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import * as LegacyBot from "./BotExecution";
import * as UsBot from "@openfront/engine/execution/bot/BotExecution";
import { StandInExecution } from "./StandIn";

type BotParams = Record<string, number>;
const TRIBE_DBG = process.argv.includes("--tribeDbg");
if (TRIBE_DBG) (globalThis as any).__tdbg = true;
const BOT_KIND = process.argv.includes("--bot") &&
  process.argv[process.argv.indexOf("--bot") + 1] === "us" ? "us" : "legacy";
const BotMod: any = BOT_KIND === "us" ? UsBot : LegacyBot;
const BotExecution = BotMod.BotExecution;
const DEFAULT_PARAMS: BotParams = BotMod.DEFAULT_PARAMS;

export interface Lobby {
  map: string;
  players: number;
  compact: boolean;
}

/** Deterministic draw of a lobby cell from the online 30+ FFA mix. */
export function rouletteLobby(seed: string): Lobby {
  const cells: (Lobby & { w: number })[] = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "../../results/online-ffa-mix/ffa_cells_v035.json"), "utf8"),
  );
  let u = new PseudoRandom(simpleHash("roulette:" + seed)).nextInt(0, 1_000_000) / 1_000_000;
  for (const c of cells) {
    u -= c.w;
    if (u < 0) return { map: c.map, players: c.players, compact: c.compact };
  }
  const c = cells[cells.length - 1];
  return { map: c.map, players: c.players, compact: c.compact };
}

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CHECKPOINTS_MIN = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 60];

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function enumValue<T extends Record<string, string>>(e: T, name: string) {
  const key = Object.keys(e).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) throw new Error(`unknown value ${name}`);
  return e[key as keyof T];
}

export async function playGame(
  seed: string,
  difficulty: Difficulty,
  params: BotParams,
  maxMin: number,
  map: GameMapType = GameMapType.World,
  trace = false,
  lobby: Lobby | null = null,
) {
  if (lobby) map = enumValue(GameMapType, lobby.map) as GameMapType;
  const teamsArg = arg("teams", "");
  const teamMode = teamsArg !== "";
  const playerTeams: any = !teamMode ? undefined
    : /^\d+$/.test(teamsArg) ? Number(teamsArg)
    : teamsArg === "HvN" ? "Humans Vs Nations" : teamsArg;
  const donate = process.argv.includes("--donate");
  const clan = arg("clan", "") || null;
  const gameConfig: GameConfig = lobby
    ? {
        gameMap: map,
        gameMapSize: lobby.compact ? GameMapSize.Compact : GameMapSize.Normal,
        gameMode: teamMode ? GameMode.Team : GameMode.FFA,
        ...(teamMode ? { playerTeams } : {}),
        gameType: GameType.Public,
        difficulty: Difficulty.Medium,
        nations: "default",
        donateGold: donate,
        donateTroops: donate,
        bots: lobby.compact ? 100 : 400,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
        maxPlayers: lobby.players,
        spawnImmunityDuration: 5 * 10,
        disableClanTags: clan === null,
        overtime: { enabled: true },
      } as GameConfig
    : {
        gameMap: map,
        gameMapSize: GameMapSize.Normal,
        gameMode: teamMode ? GameMode.Team : GameMode.FFA,
        ...(teamMode ? { playerTeams } : {}),
        gameType: GameType.Singleplayer,
        difficulty,
        nations: "default",
        donateGold: donate,
        donateTroops: donate,
        bots: 400,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      };
  const gameStart: GameStartInfo = {
    gameID: seed,
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: [],
  };
  const config = new EngineConfig(gameConfig, false);
  const mapLoader = new NodeGameMapLoader(
    path.join(PROJECT_ROOT, "resources/maps"),
  );
  const terrain = await loadTerrainMap(
    await loadMapFiles(mapLoader, gameConfig.gameMap, gameConfig.gameMapSize),
  );
  const random = new PseudoRandom(simpleHash(seed));
  const me = new PlayerInfo("Bot", PlayerType.Human, "BOTCLNT1", random.nextID(), false, clan);
  const kinBots = Number(arg("kinBots", "0"));
  const standIns: PlayerInfo[] = [];
  for (let i = 1; lobby && i < lobby.players; i++) {
    standIns.push(
      new PlayerInfo(`Imp${i}`, PlayerType.Human, `SI${String(i).padStart(6, "0")}`, random.nextID(), false, i <= kinBots ? clan : null),
    );
  }
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    1 + standIns.length,
    random,
  );
  const fromSnap = arg("fromSnap", "");
  const snapAt = Number(arg("snapAt", "0"));
  const snapOut = arg("snapOut", "");
  if ((fromSnap || snapAt > 0) && !process.argv.includes("--fast")) throw new Error("--snapAt/--fromSnap need --fast");
  const game = fromSnap
    ? restoreGame(new Uint8Array(zlib.gunzipSync(fs.readFileSync(fromSnap))), {
        config: () => config,
        gameMap: terrain.gameMap,
        miniGameMap: terrain.miniGameMap,
        teamGameSpawnAreas: terrain.teamGameSpawnAreas,
      })
    : createGame(
        [me, ...standIns],
        nations,
        terrain.gameMap,
        terrain.miniGameMap,
        config,
        terrain.teamGameSpawnAreas,
      );
  const runner = new GameRunner(
    game,
    new Executor(game, seed, undefined),
    () => {},
  );
  if (fromSnap) {
    // Safety: retire any restored Nation execution of our bot or a stand-in
    // (the snapshot leaves them out); fresh ones are added below.
    const ours = new Set([me.id, ...standIns.map((x) => x.id)]);
    for (const e of (game as any).executions() as any[]) {
      const pl = (e as any).player;
      if (e instanceof NationExecution && pl && ours.has(pl.id())) {
        (e as any).active = false;
        e.tick = () => {};
      }
    }
  } else {
    runner.init();
  }
  const bot = new BotExecution(seed, new Nation(undefined as Cell | undefined, me), params);
  game.addExecution(bot);
  const kinExecs: any[] = [];
  for (const [i, si] of standIns.entries()) {
    if (i < kinBots) {
      const kb = new BotExecution(`${seed}-${si.name}`, new Nation(undefined as Cell | undefined, si), { ...params, kin: 1 });
      kinExecs.push(kb);
      game.addExecution(kb);
      continue;
    }
    game.addExecution(
      new StandInExecution(`${seed}-${si.name}`, new Nation(undefined as Cell | undefined, si)).ignoreSpawnOf(me.clientID!),
    );
  }

  const t0 = performance.now();
  let turn = 0;
  // --fast: headless stepping. Skips render-only work (player update packets,
  // name-label placement, desync hashes); game logic is unchanged.
  const fast = process.argv.includes("--fast");
  const g = game as any;
  if (fast) {
    PlayerImpl.prototype.toUpdate = function () {
      return null;
    };
    g.hash = () => 0;
  }
  const step = fast
    ? () => {
        g.executeNextTick();
        g.drainPackedTileUpdates();
        g.drainPackedMotionPlans();
        g.drainPackedPlayerUpdates();
        g.drainPackedAttackUpdates();
        g.drainNukeImpacts();
      }
    : () => {
        runner.addTurn({ turnNumber: turn++, intents: [] });
        runner.executeNextTick();
      };
  while (game.inSpawnPhase()) {
    step();
    if (turn > 2000) throw new Error("spawn phase did not end");
  }

  const land = game.numLandTiles();
  const meP = () => game.player(me.id);
  // Trace: tag each of our attacks with the bot/AI methods that launched it (call stack).
  if (trace) {
    const origAdd = game.addExecution.bind(game);
    (game as any).addExecution = (...es: any[]) => {
      for (const e of es) {
        if (!(e instanceof AttackExecution) || (e as any)._owner !== meP()) continue;
        const src = (new Error().stack ?? "").split("\n").slice(2)
          .map((l) => /at (?:[\w$]+\.)?([\w$<>]+) \(.*[\\/](\w+)\.ts:/.exec(l))
          .filter((m) => m !== null && m[2] !== "BotGame" && m[2] !== "AttackExecution" && m[1] !== "addExecution")
          .slice(0, 3).map((m) => `${m![2].replace(/Execution|Behavior/, "")}.${m![1]}`).join("<");
        const tid = (e as any)._targetID;
        const t = tid ? game.player(tid) : null;
        const send = (e as any).startTroops;
        console.error(`[atk ${(game.elapsedGameSeconds() / 60).toFixed(2)}m] ${t ? `${t.name()}(${t.type()[0]}${meP().isAlliedWith(t) ? ",ALLY" : ""}):${Math.round(t.troops() / 1000)}k` : "TN"} send=${send === null ? "def" : Math.round(send / 1000) + "k"} of ${Math.round(meP().troops() / 1000)}k src=${src}`);
      }
      return origAdd(...es);
    };
  }
  const majors = () =>
    game
      .allPlayers()
      .filter(
        (p) => p.type() === PlayerType.Nation || p.type() === PlayerType.Human,
      );
  const rankOfMe = () => {
    const mine = meP().numTilesOwned();
    return 1 + majors().filter((p) => p.isAlive() && p.numTilesOwned() > mine).length;
  };

  const checkpoints: Record<string, { share: number; rank: number; C: number; P: number; L?: number }> = {};
  // Hopeless rule (strict): [minute, min land share, min fraction of the leader's land].
  // Fires when EITHER bound fails at/after that minute. Always
  // recorded as hopelessAt (also in audit runs without --hopeless); with --hopeless the
  // game stops there and counts as a loss ("dead"). Audit: a won game with hopelessAt set
  // means the rule is too strict.
  // v2 (rl_base3 audit): the relative-to-leader bound cut a real win (rl12: 2.7%
  // of land = 13% of the leader at 20:00, won at 52:00 in overtime) and a 1-s dip
  // cut a game that reached 34%. Now absolute share only, sustained for 60 s.
  const HOPELESS: [number, number, number][] = [
    [8, 0.003, 0],
    [12, 0.008, 0],
    [20, 0.015, 0],
    [30, 0.05, 0],
    [40, 0.1, 0],
  ];
  let lowSince: number | null = null;
  const stopHopeless = process.argv.includes("--hopeless");
  let hopelessAt: number | null = null;
  const tribeAtk = new Map<string, Player>();
  if (TRIBE_DBG) {
    // Debug: every attack of ours on a tribe, with the routine that sent it and the kill estimate.
    const add = game.addExecution.bind(game);
    (game as any).addExecution = (...ex: any[]) => {
      for (const e of ex) {
        if (!(e instanceof AttackExecution) || (e as any)._owner !== meP()) continue;
        const id = (e as any)._targetID;
        const tg = id ? game.player(id) : null;
        if (tg === null || tg.type() !== PlayerType.Bot) continue;
        const src = (new Error().stack ?? "").split(/\r?\n/).slice(2, 6).map((l) => l.trim().split(" ")[1]).join("<");
        console.error(`SEND t=${game.ticks()} ${tg.name()} tiles=${tg.numTilesOwned()} troops=${Math.round(tg.troops())} send=${Math.round((e as any).startTroops ?? -1)} kill=${(bot as any).killSend?.(tg)} boat=${(e as any).sourceTile !== null} src=${src}`);
      }
      return add(...ex);
    };
  }
  let tribeStalls = 0;
  let tribeKills = 0;
  const tribesHit = new Map<string, Player>(); // every tribe we attacked (alive at the end = left half-eaten)
  let tribes10: number[] | null = null; // [attacked, still alive] at 10:00
  const leaderTiles = () => {
    let best = 0;
    for (const q of majors()) if (q.isAlive() && q.id() !== me.id && q.numTilesOwned() > best) best = q.numTilesOwned();
    return best;
  };
  let ci = 0;
  let maxShare = 0;
  let deathMin: number | null = null;
  const capSec = maxMin * 60;
  // Fine trace window (minutes) and step (ticks); default: every 1 s after 4:20
  const earlyMin = Number(arg("earlyMin", "0"));
  const earlyShare = Number(arg("earlyShare", "0.01"));
  const fineFrom = Number(arg("fineFrom", "4.33"));
  const fineTo = Number(arg("fineTo", "999"));
  const fineEvery = Number(arg("fineEvery", "10"));
  const nukeTypes = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV, UnitType.MIRVWarhead];
  const seenNukes = new Set<number>();
  const nukesIn = { atom: 0, hydro: 0, mirv: 0, firstMirv: null as number | null };
  while (ci < CHECKPOINTS_MIN.length && game.elapsedGameSeconds() > CHECKPOINTS_MIN[ci] * 60) ci++;
  let snapped = false;
  let idleSec = 0; // seconds at >= 95% of max troops (idle at the cap)
  let lastSec = game.elapsedGameSeconds();
  while (game.getWinner() === null) {
    step();
    const sec = game.elapsedGameSeconds();
    const p = meP();
    if (p.isAlive() && p.troops() >= 0.95 * game.config().maxTroops(p)) idleSec += sec - lastSec;
    lastSec = sec;
    const share = (teamMode && p.team() !== null ? game.teamTilesOwned(p.team()!) : p.numTilesOwned()) / land;
    if (share > maxShare) maxShare = share;
    if (ci < CHECKPOINTS_MIN.length && sec >= CHECKPOINTS_MIN[ci] * 60) {
      checkpoints[`${CHECKPOINTS_MIN[ci]}m`] = {
        share: +share.toFixed(4),
        rank: rankOfMe(),
        C: p.unitCount(UnitType.City),
        P: p.unitCount(UnitType.Port),
        L: +(leaderTiles() / land).toFixed(4),
        // Richer early-game features (output only, no effect on play).
        g: Math.round(Number(p.gold()) / 1000),
        tr: +(p.troops() / Math.max(1, game.config().maxTroops(p))).toFixed(3),
        mx: Math.round(game.config().maxTroops(p) / 1000),
        F: p.unitCount(UnitType.Factory),
        D: p.unitCount(UnitType.DefensePost),
        W: p.unitCount(UnitType.Warship),
        S: p.unitCount(UnitType.MissileSilo) + p.unitCount(UnitType.SAMLauncher),
        idle: Math.round(idleSec),
        // Built vs captured cities/ports (engine stats: units[type][0]=built, [2]=captured, [3]=lost).
        ...(() => { const u = (game.stats().getPlayerStats(p) as any)?.units ?? {}; const n = (t: string, i: number) => Number(u[t]?.[i] ?? 0n);
          return { Cb: n("city", 0), Cc: n("city", 2), Cl: n("city", 3), Pb: n("port", 0), Pc: n("port", 2), Pl: n("port", 3) }; })(),
        nb: game.players().filter((q) => q !== p && q.isAlive() && q.type() !== PlayerType.Bot && p.sharesBorderWith(q)).length,
        nbR: +(Math.max(0, ...game.players().filter((q) => q !== p && q.isAlive() && q.type() !== PlayerType.Bot && !p.isFriendly(q) && p.sharesBorderWith(q)).map((q) => q.troops())) / Math.max(1, p.troops())).toFixed(2),
        tb: game.players().filter((q) => q.isAlive() && q.type() === PlayerType.Bot && p.sharesBorderWith(q)).length,
        al: p.alliances().length,
        inA: p.incomingAttacks().length,
        outA: p.outgoingAttacks().length,
      };
      ci++;
    }
    const fine = sec >= fineFrom * 60 && sec <= fineTo * 60 && game.ticks() % fineEvery === 0;
    if (trace && (game.ticks() % 300 === 0 || fine)) {
      const inc = p.incomingAttacks().map((a) => `${a.attacker().name()}(${a.attacker().type()}):${Math.round(a.troops())}`);
      const out = p.outgoingAttacks().map((a) => `${a.target().isPlayer() ? (a.target() as any).name() : "TN"}:${Math.round(a.troops())}`);
      if (game.ticks() % 300 === 0) {
        const fmt = (q: any) => `${q.name()}:${q.numTilesOwned()}t/${Math.round(q.troops() / 1000)}k/${Math.round(game.config().maxTroops(q) / 1000)}kmax/${Math.round(Number(q.gold()) / 1000)}kg/C${q.unitCount(UnitType.City)}P${q.unitCount(UnitType.Port)}F${q.unitCount(UnitType.Factory)}D${q.unitCount(UnitType.DefensePost)}S${q.unitCount(UnitType.MissileSilo)}SAM${q.unitCount(UnitType.SAMLauncher)}`;
        const top = majors().filter((q) => q.isAlive()).sort((a, b) => b.numTilesOwned() - a.numTilesOwned()).slice(0, 3);
        const natAll = majors().filter((q) => q.isAlive() && q.type() === PlayerType.Nation);
        const avgAllies = natAll.reduce((a, q) => a + q.allies().length, 0) / Math.max(1, natAll.length);
        console.error(`[ally ${(sec / 60).toFixed(1)}m] myAllies=${p.allies().length} nationAvgAllies=${avgAllies.toFixed(2)} nationsAlive=${natAll.length}`);
        console.error(`[cmp ${(sec / 60).toFixed(1)}m] ME ${fmt(p)} | TOP ${top.map(fmt).join(" | ")}`);
        const nb = (game.players() as any[]).filter((q) => q !== p && q.isAlive() && p.sharesBorderWith(q)).map((q) => `${q.name()}(${q.type()[0]}${p.isAlliedWith(q) ? ",ALLY" : ""}${p.isFriendly(q) && !p.isAlliedWith(q) ? ",friend" : ""}):${q.numTilesOwned()}t/${Math.round(q.troops() / 1000)}k`);
        console.error(`[nb ${(sec / 60).toFixed(1)}m] ${nb.join(" ")}`);
      }
      console.error(`[t ${(sec / 60).toFixed(1)}m] tiles=${p.numTilesOwned()} troops=${Math.round(p.troops())}/${Math.round(game.config().maxTroops(p))} gold=${p.gold()} rank=${rankOfMe()} in=[${inc.join(",")}] out=[${out.join(",")}]`);
    }
    if (trace || game.ticks() % 10 === 0) {
      for (const q of game.allPlayers()) {
        for (const u of q.units(...nukeTypes)) {
          if (seenNukes.has(u.id())) continue;
          seenNukes.add(u.id());
          const tgt = u.targetTile();
          const victim = tgt !== undefined ? game.owner(tgt) : null;
          if (victim === p && q !== p && u.type() !== UnitType.MIRVWarhead) {
            const k = u.type() === UnitType.MIRV ? "mirv" : u.type() === UnitType.HydrogenBomb ? "hydro" : "atom";
            nukesIn[k]++;
            if (k === "mirv" && nukesIn.firstMirv === null) nukesIn.firstMirv = +(sec / 60).toFixed(1);
          }
          if (!trace) continue;
          const vName = victim && victim.isPlayer() ? (victim as any).name() : "-";
          if (u.type() !== UnitType.MIRVWarhead || vName === "Bot") {
            console.error(`[nuke ${(sec / 60).toFixed(2)}m] ${q.name()} ${u.type()} -> ${vName}`);
          }
        }
      }
    }
    if (!p.isAlive()) {
      deathMin = +(sec / 60).toFixed(2);
      break;
    }
    if (snapAt > 0 && sec >= snapAt * 60) {
      // Our bot and the stand-ins are BotExecutions (not snapshot-registered); they
      // are left out and re-created fresh on resume. Their players are stored.
      const all = g.execs;
      g.execs = all.filter((e: any) => !(e instanceof UsBot.BotExecution || e instanceof LegacyBot.BotExecution));
      try {
        fs.writeFileSync(snapOut, zlib.gzipSync(snapshotGame(game), { level: 1 }));
      } finally {
        g.execs = all;
      }
      snapped = true;
      break;
    }
    if (sec >= capSec) break;
    if (game.ticks() % 10 === 0 && p.isAlive()) {
      // Our attacks on tribes: did each end with the tribe dead (kill) or alive (stall)?
      const now = new Set<string>();
      for (const at of p.outgoingAttacks()) {
        const tg = at.target();
        if (!tg.isPlayer() || (tg as Player).type() !== PlayerType.Bot) continue;
        now.add(at.id());
        if (!tribeAtk.has(at.id())) tribeAtk.set(at.id(), tg as Player);
        tribesHit.set((tg as Player).id(), tg as Player);
      }
      if (tribes10 === null && sec >= 600) tribes10 = [tribesHit.size, [...tribesHit.values()].filter((t) => t.isAlive()).length];
      for (const [id, tg] of tribeAtk) {
        if (now.has(id)) continue;
        if (tg.isAlive()) {
          tribeStalls++;
          if (TRIBE_DBG) console.error(`STALL t=${game.ticks()} ${tg.name()} tiles=${tg.numTilesOwned()} troops=${Math.round(tg.troops())}`);
        }
        else tribeKills++;
        tribeAtk.delete(id);
      }
    }
    if (hopelessAt === null && game.ticks() % 10 === 0) {
      const rule = HOPELESS.filter((h) => sec >= h[0] * 60).pop();
      const low = rule !== undefined && (share < rule[1] || (rule[2] > 0 && p.numTilesOwned() < rule[2] * leaderTiles()));
      if (!low) lowSince = null;
      else if (lowSince === null) lowSince = sec;
      if (low && lowSince !== null && sec - lowSince >= 60) {
        hopelessAt = +(sec / 60).toFixed(2);
        if (stopHopeless) {
          deathMin = hopelessAt;
          break;
        }
      }
    }
    // Early stop for hopeless games (counted as "dead" at this minute).
    if (earlyMin > 0 && sec >= earlyMin * 60 && share < earlyShare) {
      deathMin = +(sec / 60).toFixed(2);
      break;
    }
  }

  const winner = game.getWinner();
  const winnerName =
    winner === null ? null : typeof winner === "string" ? winner : winner.name();
  const won = winner !== null && (typeof winner === "string" ? teamMode && winner === meP().team() : winner.id() === me.id);
  const outcome = snapped ? "snap" : won ? "win" : deathMin !== null ? "dead" : winner !== null ? "lost" : "timeout";
  const p = meP();
  const pstats = (game.stats().getPlayerStats(p) as any) ?? {};
  const units = pstats.units ?? {};
  const g8 = (pstats.gold ?? []).map((x: bigint) => Math.round(Number(x ?? 0n) / 1000));
  const goldK = { work: g8[0] ?? 0, war: g8[1] ?? 0, trade: g8[2] ?? 0, steal: g8[3] ?? 0, trainSelf: g8[4] ?? 0, trainOther: g8[5] ?? 0 };
  const captured: Record<string, number> = {};
  const built: Record<string, number> = {};
  for (const [k, v] of Object.entries(units) as [string, bigint[]][]) {
    if (Number(v[2] ?? 0n) > 0) captured[k] = Number(v[2]);
    if (Number(v[0] ?? 0n) > 0) built[k] = Number(v[0]);
  }
  const lobbyOut = lobby ?? { map, players: 1, compact: false };
  const humansAlive = majors().filter((q) => q.isAlive() && q.type() === PlayerType.Human).length;
  return {
    seed,
    lobby: lobbyOut,
    nations: nations.length,
    humansAlive,
    hopelessAt,
    // Same seed => same map/lobby; enemySpawnHash must match across param sets (fair A/B).
    enemySpawnHash: simpleHash(
      game.allPlayers().filter((q) => q.id() !== me.id && q.type() !== PlayerType.Bot)
        .map((q) => `${q.name()}@${q.spawnTile() ?? "-"}`).sort().join(","),
    ),
    tribeSpawnHash: simpleHash(
      game.allPlayers().filter((q) => q.type() === PlayerType.Bot).map((q) => `${q.name()}@${q.spawnTile() ?? "-"}`).sort().join(","),
    ),
    difficulty,
    params,
    outcome,
    minutes: +(game.elapsedGameSeconds() / 60).toFixed(2),
    deathMin,
    finalShare: +(p.numTilesOwned() / land).toFixed(4),
    finalRank: rankOfMe(),
    maxShare: +maxShare.toFixed(4),
    winner: winnerName,
    team: teamMode ? meP().team() : undefined,
    kin: [...((bot as any).kin ?? [])].length,
    kinSent: (bot as any).kinSent ?? 0,
    kinBoats: (bot as any).kinBoats ?? 0,
    donations: (bot as any).donations,
    kinBotsFound: kinExecs.map((k) => k.kin.size),
    checkpoints,
    snipes: bot.snipesSent,
    grabs: bot.grabsSent,
    pirates: bot.piratesBuilt,
    medBreaks: (bot as any).medBreaks ?? 0,
    medSeen: (bot as any).medSeen ?? 0,
    medWhy: (bot as any).medWhy ?? [],
    tribe: { kills: tribeKills, stalls: tribeStalls, sized: (bot as any).killsSized ?? 0, held: (bot as any).killsHeld ?? 0,
      steals: (bot as any).steals ?? 0, pvpSkips: (bot as any).pvpSkips ?? 0,
      hit: tribesHit.size, at10: tribes10, left: [...tribesHit.values()].filter((t) => t.isAlive()).length, fin: (bot as any).fin ?? null },
    boats: (bot as any).boatPicks ?? null,
    nukes: { sent: ((bot as any).nukeBehavior?.atomBombsLaunched ?? 0) + ((bot as any).nukeBehavior?.hydrogenBombsLaunched ?? 0),
      counter: (bot as any).counterNukes ?? 0, lapse: (bot as any).lapseStrikes ?? 0, lapseGuarded: (bot as any).lapseGuarded ?? 0, siloGated: (bot as any).siloGated ?? 0, lapseCapped: (bot as any).lapseCapped ?? 0, samHeld: (bot as any).samHeld ?? 0, nukeRisk: (bot as any).nukeRiskSkips ?? 0, sams: (bot as any).samsBuilt ?? 0, boxStrong: (bot as any).boxStrongPicks ?? 0, betray: (bot as any).betrayals ?? 0, traitor: (bot as any).traitorStrikes ?? 0,
      posts: (bot as any).defPosts ?? 0, richV: (bot as any).richVetoes ?? 0, richR: (bot as any).richRedirects ?? 0,
      mirv: (bot as any).mirvsSent ?? 0, mirvPre: (bot as any).mirvPreFired ?? 0, killCapped: (bot as any).killCapped ?? 0, mirvHit: (bot as any).mirvStrikes ?? 0, chain: (bot as any).chainBoats ?? 0, in: nukesIn },
    gold: Number(p.gold()),
    goldK,
    captured,
    built,
    wallSec: +((performance.now() - t0) / 1000).toFixed(1),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const params: BotParams = {
    ...DEFAULT_PARAMS,
    ...(process.argv.includes("--autoplay") ? BotMod.AUTOPLAY_PARAMS : {}),
    ...JSON.parse(arg("params", "{}")),
  };
  const seed = arg("seed", "s1");
  const lobby: Lobby | null = process.argv.includes("--roulette")
    ? rouletteLobby(seed)
    : process.argv.includes("--players")
      ? { map: arg("map", "World"), players: Number(arg("players", "30")), compact: process.argv.includes("--compact") }
      : null;
  playGame(
    seed,
    enumValue(Difficulty, arg("difficulty", "Medium")) as Difficulty,
    params,
    Number(arg("maxMin", "40")),
    enumValue(GameMapType, arg("map", "World")) as GameMapType,
    process.argv.includes("--trace"),
    lobby,
  )
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
