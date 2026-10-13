/**
 * Baseline bot for a Human player: scored spawn choice + the Nation AI
 * behaviors (attack/expand, structures, alliances, nukes, warships) with
 * tunable ratios and reaction rate. Private NationExecution fields are set
 * through `any` (tsx does no type-check of privacy at runtime).
 */
import type { Game, Player } from "@openfront/engine/game/Game";
import { Nation, PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { canBuildTransportShip, targetTransportTile } from "@openfront/engine/game/TransportShipUtils";
import { randTerritoryTileArray } from "@openfront/engine/execution/nation/NationUtils";
import { nearestTileDist, nearestTileDistCapped } from "@openfront/engine/execution/Util";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
import { TargetPlayerExecution } from "@openfront/engine/execution/TargetPlayerExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { AllianceExtensionExecution } from "@openfront/engine/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";

export interface BotParams {
  trigger: number; // troop/max ratio needed to start an attack
  reserve: number; // ratio kept home when attacking players
  expand: number; // ratio kept home when expanding into neutral land/tribes
  rate: number; // ticks between decisions (Impossible nations: 30-50)
  spawnDelay: number; // ticks to wait so nations are placed first
  spawnSamples: number; // candidate spawn tiles scored
  wDist: number; // weight: distance to nearest nation/human spawn
  wLand: number; // weight: land density around the tile
  wTribe: number; // weight: tribes nearby (easy early food)
  distCap: number; // distance (tiles) beyond which a rival is "far enough"
  defK: number; // keep troops >= defK x strongest bordering nation/human (KNOWLEDGE S28)
  defMin: number; // keep troops >= defMin x own max troops (out of 'veryWeak' filter)
  ally: number; // 1 = actively request alliances with nearby nations, renew, accept all
  allyRange: number; // request alliances with nations whose spawn is within this many tiles (plus all bordering)
  betray: number; // 1 = allow the AI to betray allies when "safe", 0 = never
  econ: number; // 1 = don't hoard gold for nukes, don't block builds on failed defense posts
  defCap: number; // max defense floor (ratio of own max troops)
  counter: number; // 1 = counter incoming land attacks (opposing attacks cancel 1:1)
  cExtra: number; // counter sends incoming + cExtra x attacker's home troops
  counterMax: number; // never send more than this ratio of own troops in a counter
  cFloor: number; // after all counters this tick, keep troops >= cFloor x own max troops
  econUntil: number; // minutes; after this the AI saves gold for nukes/SAMs again (0 = never revert)
  cPart: number; // if the full counter is unaffordable, cancel cPart x incoming troops instead (0 = off)
  dump: number; // 1 = at troop cap, dump surplus on a neighbor (engine's Impossible send cap stalls small players)
  dumpAt: number; // troops/max ratio that triggers a dump
  dumpKeep: number; // keep this ratio of max troops home after a dump
  dumpRel: number; // only dump on players with troops <= dumpRel x ours
  snipe: number; // 1 = boat-snipe enemy coastal structures (captured structures flip to the tile owner)
  snipeK: number; // send snipeK x defender troops-per-tile x 40 (about a 3-4 tile radius)
  snipeMax: number; // never send more than this ratio of own troops in one snipe
  snipeRange: number; // max boat distance (tiles) launch -> landing
  snipeEvery: number; // ticks between snipe checks
  snipeHome: number; // only snipe when troops >= snipeHome x max troops
  snipeWeak: number; // only snipe "losing" players: under attack, or troops < snipeWeak x their max (1 = anyone)
  grab: number; // 1 = land-attack weak bordering players whose structures sit near our border
  grabUntil: number; // minutes the grab behavior is active (early game)
  grabRel: number; // target troops <= grabRel x ours (x2 if someone else is already hitting it)
  grabK: number; // send grabK x target troops (capped by our defense floor)
  grabDist: number; // structures within this many tiles of our border count
  grabAllyRisk: number; // skip if target's allies near us (not our allies) have > grabAllyRisk x our troops
  grabMark: number; // 1 = also mark the target, so our Friendly nation allies assist (AiAttackBehavior.assistAllies)
  cityPlace: number; // 1 = human-style city placement: deep interior / hard to reach, rail-connected
  cityDepth: number; // distance (tiles) to the nearest land front that counts fully (not capped at nuke radius)
  cityDeepW: number; // weight per tile of distance from the land front
  cityShoreW: number; // weight per tile of distance from our coast (halved when we own warships)
  cityRailW: number; // weight of rail-cluster connectivity (ally stations pay 35k/stop, other 25k, self 10k)
  citySamples: number; // candidate tiles scored per city placement (engine: 25)
  factRatio: number; // factories per city (0 = engine default 0.75, x0.33 if coastal)
  portRatio: number; // ports per city (0 = engine default 0.75)
  pirate: number; // 1 = warships patrol enemy trade lanes and capture trade ships (gold)
  pirateMax: number; // max warships we build for pirating
  pirateRange: number; // hotspot must be within this many tiles of one of our ports
  pirateMin: number; // min non-friendly trade ships near a hotspot to act
  pirateKeep: number; // gold left after buying a warship (ratio of its cost)
  pirateEvery: number; // ticks between pirate decisions
  pirateSafe: number; // robbing angers the owner: only rob owners already attacking us, not bordering us, or with troops <= pirateSafe x ours
}

export const DEFAULT_PARAMS: BotParams = {
  trigger: 0.55,
  reserve: 0.35,
  expand: 0.15,
  rate: 40,
  spawnDelay: 20,
  spawnSamples: 300,
  wDist: 1,
  wLand: 1,
  wTribe: 0.5,
  distCap: 120,
  defK: 0,
  defMin: 0,
  ally: 0,
  allyRange: 250,
  betray: 1,
  econ: 0,
  defCap: 0.9,
  counter: 0,
  cExtra: 0.5,
  counterMax: 0.6,
  cFloor: 0,
  econUntil: 0,
  cPart: 0,
  dump: 0,
  dumpAt: 0.9,
  dumpKeep: 0.5,
  dumpRel: 2,
  snipe: 0,
  snipeK: 3,
  snipeMax: 0.25,
  snipeRange: 250,
  snipeEvery: 30,
  snipeHome: 0.3,
  snipeWeak: 0.3,
  grab: 0,
  grabUntil: 15,
  grabRel: 0.6,
  grabK: 1.3,
  grabDist: 40,
  grabAllyRisk: 1,
  grabMark: 1,
  cityPlace: 0,
  cityDepth: 60,
  cityDeepW: 1,
  cityShoreW: 0.5,
  cityRailW: 1,
  citySamples: 60,
  factRatio: 0,
  portRatio: 0,
  pirate: 0,
  pirateMax: 3,
  pirateRange: 400,
  pirateMin: 3,
  pirateKeep: 0.5,
  pirateEvery: 50,
  pirateSafe: 0.7,
};

export class BotExecution extends NationExecution {
  private botGame!: Game;
  private spawnSent = false;
  private rng: PseudoRandom;
  public spawnTile: TileRef | null = null;

  constructor(
    private botGameID: string,
    private botNation: Nation,
    private params: BotParams,
  ) {
    super(botGameID, botNation);
    this.rng = new PseudoRandom(simpleHash(botGameID) + 77);
    const self = this as any;
    self.triggerRatio = params.trigger;
    self.reserveRatio = params.reserve;
    self.expandRatio = params.expand;
  }

  init(mg: Game) {
    super.init(mg);
    this.botGame = mg;
    const self = this as any;
    self.attackRate = Math.max(5, Math.round(this.params.rate));
    self.attackTick = 0;
  }

  tick(ticks: number) {
    if (this.botGame.inSpawnPhase() && !this.spawnSent) {
      if (ticks < this.params.spawnDelay) return;
      this.spawnTile = this.chooseSpawn();
      this.botGame.addExecution(
        new SpawnExecution(
          this.botGameID,
          this.botNation.playerInfo,
          this.spawnTile ?? undefined,
        ),
      );
      this.spawnSent = true;
      (this as any).spawnExecAdded = true;
      return;
    }
    if (ticks % 10 === 0) this.updateDefenseFloor();
    if (this.params.ally > 0) this.diplomacy(ticks);
    if (this.params.counter > 0 && ticks % 5 === 0) this.counterAttacks(ticks);
    if (this.params.grab > 0 && ticks < this.params.grabUntil * 600 &&
        ticks % Math.max(5, Math.round(this.params.rate)) === 0) this.grab(ticks);
    if (this.params.snipe > 0 && ticks % Math.max(5, Math.round(this.params.snipeEvery)) === 0) this.snipe(ticks);
    if (this.params.dump > 0 && ticks % Math.max(5, Math.round(this.params.rate)) === 0) this.dumpSurplus();
    const self = this as any;
    if (this.params.betray === 0 && self.allianceBehavior && !self.allianceBehavior.__noBetray) {
      self.allianceBehavior.isSafeToBetray = () => false;
      self.allianceBehavior.__noBetray = true;
    }
    const sb = self.structureBehavior;
    if (this.params.econ > 0 && sb && !sb.__econ) {
      sb.getSaveUpTarget = () => 0n;
      sb.isInPostSaveUpBlockedPhase = () => false;
      sb.defensePostNeeded = () => false;
      sb.__econ = true;
    }
    if (this.params.cityPlace > 0 && sb && !sb.__city) this.patchCityPlacement(sb);
    if ((this.params.factRatio > 0 || this.params.portRatio > 0) && sb && !sb.__fact) {
      const orig = sb.shouldBuildStructure.bind(sb);
      const ratio: Partial<Record<UnitType, number>> = {};
      if (this.params.factRatio > 0) ratio[UnitType.Factory] = this.params.factRatio;
      if (this.params.portRatio > 0) ratio[UnitType.Port] = this.params.portRatio;
      sb.shouldBuildStructure = (type: UnitType, cityCount: number, coastal: boolean) =>
        ratio[type] !== undefined
          ? (type !== UnitType.Port || coastal) &&
            sb.player.unitsOwned(type) < Math.floor(cityCount * ratio[type]!)
          : orig(type, cityCount, coastal);
      sb.__fact = true;
    }
    if (this.params.pirate > 0 && ticks % Math.max(10, Math.round(this.params.pirateEvery)) === 0) this.pirate();
    // Late game: restore nuke/SAM saving (instance props shadow the prototype).
    if (sb && sb.__econ && !sb.__econOff && this.params.econUntil > 0 &&
        ticks >= this.params.econUntil * 600) {
      delete sb.getSaveUpTarget;
      delete sb.isInPostSaveUpBlockedPhase;
      sb.__econOff = true;
    }
    super.tick(ticks);
  }

  // Pirating: warships capture non-friendly trade ships in open water within
  // patrol range (100) of their patrol tile, and the captured ship sails to our
  // port and pays us. Ships near a shoreline are safe for a while, so patrol
  // the open-water middle of busy foreign trade lanes near our ports.
  public piratesBuilt = 0;
  private pirate() {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive()) return;
    const ports = me.units(UnitType.Port).filter((u) => u.isActive() && !u.isUnderConstruction());
    if (ports.length === 0) return;
    const r2 = this.params.pirateRange ** 2;
    const ships: TileRef[] = [];
    const hostile = new Set(me.incomingAttacks().map((a) => a.attacker()));
    const okVictim = new Map<Player, boolean>();
    const canRob = (o: Player) => {
      let ok = okVictim.get(o);
      if (ok === undefined) {
        ok = hostile.has(o) || !me.sharesBorderWith(o) || o.troops() <= this.params.pirateSafe * me.troops();
        okVictim.set(o, ok);
      }
      return ok;
    };
    for (const s of g.units(UnitType.TradeShip)) {
      const o = s.owner();
      if (o === me || o.isFriendly(me) || s.isSafeFromPirates() || !canRob(o)) continue;
      const dst = s.targetUnit()?.owner();
      if (dst !== undefined && (dst === me || dst.isFriendly(me))) continue;
      const t = s.tile();
      if (g.isShoreline(t)) continue;
      const wc = g.getWaterComponent(t);
      if (wc === null) continue;
      if (!ports.some((p) => g.euclideanDistSquared(p.tile(), t) <= r2 && g.hasWaterComponent(p.tile(), wc))) continue;
      ships.push(t);
    }
    if (ships.length < this.params.pirateMin) return;
    const near = (c: TileRef) => ships.filter((t) => g.euclideanDistSquared(t, c) <= 70 * 70).length;
    let best: TileRef = ships[0];
    let bestN = 0;
    for (const t of ships) {
      const n = near(t);
      if (n > bestN) { best = t; bestN = n; }
    }
    if (bestN < this.params.pirateMin) return;
    const warships = me.units(UnitType.Warship);
    const covered = warships.some((w) => {
      const pt = w.warshipState().patrolTile;
      return pt !== undefined && g.euclideanDistSquared(pt, best) <= 50 * 50;
    });
    if (covered) return;
    const cost = g.unitInfo(UnitType.Warship).cost(g, me);
    if (warships.length < this.params.pirateMax &&
        Number(me.gold()) >= Number(cost) * (1 + this.params.pirateKeep) &&
        me.canBuild(UnitType.Warship, best) !== false) {
      g.addExecution(new ConstructionExecution(me, UnitType.Warship, best));
      this.piratesBuilt++;
      return;
    }
    // Re-task the warship whose patrol area has the least foreign traffic.
    let worst = null as null | (typeof warships)[number];
    let worstN = Infinity;
    for (const w of warships) {
      const pt = w.warshipState().patrolTile;
      if (pt === undefined || g.getWaterComponent(pt) !== g.getWaterComponent(best)) continue;
      const n = near(pt);
      if (n < worstN) { worst = w; worstN = n; }
    }
    if (worst !== null && worstN * 2 < bestN) {
      g.addExecution(new MoveWarshipExecution(me, [worst.id()], best));
    }
  }

  // City placement like strong human players: cities go where enemies can't
  // reach them quickly (deep inside our land, islands/coast covered by
  // warships), and inside a rail cluster so factory trains stop there (every
  // City/Port stop pays the train owner and the station owner). Replaces the
  // engine's value (depth capped at one nuke radius, avoids factories).
  private patchCityPlacement(sb: any) {
    const g = this.botGame;
    const P = this.params;
    sb.cityValue = () => {
      const me: Player = sb.player;
      const front = new Set<TileRef>();
      const shore = new Set<TileRef>();
      for (const t of me.borderTiles()) {
        if (g.isShore(t)) shore.add(t);
        for (const n of g.neighbors(t)) {
          if (!g.isLand(n)) continue;
          const o = g.owner(n);
          if (o === me) continue;
          if (o.isPlayer() && me.isFriendly(o as Player)) continue;
          front.add(t);
          break;
        }
      }
      const { borderSpacing, structureSpacing } = sb.spacingConstants();
      const cities = me.units(UnitType.City).map((u) => u.tile());
      const stations = sb.getOrBuildReachableStations();
      const range2 = g.config().trainStationMaxRange() ** 2;
      const min2 = g.config().trainStationMinRange() ** 2;
      const shoreW = P.cityShoreW * (me.unitCount(UnitType.Warship) > 0 ? 0.5 : 1);
      return (tile: TileRef) => {
        let w = g.magnitude(tile);
        const dl = nearestTileDistCapped(g, front, tile, P.cityDepth);
        w += P.cityDeepW * (dl === Infinity ? P.cityDepth * 1.25 : dl);
        const ds = nearestTileDistCapped(g, shore, tile, borderSpacing);
        w += shoreW * (ds === Infinity ? borderSpacing : ds);
        const others = new Set(cities);
        others.delete(tile);
        const dc = nearestTileDist(g, others, tile);
        if (dc !== Infinity) w += Math.min(dc, structureSpacing);
        w += P.cityRailW * structureSpacing * sb.computeConnectivityScore(tile, stations, min2, range2);
        return w;
      };
    };
    const orig = sb.structureSpawnTile.bind(sb);
    sb.structureSpawnTile = (type: UnitType) => {
      if (type !== UnitType.City) return orig(type);
      const tiles = randTerritoryTileArray(sb.random, g, sb.player, Math.round(P.citySamples));
      const value = sb.cityValue();
      let best: TileRef | null = null;
      let bestV = -Infinity;
      for (const t of tiles) {
        const v = value(t);
        if (v <= bestV) continue;
        if (!sb.player.canBuild(UnitType.City, t)) continue;
        best = t;
        bestV = v;
      }
      return best;
    };
    sb.__city = true;
  }

  // Ask nearby nations for alliances (early acceptance window + "threat" accept),
  // renew before expiry (nations never initiate renewals with humans), accept all.
  private diplomacy(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    for (const req of me.incomingAllianceRequests()) req.accept();
    if (ticks % 20 !== 0) return;
    for (const a of me.alliances()) {
      if (a.expiresAt() - ticks < 600 && !a.agreedToExtend(me)) {
        g.addExecution(new AllianceExtensionExecution(me, a.other(me).id()));
      }
    }
    const map = g.map();
    const mySpawn = me.spawnTile();
    const r2 = this.params.allyRange * this.params.allyRange;
    for (const o of g.players()) {
      if (o === me || o.type() !== PlayerType.Nation) continue;
      if (me.isAlliedWith(o) || !me.canSendAllianceRequest(o)) continue;
      const st = o.spawnTile();
      const near =
        me.sharesBorderWith(o) ||
        (mySpawn !== undefined && st !== undefined && map.euclideanDistSquared(mySpawn, st) <= r2);
      if (near) g.addExecution(new AllianceRequestExecution(me, o.id()));
    }
  }

  // Counter incoming land attacks: our attack on the attacker cancels its
  // attack 1:1 and the rest hits its (now thinner) home (KNOWLEDGE S07/S09).
  private lastCounter = new Map<string, number>();
  private counterAttacks(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const floor = this.params.cFloor * this.botGame.config().maxTroops(me);
    let left = me.troops();
    for (const a of me.incomingAttacks()) {
      if (a.sourceTile() !== null) continue; // boat landing
      const x = a.attacker();
      if (x.type() === PlayerType.Bot || me.isFriendly(x)) continue;
      if (ticks - (this.lastCounter.get(x.id()) ?? -1e9) < 50) continue;
      let send = a.troops() + this.params.cExtra * x.troops();
      if (send > this.params.counterMax * left || left - send < floor) {
        // Partial counter: only cancel (part of) the incoming attack.
        send = Math.min(this.params.cPart * a.troops(), this.params.counterMax * left, left - floor);
        if (this.params.cPart <= 0 || send < 0.2 * a.troops()) continue;
      }
      left -= send;
      this.lastCounter.set(x.id(), ticks);
      this.botGame.addExecution(new AttackExecution(send, me, x.id()));
    }
  }

  // Port/city snipe (KNOWLEDGE S27, MD-009, MF-016): land a boat on an enemy's
  // coastal structure; the landing attack spreads from the beach, so the
  // structure flips within seconds. Captured cities don't raise our city price.
  private sniped = new Map<number, number>();
  public snipesSent = 0;
  private snipe(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    const maxT = g.config().maxTroops(me);
    const troops = me.troops();
    if (troops < this.params.snipeHome * maxT) return;
    if (me.unitCount(UnitType.TransportShip) >= g.config().boatMaxNumber()) return;
    const map = g.map();
    const VAL: Partial<Record<UnitType, number>> = {
      [UnitType.Port]: 1, [UnitType.City]: 1, // cities only when on the coast (rare)
    };
    const types = Object.keys(VAL) as UnitType[];
    const r2 = this.params.snipeRange * this.params.snipeRange;
    const border = [...me.borderTiles()];
    if (border.length === 0) return;
    let best: { tile: TileRef; send: number; score: number; id: number } | null = null;
    for (const o of g.players()) {
      if (o === me || !o.isAlive() || me.isFriendly(o)) continue;
      // Snipe the losing: tribes, players being hit by someone, or drained ones.
      const losing = o.type() === PlayerType.Bot || this.params.snipeWeak >= 1 ||
        o.incomingAttacks().some((a) => a.attacker() !== me) ||
        o.troops() < this.params.snipeWeak * g.config().maxTroops(o);
      if (!losing) continue;
      const dens = o.troops() / Math.max(1, o.numTilesOwned());
      const send = Math.max(1000, this.params.snipeK * dens * 40);
      if (send > this.params.snipeMax * troops) continue;
      for (const u of o.units(...types)) {
        const t = u.tile();
        if (!map.isShore(t) && u.type() !== UnitType.Port) continue;
        if (ticks - (this.sniped.get(u.id()) ?? -1e9) < 600) continue;
        // cheap distance prefilter against a sample of our border
        let near = false;
        for (let i = 0; i < border.length; i += Math.max(1, Math.floor(border.length / 64))) {
          if (map.euclideanDistSquared(border[i], t) <= r2) { near = true; break; }
        }
        if (!near) continue;
        const score = (VAL[u.type()] ?? 0) * u.level() / send;
        if (best === null || score > best.score) best = { tile: t, send, score, id: u.id() };
      }
    }
    if (best === null) return;
    const dst = targetTransportTile(g, me, best.tile);
    const launch = canBuildTransportShip(g, me, best.tile);
    if (dst === null || launch === false) { this.sniped.set(best.id, ticks); return; }
    if (map.euclideanDistSquared(launch, dst) > r2) { this.sniped.set(best.id, ticks); return; }
    this.sniped.set(best.id, ticks);
    this.snipesSent++;
    g.addExecution(new TransportShipExecution(me, best.tile, best.send));
  }

  // Early structure grab (user/Ultimus Rex pattern, KNOWLEDGE S27): find weak
  // bordering players (tribes included) whose cities/ports/factories sit near
  // our border and land-attack them; captured structures flip to us. Politics:
  // not while we are under heavy attack, not if the target's allies next to us
  // would pile in, prefer targets already being hit by someone else (race).
  private grabbed = new Map<string, number>();
  public grabsSent = 0;
  private grab(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    const map = g.map();
    const troops = me.troops();
    const maxT = g.config().maxTroops(me);
    const incoming = me.incomingAttacks().reduce((a, x) => a + x.troops(), 0);
    if (incoming > 0.3 * troops) return;
    const budget = troops - (self.reserveRatio ?? this.params.reserve) * maxT;
    const dbg = process.env.GRAB_DEBUG ? (k: string) => { (this as any).__gd ??= {}; (this as any).__gd[k] = ((this as any).__gd[k] ?? 0) + 1; } : (_: string) => {};
    if (ticks % 600 === 0 && process.env.GRAB_DEBUG) console.error(ticks / 600, JSON.stringify((this as any).__gd), "budget", Math.round(budget), "troops", Math.round(troops));
    if (budget <= 0) { dbg("nobudget"); return; }
    const border = [...me.borderTiles()];
    if (border.length === 0) return;
    const step = Math.max(1, Math.floor(border.length / 96));
    const d2 = this.params.grabDist * this.params.grabDist;
    const nearBorder = (t: TileRef) => {
      for (let i = 0; i < border.length; i += step) if (map.euclideanDistSquared(border[i], t) <= d2) return true;
      return false;
    };
    const VAL: Partial<Record<UnitType, number>> = {
      [UnitType.City]: 1, [UnitType.Port]: 1, [UnitType.Factory]: 0.8,
      [UnitType.MissileSilo]: 0.6, [UnitType.SAMLauncher]: 0.4,
    };
    const types = Object.keys(VAL) as UnitType[];
    let best: { o: Player; send: number; score: number } | null = null;
    const nearSet = new Set(me.nearby());
    for (const n of me.nearby()) {
      if (!n.isPlayer()) continue;
      const o = n as Player;
      if (!o.isAlive() || me.isFriendly(o) || !me.sharesBorderWith(o)) continue;
      if (ticks - (this.grabbed.get(o.id()) ?? -1e9) < 150) continue;
      if (me.outgoingAttacks().some((a) => a.target() === o)) continue;
      const hitByOthers = o.incomingAttacks().some((a) => a.attacker() !== me);
      // Allies of ours already hitting it: coordinated attack, bigger bonus.
      const alliesOnIt = o.incomingAttacks().some((a) => a.attacker() !== me && me.isFriendly(a.attacker()));
      const rel = this.params.grabRel * (hitByOthers ? 2 : 1);
      if (o.type() !== PlayerType.Bot && o.troops() > rel * troops) { dbg("strong"); continue; }
      // Politics: the target's allies that aren't ours would assist it. Full
      // weight if they border us, half if they're merely near (across water).
      // A target ally that is busy being attacked itself counts half again.
      let allyRisk = 0;
      for (const a of o.allies()) {
        if (a === me || me.isFriendly(a)) continue;
        const w = me.sharesBorderWith(a) ? 1 : nearSet.has(a) ? 0.5 : 0;
        const busy = a.incomingAttacks().length > 0 ? 0.5 : 1;
        allyRisk += w * busy * a.troops();
      }
      if (allyRisk > this.params.grabAllyRisk * troops) { dbg("allyrisk"); continue; }
      let value = 0;
      for (const u of o.units(...types)) if (nearBorder(u.tile())) value += (VAL[u.type()] ?? 0) * u.level();
      if (value <= 0) { dbg(o.type() === PlayerType.Bot ? "novalBot" : "noval"); continue; }
      const need = this.params.grabK * o.troops();
      const send = Math.min(need, budget);
      if (send < 0.7 * need || send < 1) { dbg("short"); continue; }
      dbg("cand");
      const score = (value * (alliesOnIt ? 2 : hitByOthers ? 1.5 : 1)) / (send + 1);
      if (best === null || score > best.score) best = { o, send, score };
    }
    if (best === null) return;
    this.grabbed.set(best.o.id(), ticks);
    this.grabsSent++;
    g.addExecution(new AttackExecution(best.send, me, best.o.id()));
    if (this.params.grabMark > 0 && best.o.type() !== PlayerType.Bot) {
      g.addExecution(new TargetPlayerExecution(me, best.o.id()));
    }
  }

  // At troop cap growth stops, and the engine's Impossible cap (keep 90% of the
  // strongest neighbor) blocks every player attack of a small player. Dump the
  // surplus: neutral land first, then the weakest bordering tribe/player.
  private dumpSurplus() {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    const maxT = g.config().maxTroops(me);
    const troops = me.troops();
    if (troops < this.params.dumpAt * maxT) return;
    const busy = me.outgoingAttacks().reduce((s, a) => s + (a.sourceTile() === null ? a.troops() : 0), 0);
    if (busy > 0.1 * maxT) return;
    const send = troops - this.params.dumpKeep * maxT;
    if (send < 1) return;
    let best: Player | null = null;
    let tn = false;
    for (const n of me.nearby()) {
      if (!n.isPlayer()) { tn = true; continue; }
      const p = n as Player;
      if (me.isFriendly(p) || !me.sharesBorderWith(p)) continue;
      if (p.type() !== PlayerType.Bot && p.troops() > this.params.dumpRel * troops) continue;
      const score = p.type() === PlayerType.Bot ? -1 : p.troops();
      if (best === null || score < (best.type() === PlayerType.Bot ? -1 : best.troops())) best = p;
    }
    if (tn) g.addExecution(new AttackExecution(send, me, g.terraNullius().id()));
    else if (best !== null) g.addExecution(new AttackExecution(send, me, best.id()));
  }

  // Raise the AI's reserve/expand/trigger ratios so attacks never drop home
  // troops below the defense floor.
  private updateDefenseFloor() {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive()) return;
    const g = this.botGame;
    const maxT = g.config().maxTroops(me);
    if (maxT <= 0) return;
    let strongest = 0;
    if (this.params.defK > 0) {
      for (const o of g.players()) {
        if (o === me) continue;
        const t = o.type();
        if (t !== PlayerType.Nation && t !== PlayerType.Human) continue;
        if (o.isFriendly(me)) continue;
        if (!me.sharesBorderWith(o)) continue;
        strongest = Math.max(strongest, o.troops());
      }
    }
    const floor = Math.min(
      this.params.defCap,
      Math.max(this.params.defMin, (this.params.defK * strongest) / maxT),
    );
    self.reserveRatio = Math.max(this.params.reserve, floor);
    self.expandRatio = Math.max(this.params.expand, floor);
    self.triggerRatio = Math.max(this.params.trigger, Math.min(0.97, floor + 0.08));
    const ab = self.attackBehavior;
    if (ab) {
      ab.reserveRatio = self.reserveRatio;
      ab.expandRatio = self.expandRatio;
      ab.triggerRatio = self.triggerRatio;
    }
  }

  private chooseSpawn(): TileRef | null {
    const g = this.botGame;
    const map = g.map();
    const w = g.width();
    const h = g.height();
    const rivals: TileRef[] = g
      .allPlayers()
      .filter(
        (p: Player) =>
          (p.type() === PlayerType.Nation || p.type() === PlayerType.Human) &&
          p.spawnTile() !== undefined,
      )
      .map((p: Player) => p.spawnTile()!);
    const maxD = this.params.distCap;
    let best: TileRef | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.params.spawnSamples; i++) {
      const t = map.ref(this.rng.nextInt(0, w), this.rng.nextInt(0, h));
      if (!map.isLand(t) || map.hasOwner(t)) continue;
      const tx = map.x(t);
      const ty = map.y(t);
      let dMin = maxD;
      for (const r of rivals) {
        const d = Math.hypot(map.x(r) - tx, map.y(r) - ty);
        if (d < dMin) dMin = d;
      }
      let landN = 0;
      const tribes = new Set<string>();
      const N = 48;
      for (let k = 0; k < N; k++) {
        const ang = (k / N) * 2 * Math.PI;
        const rad = 8 + (k % 4) * 10;
        const x = Math.round(tx + Math.cos(ang) * rad);
        const y = Math.round(ty + Math.sin(ang) * rad);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const s = map.ref(x, y);
        if (!map.isLand(s)) continue;
        landN++;
        const o = g.owner(s);
        if (o.isPlayer() && (o as Player).type() === PlayerType.Bot) {
          tribes.add((o as Player).id());
        }
      }
      const score =
        this.params.wDist * (dMin / maxD) +
        this.params.wLand * (landN / N) +
        this.params.wTribe * Math.min(tribes.size, 6) / 6;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }
}
