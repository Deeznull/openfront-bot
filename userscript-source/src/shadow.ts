/**
 * Shadow engine: a second copy of the game simulation fed the exact same
 * init + turns as the page's real engine worker. After each tick it runs the
 * code bot (BotExecution) for our player, but instead of letting the bot touch
 * the game it captures what the bot *would* do (executions it adds, alliance /
 * embargo calls it makes) and turns that into ordinary player intents. The page
 * sends those intents through the game's own UI event bus, so they reach the
 * game exactly like clicks would. The shadow game itself is never mutated by
 * the bot, so it stays bit-identical to the real one (checked by hash). If it
 * drifts anyway (a newer site version) and the engine can't restore a
 * snapshot, mirror.ts keeps it close to the real game from the real engine's
 * own updates.
 *
 * Runs inside a Worker (normal) or on the page (fallback); `createShadow`
 * takes the function to post messages back with.
 */
import {
  AllianceExtensionExecution,
  AllianceRequestExecution,
  AllianceRequestImpl,
  AttackExecution,
  AUTOPLAY_PARAMS,
  BotExecution,
  CAN_SNAPSHOT,
  ConstructionExecution,
  createRunner,
  DonateGoldExecution,
  DonateTroopsExecution,
  EmojiExecution,
  ENGINE,
  GameUpdateType,
  MirvExecution,
  MoveWarshipExecution,
  Nation,
  NukeExecution,
  PlayerImpl,
  QuickChatExecution,
  saveSharedAiState,
  SpawnExecution,
  TargetPlayerExecution,
  TransportShipExecution,
  UnitImpl,
  UnitType,
  UpgradeStructureExecution,
} from "ofengine";
import type { BotParams, Game, GameRunner, MapSource, Player } from "ofengine";
import { type FeedEntry, findHashes } from "./feed";
import { Mirror } from "./mirror";

export type Post = (msg: any, transfer?: Transferable[]) => void;

/** What the bot tried to do during one tick, before translation. */
type Captured =
  | { k: "exec"; e: unknown }
  | { k: "embargo"; from: Player; target: Player; action: "start" | "stop" }
  | { k: "break"; from: Player; alliance: any }
  | { k: "accept"; req: any }
  | { k: "reject"; req: any }
  | { k: "patrol"; unit: any; tile: number };

/** A plain intent, as the game's Transport builds it (minus clientID). */
export type Intent = { type: string; [k: string]: unknown };

/** Behind the latest turn by more than this: catching up, the bot sits out. */
const MAX_LAG_FOR_BOT = 3;
/** Page fallback: hand the thread back after this long (ms). */
const SLICE_MS = 25;

export function createShadow(post: Post, onPage = false) {
  let gameStartInfo: any = null;
  let clientID: string | undefined;
  let mapSource: MapSource = {}; // map files are cloned per runner by the adapter
  let runner: GameRunner | null = null;
  let generation = 0;
  const turns: any[] = [];
  let baseTick = 0; // game tick of turns[0]
  let fed = 0; // turns handed to the current runner
  let draining = false;

  const mySmallID = () => {
    const me = runner && clientID ? runner.game.playerByClientID(clientID) : null;
    return me ? me.smallID() : 0;
  };
  let mirror = new Mirror(post, mySmallID);

  let enabled = false;
  let emojis = false;
  /**
   * UI switches. team: same-script teaming (chat handshake at 0:04, clan-tag
   * kin, alliances, factory links, SAM cover, a boat toward far kin). share:
   * troop/gold gifts to friends under attack, only from our own slack.
   */
  let team = true;
  let share = true;
  const switchParams = (): Partial<BotParams> => ({ // keys absent from older engines are ignored
    kin: team ? 1 : 0, clanKin: team ? 1 : 0, clanSpawn: team ? 1 : 0, kinBoat: team ? 1 : 0,
    samCover: team ? 1 : 0, teamHelp: team || share ? 1 : 0, donate: share ? 1 : 0,
  }) as any;
  /**
   * Changes from the tuned set for play in the user's games (the training
   * baseline in tests/bot is unchanged): boat-snipe only players that are
   * losing (under attack, or below 30% of their max troops), plus far players
   * we could ally with, who get an alliance request right after the boat.
   * Diplomacy by situation (ally threats, eat weak neighbors, stay under the
   * alliance cap), tribe kill-steals and finishing, factories only where rails
   * link, and war tactics that run only when the politics allow (we are not
   * weaker, no other strong enemy next to us): boat snipes on the war enemy's
   * coastal cities/ports (several boats when an enemy warship guards them),
   * a land push when our boat lands, a counter when theirs lands, warships
   * against serious naval invasions and one guard warship on an island.
   * No even 1v1s: the AI's own attacks on players need 2x their troops
   * (less when others already hit them). The frozen training set (base5,
   * also baked into AUTOPLAY_PARAMS) adds the video-backed ally rules, a
   * 13% reserve, the nuke gates, a strike on a lapsed ally, an early City
   * and the graded traitor/AFK strike. Play-only on top: renewals 26 s
   * before expiry, graded acceptance of human requests, Doomsday Clock
   * awareness and positive emojis (the Nation ask window by difficulty
   * exists but is off).
   */
  const PLAY_TWEAKS: Partial<BotParams> = {
    // base5 (sets_final.json)
    snipeWeak: 0.3,
    snipeAlly: 1,
    allySelect: 1,
    boxFront: 1,
    potW: 0.5,
    strikeExposed: 1,
    tribeCounter: 1,
    crownGate: 1,
    tribeSteal: 1,
    finishK: 0.05,
    warSnipe: 1,
    snipeBurst: 3,
    boatCounter: 1,
    landPush: 1,
    navy: 1,
    factLink: 1,
    portLake: 1,
    pvpRatio: 2,
    allyVid: 1,
    reserve: 0.13,
    nukeGate: 0.9,
    nukeProv: 1,
    lapseStrike: 0.8,
    earlyCity: 2,
    earlyCityMin: 3,
    traitorK: 1,
    // 0.5.1 live-play fixes (owner reports 2026-10-14; quick sim on tf0-15)
    tribeFinish: 1, // finish tribes we hit, steal ones others hit (allies too), hunt early
    finishFloor: 0.6,
    tribeCommit: 1, // 0.5.6 (owner 2026-10-16): a tribe we attacked is finished (counter push + kill, low commit floor)
    playerSteal: 0.5, // 0.5.6 (owner 2026-10-16): steal the kill of a very low enemy/ex-ally/traitor ally others attack (other allies never); kill fits in 50% of our troops
    baitHuman: 1, // ally-bait boats only into humans no stronger than us
    structTarget: 0.5, // prefer neighbours whose cities/ports/factories our attack can reach
    // 0.5.2 live-play fixes (owner reports 2026-10-14; quick sim on tf0-15)
    regenKeep: 0.35, // tribe attacks keep 35% of max troops home (regen ~94% of peak + reserve)
    wWater: 1.5, // spawn near ocean (or a lake); maps without water are unaffected
    snipeSmall: 0.01, // port snipes land on the port tile with 1% of our troops
    trigMax: 0.7, // attack once troops reach 70% of max (was up to ~90%; regen is slow near the cap)
    sendKeep: 0.7, // Hard/Impossible send cap keeps 0.7x (not 0.9x) the strongest non-ally home; allies letting the alliance run out count
    foodAll: 1, // a player under 0.4x our strength is no ally, bordering or overseas
    humansOnly: 1, // never ally AI Nations
    farAlly: 1, // a player we don't border is no ally unless its combined far threat (silo, bomb gold, nuked/embargoed us, captured our ships, boats at us, strength) scores >= 1
    mirvRich: 0, // off since 0.5.3 (owner: the 1.5x-the-cost spend was a bad rule); mirvDuel replaces it
    mirvDuel: 1, // FFA leader endgame: 2 leaders sharing a border -> MIRV the other as soon as the gold is there; a clear 2-3 leader endgame (each >= half the top, the rest under half the smallest, together >= half the land) -> bank for a MIRV at the biggest rival
    samCluster: 5, // SAMs only over clusters: >= 5 structure levels (an upgraded city counts each level) within 0.8 SAM range not yet covered, while a non-friend has a silo; the AI's SAM-per-city ratio is off
    mirvSave: 2, // bank gold for a MIRV only against a runaway (2x our land, 1.5x our power, wins within ~20 min) when our income affords it in time
    wildSize: 1.5, // boats into empty land carry 1.5x what that land costs, not a fifth of our army
    postSpread: 1.5, // AI defense posts never inside another post's cover (overlap adds no defense)
    mirvDump: 0.05, // an enemy MIRV flying at our land leaves ~3% of max troops anyway: pour troops above 5% into free land, tribes we outnumber 2x, players we outnumber 4x (owner: never strong enemies)
    minKeep: 0.2, // hard floor: no attack or boat (kills included) leaves under 20% of max troops home (owner request)
    homeKeep: 0.3, // every attack/boat leaves max(30% of max troops, defense floor) + incoming attackers home; a kill may dip to the defense floor
    // play-only (no sim signal; kept per the transfer rule)
    renewLead: 26,
    humanAccept: 1,
    natWin: 0, // off: on Impossible it would change the sim-tested ask logic
    doomAware: 1,
    emojiMode: 1, // positive, rare; 🤝 / ☢️ with alliance asks (sent only if the emoji box is ticked)
  } as any;
  let params: BotParams = { ...AUTOPLAY_PARAMS, ...PLAY_TWEAKS };
  let paramsKey = "{}"; // JSON of the last enable's params (page profile)
  let bot: BotExecution | null = null;
  let spawnSent = false;

  function log(msg: string) {
    post({ t: "log", msg });
  }

  async function start(snapshot: Uint8Array | undefined, initial: boolean) {
    const gen = ++generation;
    runner = null;
    bot = null;
    const cb = (gu: any) => {
      if (gen !== generation) return;
      if (gu && "updates" in gu) {
        for (const h of findHashes(gu, GameUpdateType.Hash)) post({ t: "hash", tick: h.tick, hash: h.hash });
        mirror.shadowTiles(gu.packedTileUpdates);
      } else if (gu && "errMsg" in gu) {
        post({ t: "error", msg: `shadow tick error: ${gu.errMsg}` });
      }
    };
    const r: GameRunner = await createRunner(gameStartInfo, clientID, mapSource, cb, snapshot);
    if (gen !== generation) return;
    const tick = r.game.ticks();
    if (initial) {
      baseTick = tick;
      fed = 0;
    } else {
      fed = tick - baseTick;
      if (fed < 0 || fed > turns.length) {
        post({ t: "error", msg: `resync tick ${tick} outside turn buffer` });
        return;
      }
    }
    guardIntents(r);
    runner = r;
    const me = clientID ? r.game.playerByClientID(clientID) : null;
    post({
      t: "ready",
      tick,
      myID: me?.id() ?? null,
      resync: !initial,
      engine: ENGINE,
      canSnapshot: CAN_SNAPSHOT,
    });
    drain();
  }

  // Our attack and boat intents on their way to the game: sent, not yet in a
  // turn. Their troops are still ours in this engine, so the bot gets their
  // sum (inflightTroops) and its home keep doesn't spend them a second time.
  // An intent the page dropped never lands: the page reports it ("dropped"),
  // and entries expire after INFLIGHT_MS of real time anyway (the page drops
  // what it couldn't send within 2.5 s). Real time, not ticks: at Max speed
  // a queued send waited hundreds of ticks, expired here while still queued,
  // and the bot spent the same troops again (live 2026-10-15: troops to ~0).
  const INFLIGHT_MS = 6000;
  let inflight: { troops: number; at: number }[] = [];
  function unflight(i: any) {
    if (i?.type !== "attack" && i?.type !== "boat") return;
    const k = inflight.findIndex((x) => x.troops === i.troops);
    if (k >= 0) inflight.splice(k, 1);
  }
  // Our defense posts sent but not on the map yet (bot.pendingPosts): the AI
  // spaces new posts from them. Dropped once a post of ours stands within a
  // few tiles (the game may shift the spot), or after INFLIGHT_MS.
  let posts: { tile: number; at: number }[] = [];
  // Attack ids ("boat<unit id>" for boats) already called back by the farm hold.
  const recalled = new Set<string>();
  function landed(turn: any) {
    if (inflight.length === 0) return;
    for (const i of turn?.intents ?? []) {
      if (i?.clientID === clientID) unflight(i);
    }
  }

  function drain() {
    if (!runner || draining) return;
    draining = true;
    const t0 = performance.now();
    try {
      const r = runner;
      while (fed < turns.length && r === runner) {
        // Mirror mode: no further ahead than the real game (its tick-N
        // update is what corrects our tick N).
        if (mirror.holds(r.game.ticks() + 1, turns.length - fed)) break;
        landed(turns[fed]);
        r.addTurn(turns[fed++]);
        r.executeNextTick();
        if (!CAN_SNAPSHOT) mirror.sync(r.game);
        if (enabled && turns.length - fed <= MAX_LAG_FOR_BOT) botStep(r.game);
        if (onPage && performance.now() - t0 > SLICE_MS) {
          setTimeout(drain, 0);
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  /**
   * A turn may hold intents this engine doesn't know (a newer site version)
   * or can't build: skip those (logged once per type) instead of letting the
   * throw take the whole tick down. Executions made from intents that throw
   * later, in init or tick, are switched off the same way.
   */
  const badIntents = new Set<string>();
  function skipIntent(type: unknown, e: any) {
    const k = String(type);
    if (badIntents.has(k)) return;
    badIntents.add(k);
    log(`skipping intent "${k}" this engine can't run: ${e?.message ?? e}`);
  }
  function guardIntents(r: GameRunner) {
    const em = (r as any).execManager;
    if (!em || typeof em.createExec !== "function") return;
    em.createExecs = (turn: any) => {
      const out: any[] = [];
      for (const i of turn?.intents ?? []) {
        try {
          out.push(guardExec(em.createExec(i), i?.type));
        } catch (e) {
          skipIntent(i?.type, e);
        }
      }
      return out;
    };
  }
  function guardExec(ex: any, type: unknown) {
    if (!ex || typeof ex.init !== "function") return ex;
    let dead = false;
    for (const m of ["init", "tick"]) {
      const f = ex[m];
      if (typeof f !== "function") continue;
      ex[m] = function (this: any, ...a: unknown[]) {
        if (dead) return;
        try {
          return f.apply(this, a);
        } catch (e) {
          dead = true;
          skipIntent(type, e);
        }
      };
    }
    const active = ex.isActive;
    if (typeof active === "function") ex.isActive = function (this: any) {
      return !dead && active.call(this);
    };
    return ex;
  }

  function botStep(g: Game) {
    if (!clientID) return;
    const me = g.playerByClientID(clientID);
    if (!me) return;
    if (!bot) {
      bot = new BotExecution(
        `${gameStartInfo.gameID}:${me.id()}`,
        new Nation(undefined, me.info()),
        { ...params, ...switchParams() },
      );
      capture(g, () => bot!.init(g));
      // Never move a player who is already placed outside the spawn phase.
      if (spawnSent || !g.inSpawnPhase()) (bot as any).spawnSent = true;
      log(`bot attached to ${me.name()} (${me.id()})`);
    }
    if (!bot.isActive() || !me.isAlive() && !g.inSpawnPhase()) return;
    const now = g.ticks();
    const wall = performance.now();
    inflight = inflight.filter((x) => wall - x.at < INFLIGHT_MS);
    (bot as any).inflightTroops = inflight.reduce((a, x) => a + x.troops, 0);
    if (posts.length > 0) {
      const built = me.units(UnitType.DefensePost).map((u: any) => u.tile());
      posts = posts.filter((x) => wall - x.at < INFLIGHT_MS && !built.some((t: number) => g.manhattanDist(t, x.tile) <= 4));
    }
    (bot as any).pendingPosts = posts.map((x) => x.tile);
    const out = capture(g, () => bot!.tick(now));
    const intents: Intent[] = [];
    for (const c of out) {
      const i = translate(g, me, c);
      if (i && !aimedAtTribe(g, me, i)) {
        intents.push(i);
        if ((i.type === "attack" || i.type === "boat") && typeof i.troops === "number" && i.troops > 0)
          inflight.push({ troops: i.troops, at: wall });
        if (i.type === "build_unit" && i.unit === UnitType.DefensePost) posts.push({ tile: i.tile, at: wall });
      }
    }
    // Farm hold (holdWin): the bot sends no new attacks or boats near the win
    // line, but the ones already running carried it from ~70% to the 80% win
    // in under a game minute (sims 2026-10-15: wins at 14-20 min, not 30+).
    // Call them back; retreating troops come home (a player target keeps 75%).
    if ((bot as any).holding) {
      for (const a of me.outgoingAttacks()) {
        if (a.retreating() || recalled.has(a.id())) continue;
        recalled.add(a.id());
        intents.push({ type: "cancel_attack", attackID: a.id() });
      }
      for (const u of me.units(UnitType.TransportShip)) {
        if (recalled.has(`boat${u.id()}`) || (u as any).retreating?.()) continue;
        recalled.add(`boat${u.id()}`);
        intents.push({ type: "cancel_boat", unitID: u.id() });
      }
    }
    if (intents.length > 0) post({ t: "intents", tick: g.ticks(), intents });
    if (g.ticks() % 10 === 0) {
      post({
        t: "state",
        tick: g.ticks(),
        spawn: g.inSpawnPhase(),
        alive: me.isAlive(),
        tiles: me.numTilesOwned(),
        troops: Math.round(me.troops()),
        gold: Number(me.gold()),
        mirv: (bot as any).mirvSaving?.name?.() ?? null,
        keep: (bot as any).mirvSaving ? Math.round((bot as any).mirvReserve ?? 0) : 0,
      });
    }
  }

  /**
   * Runs `fn` (a bot tick) with every way it could change the game diverted
   * into a list: added executions, and the few direct Player / alliance
   * request calls the Nation AI makes. Relation tweaks are dropped (they are
   * AI bookkeeping a human client can't send).
   */
  function capture(g: Game, fn: () => void): Captured[] {
    const out: Captured[] = [];
    const ga = g as any;
    const P = PlayerImpl.prototype as any;
    const R = AllianceRequestImpl.prototype as any;
    const U = UnitImpl.prototype as any;
    const restoreShared = saveSharedAiState(g);
    const saved = {
      add: Object.prototype.hasOwnProperty.call(ga, "addExecution") ? ga.addExecution : undefined,
      ur: P.updateRelation,
      ae: P.addEmbargo,
      se: P.stopEmbargo,
      ba: P.breakAlliance,
      acc: R.accept,
      rej: R.reject,
      ws: U.updateWarshipState,
    };
    ga.addExecution = (...ex: unknown[]) => {
      for (const e of ex) out.push({ k: "exec", e });
    };
    P.updateRelation = function () {};
    P.addEmbargo = function (this: Player, other: Player) {
      out.push({ k: "embargo", from: this, target: other, action: "start" });
    };
    P.stopEmbargo = function (this: Player, other: Player) {
      out.push({ k: "embargo", from: this, target: other, action: "stop" });
    };
    P.breakAlliance = function (this: Player, alliance: any) {
      out.push({ k: "break", from: this, alliance });
    };
    R.accept = function () {
      out.push({ k: "accept", req: this });
    };
    R.reject = function () {
      out.push({ k: "reject", req: this });
    };
    // The Nation AI re-targets warships by writing their patrol tile directly.
    U.updateWarshipState = function (update: any) {
      if (update?.patrolTile !== undefined) out.push({ k: "patrol", unit: this, tile: update.patrolTile });
    };
    try {
      fn();
    } catch (e: any) {
      post({ t: "error", msg: `bot tick threw: ${e?.stack ?? e}` });
    } finally {
      if (saved.add !== undefined) ga.addExecution = saved.add;
      else delete ga.addExecution;
      P.updateRelation = saved.ur;
      P.addEmbargo = saved.ae;
      P.stopEmbargo = saved.se;
      P.breakAlliance = saved.ba;
      R.accept = saved.acc;
      R.reject = saved.rej;
      U.updateWarshipState = saved.ws;
      restoreShared();
    }
    return out;
  }

  /**
   * The user's rule: tribes (the small gray PlayerType.Bot players) are food,
   * not diplomacy partners or rivals. Whatever the bot decides, never ask them
   * for (or extend) an alliance, embargo them, mark them as a target, send
   * them emojis or break an alliance with them. If we are allied with one
   * anyway (accepted by hand, or from an older version), don't attack it
   * either: that would be a betrayal and the traitor debuff. Let the alliance
   * run out instead. Attacks and boats against other tribes still go through.
   * Same for everyone else: the bot never betrays (no alliance breaks, no
   * attacks or boats on any ally), whatever path inside the AI decides to.
   */
  const TRIBE_FIELD: Record<string, string> = {
    allianceRequest: "recipient",
    allianceExtension: "recipient",
    breakAlliance: "recipient",
    embargo: "targetID",
    targetPlayer: "target",
    emoji: "recipient",
  };
  const tribeDrops: Record<string, number> = {};
  function aimedAtTribe(g: Game, me: Player, i: Intent): boolean {
    let drop = false;
    let why = "aimed at a tribe (tribes are just food)";
    const field = TRIBE_FIELD[i.type];
    if (i.type === "breakAlliance") {
      drop = true;
      why = "(the bot never betrays)";
    } else if (field !== undefined) {
      if (i[field] === "AllPlayers") return false; // an emoji to everyone
      const p: any = g.players().find((x) => x.id() === i[field]);
      // Gone (dead) or a tribe: drop. Embargo "stop" on a dead player is moot too.
      drop = !p || p.type() === "BOT";
      // A renewal we already agreed to: the click is done, don't repeat it.
      if (!drop && i.type === "allianceExtension") {
        const a = me.allianceWith(p);
        drop = !a || a.agreedToExtend(me);
        why = "(already renewed)";
      }
    } else if (i.type === "attack" || i.type === "boat") {
      let p: any = null;
      if (i.type === "attack") p = i.targetID ? g.players().find((x) => x.id() === i.targetID) : null;
      else {
        const o: any = g.owner(i.dst);
        p = o?.isPlayer?.() ? o : null;
      }
      drop = !!p && me.isAlliedWith(p);
      if (drop && p.type() !== "BOT") why = "on an ally (the bot never betrays)";
      if (!drop && i.type === "boat" && p?.type() === "BOT" && me.sharesBorderWith(p)) {
        drop = true;
        why = "to a tribe we border by land (a land attack is faster)";
      }
    }
    if (!drop) return false;
    tribeDrops[i.type] = (tribeDrops[i.type] ?? 0) + 1;
    if (tribeDrops[i.type] === 1) log(`ignoring ${i.type} ${why}`);
    return true;
  }

  function translate(g: Game, me: Player, c: Captured): Intent | null {
    switch (c.k) {
      case "embargo":
        if (c.from !== me) return null;
        return { type: "embargo", targetID: c.target.id(), action: c.action };
      case "break":
        if (c.from !== me) return null;
        return { type: "breakAlliance", recipient: c.alliance.other(me).id() };
      case "accept":
        // Accepting = requesting back (AllianceRequestExecution accepts a
        // pending incoming request).
        if (c.req.recipient() !== me) return null;
        return { type: "allianceRequest", recipient: c.req.requestor().id() };
      case "reject":
        if (c.req.recipient() !== me) return null;
        return { type: "allianceReject", requestor: c.req.requestor().id() };
      case "patrol":
        if (c.unit.owner() !== me || !c.unit.isActive()) return null;
        return { type: "move_warship", unitIds: [c.unit.id()], tile: c.tile };
    }
    const e: any = c.e;
    if (e instanceof AttackExecution) {
      if (e["_owner"] !== me) return null;
      // v0.35 clients drop an attack whose troops aren't a finite number (null
      // included), so a not-yet-sized send goes out with the engine's default.
      let troops = e["startTroops"];
      if (troops === null || troops === undefined) {
        const tid = e["_targetID"];
        const target = tid && g.hasPlayer(tid) ? g.player(tid) : g.terraNullius();
        troops = Math.min(me.troops(), g.config().attackAmount(me, target));
      }
      if (!Number.isFinite(troops)) return null;
      return { type: "attack", targetID: e["_targetID"] ?? null, troops: Math.max(0, troops) };
    }
    if (e instanceof TransportShipExecution) {
      if (e["attacker"] !== me) return null;
      if (!Number.isFinite(e["troops"])) return null;
      return { type: "boat", troops: Math.max(0, e["troops"]), dst: e["ref"] };
    }
    if (e instanceof ConstructionExecution) {
      if (e["player"] !== me) return null;
      const i: Intent = { type: "build_unit", unit: e["constructionType"], tile: e["tile"] };
      if (e["rocketDirectionUp"] !== undefined) i.rocketDirectionUp = e["rocketDirectionUp"];
      if (e["amount"] !== undefined) i.amount = e["amount"];
      return i;
    }
    if (e instanceof MoveWarshipExecution) {
      if (e["owner"] !== me || e["unitIds"].length === 0) return null;
      return { type: "move_warship", unitIds: [...e["unitIds"]], tile: e["position"] };
    }
    if (e instanceof TargetPlayerExecution) {
      if (e["requestor"] !== me) return null;
      return { type: "targetPlayer", target: e["targetID"] };
    }
    if (e instanceof SpawnExecution) {
      // The bot's own scored spawn has a tile; the Nation AI's random
      // spawn-phase "hops" don't, and are dropped.
      if (e["playerInfo"].id !== me.id() || e.tile === undefined) return null;
      spawnSent = true;
      return { type: "spawn", tile: e.tile };
    }
    if (e instanceof AllianceExtensionExecution) {
      if (e["from"] !== me) return null;
      return { type: "allianceExtension", recipient: e["toID"] };
    }
    if (e instanceof AllianceRequestExecution) {
      if (e["requestor"] !== me) return null;
      return { type: "allianceRequest", recipient: e["recipientID"] };
    }
    if (e instanceof MirvExecution) {
      if (e["player"] !== me) return null;
      return { type: "build_unit", unit: UnitType.MIRV, tile: e["dst"] };
    }
    if (e instanceof NukeExecution) {
      if (e["player"] !== me) return null;
      return {
        type: "build_unit",
        unit: e["nukeType"],
        tile: e["dst"],
        rocketDirectionUp: e["rocketDirectionUp"],
      };
    }
    if (e instanceof UpgradeStructureExecution) {
      if (e["player"] !== me) return null;
      const u = g.unit(e["unitId"]);
      if (!u) return null;
      const i: Intent = { type: "upgrade_structure", unit: u.type(), unitId: e["unitId"] };
      if (e["amount"] !== undefined) i.amount = e["amount"];
      return i;
    }
    if (e instanceof EmojiExecution) {
      if (!emojis || e["requestor"] !== me) return null;
      return { type: "emoji", recipient: e["recipientID"], emoji: e["emoji"] };
    }
    if (e instanceof QuickChatExecution) {
      if (e["sender"] !== me) return null;
      return { type: "quick_chat", recipient: e["recipientID"], quickChatKey: e["quickChatKey"], target: e["target"] };
    }
    if (e instanceof DonateTroopsExecution) {
      if (e["sender"] !== me || !share) return null;
      return { type: "donate_troops", recipient: e["recipientID"], troops: e["troops"] ?? null };
    }
    if (e instanceof DonateGoldExecution) {
      if (e["sender"] !== me || !share) return null;
      const gold = e["gold"];
      return { type: "donate_gold", recipient: e["recipientID"], gold: gold === null || gold === undefined ? null : Number(gold) };
    }
    log(`dropped unsupported action ${e?.constructor?.name ?? typeof e}`);
    return null;
  }

  return function onMessage(m: any) {
    switch (m.t) {
      case "init":
        gameStartInfo = m.gameStartInfo;
        clientID = m.clientID;
        mapSource = m.mapSource ?? { files: m.map };
        turns.length = 0;
        inflight = [];
        posts = [];
        recalled.clear();
        spawnSent = false;
        mirror = new Mirror(post, mySmallID);
        start(m.snapshot, true).catch((e) => post({ t: "error", msg: `shadow init failed: ${e?.message ?? e}` }));
        break;
      case "turn":
        turns.push(m.turn);
        drain();
        break;
      case "real":
        // What the page's real engine reported (feed.ts); used by mirror mode.
        if (CAN_SNAPSHOT) break;
        mirror.push(m.list as FeedEntry[]);
        if (runner && !draining) mirror.sync(runner.game);
        drain();
        break;
      case "mirror":
        // Hashes differ and this engine can't resync: follow the real game.
        if (!CAN_SNAPSHOT && m.on) mirror.start(m.correct !== false);
        if (runner && !draining) mirror.sync(runner.game);
        drain();
        break;
      case "dropped":
        for (const i of m.intents ?? []) unflight(i);
        break;
      case "resync":
        start(m.snapshot, false).catch((e) => post({ t: "error", msg: `resync failed: ${e?.message ?? e}` }));
        break;
      case "enable":
        enabled = !!m.on;
        const fresh = m.params !== undefined && JSON.stringify(m.params) !== paramsKey;
        if (fresh) {
          paramsKey = JSON.stringify(m.params);
          params = { ...AUTOPLAY_PARAMS, ...PLAY_TWEAKS, ...m.params };
        }
        if (typeof m.emojis === "boolean") emojis = m.emojis;
        if (typeof m.team === "boolean") team = m.team;
        if (typeof m.share === "boolean") share = m.share;
        params = { ...params, ...switchParams() };
        if (bot) Object.assign((bot as any).params, switchParams()); // live switch
        if (fresh) bot = null; // re-create with the new params
        break;
    }
  };
}

/** Worker entry: wire the shadow to the worker's message port. */
export function runInWorker(scope: any) {
  const handle = createShadow((msg, transfer) => scope.postMessage(msg, transfer ?? []));
  scope.addEventListener("message", (e: MessageEvent) => handle(e.data));
}
