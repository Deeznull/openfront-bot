/**
 * Headless check of the shadow engine (node build.mjs --test, then
 * node test-dist/sim.mjs [--map World] [--min 8] [--seed s1]).
 *
 * A "real" GameRunner stands in for the page's engine worker, and the test
 * plays the singleplayer server: the bot's intents, as the shadow emits them,
 * are stamped with our clientID and put in the turn two ticks later. Checks:
 *  - every state hash from the shadow equals the real game's (no drift, so
 *    the bot never mutates its copy of the game),
 *  - a snapshot resync mid-game keeps the hashes equal (engines that have
 *    snapshots only),
 *  - the bot spawns and grows our player in the real game through intents
 *    alone,
 *  - the real game's updates, forwarded like the page does (feed.ts), pass
 *    the shadow's format check and agree with it everywhere.
 *
 * --drift [n]: every n ticks (default 50) after spawn, scale the troops of
 * three random players by 0.8-1.2 and give them some gold, in the real game
 * only (no side is favoured on average), so the hashes differ like with
 * a newer site version. On the first mismatch the test, like the page on an
 * engine without snapshots, switches the shadow to mirror mode; --nocorrect
 * measures the same with no corrections. Reported: owned-tile agreement
 * (full map), own tiles and troops real vs shadow, and the real game's growth.
 */
import { CAN_SNAPSHOT, createRunner, ENGINE, GameUpdateType, UnitType } from "ofengine";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  nodeMapSource,
} from "ofengine-node";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { feedEntry, findHashes } from "../src/feed";

declare const __REPO__: string;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const CLIENT = "MECLNT01";
const LATENCY = 2; // ticks between the bot's decision and its turn

async function main() {
  const mapName = arg("map", "World");
  const minutes = Number(arg("min", "8"));
  const seed = arg("seed", "ofbot1");
  const difficulty = arg("difficulty", "Impossible") as Difficulty;
  const gameMap = (GameMapType as any)[mapName] ?? mapName;
  const gameStart: any = {
    gameID: seed,
    lobbyCreatedAt: 0,
    players: [{ clientID: CLIENT, username: "Tester" }],
    config: {
      gameMap,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty,
      nations: "default",
      donateGold: false,
      donateTroops: false,
      bots: 400,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      // --doomsday <speed>: a Doomsday Clock lobby (engines that have it, v0.34+).
      ...(process.argv.includes("--doomsday") ? { doomsdayClock: { enabled: true, speed: arg("doomsday", "veryfast") } } : {}),
    },
  };
  const src = await nodeMapSource(__REPO__, gameMap, GameMapSize.Normal);
  console.log(`engine ${ENGINE} (${__REPO__})`);

  const realHashes = new Map<number, number>();
  let realErrors = 0;
  let feed: any[] = []; // the real game's updates since the last turn, as the page forwards them
  const real: any = await createRunner(gameStart, CLIENT, src, (gu: any) => {
    for (const h of findHashes(gu, GameUpdateType.Hash)) realHashes.set(h.tick, h.hash);
    const e = feedEntry(gu);
    if (e) feed.push(e);
    if (gu && "errMsg" in gu && realErrors++ < 3) console.error("real game error:", gu.stack ?? gu.errMsg);
  });
  const driftAt = process.argv.indexOf("--drift");
  const driftEvery = driftAt < 0 ? 0 : Number(process.argv[driftAt + 1]) || 50;
  const correct = !process.argv.includes("--nocorrect");
  let rng = 0;
  for (const ch of seed) rng = (rng * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => {
    rng = (rng + 0x6d2b79f5) >>> 0;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let mirrorAt = -1;
  const syncs: any[] = [];
  let lost = 0;
  let diverged = 0;
  let lastFeed = "none";
  let preOwnedMin = 1;
  let lowMin = 1;
  let lastRatio = 1;
  let lowAt = -1;
  let lowTicks = 0;
  let lowLogged = 0;

  const shadowHashes = new Map<number, number>();
  const counts: Record<string, number> = {};
  const pending = new Map<number, any[]>(); // tick -> stamped intents
  let ready = 0;
  let errors = 0;
  let curTick = 0;
  // Diplomacy intents aimed at tribes (PlayerType.Bot): the shadow drops them, so 0.
  const TRIBE_FIELD: Record<string, string> = {
    allianceRequest: "recipient",
    allianceExtension: "recipient",
    breakAlliance: "recipient",
    embargo: "targetID",
    targetPlayer: "target",
    emoji: "recipient",
  };
  let tribeDiplomacy = 0;
  let tribeAttacks = 0; // land attacks on tribes (eating, kill-steals, finishing)
  let snipeAllies = 0; // boat + alliance request to the port's owner in one batch
  // The shadow runs in a worker thread (test-dist/shadow-thread.mjs); each
  // message is acknowledged with "done" and the loop waits for it, so the
  // shadow stays in lockstep with the real game.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const thread = new Worker(path.join(here, "shadow-thread.mjs"));
  let acks = 0;
  let posted = 0;
  const shadow = (m: any) => {
    posted++;
    thread.postMessage(m);
  };
  const settle = async () => {
    while (acks < posted) await new Promise((r) => setImmediate(r));
  };
  thread.on("error", (e) => {
    console.error("shadow thread crashed:", e);
    process.exit(1);
  });
  thread.on("message", (m: any) => {
    if (m.t === "done") acks++;
    else if (m.t === "ready") ready++;
    else if (m.t === "hash") shadowHashes.set(m.tick, m.hash);
    else if (m.t === "intents") {
      const due = curTick + LATENCY;
      const list = pending.get(due) ?? [];
      for (const i of m.intents) {
        counts[i.type] = (counts[i.type] ?? 0) + 1;
        const field = TRIBE_FIELD[i.type];
        if (field !== undefined) {
          const to: any = real.game.players().find((p: any) => p.id() === i[field]);
          if (to?.type() === "BOT") tribeDiplomacy++;
        }
        if (i.type === "attack" && i.targetID) {
          const to: any = real.game.players().find((p: any) => p.id() === i.targetID);
          if (to?.type() === "BOT") tribeAttacks++;
        }
        if (process.env.DBG_EXT && i.type === "allianceExtension" && (counts[i.type] ?? 0) <= 400) {
          const me: any = real.game.playerByClientID(CLIENT);
          const to: any = real.game.players().find((p: any) => p.id() === i.recipient);
          const a: any = to && me?.allianceWith(to);
          console.log(`ext t${curTick} -> ${to?.name()} ${to?.type()} exp ${a?.expiresAt()} meAgreed ${a?.agreedToExtend(me)} otherAgreed ${a?.agreedToExtend(to)}`);
        }
        list.push({ ...i, clientID: CLIENT });
      }
      for (const b of m.intents) {
        if (b.type !== "boat") continue;
        const o: any = real.game.owner(b.dst);
        if (o?.isPlayer?.() && m.intents.some((x: any) => x.type === "allianceRequest" && x.recipient === o.id())) snipeAllies++;
      }
      pending.set(due, list);
    } else if (m.t === "sync") {
      lastFeed = m.feed;
      if (m.mirror) syncs.push(m);
      else preOwnedMin = Math.min(preOwnedMin, m.owned);
    } else if (m.t === "lost") {
      lost++;
      console.error(`shadow gave up mirroring: ${m.msg}`);
    } else if (m.t === "diverged") {
      diverged++;
    } else if (m.t === "error") {
      errors++;
      console.error("shadow error:", m.msg);
    } else if (m.t === "log") console.log("shadow:", m.msg);
  });
  shadow({ t: "init", gameStartInfo: gameStart, clientID: CLIENT, nodeRepo: __REPO__ });
  while (ready < 1) await new Promise((r) => setTimeout(r, 10));
  // --params '{"spreadW":0}' overrides bot params (on top of the play tweaks).
  const params = process.argv.includes("--params") ? JSON.parse(arg("params", "{}")) : undefined;
  shadow({ t: "enable", on: !process.argv.includes("--nobot"), params });

  const ticks = minutes * 600;
  const resyncAt = Math.floor(ticks / 2);
  let compared = 0;
  let mismatches = 0;
  const check = () => {
    for (const [t, h] of shadowHashes) {
      const r = realHashes.get(t);
      if (r === undefined) continue;
      if (mirrorAt >= 0) {
        shadowHashes.delete(t);
        continue; // mirror mode: hashes no longer compared, like the page
      }
      compared++;
      if (r !== h) {
        mismatches++;
        if (mismatches <= 5 && !driftEvery) console.error(`HASH MISMATCH tick ${t}: real ${r} shadow ${h}`);
        if (driftEvery && !CAN_SNAPSHOT) {
          // What the page does on an engine without snapshots.
          mirrorAt = t;
          shadow({ t: "mirror", on: true, correct });
          console.log(`hash mismatch at tick ${t}: mirror mode${correct ? "" : " (no corrections)"}`);
        }
      }
      shadowHashes.delete(t);
    }
  };
  const t0 = performance.now();
  let maxSams = 0;
  const mirvIds = new Set<number>();
  const seenNukes = new Set<number>();
  for (let n = 0; n < ticks; n++) {
    curTick = n;
    const turn = { turnNumber: n, intents: pending.get(n) ?? [] };
    pending.delete(n);
    real.addTurn(turn);
    real.executeNextTick();
    if (driftEvery && n % driftEvery === 0 && !real.game.inSpawnPhase()) {
      // Real-only change: the shadow never sees it except through the feed.
      const alive = real.game.players().filter((p: any) => p.isAlive());
      for (let k = 0; k < 3 && alive.length; k++) {
        const p = alive[Math.floor(rand() * alive.length)];
        p.setTroops(Math.round(p.troops() * (0.8 + 0.4 * rand())));
        p.addGold(BigInt(Math.floor(rand() * 10000)));
      }
    }
    // Turn first, then the real updates: the shadow (held in mirror mode)
    // waits for them, as in the page when its real worker is slower.
    shadow({ t: "turn", turn });
    shadow({ t: "real", list: feed });
    feed = [];
    await settle();
    check();
    if (n === resyncAt && CAN_SNAPSHOT && !process.argv.includes("--noresync")) {
      // What the page does on a desync: snapshot the real engine, restore.
      const snap = real.snapshot();
      shadowHashes.clear();
      shadow({ t: "resync", snapshot: snap });
      while (ready < 2) await new Promise((r) => setTimeout(r, 10));
      console.log(`resynced at tick ${real.game.ticks()}`);
    }
    if (n % 10 === 0 && !real.game.inSpawnPhase()) {
      // Troop floor check (minKeep): how low the bot's own troops go.
      const me = real.game.playerByClientID(CLIENT);
      if (me?.isAlive()) {
        maxSams = Math.max(maxSams, me.units(UnitType.SAMLauncher).length);
        for (const u of real.game.units(UnitType.MIRV)) if (u.owner() === me) mirvIds.add(u.id());
        const ratio = me.troops() / real.game.config().maxTroops(me);
        if (process.argv.includes("--trace")) {
          // Every nuke aimed at our land (once), and every 10-tick troop drop of 3+ points of max.
          for (const u of real.game.units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRVWarhead, UnitType.MIRV)) {
            const t = u.targetTile?.();
            if (seenNukes.has(u.id()) || t === undefined || real.game.owner(t) !== me) continue;
            seenNukes.add(u.id());
            console.log(`  nuke tick ${n}: ${u.type()} from ${u.owner().name()} at ${real.game.x(t)},${real.game.y(t)}`);
          }
          if (lastRatio - ratio >= 0.03) {
            const out = me.outgoingAttacks().reduce((a: number, x: any) => a + x.troops(), 0);
            const boats = me.units(UnitType.TransportShip).reduce((a: number, x: any) => a + x.troops(), 0);
            console.log(`  drop tick ${n}: ${(lastRatio * 100).toFixed(1)}% -> ${(ratio * 100).toFixed(1)}% tiles ${me.numTilesOwned()} out ${Math.round(out)} boats ${Math.round(boats)} gold ${me.gold()}`);
          }
        }
        const prevRatio = lastRatio;
        lastRatio = ratio;
        if (ratio < lowMin) {
          lowMin = ratio;
          lowAt = n;
        }
        if (ratio < 0.2) {
          lowTicks += 10;
          if (lowLogged < 8 && ratio < 0.15) {
            lowLogged++;
            const inc = me.incomingAttacks().reduce((a: number, x: any) => a + x.troops(), 0);
            const out = me.outgoingAttacks().reduce((a: number, x: any) => a + x.troops(), 0);
            console.log(
              `low troops tick ${n}: ${(ratio * 100).toFixed(1)}% of max (10 ticks ago ${(prevRatio * 100).toFixed(1)}%), ` +
                `troops ${Math.round(me.troops())} max ${Math.round(real.game.config().maxTroops(me))} tiles ${me.numTilesOwned()} ` +
                `incoming ${Math.round(inc)} outgoing ${Math.round(out)} gold ${me.gold()}`,
            );
          }
        }
      }
    }
    if (n % 600 === 0) {
      const me = real.game.playerByClientID(CLIENT)!;
      const sy = syncs[syncs.length - 1];
      console.log(
        `min ${n / 600}: tiles ${me.numTilesOwned()} troops ${Math.round(me.troops())} ` +
          `alive ${me.isAlive()} | hashes ok ${compared} bad ${mismatches}` +
          (sy ? ` | mirror ${(sy.pct * 100).toFixed(1)}% owned ${(sy.owned * 100).toFixed(1)}% me ${sy.meShadow}/${sy.meReal}` : ""),
      );
      if (process.argv.includes("--neighbors") && me.isAlive()) {
        const nb = real.game.players().filter((p: any) => p !== me && p.isAlive() && me.sharesBorderWith(p));
        console.log(
          `  gold ${me.gold()} out ${me.outgoingAttacks().length} boats ${me.units(UnitType.TransportShip).length} | ` +
            nb.map((p: any) => `${p.name()}(${p.type()[0]} ${p.numTilesOwned()}t ${Math.round(p.troops() / 1000)}k${me.isAlliedWith(p) ? " ally" : ""}${p.hasEmbargoAgainst?.(me) ? " emb" : ""})`).join(" "),
        );
      }
    }
  }
  await settle();
  check();
  await thread.terminate();
  const me = real.game.playerByClientID(CLIENT)!;
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`intents sent: ${JSON.stringify(counts)}`);
  console.log(`troop floor: min ${(lowMin * 100).toFixed(1)}% of max at tick ${lowAt}, ${lowTicks} ticks below 20%`);
  if (process.argv.includes("--doomsday")) {
    const doomed = real.game.players().filter((p: any) => p.type() !== "BOT" && p.inDoomsdayClock?.()).length;
    console.log(`DOOMSDAY ours flagged ${me.inDoomsdayClock?.() ?? "n/a"}, players flagged ${doomed}, our land share ${((me.numTilesOwned() / real.game.numLandTiles()) * 100).toFixed(2)}%`);
  }
  console.log(`SAMs (most at once) ${maxSams}, MIRVs launched ${mirvIds.size}`);
  console.log(`tribe attacks ${tribeAttacks}, snipe+ally ${snipeAllies}, ports owned ${me.units(UnitType.Port).length}, traitor ${me.isTraitor()}`);
  console.log(
    `RESULT tiles ${me.numTilesOwned()} alive ${me.isAlive()} hashes compared ${compared} mismatches ${mismatches} errors ${errors} real errors ${realErrors} tribe diplomacy ${tribeDiplomacy} (${secs}s)`,
  );
  const avg = (f: (x: any) => number) => (syncs.length ? syncs.reduce((a, x) => a + f(x), 0) / syncs.length : NaN);
  const pctOf = (x: number) => `${(x * 100).toFixed(2)}%`;
  console.log(
    `FEED last check ${CAN_SNAPSHOT ? "n/a (snapshot engine)" : lastFeed}, owned agreement before mirror (min) ${pctOf(preOwnedMin)}, diverged flags ${diverged}`,
  );
  if (driftEvery) {
    const owned = syncs.map((x) => x.owned).filter((x) => x >= 0);
    const last = syncs[syncs.length - 1];
    console.log(
      `MIRROR ${correct ? "corrected" : "uncorrected"} from tick ${mirrorAt}: reports ${syncs.length}, ` +
        `owned-tile agreement avg ${pctOf(owned.reduce((a, x) => a + x, 0) / Math.max(1, owned.length))} ` +
        `min ${pctOf(Math.min(...owned))} last ${pctOf(owned[owned.length - 1] ?? NaN)}, ` +
        `changed-tile agreement avg ${pctOf(avg((x) => x.pct))}, ` +
        `own tiles err avg ${pctOf(avg((x) => Math.abs(x.meShadow - x.meReal) / Math.max(1, x.meReal)))}, ` +
        `own troops err avg ${pctOf(avg((x) => Math.abs(x.troopsShadow - x.troopsReal) / Math.max(1, x.troopsReal)))}, ` +
        `fixes ${last?.fixedTiles ?? 0} tiles ${last?.fixedStats ?? 0} stats, lost ${lost}`,
    );
  }
  const synced = driftEvery
    ? mirrorAt >= 0 && (lost === 0 || !correct)
    : mismatches === 0 && compared > 0 && diverged === 0 && (CAN_SNAPSHOT || lastFeed === "ok") && preOwnedMin === 1;
  const ok = synced && me.numTilesOwned() > 0 && errors === 0 && realErrors === 0 && tribeDiplomacy === 0 &&
    !counts.breakAlliance && !me.isTraitor();
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
