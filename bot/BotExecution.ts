// SPDX-License-Identifier: AGPL-3.0-only
// Modified from and built on the OpenFront game's Nation AI (copyright its original authors). Changes by openfront-bot contributors, 2026. See NOTICE.
/**
 * Code bot for a Human player (CLI tuning in tests/bot, solo autoplay): scored spawn choice + the Nation AI
 * behaviors (attack/expand, structures, alliances, nukes, warships) with
 * tunable ratios and reaction rate. Private NationExecution fields are set
 * through `any` (tsx does no type-check of privacy at runtime).
 */
import type { Game, Player } from "../../game/Game";
import { Difficulty, GameMode, Nation, PlayerType, Relation, TerrainType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { NationExecution } from "../NationExecution";
import { AttackExecution } from "../AttackExecution";
import { TransportShipExecution } from "../TransportShipExecution";
import { canBuildTransportShip, targetTransportTile } from "../../game/TransportShipUtils";
import { randTerritoryTileArray } from "../nation/NationUtils";
import { mirvLeakShare } from "../nation/NationMIRVBehavior";
import { calculateTerritoryCenter, nearestTileDist, nearestTileDistCapped } from "../Util";
import { ConstructionExecution } from "../ConstructionExecution";
import { UpgradeStructureExecution } from "../UpgradeStructureExecution";
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
  wWater: number; // weight: ocean (1) or lake (0.5) near the spawn, faded with distance (ports, boats, trade); a map without water scores 0 everywhere
  distCap: number; // distance (tiles) beyond which a rival is "far enough"
  defK: number; // keep troops >= defK x strongest bordering nation/human (KNOWLEDGE S28)
  defMin: number; // keep troops >= defMin x own max troops (out of 'veryWeak' filter)
  ally: number; // 1 = actively request alliances with nearby nations, renew, accept all
  allyRange: number; // request alliances with nations whose spawn is within this many tiles (plus all bordering)
  betray: number; // 1 = allow the AI to betray allies when "safe", 0 = never
  econ: number; // 1 = don't hoard gold for nukes, don't block builds on failed defense posts
  defCap: number; // max defense floor (ratio of own max troops)
  defSum: number; // multi-attacker waves: the floor also counts defSum x the other bordering hostiles' troops (0 = strongest only)
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
  snipeSmall: number; // >0 = a snipe boat that lands on the structure's own tile carries only snipeSmall x our troops (the landing conquers that tile, TransportShipExecution, so the port/city flips whatever the boat holds); a landing beside it keeps the snipeK size
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
  earlyCity: number; // before minute earlyCityMin, build only cities (plus one port) until we own this many (0 = off)
  earlyCityMin: number; // minutes the early-city rush lasts
  pirate: number; // 1 = warships patrol enemy trade lanes and capture trade ships (gold)
  pirateMax: number; // max warships we build for pirating
  pirateRange: number; // hotspot must be within this many tiles of one of our ports
  pirateMin: number; // min non-friendly trade ships near a hotspot to act
  pirateKeep: number; // gold left after buying a warship (ratio of its cost)
  pirateEvery: number; // ticks between pirate decisions
  pirateSafe: number; // robbing angers the owner: only rob owners already attacking us, not bordering us, or with troops <= pirateSafe x ours
  allyHumans: number; // 1 = also request alliances with nearby Human players (bot arena)
  allySelect: number; // 1 = choosy diplomacy: ally threats, keep weak neighbors as food, respect the alliance cap, renew by value
  allyVid: number; // 1 = video/replay alliance rules (KNOWLEDGE AL-014/016/018/027): ask every near non-food human, re-ask every 30-120 s, ask humans at war even when far/over cap, no #1/#2 human after 5:00, max 2 strong-only Nation asks before 3:00
  allyHStrong: number; // 1 = ask bordering humans for alliances when they are strong (allyStrong) or attacking us
  allyStrong: number; // a player with troops >= allyStrong x ours is a threat: always accept, renew and ask
  mirvSave: number; // >0 = graded MIRV bank: a non-ally with >= mirvSave x our land and >= 1.5x our power that wins within ~20 min (or holds >= 35% of the land) makes us stop AI builds/warships/nukes and bank gold, but only while our measured income affords MIRV (+ silo) before its win ETA; fired at once when affordable, then the mirvBank land follow-up
  mirvRich: number; // >0 (needs mirvSave) = with no runaway, gold >= MIRV (+ silo if none) and the biggest non-ally land holder: MIRV it when (gold / cost) x (its land / ours) >= mirvRich and its land >= 0.6x ours (owner: "bot had so much money but he didnt even merv")
  postSpread: number; // >0 = the Nation AI's defense-post spots must be >= postSpread x defensePostRange from each of our posts (a post's bonus is all-or-nothing per tile, overlapping cover adds nothing; v0.34 falls back to stacking once the front is covered)
  killCap: number; // >0 = homeKeep's kill exemption (send >= 2x a small target's troops may go down to the defense floor) only covers killCap x the target's troops for a player target (tribes keep it whole); the rest of the send keeps the full homeKeep. v0.35 fin189 24.07m: the Nation AI's 'hated' send put 10.2M on Imp1 (1.19M troops, 558 tiles) out of 26.5M while Imp21/Imp29 (15-17M) stood at our border
  homeKeep: number; // >0 = every attack and boat we send (own logic and Nation AI) leaves max(homeKeep (regen ~94% of peak at .30), defense floor) x maxTroops plus the troops attacking us by land at home; sends in one tick add up. A send is trimmed to what is above that, or held if under half survives. A kill (send >= 2x the target's troops, target < 20% of our land) may go down to the defense floor; troops of an attacker we hit back are not kept (the hit cancels them 1:1); off in the doomsday clock
  mirvPre: number; // >0 (needs mirvSave) = pre-emptive MIRV: a bordering non-ally with a silo, >= 0.2x our land and gold >= mirvPre x the MIRV price can soon MIRV us (v0.35 fin167/189/198: rich stand-ins banked 15-25M while our cities kept us at ~1M, then MIRV + land strike); bank while our income reaches the price before its own (measured) gold does, MIRV it when >= 30% of the warheads get past its SAMs, then the land follow-up
  mirvDuel: number; // 1 = leader endgame MIRV (FFA, needs mirvSave): 2-3 leaders (each >= half the top's land, the rest under half the smallest of them, us among them) holding >= half the land: bank for a MIRV at the biggest non-ally leader; 2 leaders and a shared border: MIRV it whenever the gold is there (no banking)
  mirvSpend: number; // >0 = while mirvSave banks, gold above a reserve still builds (AI structures, stackUp upgrades): the deadline is fixed when banking starts (0.8 x eta, endgame 10 min) and the reserve is MIRV (+silo) cost minus mirvSpend x income x the minutes left, so it rises to the full cost by the deadline
  stackUp: number; // >0 = City/Factory: upgrade the best one under our SAM cover (score: SAM levels covering it, then its level) instead of placing a new one; any upgradable one when gold >= stackUp x its cost or a new one finds no tile
  selfDiff: number; // 1 = the inherited Nation AI behaviours (attack timing, structures, upgrades, SAM ratio, warship tracking, nukes, alliances) always run with Impossible logic; the lobby difficulty only drives world rules (engine send caps, natWin, ally cap). Public lobbies are Medium, so without it the bot plays a Medium nation's build/upgrade logic
  craterPush: number; // >0 = for craterPush minutes after our MIRV lands, keep a land attack on its target topped up to 1.5x its troops (with a share of our spare troops) and send into free land beside us; floors still apply
  mirvDump: number; // >0 = while an enemy MIRV flies at our land (or split warheads would take >= half our troops), troops above mirvDump x maxTroops go into land now, floors skipped, but only into free land, non-allied tribes we outnumber 2x and players we outnumber 4x with the send (owner: anything else is suicide)
  samCluster: number; // >0 = SAMs only (no AI ratio SAMs) where our City/Port/Factory/Silo levels not yet under a SAM sum to >= samCluster within 0.8 SAM range, while a non-friend has a silo
  minKeep: number; // >0 = hard floor: no send of ours (attack or boat, kills included) leaves fewer than minKeep x maxTroops (+ incoming land attackers) home (owner 2026-10-14: "can bot never ever get below 20 percent max troop")
  wildSize: number; // >0 = an AI boat to unowned land carries wildSize x the troops its connected wilderness costs to take (sum of per-tile attacker losses), at least 200, never more than the AI chose; a wilderness over 4000 tiles keeps the AI size
  farAlly: number; // >0 = a player we don't border is no ally (no accept, renewal, ask or ally-bait boat) unless it can hurt us from afar (farThreat score >= 1, no single factor is enough: silo .5, gold for a hydrogen bomb +.5 / atom bomb +.25, nuked us +2, embargoes us +.5, each of our trade ships it captured in the last 10 min +.5, its boats at our land 5 x their troops / ours, strong +.5)
  humansOnly: number; // >0 = never ally AI Nations (no ask, accept or renewal; live play: "never ally with non-players")
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
  tribeFinish: number; // 1 = finish every tribe we attacked (top up the running attack to the kill), kill-steal any bordering tribe someone else attacks (allies too), hunt a bordering tribe once its kill fits; replaces tribeSteal
  finishFloor: number; // tribeFinish keeps max(reserve, finishFloor x defense floor) x maxTroops at home
  tribeCommit: number; // 1 = a tribe we attacked gets killed: its counter-push is answered with push + kill, and finish/top-up sends keep only max(minKeep, reserve, defense floor) home (not regenKeep/finishFloor)
  playerSteal: number; // >0 = steal the kill of a bordering non-friendly player/nation others are killing (very low: < 1/4 of our troops, or < 15% of its max and < 1/2 of ours, and attacked by others); the kill must fit in playerSteal x our troops and above max(minKeep, reserve, defense floor);
  //   allies only when they are traitors (alliance broken at the send), teammates never
  trigMax: number; // >0 = the attack trigger never needs more than this troop/max ratio (the defense floor then tops out at trigMax - 0.08); waiting for ~90% halves regen and idles the bot for minutes
  sendKeep: number; // >0 = on Hard/Impossible the inherited send cap keeps sendKeep (not 0.75/0.9) x the strongest non-friendly neighbour home
  regenKeep: number; // >0 = every tribe attack (Nation AI sends, boats, tribeFinish) keeps max(regenKeep, defense floor) x maxTroops at home; regen (10 + T^0.73/4)(1 - T/max) peaks near 0.42 max, ~94% of peak at 0.30, ~64% at 0.13
  structTarget: number; // >0 = Nation-AI player targets are compared by troops x front cover / (1 + structTarget x value of their cities/ports/factories, faded by attack reach through terrain and defense posts); the cheapest beatable one is hit (structures flip to us on capture)
  baitHuman: number; // >0 = snipeAlly ally-bait boats go to a human only if its troops <= baitHuman x ours (a refused bait boat dies and makes an enemy)
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
  nukeGate: number; // >0 = no nuke at a player not attacking us whose troops exceed nukeGate x ours (split2 rl768: nuking a 2.2x-stronger player drew the fatal reply)
  nukeProv: number; // 1 = nukeGate also blocks retaliation nukes (rl768: the 2.2x nuke was a reply to Imp11's attack and drew a 1.03M wave)
  earlySilo: number; // >0 = replay R08: first missile silo from this minute (gold saved for it once half-affordable), a second 3 min later
  counterNuke: number; // 1 = replay R09: an enemy nuke aimed within 30 tiles of our land gets a nuke back at its owner within 30 s (bypasses nukeGate)
  betrayOk: number; // >0 (needs betray 0) = situational betrayal (replay state study: victim weaker in 94%, strike within 30 s in 90%; AL-021): from betrayMin, break with a bordering human/Nation ally whose troops < betrayOk x ours and tiles < 0.7x ours, while we are not under real attack; the inherited AI attacks it at once. Never tribes or kin.
  betrayMin: number; // minutes before betrayOk may fire
  betrayGrade: number; // 1 = betrayOk uses the traitorK gates: victim strength incl. its local helpers, discounted non-ally threat guard (traitorThreat), leaving allies count as non-allies
  lapseStrike: number; // >0 = replay R10: when an alliance lapses, attack the bordering ex-ally within 60 s if its troops < lapseStrike x ours
  lapseGuard: number; // >0 = the lapse strike keeps lapseGuard x the summed threat (threatOf) of the other bordering non-allies at home
  nukeRisk: number; // >0 = AI attacks on a nuke-armed player (silo + gold for a bomb) not already attacking us need pvpReq x (1 + nukeRisk x arm x (1 - our SAMs / its silos)); arm 1 with hydrogen-bomb gold, 0.4 with atom-bomb gold only (nations nuke whoever attacks them first; v0.35 fin191: 2.1x wave into a silo nation -> H-bomb 2 s later, troops 3.7M->0.6M)
  nukeAlly: number; // >0 = a bordering nuke-armed player counts as "strong" (ally, renew, accept) from power ratio allyStrong / (1 + nukeAlly x arm x (1 - our SAMs / its silos)), arm as in nukeRisk (v0.35 H/I nations nuke + land-strike the strongest bordering non-friend; allies are exempt)
  samSave: number; // >0 (needs samCluster) = while a SAM is due (a silo-holding non-friend, cluster >= samCluster) but gold is short, the AI's other builds wait so gold reaches the SAM cost; defense posts still build; at most samSave minutes per SAM (v0.35 fin186: 0 SAM with 80 cities, cities kept gold < 1.5M, then nukes + MIRV)
  boxStrong: number; // >0 = boxFront: when no "ok" (< allyStrong) neighbour is left, the weakest bordering non-friend under boxStrong x our power may be the front (v0.35 fin193/fin180: all neighbours 0.7-1.1x, everyone allied, land flat 5-10 min)
  lapseCap: number; // >0 = lapse/traitor/expiry strikes keep troops out on attacks (incl. this send) <= lapseCap x our total army (v0.35 fin193: three ex-ally strikes of 55-70% left 22% home)
  siloGate: number; // >0 = no silo buy while (incoming troops + 0.5 x bordering non-ally threat) / our troops > siloGate (v0.35 fin1: 1M silos bought mid pile-on, 0 nukes sent)
  traitorK: number; // >0 = graded traitor strike (30 s debuff: attackers take 0.5x losses). Bordering non-tribe traitor whose troops x (1 - 0.5 busy) < traitorK x our troops above the reserve, while no stronger hostile borders us, incoming <= 0.3x ours and >= 10 s of debuff remain: one attack on the best such target (weakest ratio first). An ally who turned traitor passes the same gates before the free break. AFK neighbours use the same gate (no window).
  traitorThreat: number; // traitorK guard: hold while a bordering non-ally's discounted troops (x0.5 if a stronger non-ally of its own borders it, x(1 - 0.5 x its outgoing/troops)) exceed traitorThreat x ours
  expiryK: number; // traitorK: a bordering ally that let the alliance run out without renewing (allyWarn window) is hit right at expiry if eff < expiryK x our spare troops (0 = off)
  fixGap: number; // 1 = gap-audit fixes: nuke aim skips tiles whose outer blast holds our boats/warships; no alliance ask to a Nation whose relation to us is below Neutral (it always refuses)
  defPost: number; // 1 = preemptive defense posts on fronts facing a strong non-ally (threat >= defPostK x ours) or under land attack >= 0.25x ours; up to min(3, ceil(threat/ours)) per front
  defPostK: number;
  richTarget: number; // 1 = from 5:00, targets passing the ratio gate score richW x min(3, gold / max(our gold, next City cost)) more; veto a >=10M-gold silo owner unless troops >= 2x it
  richW: number;
  mirvBank: number; // 1 = bank gold for a MIRV (min >= 15 or land >= 25%, own silo, a rival >= 0.5x our land or the leader, incoming < 0.25x): save-up target = MIRV cost, then MIRV the rival and land-attack within 10 s if troops >= 1.22x its remaining
  boatStrike: number; // 1 = overseas strike at traitors / disconnected players, 2 = at any player (r054: 2 lost wins) (owner: "ignoring overseas traitor targets"; attacks graded on enemy max troops, regen and others hitting it). Every 3 s, with a free boat slot, < 0.3x ours incoming and < 0.3x ours already out: for a non-bordering human/Nation we can attack, need = 1.3 x (traitor 0.6) x (targetEff (others' attacks ease it, its helpers add) + its regen over boat travel + 15 s, slowing toward and capped at its max troops); only targets whose need <= our troops above max(homeKeep, defense floor) x maxT; score = its land / need x (traitor 1.5, its troops < 30% of its max 1.3) / (1 + travel/200); one boat of need to its nearest reachable coast; 60 s per target
  boatChain: number; // 1 = 10-30 s after opening a land attack on a human/Nation T (<= 0.8x our troops), boat 10-20% of our troops to a reachable T coast tile off our front; 1 per target per 60 s
  capBot: number; // >0 = stalled at the troop cap: sends at barbarians may use up to this fraction of our troops, ignoring the keep-0.9x-neighbour cap
  capPush: number; // >0 = stalled at the troop cap (>=95% max, no land gain for 30 s): pvpRatio drops to this vs a human others already hit
  renewLead: number; // >0 = send renewals only once <= renewLead seconds are left (inside the 30 s prompt window, so a late intent still lands in it); 0 = as soon as the window opens
  humanAccept: number; // 1 = graded accept of human requests (replay Q2): a traitor only if strong; a bordering human under 0.5x our tiles and not strong is room to grow, not an ally
  doomAware: number; // 1 = Doomsday Clock lobbies: when our land is (or within 60 s will be) under the bar and we are not the leader, grab land with the troops the drain would take anyway
  holdWin: number; // >0 = no new land attacks or boats before this many game minutes once our land share is within holdGap points of the win line (solo farm: XP pays 17 per game minute up to 30, so an early win forfeits it)
  holdGap: number; // percentage points under the win line where holdWin stops taking land
  holdBreak: number; // 1 = the first enemy MIRV aimed at our land ends the holdWin hold (win now); 0 = hold through it (solo XP counts minutes alive up to 30, the win adds only 15 raw)
  cityCap: number; // >0 = solo farm vs Easy nations: no City build/upgrade that takes our City levels over max(cityCap, 2 x the next player's - 1) (their steamroll MIRV fires at > 20 levels and >= 2x the second)
  medBreak: number; // >0 = Easy/Medium lobbies: hit a bordering Nation under 30% of its max troops (below every reserve ratio, so a Medium nation can't attack or retaliate) with up to medBreak x its troops
  medR: number; // medBreak target: a Nation under medR x its max troops (default 0.3, under every Medium reserve ratio of 30-39%)
  medDef: number; // >0 = Easy/Medium lobbies: in the defense floor a bordering Nation under 50% of its max (Medium trigger gate: it attacks on a 1-in-10 roll) counts medDef x its troops, under 30% half that
  natWin: number; // 1 = the early-game Nation ask limit (AL-027) lasts the Nations' own early-accept window for the lobby difficulty (Easy 5:00, Medium/Hard 3:00, Impossible 1:00 after spawn) instead of a flat 3:00
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
  wWater: 0,
  distCap: 120,
  defK: 0,
  defMin: 0,
  ally: 0,
  allyRange: 250,
  betray: 1,
  econ: 0,
  defCap: 0.9,
  defSum: 0,
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
  snipeSmall: 0,
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
  earlyCity: 0,
  earlyCityMin: 5,
  pirate: 0,
  pirateMax: 3,
  pirateRange: 400,
  pirateMin: 3,
  pirateKeep: 0.5,
  pirateEvery: 50,
  pirateSafe: 0.7,
  allyHumans: 0,
  allySelect: 0,
  allyVid: 0,
  allyHStrong: 0,
  allyStrong: 0.7,
  allyFood: 0.4,
  mirvSave: 0,
  mirvRich: 0,
  mirvPre: 0,
  mirvDuel: 0,
  samCluster: 0,
  mirvDump: 0,
  craterPush: 0,
  selfDiff: 0,
  mirvSpend: 0,
  stackUp: 0,
  wildSize: 0,
  killCap: 0,
  homeKeep: 0,
  minKeep: 0,
  postSpread: 0,
  farAlly: 0,
  humansOnly: 0,
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
  tribeFinish: 0,
  finishFloor: 0.6,
  tribeCommit: 0,
  playerSteal: 0,
  regenKeep: 0,
  trigMax: 0,
  sendKeep: 0,
  baitHuman: 0,
  structTarget: 0,
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
  nukeGate: 0,
  nukeProv: 0,
  earlySilo: 0,
  counterNuke: 0,
  lapseStrike: 0,
  lapseGuard: 0,
  nukeRisk: 0,
  nukeAlly: 0,
  samSave: 0,
  boxStrong: 0,
  lapseCap: 0,
  siloGate: 0,
  betrayOk: 0,
  betrayMin: 10,
  betrayGrade: 0,
  traitorK: 0,
  traitorThreat: 2.5,
  expiryK: 0.8,
  fixGap: 0,
  defPost: 0,
  defPostK: 1,
  richTarget: 0,
  richW: 0.5,
  mirvBank: 0,
  boatChain: 0,
  boatStrike: 0,
  capBot: 0,
  capPush: 0,
  renewLead: 0,
  humanAccept: 0,
  doomAware: 0,
  natWin: 0,
  holdWin: 0,
  holdGap: 8,
  holdBreak: 0,
  cityCap: 0,
  medBreak: 0,
  medR: 0.3,
  medDef: 0,
};

/** Frozen best set (base5, 2026-10-13: tuned core + every adopted arm), used by solo autoplay and the userscript. */
export const AUTOPLAY_PARAMS: BotParams = {
  ...DEFAULT_PARAMS,
  allyRange: 262, cExtra: 1.407, cFloor: 0.1, counterMax: 0.526, defCap: 0.816, defK: 1.054,
  defMin: 0.004, distCap: 127, expand: 0.276, rate: 14, trigger: 0.494,
  wDist: 1.155, wLand: 1.621, wTribe: 0.573, ally: 1, betray: 0, econ: 1, counter: 1,
  snipe: 1, cityPlace: 1,
  // base5 (sets_final.json)
  snipeWeak: 0.3, snipeAlly: 1, allySelect: 1, boxFront: 1, potW: 0.5, strikeExposed: 1,
  tribeCounter: 1, crownGate: 1, tribeSteal: 1, finishK: 0.05, warSnipe: 1, snipeBurst: 3,
  boatCounter: 1, landPush: 1, navy: 1, factLink: 1, portLake: 1, pvpRatio: 2, allyVid: 1,
  reserve: 0.13, nukeGate: 0.9, nukeProv: 1, lapseStrike: 0.8, earlyCity: 2, earlyCityMin: 3,
  traitorK: 1,
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

// selfDiff: the same game, but config().gameConfig().difficulty reads
// Impossible. Only the inherited behaviours see it (NationExecution builds
// them from the game passed to init); executions they add run on the real game.
function selfDiffGame(mg: Game): Game {
  const bind = <T extends object>(t: T, over: (k: PropertyKey) => unknown) => {
    // Bound methods are cached per function, not per name: the bot swaps
    // g.addExecution for a filtering wrapper every tick, and a name-keyed cache
    // kept the inherited AI on the first tick's wrapper for the whole game.
    const cache = new Map<PropertyKey, { v: unknown; f: unknown }>();
    return new Proxy(t, {
      get(target, k) {
        const o = over(k);
        if (o !== undefined) return o;
        const v = Reflect.get(target, k, target);
        if (typeof v !== "function") return v;
        let c = cache.get(k);
        if (c === undefined || c.v !== v) { c = { v, f: v.bind(target) }; cache.set(k, c); }
        return c.f;
      },
    });
  };
  let raw: unknown = null;
  let gc: any = null;
  const gameConfig = () => {
    const r = mg.config().gameConfig();
    if (r !== raw) { raw = r; gc = { ...r, difficulty: Difficulty.Impossible }; }
    return gc;
  };
  let cfgRaw: unknown = null;
  let cfgP: unknown = null;
  const config = () => {
    const c = mg.config();
    if (c !== cfgRaw) { cfgRaw = c; cfgP = bind(c as object, (k) => (k === "gameConfig" ? gameConfig : undefined)); }
    return cfgP;
  };
  return bind(mg, (k) => (k === "config" ? config : undefined));
}

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
    super.init(this.params.selfDiff > 0 ? selfDiffGame(mg) : mg);
    this.botGame = mg;
    const self = this as any;
    self.attackRate = Math.max(5, Math.round(this.params.rate));
    self.attackTick = 0;
    this.hookChat(mg); // inert while kin is 0 (UI can switch it on mid-game)
  }

  // Owner 2026-10-14: "the bot attack with all of its troops sometimes that is
  // really bad it must consider optimal troop growth rate for every attack or
  // defence". Every send of ours passes keepHome() first.
  tick(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    this.holding = me !== null && this.holdOn(me);
    if (((this.params.homeKeep <= 0 && this.params.minKeep <= 0) && !this.holding && this.params.cityCap <= 0) || me === null) {
      this.homePending = 0;
      return this.tickBody(ticks);
    }
    const g = this.botGame as any;
    const orig = g.addExecution;
    this.homePending = 0;
    this.nukeHold = this.nukeLoss(me);
    g.addExecution = (...exs: any[]) =>
      orig.apply(g, exs.filter((e) => !this.held(me, e) && !this.cityCapped(me, e) && this.keepHome(me, e)));
    try {
      this.tickBody(ticks);
    } finally {
      g.addExecution = orig;
    }
  }

  // holdWin (farm, owner 2026-10-15): solo XP is (50 + 17 per game minute up
  // to 30 + win) x 0.25, so a 12-minute win pays about 60 and one at 30
  // minutes about 144. Until holdWin minutes we take no more land once within
  // holdGap points of the win line; attacks already running finish.
  // v0.35 Easy nations MIRV the leader (farm sim e2: three MIRVs at 11.8-22.6
  // min while we held at the line, troops 43M -> 2M each time), so the first
  // MIRV aimed at us ends the hold for the rest of the game: win now (holdBreak 1).
  // Farm sims 2026-10-17 (World/Easy f3-f8): that MIRV is the steamroll one
  // (City levels > 20 and >= 2x the second), and the levels are mostly cities
  // captured from conquered nations (106-176 vs 28-79), which cityCap can't
  // stop; breaking the hold then won at 11.8-15.8 min (XP ~65 instead of
  // ~144). holdBreak 0 holds through the MIRV: troops drop to ~3% of max, but
  // the XP is in the minutes alive.
  public holding = false;
  public holdBlocked = 0;
  public holdBroken = false;
  private holdOn(me: Player): boolean {
    if (this.params.holdWin <= 0 || this.holdBroken) return false;
    const g = this.botGame;
    const sec = g.elapsedGameSeconds();
    if (sec >= this.params.holdWin * 60) return false;
    if (this.params.holdBreak > 0) for (const u of g.units(UnitType.MIRV, UnitType.MIRVWarhead)) {
      const t = u.targetTile();
      if (u.owner() !== me && t !== undefined && g.owner(t) === me) {
        this.holdBroken = true;
        return false;
      }
    }
    const land = g.numLandTiles() - g.numTilesWithFallout();
    const line = g.config().percentageTilesOwnedToWin(sec) - this.params.holdGap;
    // Team games are won on the team's land (WinCheckExecution.checkWinnerTeam).
    let tiles = me.numTilesOwned();
    const team = me.team();
    if (team !== null) {
      for (const p of g.players()) if (p !== me && p.team() === team) tiles += p.numTilesOwned();
    }
    return tiles * 100 >= land * line;
  }

  private held(me: Player, e: unknown): boolean {
    if (!this.holding) return false;
    const x = e as any;
    const mine =
      (e instanceof AttackExecution && x._owner === me) || (e instanceof TransportShipExecution && x.attacker === me);
    if (mine) this.holdBlocked++;
    return mine;
  }

  // v0.35 Easy nations MIRV the "steamroll" leader: City levels > 20 and >= 2x
  // the second player's (NationMIRVBehavior.selectSteamrollStopTarget; farm sim
  // f2: held at 72.7% land from min 8, MIRVed at 13, troops 34.8M -> 1.8M).
  // Staying under that keeps the farm hold alive; gold goes to the rest.
  public cityCapHits = 0;
  private cityCapped(me: Player, e: unknown): boolean {
    const cap = this.params.cityCap;
    if (cap <= 0) return false;
    const x = e as any;
    let add = 0;
    if (e instanceof ConstructionExecution && x.player === me && x.constructionType === UnitType.City) add = x.amount ?? 1;
    else if (e instanceof UpgradeStructureExecution && x.player === me &&
      me.units(UnitType.City).some((u) => u.id() === x.unitId)) add = x.amount ?? 1;
    if (add === 0) return false;
    let second = 0;
    for (const p of this.botGame.players()) if (p !== me) second = Math.max(second, p.unitCount(UnitType.City));
    const after = me.unitCount(UnitType.City) + add;
    if (after <= Math.max(cap, 2 * second - 1)) return false;
    this.cityCapHits++;
    return true;
  }

  public homeTrimmed = 0;
  public killCapped = 0;
  // Enemy nukes on their way to our land, for keepHome: `keep` is the share of
  // our troops an atom/hydrogen bomb leaves (it removes 5·troops/tiles per tile
  // it takes, from home and from our attacks alike, so sending doesn't save
  // them), `loss` what MIRV warheads take (up to 500 a tile). A bomb can land in
  // the same tick as our send, before it: World/Easy, a 22M send sized on the
  // pre-blast troops left 9% of max after an H-bomb (owner: never below 20%).
  private nukeHold = { keep: 1, loss: 0 };
  private nukeLoss(me: Player): { keep: number; loss: number } {
    const g = this.botGame;
    const T = Math.max(1, me.numTilesOwned());
    let keep = 1;
    let loss = 0;
    for (const u of g.units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRVWarhead)) {
      const t = u.targetTile();
      if (u.owner() === me || t === undefined || g.owner(t) !== me) continue;
      const m = g.config().nukeMagnitudes(u.type());
      // all of the inner circle and about half of the ring are taken
      const k = Math.min(T, (Math.PI * (m.inner * m.inner + m.outer * m.outer)) / 2);
      if (u.type() === UnitType.MIRVWarhead) loss += 500 * k;
      else {
        const q = 1 - k / T;
        keep *= q * q * q * q * q;
      }
    }
    return { keep: Math.max(keep, 0.05), loss };
  }
  // mirvDump. A MIRV at our land leaves us ~3% of max troops whatever we keep
  // home: each warhead tile takes up to 500 (nukeDeathFactor), from home, our
  // attacks and our boats alike, and its 350 warheads cover the target's land
  // (1500 range). Land already taken stays, so while one flies at us troops
  // above mirvDump x max go into land now. Owner 2026-10-14: "if enemy is very
  // vulnerable u can attack, but otherwise it will be suicide": free land,
  // non-allied tribes we outnumber 2x, players we outnumber 4x; floors skipped.
  public mirvDumps = 0;
  private dumping = false;
  private mirvIncoming(me: Player): boolean {
    const g = this.botGame;
    for (const u of g.units(UnitType.MIRV)) {
      const t = u.targetTile();
      if (u.owner() !== me && t !== undefined && g.owner(t) === me) return true;
    }
    // Already split: warheads that would take at least half our troops.
    return this.nukeLoss(me).loss >= 0.5 * me.troops();
  }
  private mirvDumpTick(me: Player) {
    const g = this.botGame;
    if (!me.isAlive() || g.inSpawnPhase() || !this.mirvIncoming(me)) return;
    const maxT = g.config().maxTroops(me);
    let avail = me.troops() - this.params.mirvDump * maxT - this.inflightTroops - this.homePending;
    if (avail < 1) return;
    const picks: { p: Player | null; need: number }[] = [];
    const free = this.freeLandNear(me);
    const weak: { p: Player; need: number }[] = [];
    for (const x of me.nearby()) {
      if (!x.isPlayer() || x === me || !me.sharesBorderWith(x)) continue;
      const p = x as Player;
      if (!p.isAlive() || me.isFriendly(p) || this.isFriend(me, p) || this.holdsAlly(me, p) || !me.canAttackPlayer(p)) continue;
      const need = (p.type() === PlayerType.Bot ? 2 : 4) * p.troops();
      if (need <= avail) weak.push({ p, need });
    }
    // Players first (cheapest first, each needs its full share), free land
    // takes the rest.
    weak.sort((a, b) => a.need - b.need);
    picks.push(...weak.slice(0, free ? 2 : 3));
    if (free) picks.push({ p: null, need: 0 });
    const n = picks.length;
    for (let i = 0; i < n && avail >= 1; i++) {
      const c = picks[i];
      const send = Math.floor(Math.max(avail / (n - i), c.need));
      if (send > avail || send < 1) continue;
      this.dumping = true;
      try {
        g.addExecution(new AttackExecution(send, me, c.p === null ? null : c.p.id()));
      } finally {
        this.dumping = false;
      }
      this.homePending += send;
      avail -= send;
      this.mirvDumps++;
    }
  }
  /** Unowned land next to a sample of our border tiles. */
  private freeLandNear(me: Player): boolean {
    const g = this.botGame;
    const border = [...me.borderTiles()];
    const step = Math.max(1, Math.floor(border.length / 200));
    for (let i = 0; i < border.length; i += step) {
      if (g.neighbors(border[i]).some((n) => g.isLand(n) && !g.isImpassable(n) && !g.hasOwner(n))) return true;
    }
    return false;
  }

  // craterPush. A MIRV leaves its target ~3% of its max troops, and its
  // fallout is free land: fin199 (2026-10-17) our MIRV broke Imp29 (166k ->
  // 7k tiles in 2.5 min) but our one 1.5x follow-up took little and our ally
  // Imp26 took the crater (62k -> 171k), then broke with us and won. For
  // craterPush minutes after impact: every 3 s keep our attack on the target
  // at 1.5x its troops plus 40% of our spare troops (above the reserve, in
  // flight and pending sends counted), and put a quarter of what is left into
  // free land beside us. keepHome still trims every send.
  public craterSends = 0;
  private craterR: Player | null = null;
  private craterUntil = -1;
  private craterAt = -1e9;
  private craterTick(me: Player, ticks: number) {
    const R = this.craterR;
    if (R === null) return;
    if (ticks > this.craterUntil || !R.isAlive() || !me.isAlive()) {
      this.craterR = null;
      return;
    }
    if (ticks - this.craterAt < 30) return;
    const g = this.botGame;
    const maxT = g.config().maxTroops(me);
    let avail = me.troops() - ((this as any).reserveRatio ?? this.params.reserve) * maxT - this.inflightTroops - this.homePending;
    if (avail < 1) return;
    let sent = false;
    if (me.sharesBorderWith(R) && !me.isFriendly(R) && me.canAttackPlayer(R)) {
      const out = me.outgoingAttacks().filter((a) => a.target() === R).reduce((s, a) => s + a.troops(), 0);
      const need = 1.5 * R.troops() + 1;
      if (out < need) {
        const send = Math.floor(Math.min(avail, Math.max(need - out, 0.4 * avail)));
        if (send >= 1 && out + send >= 0.5 * R.troops()) {
          g.addExecution(new AttackExecution(send, me, R.id()));
          this.homePending += send;
          avail -= send;
          sent = true;
          this.craterSends++;
        }
      }
    }
    if (avail >= 1 && !me.outgoingAttacks().some((a) => !a.target().isPlayer()) && this.freeLandNear(me)) {
      const send = Math.floor(0.25 * avail);
      if (send >= 1) {
        g.addExecution(new AttackExecution(send, me, null));
        this.homePending += send;
        sent = true;
        this.craterSends++;
      }
    }
    if (sent) this.craterAt = ticks;
  }

  public homeHeld = 0;
  private homePending = 0;
  // Troops of our sends that are still on their way to the game (a client
  // plays through intents that land a few ticks later; set by the userscript
  // each tick). Until they land me.troops() still counts them, so without
  // this every tick re-spent the same troops and the game, which caps a send
  // at what is left, took the bot down to ~1% of max troops (World/Easy).
  public inflightTroops = 0;
  // Our defense posts sent as build intents that aren't on the map yet (set
  // by the userscript each tick). Until they land the AI sees no post there,
  // so it placed the next one beside it (live 0.5.3: three posts stacked).
  public pendingPosts: TileRef[] = [];
  private postTiles(me: Player): TileRef[] {
    return [...me.units(UnitType.DefensePost).map((u) => u.tile()), ...this.pendingPosts];
  }
  // Owner 2026-10-14: "it sometimes defence posts onto each other, if 2 defence
  // posts protection intersects it doesnt make that 10x slowth".
  private patchPostSpread(sb: any) {
    sb.__spread = true;
    if (typeof sb.findDefensePostTile === "function") {
      // v0.35: the AI itself skips tiles within 1.5 post ranges of built posts;
      // ours also keeps the pending ones (and a wider spread) apart.
      const find = sb.findDefensePostTile.bind(sb);
      sb.findDefensePostTile = (front: TileRef[], minDist: number, maxDist: number): TileRef | null => {
        const t: TileRef | null = find(front, minDist, maxDist);
        if (t === null) return null;
        const g = this.botGame;
        const r = this.params.postSpread * g.config().defensePostRange();
        return this.postTiles(sb.player).every((p) => g.euclideanDistSquared(t, p) >= r * r) ? t : null;
      };
      const count = sb.countDefensePostsNearFront.bind(sb);
      sb.countDefensePostsNearFront = (front: TileRef[], range: number, cap?: number): number => {
        let n: number = count(front, range, cap);
        if (this.pendingPosts.length === 0 || front.length === 0 || (cap !== undefined && n >= cap)) return n;
        const g = this.botGame;
        for (const p of this.pendingPosts) {
          if (front.some((t) => g.euclideanDistSquared(t, p) <= range * range)) n++;
        }
        return cap === undefined ? n : Math.min(n, cap);
      };
      return;
    }
    if (typeof sb.sampleTilesNearFront !== "function") return;
    const orig = sb.sampleTilesNearFront.bind(sb);
    sb.sampleTilesNearFront = (front: TileRef[], count: number, type: UnitType): TileRef[] => {
      const out: TileRef[] = orig(front, count, type);
      if (type !== UnitType.DefensePost) return out;
      const g = this.botGame;
      const me: Player = sb.player;
      const r = this.params.postSpread * g.config().defensePostRange();
      const posts = this.postTiles(me);
      return out.filter((t) => posts.every((p) => g.euclideanDistSquared(t, p) >= r * r));
    };
    // The AI's post count per front (its cap is ceil(threat / 0.4) posts)
    // counts the pending ones too, with the AI's own reach (1.5 border spacings).
    if (typeof sb.countDefensePostsNearFront !== "function") return;
    const count = sb.countDefensePostsNearFront.bind(sb);
    sb.countDefensePostsNearFront = (front: TileRef[], cap?: number): number => {
      let n: number = count(front, cap);
      if (this.pendingPosts.length === 0 || front.length === 0 || (cap !== undefined && n >= cap)) return n;
      const g = this.botGame;
      const reach = 1.5 * (sb.spacingConstants?.().borderSpacing ?? g.config().defensePostRange());
      for (const p of this.pendingPosts) {
        if (front.some((t) => g.euclideanDistSquared(t, p) <= reach * reach)) n++;
      }
      return cap === undefined ? n : Math.min(n, cap);
    };
  }

  /** Trims (or holds) a send of ours so the regen/defense home keep stays. */
  private keepHome(me: Player, e0: unknown): boolean {
    if (this.dumping) return true; // mirvDump sized it already
    const e = e0 as any;
    let field: "startTroops" | "troops";
    let target: Player | null = null;
    const g = this.botGame;
    if (e0 instanceof AttackExecution) {
      const x = e;
      if (x._owner !== me || x.removeTroops === false || typeof x.startTroops !== "number") return true;
      field = "startTroops";
      if (x._targetID !== null && g.hasPlayer(x._targetID)) target = g.player(x._targetID);
    } else if (e0 instanceof TransportShipExecution) {
      const x = e;
      if (x.attacker !== me || typeof x.troops !== "number") return true;
      field = "troops";
      const o = g.owner(x.ref);
      if (o.isPlayer()) target = o as Player;
    } else return true;
    if (typeof (me as any).inDoomsdayClock === "function" && (me as any).inDoomsdayClock() === true) return true;
    const send: number = e[field];
    if (!(send > 0)) return true;
    const maxT = g.config().maxTroops(me);
    let incoming = 0;
    for (const a of me.incomingAttacks()) if (a.attacker() !== target) incoming += a.troops();
    // tribeCommit: a tribe we already attacked keeps only the kill floor too (we finish it).
    const kill = target !== null && ((send >= 2 * target.troops() && target.numTilesOwned() < 0.2 * me.numTilesOwned()) ||
      (this.params.tribeCommit > 0 && target.type() === PlayerType.Bot && this.finTribes.has(target.id())));
    const self = this as any;
    const floor = self.reserveRatio ?? this.params.reserve;
    const full = Math.max(this.params.minKeep, this.params.homeKeep, floor);
    // With a bomb on its way the floor must hold whether it lands before our
    // send (the game then caps the send at what's left) or after it.
    const nk = this.nukeHold;
    const T = me.troops();
    const room = (frac: number) => {
      const base = nk.keep < 1 ? Math.min(T * nk.keep - frac * maxT, T - (frac * maxT) / nk.keep) : T - frac * maxT;
      return base - this.homePending - this.inflightTroops - nk.loss - incoming;
    };
    let avail = room(kill ? Math.max(this.params.minKeep, floor) : full);
    if (kill && this.params.killCap > 0 && target !== null && target.type() !== PlayerType.Bot) {
      const capped = Math.max(room(full), Math.min(avail, this.params.killCap * target.troops()));
      if (capped < avail && capped < send) this.killCapped++;
      avail = capped;
    }
    if (avail >= send) {
      this.homePending += send;
      return true;
    }
    if (avail < 1 || avail < 0.5 * send) {
      this.homeHeld++;
      return false;
    }
    e[field] = Math.floor(avail);
    this.homePending += e[field];
    this.homeTrimmed++;
    return true;
  }

  private tickBody(ticks: number) {
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
    if (this.params.tribeFinish > 0) { if (ticks % 10 === 0) this.tribeFinish(ticks); }
    else if (this.params.tribeSteal > 0 && ticks % 10 === 0) this.tribeSteal(ticks);
    if (this.params.playerSteal > 0 && ticks % 10 === 5) this.playerSteal(ticks);
    if (this.params.medBreak > 0 && ticks % 10 === 1) this.medBreak(ticks);
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
      if (this.params.betrayOk > 0) this.patchBetrayOk(self.allianceBehavior);
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
    if (this.params.earlyCity > 0 && sb && !sb.__early) this.patchEarlyCity(sb);
    if (this.params.postSpread > 0 && sb && !sb.__spread) this.patchPostSpread(sb);
    if (this.params.earlySilo > 0 && sb && !sb.__silo) this.patchSilo(sb);
    if (this.params.siloGate > 0 && sb && !sb.__siloGate) this.patchSiloGate(sb);
    if (this.params.samCluster > 0 && sb && !sb.__sam) this.patchSam(sb);
    if (this.params.samCluster > 0 && ticks % 50 === 7 && self.player) this.samClusterTick(self.player);
    if (this.params.counterNuke > 0 && ticks % 10 === 1) this.counterNukeTick(ticks);
    if (this.params.lapseStrike > 0 && ticks % 10 === 2) this.lapseStrikeTick(ticks);
    if (this.params.farAlly > 0 && ticks % 5 === 1 && self.player) this.trackPiracy(self.player, ticks);
    if (this.params.traitorK > 0 && ticks % 10 === 3) this.traitorStrikeTick(ticks);
    if ((this.params.mirvBank > 0 || this.params.mirvSave > 0) && ticks % 10 === 4) this.mirvBankTick(ticks);
    if (this.params.mirvSave > 0 && !self.__mirvLock && self.structureBehavior) this.patchMirvLock(self);
    if (this.params.stackUp > 0 && sb && !sb.__stack) this.patchStack(sb);
    if (this.params.boatChain > 0 && ticks % 10 === 5) this.boatChainTick(ticks);
    if (this.params.boatStrike > 0 && ticks % 30 === 11) this.boatStrikeTick(ticks);
    if (this.params.defPost > 0 && ticks % 50 === 6) this.defPostTick();
    if (this.params.doomAware > 0 && ticks % 10 === 8) this.doomTick(ticks);
    if (this.params.mirvDump > 0 && ticks % 5 === 3 && self.player) this.mirvDumpTick(self.player);
    if (this.params.craterPush > 0 && ticks % 10 === 6 && self.player) this.craterTick(self.player, ticks);
    if (this.params.pirate > 0 && ticks % Math.max(10, Math.round(this.params.pirateEvery)) === 0) this.pirate();
    // Late game: restore nuke/SAM saving (instance props shadow the prototype).
    if (sb && sb.__econ && !sb.__econOff && this.params.econUntil > 0 &&
        ticks >= this.params.econUntil * 600) {
      delete sb.getSaveUpTarget;
      delete sb.isInPostSaveUpBlockedPhase;
      sb.__econOff = true;
    }
    if (this.params.wildSize > 0 && self.player) this.sizedTick(self.player, ticks);
    else super.tick(ticks);
  }

  // Owner 2026-10-14: "it jsut sat there having max troops and send 100k boat
  // to wolderness". The Nation AI sizes wilderness boats at troops/5. The
  // wilderness a boat lands in costs only its tiles' attacker losses (mag/5:
  // plains 16, highland 20, mountain 24 a tile), so the rest stays home.
  public wildTrimmed = 0;
  private sizedTick(me: Player, ticks: number) {
    const g = this.botGame as any;
    const orig = g.addExecution;
    g.addExecution = (...exs: any[]) => {
      for (const e of exs) {
        if (!(e instanceof TransportShipExecution)) continue;
        const x = e as any;
        if (x.attacker !== me || this.botGame.hasOwner(x.ref) || !this.botGame.isLand(x.ref) || this.botGame.isImpassable(x.ref)) continue;
        const need = this.wildNeed(x.ref);
        if (need !== null && need < x.troops) { x.troops = need; this.wildTrimmed++; }
      }
      return orig.apply(g, exs);
    };
    try {
      super.tick(ticks);
    } finally {
      g.addExecution = orig;
    }
  }
  /** Troops to take the unowned land connected to t (null = over 4000 tiles). */
  private wildNeed(t: TileRef): number | null {
    const g = this.botGame;
    const map = g.map();
    const seen = new Set<TileRef>([t]);
    const queue: TileRef[] = [t];
    let cost = 0;
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      const k = map.terrainType(c);
      cost += k === TerrainType.Mountain ? 24 : k === TerrainType.Highland ? 20 : 16;
      if (queue.length > 4000) return null;
      for (const n of map.neighbors(c)) {
        if (seen.has(n) || !map.isLand(n) || map.isImpassable(n) || g.hasOwner(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return Math.max(200, Math.ceil(this.params.wildSize * cost));
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

  // Early economy (rich1 split-seed study, replay study): games we win own >= 3
  // cities by minute 4-5 and one early port. Until then every build goes to a
  // city (one port right after the first city if coastal); gold is saved for
  // the next city instead of factories/SAMs/silos.
  private patchEarlyCity(sb: any) {
    const g = this.botGame;
    const orig = sb.doHandleStructures.bind(sb);
    sb.doHandleStructures = () => {
      const me: Player = sb.player;
      const cities = me.unitsOwned(UnitType.City);
      if (g.ticks() >= this.params.earlyCityMin * 600 || cities >= this.params.earlyCity ||
          g.config().isUnitDisabled(UnitType.City)) return orig();
      sb.reachableStationsCache = null;
      sb._sharedWaterComponents = g.sharedWaterComponents(me);
      if (cities >= 1 && me.unitsOwned(UnitType.Port) === 0 && sb._sharedWaterComponents !== null &&
          !g.config().isUnitDisabled(UnitType.Port)) return sb.maybeSpawnStructure(UnitType.Port);
      return sb.maybeSpawnStructure(UnitType.City);
    };
    sb.__early = true;
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
          if (!g.isLand(n) || g.isImpassable(n)) continue;
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

  // humansOnly applies only while another human is in the game: in a solo
  // game (us vs Nations only) refusing every Nation got the bot ganged up on
  // and killed by minute 5 in 6 of 8 World/Impossible test runs (2/8 alive vs 7/8).
  private humansSeen: boolean | null = null;
  private humansAt = -1e9;
  private humansOnlyOn(me: Player): boolean {
    if (this.params.humansOnly <= 0) return false;
    const t = this.botGame.ticks();
    if (this.humansSeen === null || t - this.humansAt >= 300) {
      this.humansSeen = this.botGame.players().some((p) => p !== me && p.type() === PlayerType.Human);
      this.humansAt = t;
    }
    return this.humansSeen;
  }
  /** "strong" = threat worth allying, "food" = weak neighbor we'd rather eat. */
  private allyKind(me: Player, o: Player): "strong" | "food" | "ok" {
    if (o.type() === PlayerType.Bot) return "food";
    // Owner 2026-10-14: "never ally with non-players".
    if (o.type() === PlayerType.Nation && this.humansOnlyOn(me)) return "food";
    // Owner 2026-10-14: "allying far players doesnt benefit at all, only do if
    // all political sitations fit and if they have a silo or pirating us".
    // Checked before "strong": a far player without silo, piracy or boats
    // can't reach us however big it is (the rest of the ally logic still decides).
    if (this.params.farAlly > 0 && !me.sharesBorderWith(o) && this.farThreat(me, o) < 1) return "food";
    const ratio = this.power(o) / Math.max(1, this.power(me));
    if (ratio >= this.params.allyStrong) return "strong";
    // nukeAlly: v0.35 Hard/Impossible nations nuke the strongest bordering
    // non-friend and land-strike after the bomb; an alliance takes us off that list.
    if (this.params.nukeAlly > 0 && me.sharesBorderWith(o) &&
        ratio >= this.params.allyStrong / (1 + this.params.nukeAlly * this.nukeExposure(me, o))) return "strong";
    if (ratio < this.params.allyFood && me.sharesBorderWith(o)) return "food";
    return "ok";
  }

  // Trade ship captures, seen as owner changes (the "trade ship captured"
  // messages): last tick we took one of o's ships, ticks o took ours (last 10 min);
  // nukes of anyone aimed within 30 tiles of our land.
  private shipOwner = new Map<number, Player>();
  private piracy = new Map<Player, { byUs: number; byThem: number[] }>();
  private trackPiracy(me: Player, ticks: number) {
    const now = new Map<number, Player>();
    for (const u of this.botGame.units(UnitType.TradeShip)) {
      const o = u.owner();
      const was = this.shipOwner.get(u.id());
      if (was !== undefined && was !== o && (o === me || was === me)) {
        const other = o === me ? was : o;
        const r = this.piracy.get(other) ?? { byUs: -1e9, byThem: [] };
        if (o === me) r.byUs = ticks;
        else r.byThem.push(ticks);
        r.byThem = r.byThem.filter((t) => ticks - t <= 6000);
        this.piracy.set(other, r);
      }
      now.set(u.id(), o);
    }
    this.shipOwner = now;
    for (const u of this.botGame.units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV)) {
      const t = u.targetTile();
      if (u.owner() !== me && t !== undefined && this.landNear(me, t, 30)) this.nukedUs.add(u.owner());
    }
  }
  private nukedUs = new Set<Player>();
  /**
   * How much a player we don't border can hurt us from afar. Owner 2026-10-14:
   * "just having 1 silo is etc is not a good reason ... i mean by itself only".
   */
  private farThreat(me: Player, o: Player): number {
    const g = this.botGame;
    let score = 0;
    if (o.unitCount(UnitType.MissileSilo) > 0) {
      score += 0.5;
      const gold = o.gold();
      if (!g.config().isUnitDisabled(UnitType.HydrogenBomb) && gold >= g.unitInfo(UnitType.HydrogenBomb).cost(g, o)) score += 0.5;
      else if (!g.config().isUnitDisabled(UnitType.AtomBomb) && gold >= g.unitInfo(UnitType.AtomBomb).cost(g, o)) score += 0.25;
    }
    // Owner 2026-10-14: "having nuked us must have more weight, or embargoed us".
    if (this.nukedUs.has(o)) score += 2;
    if (o.hasEmbargoAgainst(me)) score += 0.5;
    const r = this.piracy.get(o);
    if (r !== undefined) score += 0.5 * r.byThem.filter((t) => g.ticks() - t <= 6000).length;
    let boats = 0;
    for (const u of o.units(UnitType.TransportShip)) {
      const t = u.targetTile();
      if (t !== undefined && g.owner(t) === me) boats += u.troops();
    }
    score += (5 * boats) / Math.max(1, me.troops());
    if (this.power(o) >= this.params.allyStrong * this.power(me)) score += 0.5;
    return score;
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
    if (o.type() === PlayerType.Nation && this.humansOnlyOn(me)) return null; // "lead" never overrides humansOnly
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
      const top2 = this.params.allyVid > 0 && g.elapsedGameSeconds() >= 300 ? this.topTwo(me) : [];
      for (const req of reqs) {
        const k = this.allyKind(me, req.requestor());
        const e = this.endKind(me, req.requestor());
        const leader = req.requestor().type() === PlayerType.Human && top2.includes(req.requestor());
        if (req.requestor() !== front && e !== "rival" && !leader && !this.humanNo(me, req.requestor(), k, e) &&
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
      if (this.renewDue(a, ticks) && !a.agreedToExtend(me)) {
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
      .filter((o) => o !== me && (o.type() === PlayerType.Nation || (o.type() === PlayerType.Human && this.askHuman(me, o))))
      .filter((o) => !me.isAlliedWith(o) && me.canSendAllianceRequest(o))
      // fixGap: a Nation below Neutral towards us always refuses; asking only burns the cooldown.
      .filter((o) => this.params.fixGap <= 0 || o.type() !== PlayerType.Nation || o.relation(me) >= Relation.Neutral)
      .sort((a, b) => b.troops() - a.troops());
    const vid = this.params.allyVid > 0;
    const min = g.elapsedGameSeconds() / 60;
    const top2 = vid && min >= 5 ? this.topTwo(me) : null;
    let nat = me.alliances().filter((a) => a.other(me).type() === PlayerType.Nation).length;
    for (const o of cands) {
      const e = this.endKind(me, o);
      if (e === "rival") continue;
      const k = e === "lead" ? "strong" : this.allyKind(me, o);
      if (k === "food" || o === front) continue;
      const human = o.type() === PlayerType.Human;
      if (top2?.includes(o) && human) continue; // AL-018: never ally #1/#2 after ~5:00
      // AL-027: vs Nations before 3:00 ask only strong ones, at most 2.
      if (vid && !human && this.natEarly(min) && (k !== "strong" || nat >= 2)) continue;
      // AL-016: a human hitting us, or hit by someone else, gets asked even if not near / over the cap.
      const hot = vid && human && (me.incomingAttacks().some((a) => a.attacker() === o) ||
        o.incomingAttacks().some((a) => a.attacker() !== me && a.attacker().type() !== PlayerType.Bot));
      const st = o.spawnTile();
      const near = me.sharesBorderWith(o) ||
        (mySpawn !== undefined && st !== undefined && map.euclideanDistSquared(mySpawn, st) <= r2);
      if (k !== "strong" && !hot && (!near || n >= cap)) continue;
      const log = this.asks.get(o.id());
      if (log !== undefined && ticks < log.next) continue;
      // At war, winning ground, and nobody else threatening: keep pushing
      // instead of asking. A stalled war (nothing to gain) may end in an alliance.
      if (k !== "strong" && this.params.warSnipe > 0 && me.outgoingAttacks().some((a) => a.target() === o) &&
          this.warOk(me, o) && this.gaining(o)) continue;
      if (asked >= 2) break;
      const tries = (log?.n ?? 0) + 1;
      // AL-014/AL-002: humans say no early and yes later -> re-ask every 30-120 s (vid), else 30 s..8 min.
      const wait = vid && human ? 300 * Math.min(tries, 4) : 300 * 2 ** Math.min(tries - 1, 4);
      this.asks.set(o.id(), { n: tries, next: ticks + wait });
      g.addExecution(new AllianceRequestExecution(me, o.id()));
      if (!human) nat++;
      n++;
      asked++;
    }
    for (const a of me.alliances()) this.asks.delete(a.other(me).id());
  }
  private asks = new Map<string, { n: number; next: number }>();
  /** Renewal due: inside the prompt window, and with renewLead only in its last renewLead seconds. */
  private renewDue(a: { expiresAt(): number }, ticks: number): boolean {
    const off = this.botGame.config().allianceExtensionPromptOffset();
    const lead = this.params.renewLead > 0 ? Math.min(off, Math.round(this.params.renewLead * 10)) : off;
    return a.expiresAt() - ticks <= lead;
  }
  /** humanAccept: refuse this human's request (traitor not strong; bordering, under half our land, not strong). */
  private humanNo(me: Player, o: Player, k: string, e: string | null): boolean {
    if (this.params.humanAccept <= 0 || o.type() !== PlayerType.Human || e === "lead" || k === "strong") return false;
    if (o.isTraitor()) return true;
    return me.sharesBorderWith(o) && o.numTilesOwned() < 0.5 * me.numTilesOwned();
  }
  /** AL-027 window: flat 3:00, or with natWin the Nations' early-accept window for the difficulty. */
  private natEarly(min: number): boolean {
    if (this.params.natWin <= 0) return min < 3;
    const g = this.botGame;
    const win = { [Difficulty.Easy]: 3000, [Difficulty.Medium]: 1800, [Difficulty.Hard]: 1800, [Difficulty.Impossible]: 600 }[g.config().gameConfig().difficulty] ?? 1800;
    return g.ticks() < win + g.config().numSpawnPhaseTurns();
  }
  /** The two biggest other players by land. */
  private topTwo(me: Player): Player[] {
    return this.botGame.players()
      .filter((p) => p !== me && p.isAlive() && p.type() !== PlayerType.Bot)
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
      .slice(0, 2);
  }
  /** allyHumans: every near human. allyHStrong: only a bordering human that is a threat (strong) or is attacking us (split2: our killers were the winners' allies). */
  private askHuman(me: Player, o: Player): boolean {
    if (this.params.allyHumans > 0 || this.params.allyVid > 0) return true;
    if (this.params.allyHStrong <= 0 || !me.sharesBorderWith(o)) return false;
    return this.allyKind(me, o) === "strong" || me.incomingAttacks().some((a) => a.attacker() === o);
  }

  // Boxed in: every neighbor is an ally or a threat, no wilderness or tribe
  // left to take. Allying everyone around us ends our growth (players then
  // out-grow us), so one neighbor that is no threat (< allyStrong x our
  // troops) stays un-allied as the expansion front: no accept, no renewal, no
  // ask (an alliance with it lapses; no betrayal). Weakest first, then one
  // already hit by others, then one not allied now. Kept for 2 min unless it
  // turns strong or we have room again.
  private front: Player | null = null;
  private frontAt = -1e9;
  public boxStrongPicks = 0;
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
    // Boxed by equals: with no "ok" neighbour, a bordering one under boxStrong x
    // our power may be the front, so one alliance lapses instead of none.
    const anyOk = players.some(ok);
    const okBox = (p: Player) =>
      ok(p) || (!anyOk && this.params.boxStrong > 0 && p.isAlive() && players.includes(p) && me.sharesBorderWith(p) &&
        this.power(p) < this.params.boxStrong * this.power(me));
    if (this.front !== null && okBox(this.front) && ticks - this.frontAt < 1200) return this.front;
    let best: Player | null = null;
    let bestS = Infinity;
    for (const p of players) {
      if (!okBox(p)) continue;
      const hit = p.incomingAttacks().some((a) => a.attacker() !== me);
      const s = this.power(p) / Math.max(1, this.power(me)) - (hit ? 0.2 : 0) - (me.isAlliedWith(p) ? 0 : 0.1);
      if (s < bestS) { bestS = s; best = p; }
    }
    if (best !== this.front) {
      this.frontAt = ticks;
      if (best !== null && !ok(best)) this.boxStrongPicks++;
    }
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

  // Gray bots (tribes), user live report 2026-10-14: "attacked gray bots and
  // didnt finished them", "didnt tried to steal gray bot kills", "waits like 80
  // percent to attack its first gray bot". A kill hands us the tribe's land and
  // gold stash (GameImpl.conquerPlayer; tribes earn 50 gold/tick); a half-eaten
  // tribe gives neither. The Nation AI only attacks at the trigger ratio
  // (defense floor + .08, so .8-.9 early) and sends 4x the tribe's troops,
  // whatever its size. Every 10 ticks, at most one send, in this order:
  //  1. steal: a bordering tribe someone else attacks (allies too);
  //  2. finish: a tribe we attacked that still lives (a top-up merges into the
  //     running land attack, AttackExecution.init);
  //  3. hunt: the cheapest bordering tribe whose whole kill fits.
  // Graded: the budget keeps finishFloor x the defense floor (strongest
  // neighbour vs us) at home and nothing goes out while players hit us hard.
  private finTribes = new Map<string, number>(); // tribe id -> last tick we attacked it
  private finSent = new Map<string, number>();
  public fin = { steal: 0, finish: 0, topup: 0, hunt: 0, first: -1 };
  private tribeFinish(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    const cur = new Map<string, number>();
    for (const a of me.outgoingAttacks()) {
      const t = a.target();
      if (!t.isPlayer() || (t as Player).type() !== PlayerType.Bot) continue;
      const id = (t as Player).id();
      this.finTribes.set(id, ticks);
      cur.set(id, (cur.get(id) ?? 0) + a.troops());
      if (this.fin.first < 0) this.fin.first = ticks;
    }
    const troops = me.troops();
    let hit = 0;
    for (const a of me.incomingAttacks()) if (a.attacker().type() !== PlayerType.Bot) hit += a.troops();
    if (hit > 0.3 * troops) return;
    const maxT = g.config().maxTroops(me);
    const floor = Math.max(this.params.reserve, this.params.regenKeep, this.params.finishFloor * (self.reserveRatio ?? this.params.reserve));
    const budget0 = troops - floor * maxT - hit;
    // tribeCommit (owner 2026-10-16: "if bot starts killing a gray bot it should
    // kill it"): a tribe we attacked is finished from the lower commit floor.
    const budgetC = this.params.tribeCommit > 0 ? troops - this.commitFloor(me) * maxT - hit : budget0;
    if (Math.max(budget0, budgetC) <= 0) return;
    let best: { o: Player; send: number; rank: number; kind: "steal" | "finish" | "topup" | "hunt" } | null = null;
    for (const n of me.nearby()) {
      if (!n.isPlayer()) continue;
      const o = n as Player;
      if (o.type() !== PlayerType.Bot || !o.isAlive() || me.isFriendly(o) || !me.sharesBorderWith(o)) continue;
      if (ticks - (this.finSent.get(o.id()) ?? -1e9) < 20) continue;
      const need = this.killSend(o);
      if (need > 0.9 * maxT) continue; // too big to kill at all: the usual chunk attacks eat it
      const running = cur.get(o.id()) ?? 0;
      const others = o.incomingAttacks().some((a) => a.attacker() !== me);
      const ours = this.finTribes.has(o.id());
      const budget = running > 0 || ours ? Math.max(budget0, budgetC) : budget0;
      if (budget <= 0) continue;
      let send = 0;
      let kind: "steal" | "finish" | "topup" | "hunt" = "hunt";
      if (running > 0) {
        // Running attack short of the kill: add the gap (others' attacks thin it too).
        const gap = need - running;
        if (running >= 0.8 * need || gap < Math.max(0.02 * maxT, 0.25 * need)) continue;
        send = Math.min(budget, gap);
        if (send < 0.25 * gap) continue;
        kind = "topup";
      } else if (others || ours) {
        // A partial send still eats it; the next pass tops it up.
        send = Math.min(budget, need);
        if (send < 0.5 * need || send < o.troops()) continue;
        kind = others ? "steal" : "finish";
      } else {
        if (need > budget) continue;
        send = need;
      }
      const rank = (others ? 3 : ours ? 2 : 1) * 1e12 - need;
      if (best === null || rank > best.rank) best = { o, send, rank, kind };
    }
    if (best === null) return;
    this.finSent.set(best.o.id(), ticks);
    this.finTribes.set(best.o.id(), ticks);
    this.fin[best.kind]++;
    if (this.fin.first < 0) this.fin.first = ticks;
    g.addExecution(new AttackExecution(Math.ceil(best.send), me, best.o.id()));
  }

  private commitFloor(me: Player): number {
    return Math.max(this.params.minKeep, this.params.reserve, (this as any).reserveRatio ?? this.params.reserve);
  }

  // Player/nation kill-steal (owner 2026-10-16: "it must also steal any
  // player/nation kills from enemeis ... if its vulnerable. it shouldnt betray
  // jsut to steal a kill"). Whoever's attack takes a player under 100 tiles
  // annexes the rest and gets its gold (AttackExecution.handleDeadDefender,
  // GameImpl.conquerPlayer). Every 10 ticks, at most one send, to a bordering
  // non-friendly player (teammates never; allies only when they are traitors
  // themselves; a former ally that broke with us is fair game) that others attack and whose troops are very low
  // (< 1/4 of ours, or < 15% of its max while < 1/2 of ours). The send is the whole kill (killSend, player loss model), a top-up if
  // our attack already runs; it must fit in playerSteal x our troops, above the
  // commit floor + incoming, and in homeRoom (strongest other bordering player).
  private pSent = new Map<string, number>();
  public pSteals = 0;
  private playerSteal(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    const troops = me.troops();
    const inc = me.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    if (inc > 0.3 * troops) return;
    const maxT = g.config().maxTroops(me);
    const budget = Math.min(troops - this.commitFloor(me) * maxT - inc, this.params.playerSteal * troops);
    if (budget <= 0) return;
    let best: { o: Player; send: number; need: number } | null = null;
    for (const n of me.nearby()) {
      if (!n.isPlayer()) continue;
      const o = n as Player;
      if (o.type() === PlayerType.Bot || !o.isAlive() || !me.sharesBorderWith(o) || me.isOnSameTeam(o)) continue;
      // An ally only when it is a traitor itself (owner 2026-10-16: "current allies but
      // betrayed someone is also eligable"); we break the alliance at the send.
      if (me.isFriendly(o) && !(me.isAlliedWith(o) && o.isTraitor())) continue;
      // Very low: under a quarter of us, or under 15% of its own max (owner 2026-10-16:
      // "if an enemy or betrayed ally gets very low on troops and gets attacked").
      if (o.troops() > 0.5 * troops || (o.troops() > 0.25 * troops && o.troops() > 0.15 * g.config().maxTroops(o))) continue;
      if (ticks - (this.pSent.get(o.id()) ?? -1e9) < 30) continue;
      let hitO = 0;
      for (const a of o.incomingAttacks()) if (a.attacker() !== me) hitO += a.troops();
      if (hitO <= 0) continue;
      const need = this.killSend(o);
      const running = me.outgoingAttacks().filter((a) => a.target() === o).reduce((s, a) => s + a.troops(), 0);
      if (running >= 0.8 * need) continue;
      const send = need - running;
      if (send > budget || send > this.homeRoom(me, o)) continue;
      if (best === null || need < best.need) best = { o, send, need };
    }
    if (best === null) return;
    this.pSent.set(best.o.id(), ticks);
    if (me.isAlliedWith(best.o)) {
      const a = me.allianceWith(best.o);
      if (a) me.breakAlliance(a);
    }
    if (!me.canAttackPlayer(best.o)) return;
    this.pSteals++;
    g.addExecution(new AttackExecution(Math.ceil(best.send), me, best.o.id()));
  }

  // Easy/Medium lobbies (v0.35 AiAttackBehavior.attackBestTarget): under its
  // reserve ratio (30-39% of max at every difficulty) a nation only attacks
  // tribes that hold structures, and Medium retaliates only after that gate.
  // Under its trigger ratio (50-59%) it attacks on a 1-in-10 roll per decision.
  // The real game difficulty decides, not selfDiff's view; never Hard/Impossible.
  private lowDiff(): boolean {
    const d = this.botGame.config().gameConfig().difficulty;
    return d === Difficulty.Easy || d === Difficulty.Medium;
  }
  private medWeight(o: Player): number {
    if (this.params.medDef <= 0 || o.type() !== PlayerType.Nation || !this.lowDiff()) return 1;
    const r = o.troops() / Math.max(1, this.botGame.config().maxTroops(o));
    return r < 0.3 ? 0.5 * this.params.medDef : r < 0.5 ? this.params.medDef : 1;
  }

  // Reserve-break: every 10 ticks, at most one send to the weakest bordering
  // non-friendly Nation under 30% of its max (it can't hit back): up to
  // medBreak x its troops, from above the commit floor + incoming, within
  // homeRoom and warOk (no other strong non-ally borders us), while nothing
  // hits us hard. Graded: the send must reach 1.5x its troops (with our
  // running attack) or it waits.
  private mbSent = new Map<string, number>();
  public medBreaks = 0;
  public medSeen = 0;
  public medWhy = [0, 0, 0, 0, 0, 0]; // diag: no budget, cooldown, want, send, warOk, canAttack
  private medBreak(ticks: number) {
    const me: Player | null = (this as any).player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase() || !this.lowDiff()) return;
    const troops = me.troops();
    const inc = me.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    if (inc > 0.2 * troops) return;
    const budget = troops - this.commitFloor(me) * g.config().maxTroops(me) - inc;
    let best: { o: Player; send: number; r: number } | null = null;
    for (const n of me.nearby()) {
      if (!n.isPlayer()) continue;
      const o = n as Player;
      if (o.type() !== PlayerType.Nation || !o.isAlive() || me.isFriendly(o) || me.isOnSameTeam(o) || !me.sharesBorderWith(o)) continue;
      const r = o.troops() / Math.max(1, g.config().maxTroops(o));
      if (r >= this.params.medR) continue;
      this.medSeen++;
      if (best !== null && r >= best.r) continue;
      if (budget <= 0) { this.medWhy[0]++; continue; }
      if (ticks - (this.mbSent.get(o.id()) ?? -1e9) < 50) { this.medWhy[1]++; continue; }
      const running = me.outgoingAttacks().filter((a) => a.target() === o).reduce((s, a) => s + a.troops(), 0);
      const want = this.params.medBreak * o.troops() - running;
      if (want <= 0.25 * o.troops()) { this.medWhy[2]++; continue; }
      const send = Math.min(want, budget, this.homeRoom(me, o));
      if (send < Math.min(want, 1.5 * o.troops() - running)) { this.medWhy[3]++; continue; }
      if (!this.warOk(me, o)) { this.medWhy[4]++; continue; }
      best = { o, send, r };
    }
    if (best === null) return;
    if (!me.canAttackPlayer(best.o)) { this.medWhy[5]++; return; }
    this.mbSent.set(best.o.id(), ticks);
    this.medBreaks++;
    g.addExecution(new AttackExecution(Math.ceil(best.send), me, best.o.id()));
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
    const bot = o.type() === PlayerType.Bot ? 0.7 : 1; // BOT_DEFENDER_LOSS_MULT only vs tribes
    mag = k > 0 ? (bot * mag) / k : 80 * bot;
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
  // Tribe attacks keep regenKeep x maxTroops at home (owner report 2026-10-14:
  // "ultra aggressive against bots, not leaving optimal troop regen rate and
  // some reserve"). Late game the defense floor sinks to `reserve` (.13) when
  // the neighbours are weak, and the AI sent everything above it at tribes:
  // regen there is ~64% of its peak and nothing is left for a surprise attack.
  // Wraps whatever sizes the send (patchTribeKill included), so a kill that
  // no longer fits is held, not sent short.
  // sendKeep: Hard/Impossible nations keep 0.75/0.9 x the strongest
  // non-friendly player in nearby() (boat-only ones too) at home on every send,
  // so a mid-size player sits at the cap until it outgrows its neighbour.
  // Ours keeps sendKeep x instead, and also counts an ally whose alliance runs
  // out unrenewed (owner 2026-10-14: "consider if its ally or non ally
  // (including ally which rejects ally renew)"). Replaces neighborTroopCap
  // (current engine) or troopSendCap (v0.34, incoming allowance kept); with
  // capLand only bordering players count.
  private patchSendKeep(ab: any) {
    ab.__keep = true;
    const name = typeof ab.neighborTroopCap === "function" ? "neighborTroopCap"
      : typeof ab.troopSendCap === "function" ? "troopSendCap" : null;
    if (name === null) return;
    const orig = ab[name].bind(ab);
    ab[name] = (ignore?: Player) => {
      const me: Player | null = (this as any).player ?? null;
      const cfg = this.botGame.config().gameConfig();
      const engineKeep = cfg.difficulty === Difficulty.Impossible ? 0.9 : cfg.difficulty === Difficulty.Hard ? 0.75 : 0;
      if (me === null || engineKeep === 0 || me.type() === PlayerType.Bot || cfg.gameMode === GameMode.Team) return orig(ignore);
      let max = 0;
      for (const n of me.nearby()) {
        if (!n.isPlayer() || n === ignore || n.type() === PlayerType.Bot || this.holdsAlly(me, n)) continue;
        if (this.params.capLand > 0 && !me.sharesBorderWith(n)) continue;
        max = Math.max(max, n.troops());
      }
      let cap = max === 0 ? Infinity : Math.max(0, me.troops() - Math.ceil(max * Math.min(engineKeep, this.params.sendKeep)));
      if (name === "troopSendCap") {
        const hit = me.incomingAttacks().reduce((sum, x) => sum + x.troops(), 0);
        if (hit > 0) cap = Math.max(cap, hit);
      }
      return cap;
    };
  }

  private patchRegenKeep(ab: any) {
    ab.__regen = true;
    if (typeof ab.calculateBotAttackTroops !== "function") return;
    const orig = ab.calculateBotAttackTroops.bind(ab);
    ab.calculateBotAttackTroops = (target: Player, maxTroops: number) => {
      const me: Player | null = (this as any).player ?? null;
      if (me === null) return orig(target, maxTroops);
      const keep = this.params.regenKeep * this.botGame.config().maxTroops(me);
      const room = me.troops() - keep - (ab.botAttackTroopsSent ?? 0);
      return orig(target, Math.min(maxTroops, room));
    };
  }

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
    if (this.params.sendKeep > 0) return; // patchSendKeep applies the border-only rule itself
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

  // capBot: frozen at the cap next to a strong human, the 0.9x send cap also
  // blocks barbarian land. Taking it doesn't weaken us vs the human (it regens).
  private patchCapBot(ab: any) {
    ab.__capBot = true;
    if (typeof ab.calculateAttackTroops !== "function" || typeof ab.troopSendCap !== "function") return;
    const calc = ab.calculateAttackTroops.bind(ab);
    const cap = ab.troopSendCap.bind(ab);
    let bot: Player | null = null;
    ab.calculateAttackTroops = (target: any, nonBot: any, opponent?: Player) => {
      bot = this.stalled && target.isPlayer?.() && target.type() === PlayerType.Bot ? target : null;
      try {
        return calc(target, nonBot, opponent);
      } finally {
        bot = null;
      }
    };
    ab.troopSendCap = (ignore?: Player) => {
      const c = cap(ignore);
      const me: Player | null = (this as any).player ?? null;
      if (bot === null || me === null) return c;
      return Math.max(c, Math.floor(me.troops() * this.params.capBot));
    };
  }

  // Replay study R08 (7/10 top FFA players): first silo ~7 min, 2 silos by
  // 10 min, ~6 nukes a game. Saves for the silo once half of it is in hand.
  private patchSilo(sb: any) {
    const g = this.botGame;
    const orig = sb.doHandleStructures.bind(sb);
    sb.doHandleStructures = () => {
      const me: Player = sb.player;
      const cfg = g.config();
      const min = g.ticks() / 600;
      const want = min >= this.params.earlySilo + 3 ? 2 : min >= this.params.earlySilo ? 1 : 0;
      if (want > me.unitsOwned(UnitType.MissileSilo) && !cfg.isUnitDisabled(UnitType.MissileSilo) &&
          !(cfg.isUnitDisabled(UnitType.AtomBomb) && cfg.isUnitDisabled(UnitType.HydrogenBomb))) {
        if (sb.maybeSpawnStructure(UnitType.MissileSilo)) return true;
        if (Number(me.gold()) >= 0.5 * Number(g.unitInfo(UnitType.MissileSilo).cost(g, me))) return false;
      }
      return orig();
    };
    sb.__silo = true;
  }

  public siloGated = 0;
  /** Incoming attack troops plus half the bordering non-ally threat, over our troops. */
  public pressure(me: Player): number {
    const inc = me.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    return (inc + 0.5 * this.otherThreat(me, null)) / Math.max(1, me.troops());
  }
  private patchSiloGate(sb: any) {
    const orig = sb.maybeSpawnStructure.bind(sb);
    sb.maybeSpawnStructure = (type: UnitType) => {
      if (type === UnitType.MissileSilo && this.pressure(sb.player) > this.params.siloGate) {
        this.siloGated++;
        return false;
      }
      return orig(type);
    };
    sb.__siloGate = true;
  }

  // Replay study R09 (7/10): a nuke landing near us is answered with a nuke
  // at its owner within ~30 s. Each incoming nuke triggers once; the inherited
  // tile picker chooses the spot (forced target, nukeGate bypassed).
  private forcingNuke = false;
  private nukeSeen = new Set<number>();
  private nukedBy = new Map<Player, number>();
  public counterNukes = 0;
  private landNear(me: Player, t: TileRef, r: number): boolean {
    const g = this.botGame;
    const map = g.map();
    const x = map.x(t), y = map.y(t);
    for (let dx = -r; dx <= r; dx += 10) {
      for (let dy = -r; dy <= r; dy += 10) {
        if (dx * dx + dy * dy > r * r || !map.isValidCoord(x + dx, y + dy)) continue;
        if (g.owner(map.ref(x + dx, y + dy)) === me) return true;
      }
    }
    return false;
  }
  private counterNukeTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    const nb = self.nukeBehavior;
    if (me === null || !me.isAlive() || !nb) return;
    const g = this.botGame;
    for (const u of g.units(UnitType.AtomBomb, UnitType.HydrogenBomb)) {
      if (this.nukeSeen.has(u.id())) continue;
      const o = u.owner();
      const t = u.targetTile();
      if (o === me || t === undefined || o.type() === PlayerType.Bot || me.isFriendly(o)) continue;
      if (!this.landNear(me, t, 30)) continue;
      this.nukeSeen.add(u.id());
      if (!this.nukedBy.has(o)) this.nukedBy.set(o, ticks);
    }
    if (this.nukedBy.size === 0 || me.unitCount(UnitType.MissileSilo) === 0) {
      for (const [o, at] of this.nukedBy) if (ticks - at > 300) this.nukedBy.delete(o);
      return;
    }
    for (const [o, at] of this.nukedBy) {
      if (ticks - at > 300 || !o.isAlive() || me.isFriendly(o)) {
        this.nukedBy.delete(o);
        continue;
      }
      const before = (nb.atomBombsLaunched ?? 0) + (nb.hydrogenBombsLaunched ?? 0);
      const own = Object.prototype.hasOwnProperty.call(nb, "findBestNukeTarget");
      const prev = nb.findBestNukeTarget;
      nb.findBestNukeTarget = () => o;
      this.forcingNuke = true;
      try {
        nb.maybeSendNuke();
      } finally {
        this.forcingNuke = false;
        if (own) nb.findBestNukeTarget = prev;
        else delete nb.findBestNukeTarget;
      }
      if ((nb.atomBombsLaunched ?? 0) + (nb.hydrogenBombsLaunched ?? 0) > before) {
        this.counterNukes++;
        this.nukedBy.delete(o);
      }
    }
  }

  // Situational betrayal (owner rule; replay state study n=136: victim
  // weaker in 94%, struck within 30 s in 90%). Replaces the closed
  // maybeBetray: true makes the inherited AI attack the victim right away.
  public betrayals = 0;
  private patchBetrayOk(al: any) {
    const g = this.botGame;
    al.maybeBetray = (o: Player) => {
      const me: Player | null = (this as any).player ?? null;
      if (me === null || !me.isAlliedWith(o) || o.type() === PlayerType.Bot || this.isFriend(me, o)) return false;
      if (g.ticks() < this.params.betrayMin * 600) return false;
      if (o.numTilesOwned() >= 0.7 * me.numTilesOwned()) return false;
      const incoming = me.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
      if (incoming > 0.3 * me.troops()) return false;
      // Graded (betrayGrade): the victim's local helpers count and a big
      // non-ally threat (or leaving ally) next to us blocks it.
      if (this.params.betrayGrade > 0) {
        if (this.targetEff(me, o) >= this.params.betrayOk * me.troops() || this.threatened(me, o)) return false;
      } else if (o.troops() >= this.params.betrayOk * me.troops()) return false;
      const a = me.allianceWith(o);
      if (!a) return false;
      me.breakAlliance(a);
      this.betrayals++;
      return true;
    };
  }

  // Replay study R10 (6/10): when an alliance lapses, top players hit the
  // ex-partner right away. Bordering non-tribe ex-allies weaker than
  // lapseStrike x us get one attack within 60 s, sized like a normal player
  // attack (our troops above the reserve, at most 1.5x theirs).
  private allySnap = new Set<Player>();
  private lapsed = new Map<Player, number>();
  public lapseStrikes = 0;
  public lapseGuarded = 0;
  public lapseCapped = 0;
  /** lapseCap: troops out on attacks, this send included, stay under lapseCap x our whole army. */
  public capStrike(me: Player, send: number): number {
    if (this.params.lapseCap <= 0) return send;
    const out = me.outgoingAttacks().reduce((s, a) => s + a.troops(), 0);
    const room = Math.floor(this.params.lapseCap * (me.troops() + out) - out);
    if (send <= room) return send;
    this.lapseCapped++;
    return Math.max(0, room);
  }
  /** Summed threatOf of bordering real players other than `skip` that aren't (staying) allies. */
  public otherThreat(me: Player, skip: Player | null): number {
    let sum = 0;
    for (const n of me.nearby()) {
      if (!n.isPlayer() || n === me || n === skip) continue;
      const h = n as Player;
      if (h.type() === PlayerType.Bot || !h.isAlive() || this.isFriend(me, h) || this.holdsAlly(me, h)) continue;
      if (!me.sharesBorderWith(h)) continue;
      sum += this.medWeight(h) * this.threatOf(h);
    }
    return sum;
  }
  private lapseStrikeTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive()) return;
    const g = this.botGame;
    const now = new Set<Player>(me.alliances().map((a) => a.other(me)));
    for (const o of this.allySnap) if (!now.has(o) && o.isAlive()) this.lapsed.set(o, ticks);
    this.allySnap = now;
    for (const [o, at] of this.lapsed) {
      if (ticks - at > 600 || !o.isAlive() || me.isFriendly(o) || o.type() === PlayerType.Bot) {
        this.lapsed.delete(o);
        continue;
      }
      if (!me.sharesBorderWith(o) || o.troops() >= this.params.lapseStrike * me.troops()) continue;
      if (me.outgoingAttacks().some((a) => a.target() === o)) {
        this.lapsed.delete(o);
        continue;
      }
      const maxT = g.config().maxTroops(me);
      const budget = me.troops() - (self.reserveRatio ?? this.params.reserve) * maxT;
      let send = Math.floor(Math.min(budget, 1.5 * o.troops()));
      // v0.35 fin1/fin2: a 45% lapse strike, then 2-3 other neighbours piled on
      // within a minute. Keep home troops against the others; a big threat
      // trims the strike, and only below half the target's troops drops it.
      if (this.params.lapseGuard > 0) {
        const keep = this.params.lapseGuard * this.otherThreat(me, o);
        if (me.troops() - send < keep) {
          send = Math.floor(me.troops() - keep);
          this.lapseGuarded++;
        }
      }
      send = this.capStrike(me, send);
      if (send < 0.5 * o.troops() || send < 1) continue;
      g.addExecution(new AttackExecution(send, me, o.id()));
      this.lapseStrikes++;
      this.lapsed.delete(o);
    }
  }

  // Traitor debuff (GameImpl: 300 ticks; attacking a traitor costs 0.5x
  // losses) makes a fresh traitor a cheap target, but only a graded one:
  // the gate is traitorK x our troops above the reserve, eased when others
  // already hit the traitor, and nothing fires while a stronger hostile
  // borders us or real attacks come in. The weakest target (vs the gate)
  // goes first. A traitor ally is dropped first, which marks nobody since it
  // is a traitor. AFK players are no longer friendly even when allied.
  private traitorHit = new Map<Player, number>();
  private endingAt = new Map<Player, number>();
  public traitorStrikes = 0;

  /** x's alliance with y ends within allyWarn ticks and y hasn't agreed to renew. */
  private leaving(x: Player, y: Player): boolean {
    const a = x.allianceWith(y);
    return a !== null && a !== undefined && a.expiresAt() - this.botGame.ticks() < this.params.allyWarn && !a.agreedToExtend(y);
  }

  /** Allied in a way that still counts: not about to run out unrenewed. */
  private holdsAlly(x: Player, y: Player): boolean {
    return x.isFriendly(y) && !this.leaving(x, y) && !this.leaving(y, x);
  }
  private traitorStrikeTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive()) return;
    const g = this.botGame;
    const mine = me.troops();
    const incoming = me.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    if (incoming > 0.3 * mine) return;
    const avail = mine - (self.reserveRatio ?? this.params.reserve) * g.config().maxTroops(me);
    if (avail <= 0) return;
    const hostile: Player[] = [];
    let best: Player | null = null;
    let bestR = Infinity;
    for (const o of me.nearby()) {
      if (!o.isPlayer() || o === me || !me.sharesBorderWith(o)) continue;
      const p = o as Player;
      if (p.type() === PlayerType.Bot || !p.isAlive() || this.isFriend(me, p)) continue;
      const traitor = p.isTraitor();
      const afk = p.isDisconnected();
      if (!this.holdsAlly(me, p)) hostile.push(p);
      // Pre-arm on a bordering ally that lets the alliance run out unrenewed.
      if (this.params.expiryK > 0 && me.isAlliedWith(p) && this.leaving(me, p)) this.endingAt.set(p, me.allianceWith(p)!.expiresAt());
      const at = this.endingAt.get(p);
      const expired = at !== undefined && !me.isAlliedWith(p) && ticks - at <= 100;
      if (at !== undefined && (ticks - at > 100 || (me.isAlliedWith(p) && !this.leaving(me, p)))) this.endingAt.delete(p);
      if (!traitor && !afk && !expired) continue;
      if (traitor && ((p as any).getTraitorRemainingTicks?.() ?? 300) < 100) continue;
      if (ticks - (this.traitorHit.get(p) ?? -1e9) < 300) continue;
      if (me.outgoingAttacks().some((a) => a.target() === p)) continue;
      const eff = this.targetEff(me, p);
      const k = traitor || afk ? this.params.traitorK : this.params.expiryK;
      const r = eff / (k * avail);
      if (r < 1 && r < bestR) {
        best = p;
        bestR = r;
      }
    }
    if (best === null) return;
    // Hold while a non-allied neighbour is still a big threat once its own
    // pressure (a stronger player it borders and is not allied with) and its
    // outgoing attacks count. Local only: our neighbours and their allies.
    if (this.threatened(me, best, hostile)) return;
    const send = this.capStrike(me, Math.floor(Math.min(avail, 1.5 * best.troops() + 1)));
    if (send < 0.5 * best.troops() || send < 1) return;
    if (best.isTraitor() && me.isAlliedWith(best)) {
      const a = me.allianceWith(best);
      if (a) me.breakAlliance(a);
    }
    if (!me.canAttackPlayer(best)) return;
    g.addExecution(new AttackExecution(send, me, best.id()));
    this.traitorHit.set(best, ticks);
    this.endingAt.delete(best);
    this.traitorStrikes++;
  }

  /** Target strength: troops eased by others' attacks on it, plus its local helpers. */
  private targetEff(me: Player, p: Player): number {
    const mine = me.troops();
    const theirs = Math.max(1, p.troops());
    const others = p.incomingAttacks().filter((a) => a.attacker() !== me).reduce((s, a) => s + a.troops(), 0);
    // Its allies that border us (or are strong) can come to help: half of
    // their troops count, a quarter for strong ones further away.
    let help = 0;
    for (const al of p.allies()) {
      if (al === me || this.holdsAlly(me, al) || al.type() === PlayerType.Bot || this.leaving(p, al) || this.leaving(al, p)) continue;
      if (me.sharesBorderWith(al)) help += 0.5 * al.troops();
      else if (al.troops() > mine) help += 0.25 * al.troops();
    }
    return theirs * (1 - 0.5 * Math.min(1, others / theirs)) + help;
  }

  /** A bordering non-ally (or leaving ally) other than the target is still a big threat. */
  private threatened(me: Player, target: Player, hostile?: Player[]): boolean {
    const hs =
      hostile ??
      me
        .nearby()
        .filter((o) => o.isPlayer() && o !== me && me.sharesBorderWith(o))
        .map((o) => o as Player)
        .filter((o) => o.type() !== PlayerType.Bot && o.isAlive() && !this.isFriend(me, o) && !this.holdsAlly(me, o));
    return hs.some((h) => h !== target && this.threatOf(h) > this.params.traitorThreat * me.troops());
  }

  private threatOf(h: Player): number {
    const t = h.troops();
    const out = h.outgoingAttacks().reduce((s, a) => s + a.troops(), 0);
    const pressed = h.nearby().some(
      (o) => o.isPlayer() && o !== (this as any).player && (o as Player).type() !== PlayerType.Bot && !this.holdsAlly(h, o as Player) && (o as Player).troops() > t,
    );
    return t * (pressed ? 0.5 : 1) * (1 - 0.5 * Math.min(1, out / Math.max(1, t)));
  }

  // ------------------------------------------------------- port arms
  // doomAware: in a Doomsday Clock lobby every side but the land leader that
  // sits under the bar is drained to a floor, then rots. Troops above the floor
  // are lost anyway, so turn them into land before the bar (or the drain) gets
  // them. The bar is v0.34-only: doomReq is set by the engine adapter that has
  // DoomsdayClock (required tiles at an elapsed second); without it the bot
  // still reacts once it is flagged.
  public static doomReq: ((cfg: any, land: number, elapsed: number) => number) | null = null;
  public doomAttacks = 0;
  private doomAt = -1e9;
  private doomTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    const g = this.botGame;
    if (me === null || !me.isAlive() || g.inSpawnPhase()) return;
    const cfgFn = (g.config() as any).doomsdayClockConfig;
    const cfg = typeof cfgFn === "function" ? cfgFn.call(g.config()) : null;
    if (!cfg?.enabled || ticks - this.doomAt < 30) return;
    const side = (p: Player) => g.players()
      .filter((q) => q.type() !== PlayerType.Bot && (q === p || p.isOnSameTeam(q)))
      .reduce((s, q) => s + q.numTilesOwned(), 0);
    const mine = side(me);
    if (g.players().every((p) => p.type() === PlayerType.Bot || p.isOnSameTeam(me) || p === me || side(p) <= mine)) return;
    const doomed = typeof (me as any).inDoomsdayClock === "function" && (me as any).inDoomsdayClock() === true;
    let near = false;
    const req = BotExecution.doomReq;
    if (!doomed && req !== null) {
      const teams = g.players().some((p) => p !== me && p.isOnSameTeam(me));
      const land = g.numLandTiles() - g.numTilesWithFallout();
      near = mine < 1.1 * req({ ...cfg, teamGame: teams }, land, g.elapsedGameSeconds() + 60);
    }
    if (!doomed && !near) return;
    const maxT = g.config().maxTroops(me);
    const keep = (doomed ? 0.3 : (self.reserveRatio ?? this.params.reserve)) * maxT;
    const avail = me.troops() - keep;
    if (avail < 1) return;
    const send = Math.floor(doomed ? avail : 0.5 * avail);
    if (send < 1) return;
    // Free land first, then the cheapest tribe, then the weakest bordering
    // non-friend we outnumber with what we send.
    let free = false;
    const border = [...me.borderTiles()];
    const step = Math.max(1, Math.floor(border.length / 200));
    for (let i = 0; i < border.length && !free; i += step) {
      free = g.neighbors(border[i]).some((n) => g.isLand(n) && !g.isImpassable(n) && !g.hasOwner(n));
    }
    let target: Player | null = null;
    if (!free) {
      let best = Infinity;
      for (const x of me.nearby()) {
        if (!x.isPlayer() || x === me || !me.sharesBorderWith(x)) continue;
        const p = x as Player;
        if (!p.isAlive() || me.isFriendly(p) || this.isFriend(me, p) || !me.canAttackPlayer(p)) continue;
        const r = p.troops() / Math.max(1, send) + (p.type() === PlayerType.Bot ? 0 : 1);
        if (p.type() !== PlayerType.Bot && p.troops() > send) continue;
        if (r < best) {
          best = r;
          target = p;
        }
      }
      if (target === null) return;
    }
    if (me.outgoingAttacks().some((a) => (target === null ? !a.target().isPlayer() : a.target() === target))) return;
    g.addExecution(new AttackExecution(send, me, target === null ? null : target.id()));
    this.doomAttacks++;
    this.doomAt = ticks;
  }

  // ------------------------------------------------------- final gap arms
  /** fixGap: an AI nuke aim must also keep our own boats/warships out of its outer blast. */
  private patchShipGuard(nb: any, me: Player) {
    nb.__ships = true;
    if (typeof nb.blastHitsFriendlyLand !== "function") return;
    const orig = nb.blastHitsFriendlyLand.bind(nb);
    const g = this.botGame;
    nb.blastHitsFriendlyLand = (center: TileRef, type: any) => {
      if (orig(center, type)) return true;
      const outer = g.config().nukeMagnitudes(type).outer;
      return me.units(UnitType.TransportShip, UnitType.Warship)
        .some((u) => g.euclideanDistSquared(u.tile(), center) <= outer * outer);
    };
  }

  /** Our border tiles touching p's land. */
  private frontTiles(me: Player, p: Player): TileRef[] {
    const g = this.botGame;
    const out: TileRef[] = [];
    const pid = p.smallID();
    for (const t of me.borderTiles()) {
      if (g.neighbors(t).some((n) => g.ownerID(n) === pid)) out.push(t);
    }
    return out;
  }

  // defPost: posts before the wave, not after (the AI only builds them once
  // a big attack is already in). Gold kept: the post costs at most half our
  // gold, so a City fund is never emptied for it.
  public defPosts = 0;
  private defPostTick() {
    const me: Player | null = (this as any).player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    if (g.config().isUnitDisabled(UnitType.DefensePost)) return;
    const cost = g.unitInfo(UnitType.DefensePost).cost(g, me);
    if (me.gold() < 2n * cost) return;
    const mine = Math.max(1, me.troops());
    let best: { front: TileRef[]; deficit: number; threat: number } | null = null;
    for (const o of me.nearby()) {
      if (!o.isPlayer() || o === me || !me.sharesBorderWith(o)) continue;
      const n = o as Player;
      if (n.type() === PlayerType.Bot || !n.isAlive() || this.isFriend(me, n) || this.holdsAlly(me, n)) continue;
      const busy = n.outgoingAttacks().some((a) => a.target() !== me);
      const threat = n.troops() * (busy ? 0.5 : 1);
      const inc = me.incomingAttacks()
        .filter((a) => a.attacker() === n && a.sourceTile() === null)
        .reduce((s, a) => s + a.troops(), 0);
      if (threat < this.params.defPostK * mine && inc < 0.25 * mine) continue;
      const front = this.frontTiles(me, n);
      if (front.length === 0) continue;
      const want = Math.min(3, Math.max(1, Math.ceil(threat / mine)));
      const step = Math.max(1, Math.floor(front.length / 32));
      const have = this.postTiles(me).filter((d) => {
        for (let i = 0; i < front.length; i += step) {
          if (g.euclideanDistSquared(front[i], d) <= g.config().defensePostRange() ** 2) return true;
        }
        return false;
      }).length;
      const deficit = want - have;
      if (deficit <= 0) continue;
      if (best === null || deficit > best.deficit || (deficit === best.deficit && threat > best.threat)) {
        best = { front, deficit, threat };
      }
    }
    if (best === null) return;
    const cities = me.units(UnitType.City).map((c) => c.tile());
    const step = Math.max(1, Math.floor(best.front.length / 40));
    const cand: { t: TileRef; d: number }[] = [];
    for (let i = 0; i < best.front.length; i += step) {
      const t = best.front[i];
      let d = Infinity;
      for (const c of cities) d = Math.min(d, g.euclideanDistSquared(t, c));
      cand.push({ t, d });
    }
    cand.sort((a, b) => a.d - b.d);
    // Owner 2026-10-14: "if 2 defence posts protection intersects it doesnt
    // make that 10x slowth". A post's bonus is all-or-nothing per tile
    // (hasUnitNearby within defensePostRange), so a second post only pays on
    // front its neighbour doesn't cover: skip covered front, keep posts >= 1.5
    // ranges apart.
    const R = g.config().defensePostRange();
    const posts = this.postTiles(me);
    const near = (t: TileRef, r: number) => posts.some((p) => g.euclideanDistSquared(t, p) < r * r);
    for (const { t } of cand) {
      if (near(t, R)) continue;
      const spot = me.canBuild(UnitType.DefensePost, t);
      if (spot === false || near(spot, 1.5 * R)) continue;
      g.addExecution(new ConstructionExecution(me, UnitType.DefensePost, spot));
      this.defPosts++;
      return;
    }
  }

  // richTarget: gold left on a player is ours when we take its land; a rich
  // silo owner is the exception (it nukes back) unless we clearly outnumber it.
  public richVetoes = 0;
  public richRedirects = 0;
  private richBonus(me: Player, p: Player): number {
    const g = this.botGame;
    const base = Math.max(Number(me.gold()), Number(g.unitInfo(UnitType.City).cost(g, me)), 1);
    return this.params.richW * Math.min(3, Number(p.gold()) / base);
  }

  private richVeto(me: Player, p: Player): boolean {
    return Number(p.gold()) >= 10_000_000 && p.unitCount(UnitType.MissileSilo) > 0 && me.troops() < 2 * p.troops();
  }

  /** null = keep the target, false = veto with no alternative, else the better target. */
  private richPick(me: Player, o: Player): Player | null | false {
    const veto = this.richVeto(me, o);
    let best: Player | null = null;
    let bestB = veto ? -Infinity : this.richBonus(me, o) + this.params.richW;
    for (const x of me.nearby()) {
      if (!x.isPlayer() || x === me || x === o || !me.sharesBorderWith(x)) continue;
      const p = x as Player;
      if (p.type() === PlayerType.Bot || !p.isAlive() || me.isFriendly(p) || this.isFriend(me, p)) continue;
      if (!me.canAttackPlayer(p) || this.richVeto(me, p)) continue;
      if (me.troops() < this.pvpReq(me, p) * Math.max(1, p.troops())) continue;
      const b = this.richBonus(me, p);
      if (b > bestB) {
        best = p;
        bestB = b;
      }
    }
    if (best !== null) return best;
    return veto ? false : null;
  }

  // mirvBank: the AI already banks MIRV + Hydro gold (getSaveUpTarget) but
  // only fires at a MIRV sender, a near-winner or a steamroller. With the
  // gold in hand, MIRV the main rival and take the land while it is broken.
  public mirvsSent = 0;
  public mirvStrikes = 0;
  private mirvR: Player | null = null;
  private mirvAt = -1e9;
  private mirvLanded: number | null = null;
  private mirvBankTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    const mine = me.troops();
    if (this.mirvR !== null) {
      const R = this.mirvR;
      if (me.units(UnitType.MIRV, UnitType.MIRVWarhead).length > 0) {
        this.mirvLanded = null;
        return;
      }
      if (ticks - this.mirvAt < 20) return;
      if (this.mirvLanded === null) {
        this.mirvLanded = ticks;
        if (this.params.craterPush > 0) {
          this.craterR = R;
          this.craterUntil = ticks + this.params.craterPush * 600;
        }
      }
      if (ticks - this.mirvLanded > 100 || !R.isAlive()) {
        this.mirvR = null;
        return;
      }
      if (!me.sharesBorderWith(R) || me.isFriendly(R) || mine < 1.22 * R.troops()) return;
      if (me.outgoingAttacks().some((a) => a.target() === R) || !me.canAttackPlayer(R)) return;
      const avail = mine - (self.reserveRatio ?? this.params.reserve) * g.config().maxTroops(me);
      const send = Math.floor(Math.min(avail, 1.5 * R.troops() + 1));
      if (send < 1 || send < 0.5 * R.troops()) return;
      g.addExecution(new AttackExecution(send, me, R.id()));
      this.mirvStrikes++;
      this.mirvR = null;
      return;
    }
    if (this.params.mirvSave > 0) return this.mirvSaveTick(me, ticks);
    if (ticks - this.mirvAt < 600) return;
    if (g.config().isUnitDisabled(UnitType.MIRV) || me.unitCount(UnitType.MissileSilo) === 0) return;
    if (me.gold() < g.unitInfo(UnitType.MIRV).cost(g, me)) return;
    const land = me.numTilesOwned();
    if (ticks < 15 * 600 && land < 0.25 * g.numLandTiles()) return;
    if (me.incomingAttacks().reduce((s, a) => s + a.troops(), 0) >= 0.25 * mine) return;
    let leader: Player | null = null;
    let rival: Player | null = null;
    for (const p of g.players()) {
      if (p === me || !p.isAlive() || p.type() === PlayerType.Bot) continue;
      if (leader === null || p.numTilesOwned() > leader.numTilesOwned()) leader = p;
      if (me.isFriendly(p) || this.isFriend(me, p) || p.numTilesOwned() < 0.5 * land) continue;
      if (rival === null || p.numTilesOwned() > rival.numTilesOwned()) rival = p;
    }
    const R = leader !== null && !me.isFriendly(leader) && !this.isFriend(me, leader) ? leader : rival;
    if (R === null) return;
    const mb = self.mirvBehavior;
    if (!mb || typeof mb.maybeSendMIRV !== "function") return;
    const center = calculateTerritoryCenter(g, R);
    if (center === null || me.canBuild(UnitType.MIRV, center) === false) return;
    mb.maybeSendMIRV(R);
    this.mirvsSent++;
    this.mirvR = R;
    this.mirvAt = ticks;
    this.mirvLanded = null;
  }

  // mirvSave. Owner 2026-10-14: "it never saves up his money on merv, but it
  // msut consider its money per minute, political situations too, merv
  // sometimes the only option agains very very strong players will probably
  // win the game". econ never banks gold, so a MIRV never got affordable.
  // Here: income is measured (gold rises every 10 ticks over the last
  // minute), a threat is a non-ally far stronger than us that wins soon, and
  // we bank only while the MIRV (plus a silo if we have none) is affordable
  // before that win; otherwise the gold keeps building our economy.
  public mirvSaving: Player | null = null;
  public mirvSaveFired = 0;
  private goldPrev = -1;
  private goldGains: number[] = [];
  private mirvThreat(me: Player): { T: Player; eta: number } | null {
    const g = this.botGame;
    const land = Math.max(1, g.numLandTiles() - g.numTilesWithFallout());
    const mine = this.sideTiles(me);
    let best: { T: Player; eta: number } | null = null;
    for (const p of g.players()) {
      if (p === me || !p.isAlive() || me.isOnSameTeam(p) || this.holdsAlly(me, p)) continue;
      if (p.type() !== PlayerType.Human && p.type() !== PlayerType.Nation) continue;
      const tiles = this.sideTiles(p);
      if (tiles < this.params.mirvSave * mine || this.power(p) < 1.5 * this.power(me)) continue;
      const eta = this.winEta(p);
      if (eta > 20 && tiles < 0.35 * land) continue;
      // Someone else's MIRV already flies at it: wait for that one.
      if (g.units(UnitType.MIRV).some((u) => u.owner() !== me && u.targetTile() !== undefined && g.owner(u.targetTile()!) === p)) continue;
      const e = Math.min(eta, 20);
      if (best === null || e < best.eta) best = { T: p, eta: e };
    }
    return best;
  }
  private mirvSaveTick(me: Player, ticks: number) {
    const g = this.botGame;
    const gold = Number(me.gold());
    if (this.goldPrev >= 0) {
      const d = gold - this.goldPrev;
      // A purchase hides that interval's income: reuse the last real gain.
      this.goldGains.push(d >= 0 ? d : (this.goldGains[this.goldGains.length - 1] ?? 0));
      if (this.goldGains.length > 60) this.goldGains.shift();
    }
    this.goldPrev = gold;
    this.mirvReserve = 0; // set again below while banking (a new bank rebases the deadline)
    const cfg = g.config();
    if (cfg.isUnitDisabled(UnitType.MIRV) || cfg.isUnitDisabled(UnitType.MissileSilo)) { this.mirvSaving = null; return; }
    let pick: { T: Player; eta: number; mode?: "duel" | "endgame" | "pre" } | null = this.mirvThreat(me);
    if (pick === null && this.params.mirvDuel > 0 && ticks >= 5 * 600) pick = this.mirvDuelTarget(me);
    if (pick === null && this.params.mirvRich > 0) {
      const T = this.mirvRichTarget(me, gold, ticks);
      if (T !== null) pick = { T, eta: Infinity };
    }
    if (this.params.mirvPre > 0) this.trackRivalGold(me);
    if (pick === null && this.params.mirvPre > 0) pick = this.mirvPreTarget(me);
    if (pick === null) { this.mirvSaving = null; return; }
    const T = pick.T;
    const mirvCost = Number(g.unitInfo(UnitType.MIRV).cost(g, me));
    const silos = me.unitCount(UnitType.MissileSilo);
    if (silos > 0 && gold >= mirvCost && ticks - this.mirvAt >= 600) {
      const mb = (this as any).mirvBehavior;
      const center = calculateTerritoryCenter(g, T);
      if (mb && typeof mb.maybeSendMIRV === "function" && center !== null && me.canBuild(UnitType.MIRV, center) !== false) {
        mb.maybeSendMIRV(T);
        this.mirvsSent++;
        this.mirvSaveFired++;
        if (pick.mode === "pre") this.mirvPreFired++;
        this.mirvR = T;
        this.mirvAt = ticks;
        this.mirvLanded = null;
        this.mirvSaving = null;
        return;
      }
    }
    const need = mirvCost + (silos === 0 ? Number(g.unitInfo(UnitType.MissileSilo).cost(g, me)) : 0) - gold;
    // Duel: no banking; with the gold in hand but no silo, hold it while the silo goes up.
    if (pick.mode === "duel") { this.mirvSaving = silos === 0 && need <= 0 ? T : null; return; }
    // mirvRich with a silo but no MIRV now (cooldown, unbuildable): don't hold the economy.
    if (pick.mode === undefined && pick.eta === Infinity && silos > 0) { this.mirvSaving = null; return; }
    const perMin = this.goldGains.length >= 30 ? (this.goldGains.reduce((a, b) => a + b, 0) * 60) / this.goldGains.length : 0;
    const minutes = need <= 0 ? 0 : perMin > 0 ? need / perMin : Infinity;
    const budget = pick.mode === "endgame" ? 10 : pick.mode === "pre" ? pick.eta : 0.8 * pick.eta;
    const was = this.mirvSaving;
    this.mirvSaving = minutes <= budget ? T : null;
    if (this.mirvSaving === null) return;
    // mirvSpend: the deadline is fixed when banking starts (or the threat speeds up),
    // so the reserve climbs to the full cost by then instead of sliding forever.
    const end = ticks + budget * 600;
    if (was !== T || this.mirvDeadline < 0 || end < this.mirvDeadline) this.mirvDeadline = end;
    const left = Math.max(0, (this.mirvDeadline - ticks) / 600);
    this.mirvReserve = Math.max(0, need + gold - this.params.mirvSpend * perMin * left);
  }
  public mirvDeadline = -1;
  public mirvReserve = 0;
  // mirvPre. v0.35 leader deaths (fin167/189/198): the rich stand-in next to
  // us banks 15-25M for a MIRV while our cities keep us near 1M, then MIRVs
  // us and takes the land with a strike. Humans do the same to a clear
  // leader. Our MIRV first breaks it (troops to ~3%), the follow-up takes its
  // silos, and every launch raises the next MIRV's price for everyone.
  public mirvPreFired = 0;
  private rivalGold = new Map<Player, number[]>();
  private trackRivalGold(me: Player) {
    for (const p of this.botGame.players()) {
      if (p === me || !p.isAlive() || p.unitCount(UnitType.MissileSilo) === 0 || !me.sharesBorderWith(p)) {
        this.rivalGold.delete(p);
        continue;
      }
      const h = this.rivalGold.get(p) ?? [];
      h.push(Number(p.gold()));
      if (h.length > 30) h.shift();
      this.rivalGold.set(p, h);
    }
  }
  /** Gold per minute from the rises of the last ~30 s (purchases don't count against it). */
  private rivalGoldRate(p: Player): number {
    const h = this.rivalGold.get(p);
    if (!h || h.length < 6) return 0;
    let up = 0;
    for (let i = 1; i < h.length; i++) up += Math.max(0, h[i] - h[i - 1]);
    return (up * 60) / (h.length - 1);
  }
  private mirvPreTarget(me: Player): { T: Player; eta: number; mode: "pre" } | null {
    const g = this.botGame;
    const cost = Number(g.unitInfo(UnitType.MIRV).cost(g, me));
    const mine = me.numTilesOwned();
    let best: { T: Player; eta: number; mode: "pre" } | null = null;
    for (const [p] of this.rivalGold) {
      if (!p.isAlive() || (p.type() !== PlayerType.Human && p.type() !== PlayerType.Nation)) continue;
      if (me.isOnSameTeam(p) || me.isFriendly(p) || this.isFriend(me, p) || this.holdsAlly(me, p)) continue;
      const gold = Number(p.gold());
      if (gold < this.params.mirvPre * cost || p.numTilesOwned() < 0.2 * mine) continue;
      if (g.units(UnitType.MIRV).some((u) => u.owner() !== me && u.targetTile() !== undefined && g.owner(u.targetTile()!) === p)) continue;
      if (mirvLeakShare(g, me, p) < 0.3) continue;
      const rate = this.rivalGoldRate(p);
      const eta = gold >= cost ? 0.5 : rate > 0 ? (cost - gold) / rate : 20;
      if (best === null || eta < best.eta) best = { T: p, eta: Math.min(eta, 20), mode: "pre" };
    }
    return best;
  }
  // mirvDuel. Owner 2026-10-14: "if the bot became 1v1 situations on
  // leadership and if it has border with that enemy, it should mirv it once
  // it has the money. if game became 3 or 2 players got bigger and became
  // sole leader candidates it may start to save up for mirv. but it must be
  // when that 3 or 2 person endgame becomes clear." (replaces mirvRich)
  private mirvDuelTarget(me: Player): { T: Player; eta: number; mode: "duel" | "endgame" } | null {
    const g = this.botGame;
    if (me.team() !== null) return null; // FFA only: team endgames are sides, not players
    const ps = g.players()
      .filter((p) => p.isAlive() && (p.type() === PlayerType.Human || p.type() === PlayerType.Nation))
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    if (ps.length < 2) return null;
    const top = ps[0].numTilesOwned();
    const lead = ps.filter((p) => p.numTilesOwned() >= 0.5 * top);
    if (lead.length < 2 || lead.length > 3 || !lead.includes(me)) return null;
    const small = lead[lead.length - 1].numTilesOwned();
    // The rest must be clearly out of the race.
    if ((ps[lead.length]?.numTilesOwned() ?? 0) > 0.5 * small) return null;
    const rivals = lead.filter((p) => p !== me && !this.holdsAlly(me, p) &&
      !g.units(UnitType.MIRV).some((u) => u.owner() !== me && u.targetTile() !== undefined && g.owner(u.targetTile()!) === p));
    if (rivals.length === 0) return null;
    const T = rivals[0]; // the biggest (ps is sorted)
    const land = Math.max(1, g.numLandTiles() - g.numTilesWithFallout());
    if (lead.reduce((s, p) => s + p.numTilesOwned(), 0) >= 0.5 * land) return { T, eta: Infinity, mode: "endgame" };
    if (lead.length === 2 && me.sharesBorderWith(T)) return { T, eta: Infinity, mode: "duel" };
    return null;
  }

  // samCluster. Owner 2026-10-14: "why it doesnt build sams, it should built
  // only to places where there is many valuable buildings close to each other
  // or stacked". Value = structure levels (an upgraded city counts each level)
  // not yet under one of our SAMs; the SAM goes to the level-weighted middle
  // of the best cluster. Only while a non-friend has a silo (else no nukes).
  public samsBuilt = 0;
  public samHeld = 0;
  private samDueFrom = -1; // tick a SAM first came due without the gold (-1 = none due)
  private samDueAt = -1e9; // last tick it was seen due
  /** samSave: hold other AI builds while a due SAM is short of gold, up to samSave minutes. */
  public samHold(): boolean {
    if (this.params.samSave <= 0 || this.samDueFrom < 0) return false;
    const t = this.botGame.ticks();
    return t - this.samDueAt <= 60 && t - this.samDueFrom <= this.params.samSave * 600;
  }
  private samClusterTick(me: Player) {
    const g = this.botGame;
    const cfg = g.config();
    if (!me.isAlive() || g.inSpawnPhase() || cfg.isUnitDisabled(UnitType.SAMLauncher) || this.mirvSaving !== null) return;
    const threat = g.players().some((p) => p !== me && p.isAlive() && !this.isFriend(me, p) && !this.holdsAlly(me, p) &&
      p.unitCount(UnitType.MissileSilo) > 0);
    if (!threat) { this.samDueFrom = -1; return; }
    const short = Number(me.gold()) < Number(g.unitInfo(UnitType.SAMLauncher).cost(g, me));
    if (short && this.params.samSave <= 0) return;
    const sams = me.units(UnitType.SAMLauncher);
    const kinds = new Set<UnitType>([UnitType.City, UnitType.Port, UnitType.Factory, UnitType.MissileSilo]);
    const open = me.units().filter((u) => kinds.has(u.type()) &&
      !sams.some((s) => g.euclideanDistSquared(u.tile(), s.tile()) <= cfg.samRange(s.level()) ** 2));
    const r2 = (0.8 * cfg.defaultSamRange()) ** 2;
    let bestV = 0;
    let bx = 0;
    let by = 0;
    for (const u of open) {
      let v = 0;
      let x = 0;
      let y = 0;
      for (const w of open) {
        if (g.euclideanDistSquared(u.tile(), w.tile()) > r2) continue;
        v += w.level();
        x += w.level() * g.x(w.tile());
        y += w.level() * g.y(w.tile());
      }
      if (v > bestV) { bestV = v; bx = x / v; by = y / v; }
    }
    if (bestV < this.params.samCluster) { this.samDueFrom = -1; return; }
    if (short) {
      const t = g.ticks();
      if (this.samDueFrom < 0) this.samDueFrom = t;
      this.samDueAt = t;
      return;
    }
    // Nearest buildable tile of ours to the middle (diamond rings out to 8).
    const cx = Math.round(bx);
    const cy = Math.round(by);
    for (let d = 0; d <= 8; d++) {
      for (let dx = -d; dx <= d; dx++) {
        const r = d - Math.abs(dx);
        for (const dy of r === 0 ? [0] : [r, -r]) {
          if (!g.isValidCoord(cx + dx, cy + dy)) continue;
          const t = g.ref(cx + dx, cy + dy);
          if (g.owner(t) !== me) continue;
          const spot = me.canBuild(UnitType.SAMLauncher, t);
          if (spot === false) continue;
          g.addExecution(new ConstructionExecution(me, UnitType.SAMLauncher, spot));
          this.samsBuilt++;
          this.samDueFrom = -1;
          return;
        }
      }
    }
  }
  // mirvRich: gold piling up with no runaway to save for. Graded: the more
  // gold over the cost and the bigger the target next to us, the sooner;
  // a target under 0.6x our land is never worth it, nor an ally/teammate.
  private mirvRichTarget(me: Player, gold: number, ticks: number): Player | null {
    const g = this.botGame;
    if (ticks < 5 * 600) return null;
    if (me.incomingAttacks().reduce((s, a) => s + a.troops(), 0) >= 0.25 * me.troops()) return null;
    const cost = Number(g.unitInfo(UnitType.MIRV).cost(g, me)) +
      (me.unitCount(UnitType.MissileSilo) === 0 ? Number(g.unitInfo(UnitType.MissileSilo).cost(g, me)) : 0);
    const r = gold / Math.max(1, cost);
    if (r < 1) return null;
    const mine = Math.max(1, this.sideTiles(me));
    let T: Player | null = null;
    let best = 0;
    for (const p of g.players()) {
      if (p === me || !p.isAlive() || me.isOnSameTeam(p) || me.isFriendly(p) || this.holdsAlly(me, p)) continue;
      if (p.type() !== PlayerType.Human && p.type() !== PlayerType.Nation) continue;
      if (g.units(UnitType.MIRV).some((u) => u.targetTile() !== undefined && g.owner(u.targetTile()!) === p)) continue;
      const t = this.sideTiles(p);
      if (t > best) { best = t; T = p; }
    }
    if (T === null) return null;
    const q = best / mine;
    return q >= 0.6 && r * q >= this.params.mirvRich ? T : null;
  }
  /** While mirvSaving: no AI structures (but a missing silo), warships or nukes. */
  // samCluster replaces the AI's SAM-per-city ratio: its own SAMs are off.
  private patchSam(sb: any) {
    const orig = sb.maybeSpawnStructure.bind(sb);
    sb.maybeSpawnStructure = (type: UnitType) => {
      if (type === UnitType.SAMLauncher) return false;
      if (type !== UnitType.DefensePost && this.samHold()) { this.samHeld++; return false; }
      return orig(type);
    };
    sb.__sam = true;
  }
  // stackUp. Owner 2026-10-15: "it sometimes stop spending money and misses
  // many stacked building opportinities". An upgrade costs what a new one
  // costs, is instant and needs no tile; a level under our SAMs is shielded
  // from nukes, and a factory level spawns more trains. The AI only upgrades
  // past 1 structure per 1500 tiles and picks at random up to 70% of the time.
  public stackUps = 0;
  private patchStack(sb: any) {
    sb.__stack = true;
    const orig = sb.maybeSpawnStructure.bind(sb);
    const stack = (type: UnitType, anyOk: boolean): boolean => {
      const me: Player = sb.player;
      const g = this.botGame;
      const cost = g.unitInfo(type).cost(g, me);
      if (me.gold() < cost) return false;
      const sams = me.units(UnitType.SAMLauncher).filter((s) => !s.isUnderConstruction());
      const cfg = g.config();
      let best: any = null;
      let bestS = -1;
      for (const u of me.units(type)) {
        if (u.isUnderConstruction() || !me.canUpgradeUnit(u)) continue;
        let cover = 0;
        for (const s of sams) if (g.euclideanDistSquared(u.tile(), s.tile()) <= cfg.samRange(s.level()) ** 2) cover += s.level();
        if (cover === 0 && !anyOk) continue;
        const sc = cover * 100 + u.level();
        if (sc > bestS) { bestS = sc; best = u; }
      }
      if (best === null) return false;
      g.addExecution(new UpgradeStructureExecution(me, best.id()));
      this.stackUps++;
      return true;
    };
    sb.maybeSpawnStructure = (type: UnitType) => {
      if (type !== UnitType.City && type !== UnitType.Factory) return orig(type);
      if (this.samHold()) { this.samHeld++; return false; }
      const me: Player = sb.player;
      const g = this.botGame;
      const rich = Number(me.gold()) >= this.params.stackUp * Number(g.unitInfo(type).cost(g, me));
      if (stack(type, rich)) return true;
      if (orig(type)) return true;
      return stack(type, true);
    };
  }
  private patchMirvLock(self: any) {
    self.__mirvLock = true;
    const sb = self.structureBehavior;
    const origS = sb.handleStructures.bind(sb);
    sb.handleStructures = () => {
      if (this.mirvSaving === null) return origS();
      if (sb.player.unitCount(UnitType.MissileSilo) === 0) return sb.maybeSpawnStructure(UnitType.MissileSilo);
      if (this.params.mirvSpend <= 0) return false;
      // mirvSpend: the AI sees only the gold above the reserve (real gold
      // checks in canBuild/upgrade still use the full amount).
      const me = sb.player;
      const spare = Number(me.gold()) - this.mirvReserve;
      if (spare < 125_000) return false;
      me.gold = () => BigInt(Math.floor(spare));
      try {
        return origS();
      } finally {
        delete me.gold;
      }
    };
    const wb = self.warshipBehavior;
    if (wb && typeof wb.maybeSpawnWarship === "function") {
      const origW = wb.maybeSpawnWarship.bind(wb);
      wb.maybeSpawnWarship = () => (this.mirvSaving === null ? origW() : false);
    }
    const nb = self.nukeBehavior;
    if (nb && typeof nb.maybeSendNuke === "function") {
      const origN = nb.maybeSendNuke.bind(nb);
      nb.maybeSendNuke = (...a: any[]) => (this.mirvSaving === null ? origN(...a) : undefined);
    }
  }

  // boatChain: a second front. Once a land attack on a real player runs,
  // a boat lands off our front so its troops split (replays: top players
  // open 2-3 fronts on a weaker target).
  public chainBoats = 0;
  private landSince = new Map<Player, number>();
  private chainAt = new Map<Player, number>();
  private boatChainTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    const seen = new Set<Player>();
    for (const a of me.outgoingAttacks()) {
      if (a.sourceTile() !== null) continue;
      const t = a.target();
      if (!t.isPlayer()) continue;
      const T = t as Player;
      if (T.type() !== PlayerType.Human && T.type() !== PlayerType.Nation) continue;
      seen.add(T);
      if (!this.landSince.has(T)) this.landSince.set(T, ticks);
    }
    for (const T of [...this.landSince.keys()]) if (!seen.has(T)) this.landSince.delete(T);
    if (me.unitCount(UnitType.TransportShip) >= g.config().boatMaxNumber()) return;
    const mine = me.troops();
    const reserve = (self.reserveRatio ?? this.params.reserve) * g.config().maxTroops(me);
    for (const [T, since] of this.landSince) {
      const age = ticks - since;
      if (age < 100 || age > 300) continue;
      if (ticks - (this.chainAt.get(T) ?? -1e9) < 600) continue;
      if (T.troops() > 0.8 * mine) continue;
      const send = Math.floor(0.15 * mine);
      if (send < 1 || mine - send < reserve) continue;
      this.chainAt.set(T, ticks);
      const dst = this.chainLanding(me, T);
      if (dst === null) continue;
      g.addExecution(new TransportShipExecution(me, dst, send));
      this.chainBoats++;
      return;
    }
  }

  // boatStrike: a far target is only reachable by sea, so the land logic
  // never sees it. The boat must beat what the target will have when it
  // lands: its (eased) troops plus its regen during the trip.
  public boatStrikes = 0;
  private struckAt = new Map<Player, number>();
  private boatStrikeTick(ticks: number) {
    const self = this as any;
    const me: Player | null = self.player ?? null;
    if (me === null || !me.isAlive() || this.botGame.inSpawnPhase()) return;
    const g = this.botGame;
    if (me.unitCount(UnitType.TransportShip) >= g.config().boatMaxNumber()) return;
    const mine = me.troops();
    const incoming = me.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    const out = me.outgoingAttacks().reduce((s, a) => s + a.troops(), 0);
    if (incoming >= 0.3 * mine || out >= 0.3 * mine) return;
    const maxT = g.config().maxTroops(me);
    const floor = self.reserveRatio ?? this.params.reserve;
    const avail = mine - Math.max(this.params.homeKeep, this.params.minKeep, floor) * maxT - incoming;
    if (avail < 1) return;
    const border = [...me.borderTiles()];
    if (border.length === 0) return;
    const bs = Math.max(1, Math.floor(border.length / 64));
    const cand: { o: Player; need0: number; tk: number; rate: number; room: number; mult: number }[] = [];
    for (const o of g.players()) {
      if (o === me || !o.isAlive() || o.type() === PlayerType.Bot || me.isFriendly(o)) continue;
      if (me.sharesBorderWith(o) || !me.canAttackPlayer(o)) continue;
      if (ticks - (this.struckAt.get(o) ?? -1e9) < 600) continue;
      const traitor = o.isTraitor();
      // r054: striking any far player cost wins (6 -> 2 of 16, deaths 4 -> 9);
      // 1 = only traitors and disconnected players, 2 = anyone.
      if (this.params.boatStrike < 2 && !traitor && !o.isDisconnected()) continue;
      // A traitor's land costs the attacker half (0.6: a margin) for 30 s.
      const tk = traitor ? 0.6 : 1;
      const eff = this.targetEff(me, o);
      if (1.3 * tk * eff > avail) continue;
      const low = o.troops() < 0.3 * g.config().maxTroops(o);
      // Its regen during the trip, capped at its max troops.
      cand.push({ o, need0: eff, tk, rate: g.config().troopIncreaseRate(o), room: Math.max(0, g.config().maxTroops(o) - o.troops()), mult: (traitor ? 1.5 : 1) * (low ? 1.3 : 1) });
    }
    let best: { o: Player; dst: TileRef; need: number; score: number } | null = null;
    // Cheapest first; the landing search is costly, so only the best 4.
    cand.sort((a, b) => b.o.numTilesOwned() / Math.max(1, b.tk * b.need0) * b.mult - a.o.numTilesOwned() / Math.max(1, a.tk * a.need0) * a.mult);
    for (const c of cand.slice(0, 4)) {
      const dst = this.chainLanding(me, c.o, 0);
      if (dst === null) continue;
      let d2 = Infinity;
      for (let j = 0; j < border.length; j += bs) d2 = Math.min(d2, g.euclideanDistSquared(border[j], dst));
      const travel = 1.2 * Math.sqrt(d2);
      // Regen slows as it fills toward its max: step it in 1 s steps.
      let grow = 0;
      for (let t = 0; t < travel + 150 && grow < c.room; t += 10) grow += 10 * c.rate * (1 - grow / c.room);
      const need = 1.3 * c.tk * (c.need0 + Math.min(c.room, grow));
      if (need > avail) continue;
      const score = (c.o.numTilesOwned() / need) * c.mult / (1 + travel / 200);
      if (best === null || score > best.score) best = { o: c.o, dst, need, score };
    }
    if (best === null) return;
    this.struckAt.set(best.o, ticks);
    g.addExecution(new TransportShipExecution(me, best.dst, Math.max(1, Math.floor(best.need))));
    this.boatStrikes++;
  }

  /** A shore tile of T at least 15 tiles (minD2 = 225) off our border that a boat of ours can reach (nearest first). */
  private chainLanding(me: Player, T: Player, minD2 = 225): TileRef | null {
    const g = this.botGame;
    const border = [...me.borderTiles()];
    if (border.length === 0) return null;
    const bs = Math.max(1, Math.floor(border.length / 64));
    const theirs = [...T.borderTiles()];
    const ts = Math.max(1, Math.floor(theirs.length / 200));
    const cand: { t: TileRef; d: number }[] = [];
    for (let i = 0; i < theirs.length; i += ts) {
      const t = theirs[i];
      if (!g.isShore(t)) continue;
      let d = Infinity;
      for (let j = 0; j < border.length; j += bs) d = Math.min(d, g.euclideanDistSquared(border[j], t));
      if (d >= minD2) cand.push({ t, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const { t } of cand.slice(0, 8)) {
      if (targetTransportTile(g, me, t) === null || canBuildTransportShip(g, me, t) === false) continue;
      return t;
    }
    return null;
  }

  private patchNukeGate(nb: any, me: Player) {
    nb.__gate = true;
    if (typeof nb.sendNuke !== "function") return;
    const orig = nb.sendNuke.bind(nb);
    nb.sendNuke = (tile: any, type: any, target: Player, wait?: number) => {
      if (this.forcingNuke) return orig(tile, type, target, wait);
      const provoked = this.params.nukeProv <= 0 && me.incomingAttacks().some((a) => a.attacker() === target);
      if (!provoked && target.troops() > this.params.nukeGate * me.troops()) return;
      return orig(tile, type, target, wait);
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
      const risk = this.nukeRiskMult(me, o);
      if (me.troops() < this.pvpReq(me, o) * risk * Math.max(1, o.troops())) {
        this.pvpSkips++;
        if (risk > 1 && me.troops() >= this.pvpReq(me, o) * Math.max(1, o.troops())) this.nukeRiskSkips++;
        // Boxed in by a strong player: hit a weaker Nation neighbour instead of idling.
        const nat = this.pvpNatTarget(me, o);
        return nat !== null ? orig(nat, force) : false;
      }
      if (this.params.richTarget > 0 && this.botGame.ticks() >= 3000) {
        const pick = this.richPick(me, o);
        if (pick === false) {
          this.richVetoes++;
          return false;
        }
        if (pick !== null) {
          this.richRedirects++;
          return orig(pick, force);
        }
      }
      if (this.params.structTarget > 0) {
        const pick = this.structPick(me, o);
        if (pick !== o) {
          this.structRedirects++;
          return orig(pick, force);
        }
      }
      return orig(target, force);
    };
  }

  // Target choice by structures near our border (user live report 2026-10-14:
  // "if that enemy has buildings nearby or not to the border should be
  // considered"). Captured land flips cities/ports/factories to us, so a
  // neighbour with structures our attack can reach is worth more troops than
  // an empty one. v2 (user 2026-10-14: "40 tile shouldn't be fix value,
  // defense posts and landscapes also affects"): no distance cutoff. Each
  // structure is weighted by how far an attack of half our army can push into
  // p, using attackLogic's per-tile loss: terrain mag (plains 80, highland
  // 100, mountain 120), x5 on tiles within 30 of p's defense post
  // (defensePostDefenseBonus), times clamp(D/A, 0.6, 2) x (0.463 + 0.0039 x
  // D/N). The line from our nearest front tile to the structure is walked;
  // water and third-party land on it cost extra (the push must go around).
  // reach = (A / loss per plains tile) / front width, and the structure adds
  // worth / (1 + (pathCost / reach)^2): reachable ones count fully, far ones
  // fade. The front's own cover (mean tile cost on p's side) scales the
  // target cost, so a front under p's defense posts is dearer to hit.
  public structRedirects = 0;
  private structCache = new Map<string, [number, number, number]>();
  public structEval(me: Player, p: Player): { value: number; front: number } {
    const g = this.botGame;
    const tick = g.ticks();
    const c = this.structCache.get(p.id());
    if (c !== undefined && c[0] === tick) return { value: c[1], front: c[2] };
    const out = (value: number, front: number) => {
      this.structCache.set(p.id(), [tick, value, front]);
      return { value, front };
    };
    const front = this.frontTiles(me, p);
    if (front.length === 0) return out(0, 1);
    const pid = p.smallID();
    const mid = me.smallID();
    const posts = p.units(UnitType.DefensePost).map((u) => u.tile());
    const covered = (t: TileRef) => posts.some((d) => g.euclideanDistSquared(d, t) <= 900);
    const magOf = (t: TileRef) => {
      const tt = g.terrainType(t);
      return tt === TerrainType.Mountain ? 1.5 : tt === TerrainType.Highland ? 1.25 : 1;
    };
    // Cost of one tile in plains-tile units.
    const tileW = (t: TileRef) => {
      if (!g.isLand(t) || g.isImpassable(t)) return 2;
      const o = g.ownerID(t);
      if (o === mid) return 0;
      if (o === pid) return magOf(t) * (covered(t) ? 5 : 1);
      return o === 0 ? 0.2 : 2;
    };
    const step = Math.max(1, Math.floor(front.length / 64));
    let fw = 0;
    let fk = 0;
    for (let i = 0; i < front.length; i += step) {
      const n = g.neighbors(front[i]).find((x) => g.ownerID(x) === pid);
      if (n === undefined) continue;
      fw += tileW(n);
      fk++;
    }
    const frontCost = fk > 0 ? fw / fk : 1;
    const A = Math.max(1, 0.5 * me.troops());
    const D = Math.max(1, p.troops());
    const N = Math.max(1, p.numTilesOwned());
    const lossPlains = 80 * Math.min(2, Math.max(0.6, D / A)) * (0.463 + 0.0039 * (D / N));
    const reach = Math.max(1, A / lossPlains / front.length);
    let v = 0;
    for (const u of p.units(UnitType.City, UnitType.Port, UnitType.Factory)) {
      const worth = u.type() === UnitType.City ? u.level() : u.type() === UnitType.Port ? 0.7 * u.level() : 0.5 * u.level();
      const ut = u.tile();
      let b = front[0];
      let bd = Infinity;
      for (let i = 0; i < front.length; i += step) {
        const d = g.euclideanDistSquared(front[i], ut);
        if (d < bd) {
          bd = d;
          b = front[i];
        }
      }
      const x0 = g.x(b);
      const y0 = g.y(b);
      const dx = g.x(ut) - x0;
      const dy = g.y(ut) - y0;
      const n = Math.max(Math.abs(dx), Math.abs(dy));
      let cost = 0;
      for (let i = 1; i <= n && cost < 6 * reach; i++) {
        cost += tileW(g.ref(Math.round(x0 + (dx * i) / n), Math.round(y0 + (dy * i) / n)));
      }
      const r = cost / reach;
      v += worth / (1 + r * r);
    }
    return out(v, frontCost);
  }
  public structValue(me: Player, p: Player): number {
    return this.structEval(me, p).value;
  }

  private structPick(me: Player, o: Player): Player {
    const cost = (p: Player) => {
      const e = this.structEval(me, p);
      return (Math.max(1, p.troops()) * e.front) / (1 + this.params.structTarget * e.value);
    };
    let best = o;
    let bestC = cost(o);
    for (const x of me.nearby()) {
      if (!x.isPlayer() || x === me || x === o || !me.sharesBorderWith(x)) continue;
      const p = x as Player;
      if (p.type() === PlayerType.Bot || !p.isAlive() || me.isFriendly(p) || this.isFriend(me, p)) continue;
      if (!me.canAttackPlayer(p) || p.isDisconnected()) continue;
      if (me.troops() < this.pvpReq(me, p) * Math.max(1, p.troops())) continue;
      const c = cost(p);
      if (c < 0.8 * bestC) {
        best = p;
        bestC = c;
      }
    }
    return best;
  }

  /** Troop ratio we need over o before attacking it (eased when others already hit it). */
  public nukeRiskSkips = 0;
  /** nukeRisk: how much more of a troop edge an attack on a nuke-armed player needs (1 = none). */
  public nukeRiskMult(me: Player, o: Player): number {
    if (this.params.nukeRisk <= 0 || me.incomingAttacks().some((a) => a.attacker() === o)) return 1;
    return 1 + this.params.nukeRisk * this.nukeExposure(me, o);
  }
  /** How exposed we are to o's nukes: arm (1 with hydrogen-bomb gold, 0.4 with atom-bomb gold only, 0 without a silo) x (1 - our SAMs / its silos). */
  public nukeExposure(me: Player, o: Player): number {
    const silos = o.unitCount(UnitType.MissileSilo);
    if (silos === 0) return 0;
    const g = this.botGame;
    const gold = Number(o.gold());
    const arm = gold >= Number(g.unitInfo(UnitType.HydrogenBomb).cost(g, o)) ? 1
      : gold >= Number(g.unitInfo(UnitType.AtomBomb).cost(g, o)) ? 0.4 : 0;
    const cover = Math.min(1, me.unitCount(UnitType.SAMLauncher) / silos);
    return arm * (1 - cover);
  }
  private pvpReq(me: Player, o: Player): number {
    const theirs = Math.max(1, o.troops());
    const others = o.incomingAttacks()
      .filter((a) => a.attacker() !== me)
      .reduce((s, a) => s + a.troops(), 0);
    const busy = Math.min(1, others / theirs);
    const ratio = o.type() === PlayerType.Nation && this.params.pvpNat > 0 ? this.params.pvpNat : this.params.pvpRatio;
    let req = Math.max(1.2, ratio * (1 - 0.5 * busy));
    if (this.params.capPush > 0 && this.stalled && busy >= 0.2) req = Math.min(req, this.params.capPush);
    return req;
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
        // tribeCommit: a tribe we attacked that pushes everything at us has an empty home;
        // the counter takes the kill when it fits above the commit floor.
        const commit = this.params.tribeCommit > 0 && this.finTribes.has(x.id()) && pressure <= 0.2 * me.troops();
        const kill = (this.params.tribeKill > 0 && pressure <= 0.2 * me.troops()) || commit ? this.killSend(x) : 0;
        const kFloor = commit ? Math.max(floor, this.commitFloor(me) * this.botGame.config().maxTroops(me)) : floor;
        const fits = kill > 0 && a.troops() + kill <= left - kFloor;
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
        !me.sharesBorderWith(o) && me.canSendAllianceRequest(o) &&
        (this.params.farAlly <= 0 || this.allyKind(me, o) !== "food") &&
        (this.params.baitHuman <= 0 || o.type() !== PlayerType.Human || o.troops() <= this.params.baitHuman * troops);
      if (!losing && !ally) continue;
      const dens = o.troops() / Math.max(1, o.numTilesOwned());
      // Spreading send: ranks targets (a thin owner retakes slower) and sizes
      // a landing that misses the structure tile.
      const send = Math.max(1000, this.params.snipeK * dens * 40);
      if (send > this.params.snipeMax * troops && this.params.snipeSmall <= 0) continue;
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
    // Owner 2026-10-14: "when port sniping always make bot send little, maybe
    // 1% troop boats". A landing on the structure tile takes it on arrival.
    if (this.params.snipeSmall > 0) {
      if (dst === best.tile) best.send = Math.max(1, Math.floor(this.params.snipeSmall * troops));
      else if (best.send > this.params.snipeMax * troops) return;
    }
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
    let total = 0;
    if (this.params.defK > 0) {
      for (const o of g.players()) {
        if (o === me) continue;
        const t = o.type();
        if (t !== PlayerType.Nation && t !== PlayerType.Human) continue;
        if (o.isFriendly(me) && !this.allyEnding(me, o)) continue;
        if (!me.sharesBorderWith(o)) continue;
        const ot = this.medWeight(o) * o.troops();
        strongest = Math.max(strongest, ot);
        total += ot;
      }
    }
    // Deaths come mostly from 3-7 neighbours piling on at once (death2, split2).
    const threat = strongest + this.params.defSum * (total - strongest);
    let floor = Math.min(
      this.params.defCap,
      Math.max(this.params.defMin, (this.params.defK * threat) / maxT),
    );
    // Land grab: winners send 10-20% at a time into free land and don't wait
    // for ~40% troops (S03, OP-057); a full defense floor there halves growth.
    if (this.params.openCap > 0 && floor > this.params.openCap && me.nearby().some((n) => !n.isPlayer())) {
      floor = this.params.openCap;
    }
    // Owner 2026-10-14: "waits exactly 100 percent to send boats ... makes bot
    // sit for minutes", "0.9 is high it can be 0.7".
    if (this.params.trigMax > 0) floor = Math.min(floor, this.params.trigMax - 0.08);
    self.reserveRatio = Math.max(this.params.reserve, floor);
    self.expandRatio = Math.max(this.params.expand, floor);
    self.triggerRatio = Math.max(this.params.trigger, Math.min(0.97, floor + 0.08));
    if (this.params.trigMax > 0) self.triggerRatio = Math.min(self.triggerRatio, this.params.trigMax);
    const ab = self.attackBehavior;
    if (ab && this.params.crownGate > 0 && !ab.__crown) this.patchCrown(ab);
    if (ab && this.params.tribeKill > 0 && !ab.__kill) this.patchTribeKill(ab);
    if (ab && this.params.regenKeep > 0 && !ab.__regen) this.patchRegenKeep(ab);
    if (ab && this.params.sendKeep > 0 && !ab.__keep) this.patchSendKeep(ab);
    if (ab && this.params.pvpRatio > 0 && !ab.__pvp) this.patchPvp(ab);
    if (ab && this.params.boatPick > 0 && !ab.__boat) this.patchBoatPick(ab);
    if (ab && this.params.capLand > 0 && !ab.__capLand) this.patchCapLand(ab);
    if (ab && this.params.capBot > 0 && !ab.__capBot) this.patchCapBot(ab);
    const nb = self.nukeBehavior;
    if (nb && this.params.nukeGate > 0 && !nb.__gate) this.patchNukeGate(nb, me);
    if (nb && this.params.fixGap > 0 && !nb.__ships) this.patchShipGuard(nb, me);
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
      } else if (this.renewDue(a, ticks) && !a.agreedToExtend(me)) {
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
        if (seen.has(t) || !g.isLand(t) || g.isImpassable(t) || g.hasOwner(t) || !g.isShore(t)) continue;
        seen.add(t);
        const x0 = g.x(t), y0 = g.y(t);
        let land = 0, theirs = 0;
        for (let dx = -R; dx <= R; dx++) {
          for (let dy = -R + Math.abs(dx); dy <= R - Math.abs(dx); dy++) {
            if (!g.isValidCoord(x0 + dx, y0 + dy)) continue;
            const u = g.ref(x0 + dx, y0 + dy);
            if (!g.isLand(u) || g.isImpassable(u)) continue;
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
      if (!map.isLand(t) || map.isImpassable(t) || map.hasOwner(t)) continue;
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
      let water = 0; // best ocean/lake sample, faded by ring radius
      const tribes = new Set<string>();
      const N = 48;
      for (let k = 0; k < N; k++) {
        const rad = 8 + (k % 4) * 10;
        const x = Math.round(tx + RING[k][0] * rad);
        const y = Math.round(ty + RING[k][1] * rad);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const s = map.ref(x, y);
        if (map.isImpassable(s)) continue;
        if (!map.isLand(s)) {
          water = Math.max(water, (map.isOcean(s) ? 1 : 0.5) * (1 - (rad - 8) / 40));
          continue;
        }
        landN++;
        const o = g.owner(s);
        if (o.isPlayer() && (o as Player).type() === PlayerType.Bot) {
          tribes.add((o as Player).id());
        }
      }
      const score =
        this.params.wDist * (dMin / maxD) +
        this.params.wLand * (landN / N) +
        this.params.wTribe * Math.min(tribes.size, 6) / 6 +
        this.params.wWater * water;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }
}
