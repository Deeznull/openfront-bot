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
 *    alone.
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
    },
  };
  const src = await nodeMapSource(__REPO__, gameMap, GameMapSize.Normal);
  console.log(`engine ${ENGINE} (${__REPO__})`);

  const realHashes = new Map<number, number>();
  let realErrors = 0;
  const real: any = await createRunner(gameStart, CLIENT, src, (gu: any) => {
    for (const h of gu?.updates?.[GameUpdateType.Hash] ?? []) realHashes.set(h.tick, h.hash);
    if (gu && "errMsg" in gu && realErrors++ < 3) console.error("real game error:", gu.stack ?? gu.errMsg);
  });

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
      compared++;
      if (r !== h) {
        mismatches++;
        if (mismatches <= 5) console.error(`HASH MISMATCH tick ${t}: real ${r} shadow ${h}`);
      }
      shadowHashes.delete(t);
    }
  };
  const t0 = performance.now();
  for (let n = 0; n < ticks; n++) {
    curTick = n;
    const turn = { turnNumber: n, intents: pending.get(n) ?? [] };
    pending.delete(n);
    real.addTurn(turn);
    real.executeNextTick();
    shadow({ t: "turn", turn });
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
    if (n % 600 === 0) {
      const me = real.game.playerByClientID(CLIENT)!;
      console.log(
        `min ${n / 600}: tiles ${me.numTilesOwned()} troops ${Math.round(me.troops())} ` +
          `alive ${me.isAlive()} | hashes ok ${compared} bad ${mismatches}`,
      );
    }
  }
  await settle();
  check();
  await thread.terminate();
  const me = real.game.playerByClientID(CLIENT)!;
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`intents sent: ${JSON.stringify(counts)}`);
  console.log(`tribe attacks ${tribeAttacks}, snipe+ally ${snipeAllies}, ports owned ${me.units(UnitType.Port).length}, traitor ${me.isTraitor()}`);
  console.log(
    `RESULT tiles ${me.numTilesOwned()} alive ${me.isAlive()} hashes compared ${compared} mismatches ${mismatches} errors ${errors} real errors ${realErrors} tribe diplomacy ${tribeDiplomacy} (${secs}s)`,
  );
  const ok = mismatches === 0 && compared > 0 && me.numTilesOwned() > 0 && errors === 0 && realErrors === 0 && tribeDiplomacy === 0 &&
    !counts.breakAlliance && !me.isTraitor();
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
