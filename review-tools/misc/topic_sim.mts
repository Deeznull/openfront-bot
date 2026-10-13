/**
 * Topic extractor: re-simulates one v34 replay (commit 3f5633b9) and writes compact per-topic facts for every human:
 *   econ   every 60 s: tiles, troops, max, gold, stats gold [work,war,trade,steal,trainSelf,trainOther,donRecv], C/P/F/W/SAM/Silo/DP, city levels, allies, in/out attacks
 *   build  each build_unit intent: unit, tile, distance to nearest non-friendly land front, coast distance, nearest own city, own tiles/cities/warships
 *   cap    structure owner changes: unit, new/old owner, victim troops/max/tiles/attackers, capturer troops/tiles, boat landing nearby, capturer land attack on victim
 *   trade  trade ship spawns (owner, destination port owner) and captures (pirate, victim)
 *   pol    alliance/embargo/target/donate/break intents + alliance update events with relative strength and border sharing
 *   att    attacks/boats with target and relative strength
 * Run (from tools\OF34):  npx tsx ..\topic_sim.mts <replay.json> <out.json>
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
const ECON = 600; // ticks (60 s)
const STRUCT = new Set<string>([UnitType.City, UnitType.Port, UnitType.Factory, UnitType.DefensePost, UnitType.MissileSilo, UnitType.SAMLauncher]);
const UT: Record<string, string> = {
  [UnitType.City]: "C", [UnitType.Port]: "P", [UnitType.Factory]: "F", [UnitType.DefensePost]: "DP", [UnitType.MissileSilo]: "Silo",
  [UnitType.SAMLauncher]: "SAM", [UnitType.Warship]: "W", [UnitType.AtomBomb]: "Atom", [UnitType.HydrogenBomb]: "H", [UnitType.MIRV]: "MIRV",
  [UnitType.TransportShip]: "T", [UnitType.TradeShip]: "Trade", [UnitType.Train]: "Train",
};
const ut = (u: string) => UT[u] ?? u;

async function main() {
  const [src, out] = process.argv.slice(2);
  console.debug = () => {};
  const origLog = console.log, origErr = console.error;
  console.warn = () => {};
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
  const W = game.width();
  const xy = (t: number) => [t % W, Math.floor(t / W)];
  const sid = (p: any) => (p && typeof p.smallID === "function" ? p.smallID() : -1);
  const resolve = (id: any): any => {
    if (id === null || id === undefined) return null;
    const byC = game.playerByClientID(id);
    if (byC) return byC;
    return game.hasPlayer(id) ? game.player(id) : null;
  };

  const owner = new Map<number, number>(); // unit id -> owner small id (structures + trade ships)
  const portOwner = new Map<number, number>();
  const cap: any[] = [], trade: any[] = [], tEnd: any[] = [], unitEv: any[] = [], polEv: any[] = [];
  let fatal: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, undefined, gameStart.tribes?.map((t) => t.name)),
    (gu: any) => {
      if ("errMsg" in gu) { fatal = `${gu.errMsg}\n${gu.stack ?? ""}`; return; }
      const t = gu.tick;
      for (const a of gu.updates[GameUpdateType.AllianceRequest]) polEv.push([t, "req", a.requestorID, a.recipientID]);
      for (const a of gu.updates[GameUpdateType.AllianceRequestReply]) polEv.push([t, a.accepted ? "acc" : "rej", a.request.requestorID, a.request.recipientID]);
      for (const a of gu.updates[GameUpdateType.BrokeAlliance]) polEv.push([t, "broke", a.traitorID, a.betrayedID]);
      for (const a of gu.updates[GameUpdateType.ConquestEvent]) polEv.push([t, "conq", a.conquerorId, a.conqueredId]);
      for (const u of gu.updates[GameUpdateType.Unit]) {
        const ty = u.unitType;
        if (ty === UnitType.TransportShip && !u.isActive) { tEnd.push([t, u.ownerID, u.pos]); continue; }
        if (ty === UnitType.TradeShip) {
          const prev = owner.get(u.id);
          if (prev === undefined) {
            const dst = u.targetUnitId !== undefined ? portOwner.get(u.targetUnitId) ?? -1 : -1;
            trade.push([t, "spawn", u.ownerID, dst]);
          } else if (prev !== u.ownerID && u.isActive) {
            trade.push([t, "stolen", u.ownerID, prev, ...xy(u.pos)]);
          }
          if (!u.isActive) owner.delete(u.id); else owner.set(u.id, u.ownerID);
          continue;
        }
        if (ty === UnitType.Warship || ty === UnitType.AtomBomb || ty === UnitType.HydrogenBomb || ty === UnitType.MIRV) {
          if (!owner.has(u.id)) { owner.set(u.id, u.ownerID); unitEv.push([t, ut(ty), u.ownerID, ...xy(u.pos)]); }
          continue;
        }
        if (!STRUCT.has(ty)) continue;
        if (ty === UnitType.Port) { if (u.isActive) portOwner.set(u.id, u.ownerID); else portOwner.delete(u.id); }
        const prev = owner.get(u.id);
        if (prev !== undefined && prev !== u.ownerID && u.isActive) {
          const v = game.playerBySmallID(prev) as any, c = game.playerBySmallID(u.ownerID) as any;
          const vAtt = v && v.isPlayer?.() ? v.incomingAttacks().map((a: any) => sid(a.attacker())) : [];
          const cLand = c && c.isPlayer?.() ? c.outgoingAttacks().some((a: any) => sid(a.target()) === prev) : false;
          cap.push({
            t, u: ut(ty), lvl: u.level, to: u.ownerID, from: prev, x: xy(u.pos)[0], y: xy(u.pos)[1],
            vTr: v?.isPlayer?.() ? Math.round(v.troops()) : 0, vMax: v?.isPlayer?.() ? Math.round(config.maxTroops(v)) : 0,
            vTiles: v?.isPlayer?.() ? v.numTilesOwned() : 0, vType: v?.isPlayer?.() ? v.type() : "",
            vAtt, cTr: c?.isPlayer?.() ? Math.round(c.troops()) : 0, cTiles: c?.isPlayer?.() ? c.numTilesOwned() : 0, cLand, pos: u.pos,
          });
        }
        if (u.isActive) owner.set(u.id, u.ownerID); else owner.delete(u.id);
      }
    },
  );
  runner.init();

  const hp = game.allPlayers().filter((p) => p.type() === PlayerType.Human);
  const smallMap: Record<string, any> = {};
  for (const p of game.allPlayers()) smallMap[p.smallID()] = { name: p.name(), type: p.type() };
  const econ: any[] = [], build: any[] = [], pol: any[] = [], att: any[] = [];
  const frontCache = new Map<number, { t: number; front: number[]; shore: number[] }>();
  const frontOf = (p: any, t: number) => {
    const c = frontCache.get(p.smallID());
    if (c && c.t === t) return c;
    const front: number[] = [], shore: number[] = [];
    for (const b of p.borderTiles()) {
      if (game.isShore(b)) shore.push(b);
      for (const n of game.neighbors(b)) {
        if (!game.isLand(n)) continue;
        const o = game.owner(n) as any;
        if (o === p) continue;
        if (o.isPlayer() && p.isFriendly(o)) continue;
        if (!o.isPlayer()) continue; // unowned land is not a threat front
        front.push(b);
        break;
      }
    }
    const r = { t, front, shore };
    frontCache.set(p.smallID(), r);
    return r;
  };
  const nearest = (arr: number[], tile: number) => {
    let best = Infinity;
    for (const a of arr) { const d = game.manhattanDist(a, tile); if (d < best) best = d; }
    return best === Infinity ? -1 : best;
  };
  const rel = (p: any, o: any) => (o && o.isPlayer?.() ? [Math.round((100 * o.troops()) / Math.max(1, p.troops())) / 100, Math.round((100 * o.numTilesOwned()) / Math.max(1, p.numTilesOwned())) / 100, p.sharesBorderWith(o) ? 1 : 0, p.isFriendly(o) ? 1 : 0] : [0, 0, 0, 0]);

  for (const turn of record.turns) {
    const tn = turn.turnNumber;
    for (const it of turn.intents as any[]) {
      const p = game.playerByClientID(it.clientID) as any;
      if (!p || !p.isAlive?.()) continue;
      const me = p.smallID();
      switch (it.type) {
        case "attack": {
          const o = resolve(it.targetID);
          att.push([tn, me, "land", o ? o.smallID() : -1, Math.round(it.troops ?? 0), Math.round(p.troops()), Math.round(config.maxTroops(p)), ...rel(p, o)]);
          break;
        }
        case "boat": {
          const o = game.owner(it.dst) as any;
          att.push([tn, me, "boat", o.isPlayer() ? o.smallID() : -1, Math.round(it.troops ?? 0), Math.round(p.troops()), Math.round(config.maxTroops(p)), ...rel(p, o.isPlayer() ? o : null)]);
          break;
        }
        case "build_unit": {
          const tile = it.tile;
          const u = ut(it.unit);
          if (u === "Atom" || u === "H" || u === "MIRV") {
            const o = game.owner(tile) as any;
            build.push([tn, me, u, ...xy(tile), o.isPlayer() ? o.smallID() : -1]);
            break;
          }
          const f = frontOf(p, tn);
          const cities = p.units(UnitType.City);
          let nc = Infinity;
          for (const c of cities) nc = Math.min(nc, game.manhattanDist(c.tile(), tile));
          build.push([tn, me, u, ...xy(tile), nearest(f.front, tile), nearest(f.shore, tile), nc === Infinity ? -1 : nc,
            p.numTilesOwned(), cities.length, p.units(UnitType.Warship).length, game.owner(tile) === p ? 1 : 0, Math.round(Number(p.gold()))]);
          break;
        }
        case "upgrade_structure":
          build.push([tn, me, "up_" + ut(it.unit), -1, -1, Math.round(Number(p.gold()))]);
          break;
        case "move_warship":
          pol.push([tn, me, "move_warship", -1, it.unitIds?.length ?? 0, ...xy(it.tile)]);
          break;
        case "allianceRequest": case "breakAlliance": case "targetPlayer": case "embargo": case "donate_gold": case "donate_troops": case "allianceReject": case "allianceExtension": {
          const o = resolve(it.recipient ?? it.target ?? it.targetID ?? it.requestor);
          const amt = it.gold ?? it.troops ?? (it.action ?? "");
          pol.push([tn, me, it.type, o ? o.smallID() : -1, typeof amt === "number" ? Math.round(amt) : amt, ...rel(p, o), p.allies().length]);
          break;
        }
        case "embargo_all":
          pol.push([tn, me, "embargo_all", -1, it.action]);
          break;
        case "quick_chat": case "emoji": {
          const o = resolve(it.recipient);
          pol.push([tn, me, it.type, o ? o.smallID() : -1, String(it.quickChatKey ?? it.emoji ?? "")]);
          break;
        }
      }
    }
    runner.addTurn(turn);
    if (!runner.executeNextTick()) { origErr(`tick failed at ${tn}: ${fatal}`); break; }
    if (tn % ECON === 0 && tn > 0) {
      for (const p of hp as any[]) {
        if (!p.isAlive()) continue;
        const st: any = game.stats().getPlayerStats(p) ?? {};
        const g = (st.gold ?? []).map((x: any) => Math.round(Number(x ?? 0) / 1000));
        while (g.length < 7) g.push(0);
        const cities = p.units(UnitType.City);
        econ.push([tn, p.smallID(), p.numTilesOwned(), Math.round(p.troops()), Math.round(config.maxTroops(p)), Math.round(Number(p.gold()) / 1000), ...g.slice(0, 7),
          cities.length, cities.reduce((s: number, c: any) => s + c.level(), 0), p.units(UnitType.Port).length, p.units(UnitType.Factory).length,
          p.units(UnitType.Warship).length, p.units(UnitType.SAMLauncher).length, p.units(UnitType.MissileSilo).length, p.units(UnitType.DefensePost).length,
          p.allies().length, p.incomingAttacks().length, p.outgoingAttacks().length]);
      }
    }
  }
  // match captures with boat landings of the capturer (±15 s, within 40 tiles)
  for (const c of cap) {
    c.boat = tEnd.some((e) => e[1] === c.to && Math.abs(e[0] - c.t) <= 150 && game.manhattanDist(e[2], c.pos) <= 40) ? 1 : 0;
    delete c.pos;
  }
  const final = hp.map((p: any) => [p.smallID(), p.numTilesOwned()]).sort((a, b) => b[1] - a[1]);
  const res = {
    gid: info.gameID, map: info.config.gameMap, ticks: game.ticks(), W, H: game.height(),
    humans: hp.map((p) => ({ small: p.smallID(), name: p.name() })), smallMap, final,
    keys: {
      econ: "tick,small,tiles,troops,maxTroops,goldK,work,war,trade,steal,trainSelf,trainOther,donRecv,C,cityLvls,P,F,W,SAM,Silo,DP,allies,inAtt,outAtt (gold cols in K)",
      build: "tick,small,unit,x,y,frontDist,coastDist,nearestOwnCity,ownTiles,ownCities,ownWarships,tileIsOwn,gold | nukes: tick,small,unit,x,y,targetOwner | upgrades: tick,small,up_X,-1,-1,gold",
      att: "tick,small,kind,target,troopsSent,myTroops,myMax,targetTroops/my,targetTiles/my,sharesBorder,friendly",
      pol: "tick,small,type,target,amount,targetTroops/my,targetTiles/my,sharesBorder,friendly,myAllies",
      polEv: "tick,req|acc|rej|broke|conq,a,b", trade: "tick,spawn,owner,destPortOwner | tick,stolen,pirate,victim,x,y", unitEv: "tick,unit,owner,x,y (first seen)",
    },
    econ, build, att, pol, polEv, cap, trade, unitEv,
  };
  fs.writeFileSync(out, JSON.stringify(res));
  console.log = origLog;
  console.log(`${info.gameID} ticks=${game.ticks()} econ=${econ.length} build=${build.length} cap=${cap.length} trade=${trade.length} pol=${pol.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
