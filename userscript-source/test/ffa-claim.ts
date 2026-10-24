// npx tsx test/ffa-claim.ts — bot tabs on one account claim different FFA lobbies.
import assert from "node:assert/strict";
import { CLAIM_MS, FfaClaims } from "../src/ffa-claim";

const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const tabs = Array.from({ length: 3 }, (_, i) => new FfaClaims(store, `t${i}`));
const lobbies = [{ gameID: "A" }, { gameID: "B" }];

// Two lobbies, three tabs: the third waits.
assert.equal(tabs[0].claim(lobbies, 0)?.gameID, "A");
assert.equal(tabs[1].claim(lobbies, 1)?.gameID, "B");
assert.equal(tabs[2].claim(lobbies, 2), null);
// A new lobby appears: the waiting tab takes it.
assert.equal(tabs[2].claim([...lobbies, { gameID: "C" }], 3)?.gameID, "C");
// Re-picking keeps a tab's own lobby available to itself.
assert.equal(tabs[0].claim(lobbies, 4)?.gameID, "A");
// Kept alive, a claim outlasts CLAIM_MS; an abandoned one (t1) expires.
tabs[0].keepAlive(CLAIM_MS - 10);
const t3 = new FfaClaims(store, "t3");
assert.equal(t3.claim(lobbies, CLAIM_MS + 5)?.gameID, "B");
// A left game frees its lobby at once.
tabs[0].drop(CLAIM_MS + 6);
assert.equal(new FfaClaims(store, "t4").claim(lobbies, CLAIM_MS + 7)?.gameID, "A");
// Broken storage: no crash, the first lobby.
const bad = new FfaClaims({ getItem: () => "{oops", setItem: () => { throw new Error("off"); } }, "x");
assert.equal(bad.claim(lobbies, 0)?.gameID, "A");
console.log("ffa-claim: ok");
