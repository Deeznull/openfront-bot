// npx tsx test/ffa-claim.ts — bot tabs on one account claim different FFA lobbies.
import assert from "node:assert/strict";
import { CLAIM_MS, FfaClaims, holdLock, joinable, LockClaims, type Locks } from "../src/ffa-claim";

// Web Locks with ifAvailable, shared by every tab of the origin.
const held = new Set<string>();
const locks: Locks = {
  request(name, opts, cb) {
    assert.equal(opts.ifAvailable, true);
    if (held.has(name)) return Promise.resolve(cb(null));
    held.add(name);
    return Promise.resolve(cb({ name })).finally(() => held.delete(name));
  },
};
const lobbies = [{ gameID: "A" }, { gameID: "B" }];
const tick = () => new Promise((r) => setTimeout(r, 0));

async function lockTests() {
  const tabs = Array.from({ length: 10 }, () => new LockClaims(locks));
  // Ten tabs pick at the same moment: two lobbies, two winners, eight wait.
  const got = await Promise.all(tabs.map((t) => t.claim(lobbies)));
  assert.deepEqual(got.map((l) => l?.gameID ?? null).sort(), ["A", "B", ...Array(8).fill(null)].sort());
  const a = tabs[got.findIndex((l) => l?.gameID === "A")];
  const waiting = tabs.filter((t) => t.mine === null);
  // Re-picking keeps a tab's own lobby.
  assert.equal((await a.claim(lobbies))?.gameID, "A");
  // A new lobby appears: exactly one waiting tab takes it.
  const next = [...lobbies, { gameID: "C" }];
  const got2 = await Promise.all(waiting.map((t) => t.claim(next)));
  assert.equal(got2.filter((l) => l?.gameID === "C").length, 1);
  assert.equal(got2.filter((l) => l !== null).length, 1);
  // A tab that leaves (or closes: the lock dies with the page) frees its lobby.
  a.drop();
  await tick(); // a release lands asynchronously, as in browsers
  const w = waiting.find((t) => t.mine === null)!;
  assert.equal((await w.claim(lobbies))?.gameID, "A");
  // Picking a new lobby releases the old one.
  const free = new LockClaims(locks);
  held.clear();
  assert.equal((await free.claim([{ gameID: "D" }]))?.gameID, "D");
  assert.equal((await free.claim([{ gameID: "E" }]))?.gameID, "E");
  await tick();
  assert.equal(held.has("ofbot-ffa-game-D"), false);
  // Locks that throw: no crash, no claim.
  const bad = new LockClaims({ request: () => Promise.reject(new Error("off")) });
  assert.equal(await bad.claim(lobbies), null);
}

function storeTests() {
  // Fallback without Web Locks: claims lapse CLAIM_MS after their last refresh.
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const tabs = Array.from({ length: 3 }, (_, i) => new FfaClaims(store, `t${i}`));
  assert.equal(tabs[0].claim(lobbies, 0)?.gameID, "A");
  assert.equal(tabs[1].claim(lobbies, 1)?.gameID, "B");
  assert.equal(tabs[2].claim(lobbies, 2), null);
  assert.equal(tabs[2].claim([...lobbies, { gameID: "C" }], 3)?.gameID, "C");
  assert.equal(tabs[0].claim(lobbies, 4)?.gameID, "A");
  // Kept alive, a claim outlasts CLAIM_MS; an abandoned one (t1) expires.
  tabs[0].keepAlive(CLAIM_MS - 10);
  assert.equal(new FfaClaims(store, "t3").claim(lobbies, CLAIM_MS + 5)?.gameID, "B");
  // A left game frees its lobby at once.
  tabs[0].drop();
  assert.equal(new FfaClaims(store, "t4").claim(lobbies, CLAIM_MS + 7)?.gameID, "A");
  // Broken storage: no crash, the first lobby.
  const bad = new FfaClaims({ getItem: () => "{oops", setItem: () => { throw new Error("off"); } }, "x");
  assert.equal(bad.claim(lobbies, 0)?.gameID, "A");
}

async function joinableTests() {
  const live = [
    { gameID: "T", numClients: 2, gameConfig: { trusted: true, maxPlayers: 50 } },
    { gameID: "F", numClients: 25, gameConfig: { maxPlayers: 25 } },
    { gameID: "S", numClients: 1, gameConfig: { maxPlayers: 40 } },
    { gameID: "O", numClients: 3, gameConfig: { maxPlayers: 60 } },
    { gameID: "N" },
  ];
  const skip = new Map([["S", 1000]]);
  // Untrusted: no trusted-only lobby, no full one, no skipped one.
  assert.deepEqual(joinable(live, false, skip, 0).map((l) => l.gameID), ["O", "N"]);
  assert.deepEqual(joinable(live, true, skip, 0).map((l) => l.gameID), ["T", "O", "N"]);
  // A skip lapses after its time.
  assert.deepEqual(joinable(live, false, skip, 1000).map((l) => l.gameID), ["S", "O", "N"]);
  assert.equal(skip.size, 0);
  // holdLock: one holder at a time, free again after release.
  held.clear();
  const r1 = await holdLock(locks, "ofbot-solo");
  assert.ok(r1);
  assert.equal(await holdLock(locks, "ofbot-solo"), null);
  r1!();
  await tick();
  assert.ok(await holdLock(locks, "ofbot-solo"));
}

await lockTests();
storeTests();
await joinableTests();
console.log("ffa-claim: ok");
