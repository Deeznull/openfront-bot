// SPDX-License-Identifier: AGPL-3.0-only
// Modified from and built on the OpenFront game's Nation AI (copyright its original authors). Changes by openfront-bot contributors, 2026. See NOTICE.
/**
 * Code bot for a Human player (CLI tuning in tests/bot, solo autoplay): scored spawn choice + the Nation AI
 * behaviors (attack/expand, structures, alliances, nukes, warships) with
 * tunable ratios and reaction rate. Private NationExecution fields are set
 * through `any` (tsx does no type-check of privacy at runtime).
 */
import type { Game, Player } from "../../game/Game";
import { Difficulty, Nation, PlayerType, TerrainType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { NationExecution } from "../NationExecution";
import { AttackExecution } from "../AttackExecution";
import { TransportShipExecution } from "../TransportShipExecution";
import { canBuildTransportShip, targetTransportTile } from "../../game/TransportShipUtils";
import { randTerritoryTileArray } from "../nation/NationUtils";
import { nearestTileDist, nearestTileDistCapped } from "../Util";
import { ConstructionExecution } from "../ConstructionExecution";
import { MoveWarshipExecution } from "../MoveWarshipExecution";
import { TargetPlayerExecution } from "../TargetPlayerExecution";
import { SpawnExecution } from "../SpawnExecution";
import { AllianceExtensionExecution } from "../alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../alliance/AllianceRequestExecution";
import { QuickChatExecution } from "../QuickChatExecution";
import { DonateTroopsExecution } from "../DonateTroopExecution";
import { DonateGoldExecution } from "../DonateGoldExecution";
import { EmojiExecution } from "../EmojiExecution";
import { flattenedEmojiTable } from "@openfront/engine-api/Schemas";

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
  exposedV2: number; // >0 = "exposed" means home + troops out attacking < exposedV2 x max troops (a busy giant whose army comes back is NOT exposed; MD-015, OP-034, MD-022). 0 = old rule (home < 15% of max or away > home)
  snipeGate: number; // >0 = "losing" for snipes needs real pressure: incoming attacks (not ours) >= snipeGate x its troops, and a war snipe only when we have >= its troops (user: it snipes alive, strong players who retake the port)
  boatPick: number; // 1 = random boats: free land first, then tribes; a player only when weak (its troops x1.5 <= the boat), never a stronger one (user + KNOWLEDGE S05, OP-034, OP-055)
  openCap: number; // while free land borders us, cap the defense floor here (land grab: KNOWLEDGE S03, OP-057; 0 = off)
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
  snipeAlly: number; // 1 = also snipe far (non-bordering) players we could ally with, and ask them for an alliance right after the boat
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
  allyHumans: number; // 1 = also request alliances with nearby Human players (bot arena)
  allySelect: number; // 1 = choosy diplomacy: ally threats, keep weak neighbors as food, respect the alliance cap, renew by value
  allyStrong: number; // a player with troops >= allyStrong x ours is a threat: always accept, renew and ask
  allyFood: number; // a bordering player with troops < allyFood x ours is food: no alliance (allies box us in), let it lapse
  allyMax: number; // max alliances (0 = engine cap only: Impossible nations refuse anyone allied with >= 25% of players, Hard 50%)
  crownGate: number; // 1 = hit the runaway leader only when it is exposed, others are already hitting it, or the politics allow a war with it
  tribeCounter: number; // 1 = answer a tribe's land attack on us by attacking it: cancels its attack 1:1 and hits its emptier home
  strikeExposed: number; // 1 = land-strike an exposed bordering enemy (home nearly empty, or most troops out attacking) when politics allow
  potW: number; // strength = max(troops, potW x max troops): many cities but low troops still counts as strong (they refill fast); 0 = troops only
  boxFront: number; // 1 = when boxed in (no free land, tribes or weak neighbors), keep one non-threat neighbor un-allied as the expansion front
  allyWarn: number; // ticks before an unrenewed alliance ends from which we already keep troops home against that ally
  endAlly: number; // 1 = endgame clock (needs allySelect): no alliance/renewal with a rival about to cross the (overtime-sinking) win bar; keep every ally while we are about to cross it
  endMargin: number; // minutes added to the alliance duration for the "about to win" window
  endHurt: number; // a rival is refused only if refusing can stop it: our power >= endHurt x its power, or we can nuke it, or others are already hitting it
  tribeSteal: number; // 1 = when another player is eating a bordering tribe, attack it too and take our share
  stealK: number; // tribe kill-steal: send stealK x tribe troops (within the reserve)
  warSnipe: number; // 1 = players at war with us (our attack on them, or theirs on us) count as snipe targets: take their coastal cities/ports
  snipeBurst: number; // boats per snipe when the landing is close (warships can't sink them all in time); 1 = one boat
  snipeNear: number; // landing distance (tiles) up to which snipeBurst applies
  boatCounter: number; // 1 = counter enemy boat landings at once: a land attack on the lander cancels its landing 1:1 (x boatCounterK)
  boatCounterK: number;
  landPush: number; // 1 = when our boat lands on a bordering player, push by land too (their counter-push would wipe the beachhead)
  pushK: number; // land push = pushK x landing troops (capped at snipeMax x our troops)
  navy: number; // 1 = answer a serious naval invasion (strong invader, or many troops on boats) with warships: move ours, or build one
  navyMax: number; // max warships built for defense
  navyKeep: number; // keep gold >= cost x (1 + navyKeep) when building one
  finishK: number; // finish off a bordering tribe whose kill costs <= finishK x our troops (wounded tribes we or others left alive)
  portLake: number; // 1 = no port on a lake unless another player already has a port there (trade) and we have none there yet
  factLink: number; // 1 = build factories only where they get a rail link (to anyone's city/port/factory)
  tribeKill: number; // 1 = size every tribe attack to kill it outright (engine attack cost over its tiles), never a stalling half-attack; 2 = kill-size it when that fits, else the usual chunk attack
  killMargin: number; // extra troops on a kill-sized attack (tribe regen during the attack, estimate error)
  tribeHunt: number; // 1 = kill any bordering tribe as soon as the kill fits above the expand floor (no waiting for the trigger ratio)
  pvpRatio: number; // Nation-AI attacks on real players need our troops >= pvpRatio x theirs, less when others already hit them (0 = off)
  homeK: number; // >0 = own strikes/pushes/dumps/counter top-ups keep home troops >= homeK x strongest OTHER non-friendly neighbour (raid-then-dogpile guard)
  pvpNat: number; // >0 = pvpRatio for Nations (Medium-AI food when boxed in; KNOWLEDGE OP-032/S05 hit at >=1.22x)
  kin: number; // 1 = same-script handshake by quick chat (see kinHandshake); kin are allied, renewed and helped
  kinAt: number; // game second of the first handshake line
  kinTol: number; // +- seconds a handshake line may arrive off its time
  kinGap: number; // seconds between the first line and the reply
  kinBoat: number; // 1 = one landing boat toward far kin so factories can link (none if already close)
  donate: number; // 1 = troop/gold donations to friends under attack (UI toggle)
  emojiMode: number; // 1 = only positive casual emojis, sent rarely; 🤝 with our alliance asks/renewals, ☢️ when we keep asking and own a silo
  clanSpawn: number; // 1 = spawn next to humans with our clan tag (e.g. [BT]); 0 = ignore tags
  clanKin: number; // 1 = humans with our clan tag are kin at once (no handshake needed)
  clanR: number; // max tiles from a clan mate's spawn
  teamHelp: number; // 1 = help friends (teammates, kin): troop/gold donations when they are hit, factories linked to them
  samCover: number; // 1 = SAM on our side of a friend's border while an enemy has a silo (needs teamHelp)
  capLand: number; // 1 = the "keep 0.9x the strongest neighbour home" send cap counts only land-bordering players (not boat-only ones across water)
  capPush: number; // >0 = stalled at the troop cap (>=95% max, no land gain for 30 s): pvpRatio drops to this vs a human others already hit
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
  exposedV2: 0,
  snipeGate: 0,
  boatPick: 0,
  openCap: 0,
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
  snipeAlly: 0,
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
  allyHumans: 0,
  allySelect: 0,
  allyStrong: 0.7,
  allyFood: 0.4,
  allyMax: 0,
  allyWarn: 300,
  endAlly: 0,
  endMargin: 1,
  endHurt: 0.3,
  boxFront: 0,
  potW: 0,
  strikeExposed: 0,
  tribeCounter: 0,
  crownGate: 0,
  tribeSteal: 0,
  stealK: 1.5,
  finishK: 0,
  navy: 0,
  navyMax: 3,
  navyKeep: 0.5,
  warSnipe: 0,
  snipeBurst: 1,
  snipeNear: 80,
  boatCounter: 0,
  boatCounterK: 1.2,
  landPush: 0,
  pushK: 2,
  factLink: 0,
  portLake: 0,
  tribeKill: 0,
  killMargin: 0.15,
  tribeHunt: 0,
  pvpRatio: 0,
  homeK: 0,
  pvpNat: 0,
  kin: 0,
  kinAt: 4,
  kinTol: 5,
  kinGap: 10,
  kinBoat: 1,
  donate: 1,
  clanSpawn: 1,
  emojiMode: 0,
  clanR: 35,
  clanKin: 1,
  teamHelp: 0,
  samCover: 0,
  capLand: 0,
  capPush: 0,
};

/** Current best set (5/16 wins vs Impossible), used by solo autoplay. */
export const AUTOPLAY_PARAMS: BotParams = {
  ...DEFAULT_PARAMS,
  allyRange: 262, cExtra: 1.407, cFloor: 0.1, counterMax: 0.526, defCap: 0.816, defK: 1.054,
  defMin: 0.004, distCap: 127, expand: 0.276, rate: 14, reserve: 0.188, trigger: 0.494,
  wDist: 1.155, wLand: 1.621, wTribe: 0.573, ally: 1, betray: 0, econ: 1, counter: 1,
  snipe: 1, snipeWeak: 1, cityPlace: 1,
};

// cos/sin of k/48 turns (precomputed: Math.cos/sin are not bit-exact across JS engines).
const RING: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.991444861, 0.130526192],
  [0.965925826, 0.258819045],
  [0.923879533, 0.382683432],
  [0.866025404, 0.5],
  [0.79335334, 0.608761429],
  [0.707106781, 0.707106781],
  [0.608761429, 0.79335334],
  [0.5, 0.866025404],
  [0.382683432, 0.923879533],
  [0.258819045, 0.965925826],
  [0.130526192, 0.991444861],
  [0, 1],
  [-0.130526192, 0.991444861],
  [-0.258819045, 0.965925826],
  [-0.382683432, 0.923879533],
  [-0.5, 0.866025404],
  [-0.608761429, 0.79335334],
  [-0.707106781, 0.707106781],
  [-0.79335334, 0.608761429],
  [-0.866025404, 0.5],
  [-0.923879533, 0.382683432],
  [-0.965925826, 0.258819045],
  [-0.991444861, 0.130526192],
  [-1, 0],
  [-0.991444861, -0.130526192],
  [-0.965925826, -0.258819045],
  [-0.923879533, -0.382683432],
  [-0.866025404, -0.5],
  [-0.79335334, -0.608761429],
  [-0.707106781, -0.707106781],
  [-0.608761429, -0.79335334],
  [-0.5, -0.866025404],
  [-0.382683432, -0.923879533],
  [-0.258819045, -0.965925826],
  [-0.130526192, -0.991444861],
  [0, -1],
  [0.130526192, -0.991444861],
  [0.258819045, -0.965925826],
  [0.382683432, -0.923879533],
  [0.5, -0.866025404],
  [0.608761429, -0.79335334],
  [0.707106781, -0.707106781],
  [0.79335334, -0.608761429],
  [0.866025404, -0.5],
  [0.923879533, -0.382683432],
  [0.965925826, -0.258819045],
  [0.991444861, -0.130526192],
];

export class BotExecution extends NationExecution {
  // Grab decision counters on stderr (the CLI sets it from GRAB_DEBUG).
  static grabDebug = false;
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
    this.hookChat(mg); // inert while kin is 0 (UI can switch it on mid-game)
  }

  tick(ticks: number) {
    if (this.botGame.inSpawnPhase() && !this.spawnSent) {
      // Clan members stagger their spawn so later ones see the earlier ones.
      const tag = this.botNation.playerInfo.clanTag;
      const stagger = this.params.clanSpawn > 0 && tag ? simpleHash(this.botNation.playerInfo.id) % 30 : 0;
      if (ticks < this.params.spawnDelay + stagger) return;
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
    if (this.params.landPush > 0 && ticks % 5 === 0) this.landPush();
    if (this.params.navy > 0 && ticks % 10 === 0) this.navyDefense(ticks);
    if (this.params.strikeExposed > 0 && ticks % 10 === 5) this.strikeExposed(ticks);
    if (this.params.grab > 0 && ticks < this.params.grabUntil * 600 &&
        ticks % Math.max(5, Math.round(this.params.rate)) === 0) this.grab(ticks);
    if (this.params.snipe > 0 && ticks % Math.max(5, Math.round(this.params.snipeEvery)) === 0) this.snipe(ticks);
    if (this.params.dump > 0 && ticks % Math.max(5, Math.round(this.params.rate)) === 0) this.dumpSurplus();
    if (this.params.tribeSteal > 0 && ticks % 10 === 0) this.tribeSteal(ticks);
    if (this.params.kin > 0) this.kinHandshake();
    if (this.params.clanKin > 0 && ticks % 50 === 7) this.clanKin();
    if (this.params.emojiMode > 0 && ticks % 10 === 5) this.allyEmojis(ticks);
    if (this.params.teamHelp > 0 && ticks % 10 === 3) this.helpFriends(ticks);
    const self = this as any;
    if (this.params.betray === 0 && self.allianceBehavior && !self.allianceBehavior.__noBetray) {
      self.allianceBehavior.isSafeToBetray = () => false;
      // maybeBetray has 3 more paths that skip isSafeToBetray (Easy/Medium 10x
      // weaker, only bordering player 3x weaker, traitors): close them all.
      self.allianceBehavior.maybeBetray = () => false;
      self.allianceBehavior.__noBetray = true;
    }
    if (this.params.allySelect > 0 && self.allianceBehavior && !self.allianceBehavior.__choosy) {
      // The Nation AI accepts, renews and asks on its own every tick (and
      // re-sends renewals while only we agreed): choosyDiplomacy does all three.
      self.allianceBehavior.handleAllianceRequests = () => {};
      self.allianceBehavior.handleAllianceExtensionRequests = () => {};
      self.allianceBehavior.maybeSendAllianceRequests = () => {};
      self.allianceBehavior.__choosy = true;
    }
    const sb = self.structureBehavior;
    if (this.params.econ > 0 && sb && !sb.__econ) {
      sb.getSaveUpTarget = () => 0n;
      sb.isInPostSaveUpBlockedPhase = () => false;
      sb.defensePostNeeded = () => false;
      sb.__econ = true;
    }
    if (this.params.cityPlace > 0 && sb && !sb.__city) this.patchCityPlacement(sb);
    if (this.params.factLink > 0 && sb && !sb.__link) this.patchFactoryLink(sb);
    if (this.params.portLake > 0 && sb && !sb.__lake) this.patchPortLake(sb);
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

  // The engine scores factory tiles on elevation and spacing; its rail term
  // only counts existing stations, so the first factory (and any far from
  // stations) can land where no rail ever connects. Sample tiles around our
  // cities/ports too, and take the best one the rail preview links up.
  public factoryNoLink = 0;
  private patchFactoryLink(sb: any) {
    const g = this.botGame;
    const orig = sb.structureSpawnTile.bind(sb);
    let failedAt = -1e9;
    sb.structureSpawnTile = (type: UnitType) => {
      if (type !== UnitType.Factory) return orig(type);
      if (g.ticks() - failedAt < 100) return null;
      const me: Player = sb.player;
      const min = g.config().trainStationMinRange();
      const max = g.config().trainStationMaxRange();
      const tiles = randTerritoryTileArray(sb.random, g, me, 25);
      const hubs = me.units(UnitType.City, UnitType.Port);
      // Friends' hubs within rail range: a factory between us links both nets.
      if (this.params.teamHelp > 0) {
        for (const f of g.players()) {
          if (!f.isAlive() || !this.isFriend(me, f)) continue;
          for (const u of f.units(UnitType.City, UnitType.Port)) {
            if (me.units(UnitType.City, UnitType.Port, UnitType.Factory).some((v) => g.manhattanDist(u.tile(), v.tile()) <= 3 * max)) hubs.push(u);
          }
        }
      }
      for (let i = 0; i < Math.min(8, hubs.length); i++) {
        const h = hubs[sb.random.nextInt(0, hubs.length)].tile();
        for (let j = 0; j < 3; j++) {
          const [c, sn] = RING[sb.random.nextInt(0, RING.length)];
          const r = sb.random.nextInt(min + 5, Math.floor(max * 0.8));
          const x = g.x(h) + Math.round(c * r);
          const y = g.y(h) + Math.round(sn * r);
          if (!g.isValidCoord(x, y)) continue;
          const t = g.ref(x, y);
          if (g.owner(t) === me) tiles.push(t);
        }
      }
      const value = sb.structureSpawnTileValue(UnitType.Factory);
      if (value === null) return null;
      const scored = tiles.map((t) => ({ t, v: value(t) as number })).sort((a, b) => b.v - a.v);
      const rail = g.railNetwork();
      let checks = 0;
      for (const { t } of scored) {
        if (!me.canBuild(UnitType.Factory, t)) continue;
        if (rail.overlappingRailroads(UnitType.Factory, t).length > 0 ||
            rail.computeGhostRailPaths(UnitType.Factory, t).length > 0) return t;
        if (++checks >= 6) break;
      }
      failedAt = g.ticks();
      this.factoryNoLink++;
      return null;
    };
    sb.__link = true;
  }

  // Ask nearby nations for alliances (early acceptance window + "threat" accept),
  // renew before expiry (nations never initiate renewals with humans), accept all.
  private diplomacy(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    if (this.kin.size > 0) this.kinAlly(me, ticks);
    if (this.params.allySelect > 0) return this.choosyDiplomacy(me, ticks);
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
      if (o === me || !(o.type() === PlayerType.Nation || (this.params.allyHumans > 0 && o.type() === PlayerType.Human))) continue;
      if (me.isAlliedWith(o) || !me.canSendAllianceRequest(o)) continue;
      const st = o.spawnTile();
      const near =
        me.sharesBorderWith(o) ||
        (mySpawn !== undefined && st !== undefined && map.euclideanDistSquared(mySpawn, st) <= r2);
      if (near) g.addExecution(new AllianceRequestExecution(me, o.id()));
    }
  }

  /** Most alliances we keep: above the engine cap, Impossible/Hard nations refuse our requests and renewals. */
  private allyCap(me: Player): number {
    const g = this.botGame;
    const total = g.players().filter((p) => p.type() !== PlayerType.Bot).length;
    const diff = String(g.config().gameConfig().difficulty);
    const f = diff === "Impossible" ? 0.25 : diff === "Hard" ? 0.5 : 0;
    let cap = f > 0 ? Math.max(1, Math.ceil(total * f) - 1) : Infinity;
    if (this.params.allyMax > 0) cap = Math.min(cap, this.params.allyMax);
    return cap;
  }

  /** Strength for politics: troops now, or what cities let them refill to, unless they are exposed right now. */
  private power(p: Player): number {
    if (this.exposed(p)) return p.troops();
    return Math.max(p.troops(), this.params.potW * this.botGame.config().maxTroops(p));
  }

  /** Home nearly empty (< 15% of max troops), or more troops out attacking than at home (exposedV2: home + away low). */
  private exposed(p: Player): boolean {
    const away = p.outgoingAttacks().reduce((s, a) => s + a.troops(), 0);
    // Out-attacking troops return (attack end or retreat) and regen peaks near
    // 42% of max (MD-182): only a player low on home + away is really open.
    if (this.params.exposedV2 > 0) return p.troops() + away < this.params.exposedV2 * this.botGame.config().maxTroops(p);
    return p.troops() < 0.15 * this.botGame.config().maxTroops(p) || away > p.troops();
  }

  // Strike an exposed bordering enemy (many cities but an empty home, or busy
  // attacking someone else): a land attack now takes land and cities cheaply.
  // Never an ally, and only when the politics allow a war with it.
  private struck = new Map<string, number>();
  public strikes = 0;
  private strikeExposed(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    for (const n of me.nearby()) {
      if (!n.isPlayer()) continue;
      const o = n as Player;
      if (o.type() === PlayerType.Bot || me.isFriendly(o) || !me.sharesBorderWith(o)) continue;
      if (!this.exposed(o) || !this.warOk(me, o)) continue;
      if (ticks - (this.struck.get(o.id()) ?? -1e9) < 150) continue;
      if (me.outgoingAttacks().some((a) => a.target() === o && a.sourceTile() === null && a.troops() >= 2 * o.troops())) continue;
      const floor = this.params.cFloor * g.config().maxTroops(me);
      const send = Math.min(0.3 * me.troops(), me.troops() - floor, Math.max(2.5 * o.troops(), 0.05 * me.troops()), this.homeRoom(me, o));
      if (send < 1.5 * o.troops()) continue;
      this.struck.set(o.id(), ticks);
      this.strikes++;
      g.addExecution(new AttackExecution(send, me, o.id()));
      return; // one strike per check
    }
  }

  /** "strong" = threat worth allying, "food" = weak neighbor we'd rather eat. */
  private allyKind(me: Player, o: Player): "strong" | "food" | "ok" {
    if (o.type() === PlayerType.Bot) return "food";
    const ratio = this.power(o) / Math.max(1, this.power(me));
    if (ratio >= this.params.allyStrong) return "strong";
    if (ratio < this.params.allyFood && me.sharesBorderWith(o)) return "food";
    return "ok";
  }

  // Endgame clock. The win bar is 80% of non-fallout land; with overtime it
  // sinks 2 points a minute after 30:00 (public FFA: 0 at 70:00). A player's
  // ETA = minutes until its land share (plus its recent growth) clears the bar.
  // An alliance lasts allianceDuration (5 min): one with a rival that clears
  // the bar inside that window (+endMargin) only shields the rival's win
  // (never ally a runaway leader: S17, LT-009, LT-013), so no accept, renewal
  // or ask, but only if refusing can stop it (we can hurt it, can nuke it, or
  // others are on it). Otherwise refusing only frees it to eat us, and the
  // usual ally logic decides. Draft, tunable, off by default. When WE clear it first inside the window, every ally is a border
  // that can't hit us while the bar sinks (LT-018: hold, don't over-commit),
  // so accept and renew all (cap ignored), except the expansion front.
  private endSnap: { tick: number; tiles: Map<string, number> } | null = null;
  private endPrev: { tick: number; tiles: Map<string, number> } | null = null;
  private endEtaCache: { tick: number; eta: Map<string, number> } | null = null;
  private winEta(o: Player): number {
    const g = this.botGame;
    const ticks = g.ticks();
    if (this.endSnap === null || ticks - this.endSnap.tick >= 600) {
      this.endPrev = this.endSnap;
      const tiles = new Map<string, number>();
      for (const q of g.players()) tiles.set(q.id(), this.sideTiles(q));
      this.endSnap = { tick: ticks, tiles };
      this.endEtaCache = null;
    }
    if (this.endEtaCache === null || this.endEtaCache.tick !== ticks) this.endEtaCache = { tick: ticks, eta: new Map() };
    const hit = this.endEtaCache.eta.get(o.id());
    if (hit !== undefined) return hit;
    const land = Math.max(1, g.numLandTiles() - g.numTilesWithFallout());
    const s = (this.sideTiles(o) * 100) / land;
    let rate = 0;
    const prev = this.endPrev;
    if (prev !== null) {
      const before = prev.tiles.get(o.id());
      if (before !== undefined) rate = (((this.sideTiles(o) - before) * 100) / land) / ((ticks - prev.tick) / 600);
    }
    rate = Math.min(5, Math.max(0, rate));
    const t = g.elapsedGameSeconds();
    let eta = Infinity;
    for (let m = 0; m <= 60; m += 0.25) {
      if (s + rate * m > g.config().percentageTilesOwnedToWin(t + m * 60)) {
        eta = m;
        break;
      }
    }
    this.endEtaCache.eta.set(o.id(), eta);
    return eta;
  }
  /** "rival" = o clears the win bar inside an alliance window and before us; "lead" = we do, before everyone. */
  private endKind(me: Player, o: Player): "rival" | "lead" | null {
    if (this.params.endAlly <= 0 || o.type() === PlayerType.Bot || me.isOnSameTeam(o)) return null;
    const win = this.botGame.config().allianceDuration() / 600 + this.params.endMargin;
    const mine = this.winEta(me);
    const theirs = this.winEta(o);
    if (theirs <= win && theirs <= mine) {
      const g = this.botGame;
      const canHurt = this.power(me) >= this.params.endHurt * this.power(o) ||
        (me.unitCount(UnitType.MissileSilo) > 0 && me.gold() >= g.unitInfo(UnitType.AtomBomb).cost(g, me)) ||
        o.incomingAttacks().some((a) => a.attacker() !== me && a.attacker().type() !== PlayerType.Bot);
      return canHurt ? "rival" : null;
    }
    if (mine <= win && mine < theirs) return "lead";
    return null;
  }

  /** Allied, but the alliance ends within allyWarn ticks and the ally hasn't agreed to renew. */
  private allyEnding(me: Player, o: Player): boolean {
    if (this.params.allySelect <= 0) return false;
    const a = me.allianceWith(o);
    return a !== null && a.expiresAt() - this.botGame.ticks() < this.params.allyWarn && !a.agreedToExtend(o);
  }

  // The engine allows a port on any lake another player touches, so ports
  // went up on lakes with no one to trade with (and two on the same one). A
  // lake port needs a foreign port on that lake (a trade partner) and no port
  // of ours there yet. Ocean ports are unchanged.
  public portsSkipped = 0;
  private patchPortLake(sb: any) {
    const g = this.botGame;
    const prev = sb.structureSpawnTile.bind(sb);
    let failedAt = -1e9;
    const lakes = (t: TileRef): number[] | null => {
      const out: number[] = [];
      for (const n of g.neighbors(t)) {
        if (!g.isWater(n)) continue;
        if (g.isOcean(n)) return null; // ocean: fine
        const c = g.getWaterComponent(n);
        if (c !== null && !out.includes(c)) out.push(c);
      }
      return out;
    };
    sb.structureSpawnTile = (type: UnitType) => {
      if (type !== UnitType.Port) return prev(type);
      if (g.ticks() - failedAt < 100) return null;
      const me: Player = sb.player;
      for (let i = 0; i < 4; i++) {
        const t = prev(type);
        if (t === null) return null;
        const ls = lakes(t);
        if (ls === null) return t;
        let ours = false;
        let trade = false;
        for (const u of g.units(UnitType.Port)) {
          const ul = lakes(u.tile());
          if (ul === null || !ul.some((c) => ls.includes(c))) continue;
          if (u.owner() === me) ours = true;
          else trade = true;
        }
        if (trade && !ours) return t;
      }
      failedAt = g.ticks();
      this.portsSkipped++;
      return null;
    };
    sb.__lake = true;
  }

  // Choosy diplomacy (human-style): ally the players that can hurt us, don't
  // ally weak neighbors (they are our room to grow; allying all of them boxes
  // us in), stay under the alliance cap so renewals with the strong ones
  // still get accepted, and renew the most valuable alliances first.
  public allyRejects = 0;
  private choosyDiplomacy(me: Player, ticks: number) {
    const g = this.botGame;
    const cap = this.allyCap(me);
    const front = this.params.boxFront > 0 ? this.expansionFront(me, ticks) : null;
    if (ticks % 5 === 0) {
      let n = me.alliances().length;
      const reqs = [...me.incomingAllianceRequests()].sort((a, b) => b.requestor().troops() - a.requestor().troops());
      for (const req of reqs) {
        const k = this.allyKind(me, req.requestor());
        const e = this.endKind(me, req.requestor());
        if (req.requestor() !== front && e !== "rival" &&
            (e === "lead" || k === "strong" || (k === "ok" && n < cap))) {
          req.accept();
          n++;
        } else {
          req.reject();
          this.allyRejects++;
        }
      }
    }
    if (ticks % 20 !== 0) return;
    // Renew: strongest first; threats always, the rest while under the cap.
    const allies = me.alliances().map((a) => ({ a, o: a.other(me) }))
      .sort((x, y) => y.o.troops() - x.o.troops());
    let keep = 0;
    for (const { a, o } of allies) {
      const k = this.allyKind(me, o);
      const e = this.endKind(me, o);
      if (o === front || e === "rival" || !(e === "lead" || k === "strong" || (k === "ok" && keep < cap))) continue;
      keep++;
      if (a.expiresAt() - ticks <= g.config().allianceExtensionPromptOffset() && !a.agreedToExtend(me)) {
        g.addExecution(new AllianceExtensionExecution(me, o.id()));
      }
    }
    // Ask: threats first (near or not), then near non-food players while under
    // the cap. A player who said no is asked again after 30 s, 1, 2, 4, 8 min
    // (the engine allows every 30 s), and at most 2 new asks per round.
    let n = me.alliances().length + me.outgoingAllianceRequests().length;
    let asked = 0;
    const map = g.map();
    const mySpawn = me.spawnTile();
    const r2 = this.params.allyRange * this.params.allyRange;
    const cands = g.players()
      .filter((o) => o !== me && (o.type() === PlayerType.Nation || (this.params.allyHumans > 0 && o.type() === PlayerType.Human)))
      .filter((o) => !me.isAlliedWith(o) && me.canSendAllianceRequest(o))
      .sort((a, b) => b.troops() - a.troops());
    for (const o of cands) {
      const e = this.endKind(me, o);
      if (e === "rival") continue;
      const k = e === "lead" ? "strong" : this.allyKind(me, o);
      if (k === "food" || o === front) continue;
      const st = o.spawnTile();
      const near = me.sharesBorderWith(o) ||
        (mySpawn !== undefined && st !== undefined && map.euclideanDistSquared(mySpawn, st) <= r2);
      if (k !== "strong" && (!near || n >= cap)) continue;
      const log = this.asks.get(o.id());
      if (log !== undefined && ticks < log.next) continue;
      // At war, winning ground, and nobody else threatening: keep pushing
      // instead of asking. A stalled war (nothing to gain) may end in an alliance.
      if (k !== "strong" && this.params.warSnipe > 0 && me.outgoingAttacks().some((a) => a.target() === o) &&
          this.warOk(me, o) && this.gaining(o)) continue;
      if (asked >= 2) break;
      const tries = (log?.n ?? 0) + 1;
      this.asks.set(o.id(), { n: tries, next: ticks + 300 * 2 ** Math.min(tries - 1, 4) });
      g.addExecution(new AllianceRequestExecution(me, o.id()));
      n++;
      asked++;
    }
    for (const a of me.alliances()) this.asks.delete(a.other(me).id());
  }
  private asks = new Map<string, { n: number; next: number }>();

  // Boxed in: every neighbor is an ally or a threat, no wilderness or tribe
  // left to take. Allying everyone around us ends our growth (players then
  // out-grow us), so one neighbor that is no threat (< allyStrong x our
  // troops) stays un-allied as the expansion front: no accept, no renewal, no
  // ask (an alliance with it lapses; no betrayal). Weakest first, then one
  // already hit by others, then one not allied now. Kept for 2 min unless it
  // turns strong or we have room again.
  private front: Player | null = null;
  private frontAt = -1e9;
  private expansionFront(me: Player, ticks: number): Player | null {
    const players: Player[] = [];
    for (const n of me.nearby()) {
      if (!n.isPlayer()) return (this.front = null); // wilderness next to us
      const p = n as Player;
      if (this.isFriend(me, p)) continue;
      if (p.type() === PlayerType.Bot || this.allyKind(me, p) === "food") return (this.front = null);
      players.push(p);
    }
    const ok = (p: Player) => p.isAlive() && this.allyKind(me, p) === "ok" && players.includes(p);
    if (this.front !== null && ok(this.front) && ticks - this.frontAt < 1200) return this.front;
    let best: Player | null = null;
    let bestS = Infinity;
    for (const p of players) {
      if (!ok(p)) continue;
      const hit = p.incomingAttacks().some((a) => a.attacker() !== me);
      const s = this.power(p) / Math.max(1, this.power(me)) - (hit ? 0.2 : 0) - (me.isAlliedWith(p) ? 0 : 0.1);
      if (s < bestS) { bestS = s; best = p; }
    }
    if (best !== this.front) this.frontAt = ticks;
    return (this.front = best);
  }

  /**
   * Politics check before pressing a war on o (war snipes, land pushes):
   * we are not the weaker side, no other strong non-ally borders us, and
   * nobody else is hitting us hard. Otherwise troops stay home.
   */
  private warOk(me: Player, o: Player): boolean {
    if (this.power(o) > this.power(me)) return false;
    const others = me.incomingAttacks().filter((a) => a.attacker() !== o).reduce((s, a) => s + a.troops(), 0);
    if (others > 0.2 * me.troops()) return false;
    for (const n of me.nearby()) {
      if (!n.isPlayer() || n === o) continue;
      const p = n as Player;
      if (p.type() === PlayerType.Bot || (me.isFriendly(p) && !this.allyEnding(me, p))) continue;
      if (this.power(p) >= this.params.allyStrong * this.power(me)) return false;
    }
    return true;
  }

  // Land of each player a while ago, to tell a war that gains ground from a stalled one.
  private pastTiles = new Map<string, number>();
  private pastNext = new Map<string, number>();
  private pastAt = -1e9;
  private gaining(o: Player): boolean {
    const t = this.botGame.ticks();
    if (t - this.pastAt >= 300) {
      this.pastTiles = this.pastNext;
      this.pastNext = new Map(this.botGame.players().map((p) => [p.id(), p.numTilesOwned()]));
      this.pastAt = t;
    }
    const before = this.pastTiles.get(o.id());
    return before === undefined || o.numTilesOwned() < 0.97 * before;
  }

  // Naval defense: when a strong player (or a big troop wave) comes by boat,
  // send our nearest warship at the boats, or build one if we can afford it.
  // Small landings are left to the land counter.
  private navyAt = -1e9;
  public navyBuilt = 0;
  private navyDefense(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase() || ticks - this.navyAt < 100) return;
    const wave = new Map<Player, { troops: number; tile: TileRef }>();
    for (const b of g.units(UnitType.TransportShip)) {
      const o = b.owner();
      if (o === me || o.type() === PlayerType.Bot || me.isFriendly(o)) continue;
      const tt = b.targetTile();
      if (tt === undefined || g.owner(tt) !== me) continue;
      const w = wave.get(o) ?? { troops: 0, tile: b.tile() };
      w.troops += b.troops();
      wave.set(o, w);
    }
    let threat: TileRef | null = null;
    let worst = 0;
    for (const [o, w] of wave) {
      const serious = o.troops() >= this.params.allyStrong * me.troops() || w.troops >= 0.1 * me.troops();
      if (serious && w.troops > worst) { worst = w.troops; threat = w.tile; }
    }
    if (threat === null) {
      this.islandGuard(me);
      return;
    }
    this.navyAt = ticks;
    const wc = g.getWaterComponent(threat);
    let ship = null as null | ReturnType<Player["units"]>[number];
    let d = Infinity;
    for (const w of me.units(UnitType.Warship)) {
      if (g.getWaterComponent(w.tile()) !== wc) continue;
      const dd = g.euclideanDistSquared(w.tile(), threat);
      if (dd < d) { d = dd; ship = w; }
    }
    if (ship !== null && d > 30 * 30) {
      g.addExecution(new MoveWarshipExecution(me, [ship.id()], threat));
      return;
    }
    if (ship !== null) return;
    const cost = g.unitInfo(UnitType.Warship).cost(g, me);
    if (me.units(UnitType.Warship).length < this.params.navyMax &&
        Number(me.gold()) >= Number(cost) * (1 + this.params.navyKeep) &&
        me.canBuild(UnitType.Warship, threat) !== false) {
      this.navyBuilt++;
      g.addExecution(new ConstructionExecution(me, UnitType.Warship, threat));
    }
  }

  // Island guard: with no land neighbor but tribes, every real attack comes by
  // boat. Keep one warship by our biggest port once the gold is spare.
  private islandGuard(me: Player) {
    const g = this.botGame;
    if (me.units(UnitType.Warship).length > 0) return;
    if (me.nearby().some((n) => n.isPlayer() && (n as Player).type() !== PlayerType.Bot && !this.isFriend(me, n as Player))) return;
    const ports = me.units(UnitType.Port);
    if (ports.length === 0) return;
    const cost = g.unitInfo(UnitType.Warship).cost(g, me);
    if (Number(me.gold()) < Number(cost) * (1 + 2 * this.params.navyKeep)) return;
    const port = ports.reduce((a, b) => (b.level() > a.level() ? b : a));
    const water = g.neighbors(port.tile()).find((t) => g.isWater(t));
    if (water === undefined || me.canBuild(UnitType.Warship, water) === false) return;
    this.navyBuilt++;
    g.addExecution(new ConstructionExecution(me, UnitType.Warship, water));
  }

  // Tribe kill-steal: a tribe someone else (an ally too) is eating has few
  // troops left and its land goes to whoever conquers it. Jump in and take our
  // share. Also finish off any bordering tribe that is now cheap to kill (an
  // attack of ours that ran out of troops just short of killing it).
  private stolen = new Map<string, number>();
  public steals = 0;
  private tribeSteal(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    const troops = me.troops();
    if (me.incomingAttacks().reduce((a, x) => a + x.troops(), 0) > 0.3 * troops) return;
    const maxT = g.config().maxTroops(me);
    // Hunting kills tribes from troops above the expand floor (it already holds the defense floor).
    const huntFloor = (self.expandRatio ?? this.params.expand) * maxT;
    let budget = troops - (this.params.tribeHunt > 0 ? huntFloor : (self.reserveRatio ?? this.params.reserve) * maxT);
    for (const n of me.nearby()) {
      if (budget <= 0) return;
      if (!n.isPlayer()) continue;
      const o = n as Player;
      if (o.type() !== PlayerType.Bot || !o.isAlive() || me.isFriendly(o) || !me.sharesBorderWith(o)) continue;
      let send0 = this.params.tribeKill > 0 ? this.killSend(o) : Math.max(1, this.params.stealK * o.troops());
      // Mode 2: a kill we can't afford falls back to the usual partial steal.
      if (this.params.tribeKill >= 2 && send0 > budget) send0 = Math.max(1, this.params.stealK * o.troops());
      const cheap = this.params.finishK > 0 && send0 <= this.params.finishK * troops;
      const hunt = this.params.tribeHunt > 0 && send0 <= troops - huntFloor;
      if (!cheap && !hunt && !o.incomingAttacks().some((a) => a.attacker() !== me)) continue;
      if (me.outgoingAttacks().some((a) => a.target() === o)) continue;
      if (ticks - (this.stolen.get(o.id()) ?? -1e9) < 100) continue;
      const send = Math.min(budget, send0);
      if (send < o.troops() || (this.params.tribeKill === 1 && send < send0)) continue;
      this.stolen.set(o.id(), ticks);
      this.steals++;
      g.addExecution(new AttackExecution(send, me, o.id()));
      budget -= send;
    }
  }

  // Counter incoming land attacks: our attack on the attacker cancels its
  // attack 1:1 and the rest hits its (now thinner) home (KNOWLEDGE S07/S09).
  private lastCounter = new Map<string, number>();
  private landed = new Set<string>(); // boat landings (theirs countered, ours pushed)

  // Our boat landed on a bordering player: push by land too, so their
  // counter-push has to split and the beachhead (and its city/port) holds.
  public pushes = 0;
  private landPush() {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    for (const a of me.outgoingAttacks()) {
      if (a.sourceTile() === null || this.landed.has(a.id())) continue;
      this.landed.add(a.id());
      const t = a.target();
      if (!t.isPlayer()) continue;
      const o = t as Player;
      if (o.type() === PlayerType.Bot || me.isFriendly(o) || !me.sharesBorderWith(o) || !this.warOk(me, o)) continue;
      const floor = this.params.cFloor * g.config().maxTroops(me);
      const send = Math.min(this.params.pushK * a.troops(), this.params.snipeMax * me.troops(), me.troops() - floor, this.homeRoom(me, o));
      if (send < a.troops()) continue;
      this.pushes++;
      g.addExecution(new AttackExecution(send, me, o.id()));
    }
  }
  // Troops an attack needs to kill tribe o outright. The engine annexes a
  // defender the moment it is under 100 tiles (AttackExecution.handleDeadDefender),
  // so we conquer N-99 tiles. Per tile the attacker loses
  // mag x 0.7 (tribe defender) x clamp(T/A, 0.6, 2) x (0.463 + 0.0039 x T/N)
  // and the tribe loses T/N (EngineConfig.attackLogic; v0.34.24 Config.attackLogic
  // is the same). The 4x-troops rule of the Nation AI ignores the tile count, so
  // big thin tribes ate the attack halfway (user report 2026-10-12).
  private killCache = new Map<string, [number, number]>();
  public killSend(o: Player): number {
    const g = this.botGame;
    const tick = g.ticks();
    const c = this.killCache.get(o.id());
    if (c !== undefined && c[0] === tick) return c[1];
    const n = o.numTilesOwned();
    const T = o.troops();
    const need = Math.max(1, n - 99);
    const d = n > 0 ? T / n : 0;
    let mag = 0;
    let k = 0;
    for (const t of o.tiles()) {
      const tt = g.terrainType(t);
      mag += tt === TerrainType.Mountain ? 120 : tt === TerrainType.Highland ? 100 : 80;
      if (++k >= 64) break;
    }
    mag = k > 0 ? (0.7 * mag) / k : 56;
    const base = 0.463 + 0.0039 * d;
    const ok = (a0: number) => {
      let a = a0;
      let t = T;
      for (let i = 0; i < need; i++) {
        a -= mag * Math.min(2, Math.max(0.6, t / a)) * base;
        if (a < 1) return false;
        t -= d;
      }
      return true;
    };
    let a = Math.max(T / 0.6, need * mag * 0.6 * base) + 1;
    for (let i = 0; i < 40 && !ok(a); i++) a *= 1.1;
    const send = Math.ceil(a * (1 + this.params.killMargin));
    this.killCache.set(o.id(), [tick, send]);
    return send;
  }

  // Nation-AI tribe attacks: send the kill amount or nothing. Only a tribe we
  // can't kill even at full troops is still eaten in chunks (the old 4x rule).
  public killsSized = 0;
  public killsHeld = 0;
  private patchTribeKill(ab: any) {
    ab.__kill = true;
    if (typeof ab.calculateBotAttackTroops !== "function") return;
    const orig = ab.calculateBotAttackTroops.bind(ab);
    ab.calculateBotAttackTroops = (target: Player, maxTroops: number) => {
      const me: Player | null = (this as any).player ?? null;
      if (me === null) return orig(target, maxTroops);
      const need = this.killSend(target);
      if (need > 0.9 * this.botGame.config().maxTroops(me)) return orig(target, maxTroops);
      const cap = typeof ab.troopSendCap === "function" ? ab.troopSendCap() : Infinity;
      if (need <= Math.min(maxTroops, cap)) {
        this.killsSized++;
        return need;
      }
      // Mode 2: a stalled attack still takes land; holding back costs growth.
      if (this.params.tribeKill >= 2) return orig(target, maxTroops);
      this.killsHeld++;
      return 0;
    };
    // Random boats carry 20% of our troops (boatAttackAmount). On a tribe that
    // needs more to die but is within our reach, skip that landing: it stalls.
    // Tribes too big to kill at all are still eaten in chunks by boat.
    if (this.params.tribeKill === 1 && typeof ab.findRandomBoatTarget === "function") {
      const find = ab.findRandomBoatTarget.bind(ab);
      ab.findRandomBoatTarget = (...args: unknown[]) => {
        const r = find(...args);
        const me: Player | null = (this as any).player ?? null;
        if (r === null || me === null) return r;
        const dst: TileRef = typeof r === "number" ? r : r.tile;
        const owner = this.botGame.owner(dst);
        if (!owner.isPlayer() || (owner as Player).type() !== PlayerType.Bot) return r;
        const need = this.killSend(owner as Player);
        if (need <= me.troops() / 5 || need > 0.9 * this.botGame.config().maxTroops(me)) return r;
        this.killsHeld++;
        return null;
      };
    }
  }

  // No even 1v1s (KNOWLEDGE MD-014, MD-127, S24, MD-049): the Nation AI's
  // weakest/juicy/victim/hated strategies hit any player with fewer troops than
  // us. Graded, not a ban: the bar drops toward 1.2x as others already hit the
  // target (third party, S26/MD-015). Retaliation (force) and traitors pass.
  public pvpSkips = 0;
  // Random boats (AiAttackBehavior.findRandomBoatTarget): the engine takes
  // whichever free-land or tribe tile turns up first, then ANY non-friendly
  // player with fewer total troops than us, and lands 20% of our troops there.
  // A landing on a player that isn't weak just dies (S05, OP-034). Order:
  // free land > tribe > a weak player (troops x1.5 <= the boat).
  public boatPicks = { free: 0, tribe: 0, player: 0, skipped: 0 };
  private patchBoatPick(ab: any) {
    ab.__boat = true;
    if (typeof ab.findRandomBoatTarget !== "function") return;
    const find = ab.findRandomBoatTarget.bind(ab);
    ab.findRandomBoatTarget = (src: TileRef, enemies: Player[], high = false) => {
      const me: Player | null = (this as any).player ?? null;
      if (me === null) return find(src, enemies, high);
      const g = this.botGame;
      if (high) {
        let tribe: unknown = null;
        for (let k = 0; k < 3; k++) {
          const r = find(src, enemies, true);
          if (r === null) break;
          if (!g.owner(r.tile).isPlayer()) {
            this.boatPicks.free++;
            return r;
          }
          tribe ??= r;
        }
        if (tribe !== null) this.boatPicks.tribe++;
        return tribe;
      }
      const r = find(src, enemies, false);
      if (r === null) return r;
      const o = g.owner(r.tile);
      if (!o.isPlayer()) {
        this.boatPicks.free++;
        return r;
      }
      if ((o as Player).type() === PlayerType.Bot || 1.5 * (o as Player).troops() <= me.troops() / 5) {
        this.boatPicks.player++;
        return r;
      }
      this.boatPicks.skipped++;
      return null;
    };
  }

  // Weakest bordering non-friendly Nation we beat at pvpNat x its troops, or null.
  public pvpNatTarget(me: Player, skip: Player | null): Player | null {
    if (this.params.pvpNat <= 0) return null;
    let best: Player | null = null;
    for (const p of this.botGame.players()) {
      if (p === skip || p === me || p.type() !== PlayerType.Nation || !p.isAlive()) continue;
      if (me.isFriendly(p) || !me.sharesBorderWith(p)) continue;
      if (me.troops() < this.params.pvpNat * Math.max(1, p.troops())) continue;
      if (best === null || p.troops() < best.troops()) best = p;
    }
    return best;
  }

  // Most we may send at `target` and still keep homeK x the strongest other
  // non-friendly player bordering us at home (Infinity when homeK is off).
  public homeRoom(me: Player, target: Player | null): number {
    if (this.params.homeK <= 0) return Infinity;
    let strongest = 0;
    for (const p of this.botGame.players()) {
      if (p === me || p === target || !p.isAlive() || p.type() === PlayerType.Bot) continue;
      if (me.isFriendly(p) || !me.sharesBorderWith(p)) continue;
      strongest = Math.max(strongest, p.troops());
    }
    return me.troops() - this.params.homeK * strongest;
  }

  // Stalled at the cap: troops >= 95% of max and no land gained for 30 s.
  public stalled = false;
  private stallTiles = 0;
  private stallSince = -1;
  private trackStall(me: Player) {
    const g = this.botGame;
    const sec = g.elapsedGameSeconds();
    const t = me.numTilesOwned();
    if (t > this.stallTiles * 1.01 || me.troops() < 0.95 * g.config().maxTroops(me)) {
      this.stallTiles = t;
      this.stallSince = sec;
    }
    this.stalled = sec - this.stallSince >= 30;
  }

  // The inherited send cap keeps 0.9x the strongest non-friendly player in
  // nearby() at home, and nearby() includes players only reachable by boat.
  // capLand: only land neighbours can hit us fast, so only they count.
  private patchCapLand(ab: any) {
    ab.__capLand = true;
    if (typeof ab.neighborTroopCap !== "function") return;
    const orig = ab.neighborTroopCap.bind(ab);
    ab.neighborTroopCap = (ignore?: Player) => {
      const me: Player | null = (this as any).player ?? null;
      if (me === null) return orig(ignore);
      const cfg = this.botGame.config().gameConfig();
      if (cfg.difficulty !== Difficulty.Impossible && cfg.difficulty !== Difficulty.Hard) return orig(ignore);
      const keep = cfg.difficulty === Difficulty.Impossible ? 0.9 : 0.75;
      let max = 0;
      for (const n of me.nearby()) {
        if (!n.isPlayer() || n === ignore || me.isFriendly(n) || n.type() === PlayerType.Bot) continue;
        if (!me.sharesBorderWith(n)) continue;
        max = Math.max(max, n.troops());
      }
      return max === 0 ? Infinity : Math.max(0, me.troops() - Math.ceil(max * keep));
    };
  }

  private patchPvp(ab: any) {
    ab.__pvp = true;
    if (typeof ab.sendAttack !== "function") return;
    const orig = ab.sendAttack.bind(ab);
    ab.sendAttack = (target: any, force = false) => {
      const me: Player | null = (this as any).player ?? null;
      if (force || me === null || !target.isPlayer?.()) return orig(target, force);
      const o = target as Player;
      if (o.type() === PlayerType.Bot || o.isTraitor() || o.isDisconnected()) return orig(target, force);
      const theirs = Math.max(1, o.troops());
      const others = o.incomingAttacks()
        .filter((a) => a.attacker() !== me)
        .reduce((s, a) => s + a.troops(), 0);
      const busy = Math.min(1, others / theirs);
      const ratio = o.type() === PlayerType.Nation && this.params.pvpNat > 0 ? this.params.pvpNat : this.params.pvpRatio;
      let req = Math.max(1.2, ratio * (1 - 0.5 * busy));
      if (this.params.capPush > 0 && this.stalled && busy >= 0.2) req = Math.min(req, this.params.capPush);
      if (me.troops() < req * theirs) {
        this.pvpSkips++;
        // Boxed in by a strong player: hit a weaker Nation neighbour instead of idling.
        const nat = this.pvpNatTarget(me, o);
        return nat !== null ? orig(nat, force) : false;
      }
      return orig(target, force);
    };
  }

  // The inherited Impossible order tries "crown" (attack the runaway leader)
  // before "weakest". Attacking the strongest neighbour while a weaker one is
  // open bleeds troops (MD-022). Join a crown fight only when it pays:
  // the leader's home is exposed, others already hit it hard (third party,
  // MD-015), or warOk says we can take it on.
  public crownSkips = 0;
  private patchCrown(ab: any) {
    ab.__crown = true;
    if (typeof ab.findCrownTarget !== "function") return; // v0.34 has no crown strategy
    const orig = ab.findCrownTarget.bind(ab);
    ab.findCrownTarget = (enemies: Player[]) => {
      const leader: Player | null = orig(enemies);
      const me: Player | null = (this as any).player ?? null;
      if (leader === null || me === null) return leader;
      const others = leader.incomingAttacks()
        .filter((a) => a.attacker() !== me)
        .reduce((s, a) => s + a.troops(), 0);
      if (this.exposed(leader) || others >= 0.3 * leader.troops() || this.warOk(me, leader)) return leader;
      this.crownSkips++;
      return null;
    };
  }

  public tribeCounters = 0;
  private counterAttacks(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const floor = this.params.cFloor * this.botGame.config().maxTroops(me);
    let left = me.troops();
    // Pressure from real players: then a tribe attack is only cancelled, not chased.
    const pressure = me.incomingAttacks()
      .filter((a) => a.attacker().type() !== PlayerType.Bot)
      .reduce((s, a) => s + a.troops(), 0);
    for (const a of me.incomingAttacks()) {
      const x = a.attacker();
      if (x.type() === PlayerType.Bot && a.sourceTile() === null && this.params.tribeCounter > 0) {
        // A tribe attacking us: our attack on it cancels its attack 1:1 (AttackExecution.init)
        // and the rest lands on a home that just sent troops out. Unless real players press us,
        // also send enough to take its land.
        if (me.isFriendly(x) || me.outgoingAttacks().some((o) => o.target() === x)) continue;
        if (ticks - (this.lastCounter.get(x.id()) ?? -1e9) < 50) continue;
        // With tribeKill the rest is the full kill when it fits; else nothing (1, a half attack
        // stalls in its land) or the usual top-up (2).
        const kill = this.params.tribeKill > 0 && pressure <= 0.2 * me.troops() ? this.killSend(x) : 0;
        const fits = kill > 0 && a.troops() + kill <= left - floor;
        const rest = pressure > 0.2 * me.troops() ? 0 : fits ? kill : this.params.tribeKill === 1 ? 0 : this.params.stealK * x.troops();
        const want = a.troops() + rest;
        const send = Math.min(want, left - floor);
        if (send < a.troops()) continue;
        left -= send;
        this.lastCounter.set(x.id(), ticks);
        this.tribeCounters++;
        this.botGame.addExecution(new AttackExecution(send, me, x.id()));
        continue;
      }
      if (a.sourceTile() !== null) {
        // Boat landing: our land attack on the lander cancels the landing 1:1
        // (what players do the moment a boat lands). Needs a shared border,
        // which the beachhead gives.
        if (this.params.boatCounter <= 0 || x.type() === PlayerType.Bot || me.isFriendly(x) || !me.sharesBorderWith(x)) continue;
        if (this.landed.has(a.id())) continue;
        const send = Math.min(this.params.boatCounterK * a.troops(), left - floor);
        if (send < a.troops()) continue;
        this.landed.add(a.id());
        left -= send;
        this.botGame.addExecution(new AttackExecution(send, me, x.id()));
        continue;
      }
      if (x.type() === PlayerType.Bot || me.isFriendly(x)) continue;
      if (ticks - (this.lastCounter.get(x.id()) ?? -1e9) < 50) continue;
      let send = a.troops() + this.params.cExtra * x.troops();
      // homeK: still cancel the incoming attack, but keep home strong against the other neighbours.
      const room = this.homeRoom(me, x);
      if (send > room && room >= a.troops()) send = room;
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
  /** Is `o` a snipe target by weakness (not ally bait)? */
  snipeLosing(me: Player, o: Player, troops: number, war: boolean): boolean {
    if (o.type() === PlayerType.Bot || this.params.snipeWeak >= 1) return true;
    if (o.troops() < this.params.snipeWeak * this.botGame.config().maxTroops(o)) return true;
    const gate = this.params.snipeGate;
    if (gate <= 0) return o.incomingAttacks().some((a) => a.attacker() !== me) || war;
    const hit = o.incomingAttacks().reduce((sum, a) => sum + (a.attacker() !== me ? a.troops() : 0), 0);
    return hit >= gate * o.troops() || (war && troops >= o.troops());
  }

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
    // units() takes at most 3 types as separate args: the tuned sets saw only
    // the first 3 (kept as is; passing the array would value all of them).
    const types = (Object.keys(VAL) as UnitType[]).slice(0, 3);
    const r2 = this.params.snipeRange * this.params.snipeRange;
    const border = [...me.borderTiles()];
    if (border.length === 0) return;
    let best: { tile: TileRef; send: number; score: number; id: number; o: Player; ally: boolean } | null = null;
    for (const o of g.players()) {
      if (o === me || !o.isAlive() || me.isFriendly(o)) continue;
      // A tribe we border by land: a land attack gets there sooner than a boat.
      if (o.type() === PlayerType.Bot && me.sharesBorderWith(o)) continue;
      const war = this.params.warSnipe > 0 && o.type() !== PlayerType.Bot &&
        (me.outgoingAttacks().some((a) => a.target() === o) || o.outgoingAttacks().some((a) => a.target() === me)) &&
        this.warOk(me, o);
      // Snipe the losing: tribes, players being hit by someone, or drained ones.
      const losing = this.snipeLosing(me, o, troops, war);
      // Ally bait: a far player we could ally with. The alliance request goes
      // out right after the boat; a boat that lands on an ally takes the port
      // tile without an attack, so a yes is a free port and no betrayal.
      const ally = this.params.snipeAlly > 0 && o.type() !== PlayerType.Bot &&
        !me.sharesBorderWith(o) && me.canSendAllianceRequest(o);
      if (!losing && !ally) continue;
      const dens = o.troops() / Math.max(1, o.numTilesOwned());
      const send = Math.max(1000, this.params.snipeK * dens * 40);
      if (send > this.params.snipeMax * troops) continue;
      for (const u of o.units(types)) {
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
        if (best === null || score > best.score) best = { tile: t, send, score, id: u.id(), o, ally };
      }
    }
    if (best === null) return;
    const dst = targetTransportTile(g, me, best.tile);
    const launch = canBuildTransportShip(g, me, best.tile);
    if (dst === null || launch === false) { this.sniped.set(best.id, ticks); return; }
    if (map.euclideanDistSquared(launch, dst) > r2) { this.sniped.set(best.id, ticks); return; }
    this.sniped.set(best.id, ticks);
    // Close landing next to an enemy warship: several boats at once, so it
    // can't sink them all in time. Unguarded, one boat does it.
    let boats = 1;
    const near2 = this.params.snipeNear * this.params.snipeNear;
    const guarded = g.units(UnitType.Warship).some((w) =>
      w.owner() !== me && !w.owner().isFriendly(me) && map.euclideanDistSquared(w.tile(), dst) <= 2.25 * near2);
    if (this.params.snipeBurst > 1 && !best.ally && guarded && map.euclideanDistSquared(launch, dst) <= near2) {
      const free = g.config().boatMaxNumber() - me.unitCount(UnitType.TransportShip);
      boats = Math.max(1, Math.min(Math.round(this.params.snipeBurst), free, Math.floor((2 * this.params.snipeMax * troops) / best.send)));
    }
    for (let b = 0; b < boats; b++) {
      this.snipesSent++;
      g.addExecution(new TransportShipExecution(me, best.tile, best.send));
    }
    if (best.ally && me.canSendAllianceRequest(best.o)) g.addExecution(new AllianceRequestExecution(me, best.o.id()));
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
    const dbg = BotExecution.grabDebug ? (k: string) => { (this as any).__gd ??= {}; (this as any).__gd[k] = ((this as any).__gd[k] ?? 0) + 1; } : (_: string) => {};
    if (ticks % 600 === 0 && BotExecution.grabDebug) console.error(ticks / 600, JSON.stringify((this as any).__gd), "budget", Math.round(budget), "troops", Math.round(troops));
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
    // units() takes at most 3 types as separate args: the tuned sets saw only
    // the first 3 (kept as is; passing the array would value all of them).
    const types = (Object.keys(VAL) as UnitType[]).slice(0, 3);
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
      for (const u of o.units(types)) if (nearBorder(u.tile())) value += (VAL[u.type()] ?? 0) * u.level();
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
    if (tn) {
      const s = Math.min(send, this.homeRoom(me, null));
      if (s >= 1) g.addExecution(new AttackExecution(s, me, g.terraNullius().id()));
    } else if (best !== null) {
      const s = Math.min(send, this.homeRoom(me, best));
      if (s >= 1) g.addExecution(new AttackExecution(s, me, best.id()));
    }
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
        if (o.isFriendly(me) && !this.allyEnding(me, o)) continue;
        if (!me.sharesBorderWith(o)) continue;
        strongest = Math.max(strongest, o.troops());
      }
    }
    let floor = Math.min(
      this.params.defCap,
      Math.max(this.params.defMin, (this.params.defK * strongest) / maxT),
    );
    // Land grab: winners send 10-20% at a time into free land and don't wait
    // for ~40% troops (S03, OP-057); a full defense floor there halves growth.
    if (this.params.openCap > 0 && floor > this.params.openCap && me.nearby().some((n) => !n.isPlayer())) {
      floor = this.params.openCap;
    }
    self.reserveRatio = Math.max(this.params.reserve, floor);
    self.expandRatio = Math.max(this.params.expand, floor);
    self.triggerRatio = Math.max(this.params.trigger, Math.min(0.97, floor + 0.08));
    const ab = self.attackBehavior;
    if (ab && this.params.crownGate > 0 && !ab.__crown) this.patchCrown(ab);
    if (ab && this.params.tribeKill > 0 && !ab.__kill) this.patchTribeKill(ab);
    if (ab && this.params.pvpRatio > 0 && !ab.__pvp) this.patchPvp(ab);
    if (ab && this.params.boatPick > 0 && !ab.__boat) this.patchBoatPick(ab);
    if (ab && this.params.capLand > 0 && !ab.__capLand) this.patchCapLand(ab);
    this.trackStall(me);
    if (ab) {
      ab.reserveRatio = self.reserveRatio;
      ab.expandRatio = self.expandRatio;
      ab.triggerRatio = self.triggerRatio;
    }
  }

  // ---------------------------------------------------------------- friends
  // Friends = teammates (Team modes) and kin (same-script bots found by the
  // chat handshake). Never targets; helped when hit.
  private isFriend(me: Player, p: Player): boolean {
    return p !== me && p.type() !== PlayerType.Bot && (me.isOnSameTeam(p) || this.kin.has(p.id()));
  }

  /** Land that counts for p's win: its team's land in Team modes, else its own. */
  private sideTiles(p: Player): number {
    const t = p.team();
    if (t === null || p.type() === PlayerType.Bot) return p.numTilesOwned();
    return this.botGame.teamTilesOwned(t);
  }

  // Same-script handshake (game clock = seconds since spawn phase ended).
  // At kinAt we send "I'm on your side!" (greet.same_team) to every human.
  // Whoever sent us that line within kinTol of kinAt gets "When will my PR
  // finally get merged...?" (misc.pr) at kinAt + kinGap. Kin = a player whose
  // line AND reply both reached us on time. Another player almost never sends
  // both lines at both times, so false kin are rare.
  public kin = new Set<string>();
  private kinHello = new Set<string>();
  private kinStage = 0;
  public kinSent = 0;
  private hookChat(mg: Game) {
    const g = mg as any;
    if (g.__kinHooked) {
      // Several BotExecutions in one game (sims): one hook, every listener.
      g.__kinListeners.push(this);
      return;
    }
    g.__kinHooked = true;
    g.__kinListeners = [this];
    const orig = g.displayChat.bind(g);
    g.displayChat = (message: string, category: string, target: any, playerID: any, isFrom: boolean, other: string) => {
      for (const l of g.__kinListeners as BotExecution[]) l.onChat(category, message, playerID, isFrom, other);
      return orig(message, category, target, playerID, isFrom, other);
    };
  }
  public onChat(category: string, key: string, to: string | null, isFrom: boolean, from: string) {
    const me: Player | null = (this as any).player ?? null;
    if (this.params.kin <= 0 || me === null || to !== me.id() || !isFrom || from === me.id()) return;
    const sec = this.botGame.elapsedGameSeconds();
    const at = this.params.kinAt;
    const tol = this.params.kinTol;
    if (category === "greet" && key === "same_team" && Math.abs(sec - at) <= tol) this.kinHello.add(from);
    else if (category === "misc" && key === "pr" && this.kinHello.has(from) && Math.abs(sec - (at + this.params.kinGap)) <= tol) this.kin.add(from);
  }
  private kinHandshake() {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase() || this.kinStage >= 2) return;
    const sec = g.elapsedGameSeconds();
    const at = this.params.kinAt;
    if (this.kinStage === 0 && sec >= at) {
      this.kinStage = 1;
      if (sec > at + 1) return; // joined late: no handshake this game
      for (const p of g.players()) {
        if (p === me || p.type() !== PlayerType.Human || !p.isAlive()) continue;
        g.addExecution(new QuickChatExecution(me, p.id(), "greet.same_team", undefined));
        this.kinSent++;
      }
    } else if (this.kinStage === 1 && sec >= at + this.params.kinGap) {
      this.kinStage = 2;
      for (const id of this.kinHello) {
        if (!g.hasPlayer(id)) continue;
        g.addExecution(new QuickChatExecution(me, id, "misc.pr", undefined));
        this.kinSent++;
      }
    }
  }
  // ---------------------------------------------------------------- emojis
  // emojiMode: the Nation AI's casual emojis are kept only when positive and
  // then only 1 in 3; insults, clowns, rats etc. are dropped. Our own
  // alliance asks and renewals carry a 🤝, or ☢️ once we have asked the
  // same player 3+ times and own a missile silo (a nudge, not an attack).
  private emojiPatched = false;
  private askCount = new Map<string, number>();
  private askSeen = new Set<any>();
  private renewSeen = new Map<string, number>();
  public emojisSent = { hand: 0, nuke: 0, casual: 0, dropped: 0 };
  private static POSITIVE = new Set(
    ["😀", "😊", "🥰", "😇", "😎", "👋", "👏", "💪", "👍", "🤝", "❤️", "🕊️", "🙏", "👑", "🥇", "🫡"].map((e) =>
      flattenedEmojiTable.indexOf(e as any),
    ),
  );
  private static HAND = flattenedEmojiTable.indexOf("🤝" as any);
  private static NUKE = flattenedEmojiTable.indexOf("☢️" as any);
  private patchEmojis() {
    const eb = (this as any).emojiBehavior;
    if (this.emojiPatched || eb === undefined) return;
    this.emojiPatched = true;
    const orig = eb.sendEmoji.bind(eb);
    eb.sendEmoji = (other: any, list: number[]) => {
      if (this.params.emojiMode <= 0) return orig(other, list);
      const ok = list.filter((e) => BotExecution.POSITIVE.has(e));
      if (ok.length === 0 || !eb.random.chance(3)) {
        this.emojisSent.dropped++;
        return;
      }
      this.emojisSent.casual++;
      return orig(other, ok);
    };
  }
  private allyEmojis(ticks: number) {
    this.patchEmojis();
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    const send = (o: Player, wanted: number) => {
      if (o.type() !== PlayerType.Human || !me.canSendEmoji(o)) return;
      const nuke = wanted >= 3 && me.unitCount(UnitType.MissileSilo) > 0;
      g.addExecution(new EmojiExecution(me, o.id(), nuke ? BotExecution.NUKE : BotExecution.HAND));
      if (nuke) this.emojisSent.nuke++;
      else this.emojisSent.hand++;
    };
    for (const r of me.outgoingAllianceRequests()) {
      if (this.askSeen.has(r)) continue;
      this.askSeen.add(r);
      const o = r.recipient();
      const n = (this.askCount.get(o.id()) ?? 0) + 1;
      this.askCount.set(o.id(), n);
      send(o, n);
    }
    for (const a of me.alliances()) {
      const o = a.other(me);
      // We agreed to renew and wait for them: one emoji per renewal round.
      if (!a.agreedToExtend(me) || a.agreedToExtend(o)) continue;
      if (this.renewSeen.get(o.id()) === a.expiresAt()) continue;
      this.renewSeen.set(o.id(), a.expiresAt());
      send(o, this.askCount.get(o.id()) ?? 0);
    }
  }

  /** Same clan tag = kin at once; the chat handshake still finds untagged kin. */
  private clanKin() {
    const tag = this.botNation.playerInfo.clanTag;
    if (!tag) return;
    for (const p of this.botGame.players()) {
      if (p.type() === PlayerType.Human && p.clanTag() === tag && p.id() !== this.botNation.playerInfo.id) this.kin.add(p.id());
    }
  }
  /** Kin: accept their requests, ask them, renew every alliance with them. */
  private kinAlly(me: Player, ticks: number) {
    const g = this.botGame;
    for (const req of [...me.incomingAllianceRequests()]) if (this.kin.has(req.requestor().id())) req.accept();
    if (ticks % 20 !== 0) return;
    for (const id of this.kin) {
      if (!g.hasPlayer(id)) continue;
      const o = g.player(id);
      if (!o.isAlive()) continue;
      const a = me.alliances().find((x) => x.other(me) === o);
      if (a === undefined) {
        if (me.canSendAllianceRequest(o)) g.addExecution(new AllianceRequestExecution(me, id));
      } else if (a.expiresAt() - ticks <= g.config().allianceExtensionPromptOffset() && !a.agreedToExtend(me)) {
        g.addExecution(new AllianceExtensionExecution(me, id));
      }
    }
  }

  // Far kin: one small landing boat onto free shore next to the nearest kin,
  // so both own land within rail range and factories can link the two nets.
  // Skipped when we already border them or are already near.
  private kinBoated = new Set<string>();
  public kinBoats = 0;
  private kinBoat(me: Player) {
    const g = this.botGame;
    if (me.unitCount(UnitType.TransportShip) >= g.config().boatMaxNumber()) return;
    const near = g.config().trainStationMaxRange();
    for (const id of this.kin) {
      if (this.kinBoated.has(id) || !g.hasPlayer(id)) continue;
      const k = g.player(id);
      if (!k.isAlive() || me.sharesBorderWith(k)) { this.kinBoated.add(id); continue; }
      const kb = k.borderTiles();
      if (kb.size === 0) continue;
      // Already close: some of our land within rail range of theirs.
      let n = 0;
      let close = false;
      const mine = me.borderTiles();
      outer: for (const a of mine) {
        if (++n > 300) break;
        let m = 0;
        for (const b of kb) {
          if (++m > 300) break;
          if (g.manhattanDist(a, b) <= near) { close = true; break outer; }
        }
      }
      if (close) { this.kinBoated.add(id); continue; }
      const dst = this.kinPocket(k, kb);
      if (dst === null) continue; // nothing free to land on yet; retry later
      const to = targetTransportTile(g, me, dst);
      if (to === null || canBuildTransportShip(g, me, dst) === false) continue;
      this.kinBoated.add(id);
      this.kinBoats++;
      g.addExecution(new TransportShipExecution(me, dst, Math.max(1, Math.floor(0.05 * me.troops()))));
      return; // one boat per check
    }
  }

  // Landing spot for the kin boat: free shore land next to their border,
  // preferring the one most surrounded by their land, so the little colony
  // sits in a pocket the ally shields (and its factory links to theirs).
  kinPocket(k: Player, kb: Iterable<TileRef>): TileRef | null {
    const g = this.botGame;
    const kid = k.smallID();
    const R = 5;
    let best: TileRef | null = null;
    let bestScore = -1;
    let m = 0;
    const seen = new Set<TileRef>();
    for (const b of kb) {
      if (++m > 2000 || seen.size > 200) break;
      for (const t of g.neighbors(b)) {
        if (seen.has(t) || !g.isLand(t) || g.hasOwner(t) || !g.isShore(t)) continue;
        seen.add(t);
        const x0 = g.x(t), y0 = g.y(t);
        let land = 0, theirs = 0;
        for (let dx = -R; dx <= R; dx++) {
          for (let dy = -R + Math.abs(dx); dy <= R - Math.abs(dx); dy++) {
            if (!g.isValidCoord(x0 + dx, y0 + dy)) continue;
            const u = g.ref(x0 + dx, y0 + dy);
            if (!g.isLand(u)) continue;
            land++;
            if (g.ownerID(u) === kid) theirs++;
          }
        }
        const score = land > 0 ? theirs / land : 0;
        if (score > bestScore) { bestScore = score; best = t; }
      }
    }
    return best;
  }

  // Help friends under attack: troops when an attack would break them and we
  // are safe, gold so they can rebuild/defend; SAM cover next to a friend's
  // border while some enemy has a silo. Donations go through the engine's
  // canDonate* rules (config donateTroops/donateGold, friendly only).
  private helped = new Map<string, number>();
  private samAt = -1e9;
  public donations = { troops: 0, gold: 0, sams: 0 };
  private helpFriends(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    if (this.params.kinBoat > 0 && this.kin.size > 0 && ticks % 50 === 3) this.kinBoat(me);
    const friends = g.players().filter((p) => p.isAlive() && this.isFriend(me, p));
    if (friends.length === 0) return;
    if (this.params.donate > 0) this.donateAdaptive(me, friends, ticks);
    if (this.params.samCover > 0 && ticks - this.samAt >= 300) this.samCover(me, friends);
  }
  // Donations that never put us at risk first:
  //  - troops only from our slack: after giving we still keep half our max,
  //    1.2x the strongest non-friend neighbour and 1.5x what is hitting us;
  //    only when the gift can actually hold the friend (>= half of the need);
  //  - gold only above a reserve (a city, or 2 SAMs while an enemy has a
  //    silo), never while we are under real attack;
  //  - FFA (kin, one winner): no help to kin bigger than 1.3x us or holding
  //    30%+ of the land; they are the rival to beat. Team modes: teammates'
  //    land counts for our win, so only our own safety limits help.
  private donateAdaptive(me: Player, friends: Player[], ticks: number) {
    const g = this.botGame;
    const incoming = (p: Player) => p.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    const myIn = incoming(me);
    const max = g.config().maxTroops(me);
    let foe = 0;
    for (const q of g.players()) {
      if (q === me || !q.isAlive() || q.type() === PlayerType.Bot || this.isFriend(me, q) || !me.sharesBorderWith(q)) continue;
      foe = Math.max(foe, q.troops());
    }
    const keep = Math.max(0.5 * max, 1.2 * foe, 1.5 * myIn);
    const slack = me.troops() - keep;
    const silo = g.players().some((p) => p !== me && p.isAlive() && !this.isFriend(me, p) && p.unitCount(UnitType.MissileSilo) > 0);
    const reserve = silo
      ? 2 * Number(g.unitInfo(UnitType.SAMLauncher).cost(g, me))
      : Number(g.unitInfo(UnitType.City).cost(g, me));
    const land = g.numLandTiles();
    for (const f of friends) {
      if (ticks - (this.helped.get(f.id()) ?? -1e9) < 100) continue;
      const inc = incoming(f);
      if (inc < 0.6 * f.troops()) continue;
      const teammate = me.isOnSameTeam(f);
      if (!teammate && (f.numTilesOwned() > 1.3 * me.numTilesOwned() || f.numTilesOwned() > 0.3 * land)) {
        this.donateSkips++;
        continue;
      }
      let gave = false;
      const need = 1.2 * inc - f.troops();
      const troops = Math.min(slack, 0.25 * me.troops(), need);
      if (need > 0 && troops >= 0.5 * need && troops >= 0.03 * me.troops() && me.canDonateTroops(f)) {
        g.addExecution(new DonateTroopsExecution(me, f.id(), Math.floor(troops)));
        this.donations.troops++;
        gave = true;
      }
      const spare = Number(me.gold()) - reserve;
      if (myIn < 0.2 * me.troops() && spare > 0 && Number(f.gold()) < Number(me.gold()) / 2 && me.canDonateGold(f)) {
        g.addExecution(new DonateGoldExecution(me, f.id(), Math.floor(Math.min(spare, Number(me.gold()) * 0.25))));
        this.donations.gold++;
        gave = true;
      }
      if (gave) this.helped.set(f.id(), ticks);
    }
  }
  public donateSkips = 0;
  private samCover(me: Player, friends: Player[]) {
    const g = this.botGame;
    this.samAt = g.ticks();
    const threat = g.players().some((p) => p !== me && p.isAlive() && !this.isFriend(me, p) &&
      p.type() !== PlayerType.Bot && p.unitCount(UnitType.MissileSilo) > 0);
    if (!threat) return;
    const cost = g.unitInfo(UnitType.SAMLauncher).cost(g, me);
    if (Number(me.gold()) < 1.5 * Number(cost)) return;
    const range = 70;
    const mySams = me.units(UnitType.SAMLauncher);
    for (const f of friends) {
      if (!me.sharesBorderWith(f)) continue;
      const cities = f.units(UnitType.City, UnitType.Port, UnitType.Factory);
      if (cities.length === 0) continue;
      const hub = cities.reduce((a, b) => (b.level() > a.level() ? b : a)).tile();
      // A SAM of ours or theirs already covers the hub: nothing to add.
      if ([...mySams, ...f.units(UnitType.SAMLauncher)].some((u) => g.manhattanDist(u.tile(), hub) <= range)) continue;
      let best: TileRef | null = null;
      let bestD = Infinity;
      let n = 0;
      for (const t of me.borderTiles()) {
        if (++n > 4000) break;
        const d = g.manhattanDist(t, hub);
        if (d < bestD && d <= range) { bestD = d; best = t; }
      }
      if (best === null) continue;
      const spot = me.canBuild(UnitType.SAMLauncher, best);
      if (spot === false) continue;
      g.addExecution(new ConstructionExecution(me, UnitType.SAMLauncher, spot));
      this.donations.sams++;
      return; // one SAM per check
    }
  }

  /** Sim only (StandIn): a clientID whose spawn is ignored, so enemy spawns don't depend on it. */
  protected spawnIgnore: string | null = null;
  private chooseSpawn(): TileRef | null {
    const g = this.botGame;
    const map = g.map();
    const w = g.width();
    const h = g.height();
    const meP = g.hasPlayer(this.botNation.playerInfo.id) ? g.player(this.botNation.playerInfo.id) : null;
    const team = meP?.team() ?? null;
    const area = team !== null ? g.teamSpawnArea(team) : undefined;
    // Clan mates (same clan tag, already spawned): spawn next to one of them.
    const tag = this.botNation.playerInfo.clanTag;
    const mates: TileRef[] = this.params.clanSpawn > 0 && tag
      ? g.allPlayers()
          .filter((p: Player) => p.type() === PlayerType.Human && p.clanTag() === tag &&
            p.id() !== this.botNation.playerInfo.id && p.spawnTile() !== undefined)
          .map((p: Player) => p.spawnTile()!)
      : [];
    const rivals: TileRef[] = g
      .allPlayers()
      .filter(
        (p: Player) =>
          (p.type() === PlayerType.Nation || p.type() === PlayerType.Human) &&
          (meP === null || !meP.isOnSameTeam(p)) &&
          !(mates.length > 0 && p.type() === PlayerType.Human && p.clanTag() === tag) &&
          p.spawnTile() !== undefined &&
          (this.spawnIgnore === null || p.clientID() !== this.spawnIgnore),
      )
      .map((p: Player) => p.spawnTile()!);
    const maxD = this.params.distCap;
    let best: TileRef | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.params.spawnSamples; i++) {
      const R = this.params.clanR;
      const t = mates.length > 0
        ? map.ref(
            Math.max(0, Math.min(w - 1, map.x(mates[i % mates.length]) + this.rng.nextInt(-R, R + 1))),
            Math.max(0, Math.min(h - 1, map.y(mates[i % mates.length]) + this.rng.nextInt(-R, R + 1))),
          )
        : area !== undefined
        ? map.ref(this.rng.nextInt(area.x, area.x + area.width), this.rng.nextInt(area.y, area.y + area.height))
        : map.ref(this.rng.nextInt(0, w), this.rng.nextInt(0, h));
      if (!map.isLand(t) || map.hasOwner(t)) continue;
      const tx = map.x(t);
      const ty = map.y(t);
      // Next to a mate, not on top of it.
      if (mates.length > 0 && mates.some((m) => Math.abs(map.x(m) - tx) + Math.abs(map.y(m) - ty) < 12)) continue;
      let dMin = maxD;
      for (const r of rivals) {
        const dx = map.x(r) - tx;
        const dy = map.y(r) - ty;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < dMin) dMin = d;
      }
      let landN = 0;
      const tribes = new Set<string>();
      const N = 48;
      for (let k = 0; k < N; k++) {
        const rad = 8 + (k % 4) * 10;
        const x = Math.round(tx + RING[k][0] * rad);
        const y = Math.round(ty + RING[k][1] * rad);
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
