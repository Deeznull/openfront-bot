// npx tsx test/ffa-claim.ts — bot tabs on one account claim different FFA lobbies.
import assert from "node:assert/strict";
import { CLAIM_MAX_MS, CLAIM_MS, FfaClaims } from "../src/ffa-claim";

const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const tabs = Array.from({ length: 3 }, (_, i) => new FfaClaims(store, `t${i}`));
const lobbies = [{ gameID: "A" }, { gameID: "B" }];

// Without Web Locks (live unknown): claims lapse CLAIM_MS after their last refresh.
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

// With Web Locks (live 2026-10-25: hidden tabs' timers ran about once a
// minute, so 10 s refreshes missed CLAIM_MS and tabs shared a game).
mem.clear();
const [p, q, r] = ["p", "q", "r"].map((id) => new FfaClaims(store, id));
const live = new Set(["p", "q", "r"]);
assert.equal(p.claim(lobbies, 0, live)?.gameID, "A");
// p never refreshes (throttled): its claim still holds 10 minutes later.
assert.equal(q.claim(lobbies, 10 * 60_000, live)?.gameID, "B");
assert.equal(r.claim(lobbies, 10 * 60_000 + 1, live), null);
// A keepAlive (no live list) leaves other tabs' old claims in place.
q.keepAlive(10 * 60_000 + 2);
assert.equal(r.claim(lobbies, 10 * 60_000 + 3, live), null);
// p's tab closes (its lock is released): its lobby is free at once.
live.delete("p");
assert.equal(r.claim(lobbies, 10 * 60_000 + 4, live)?.gameID, "A");
// A live tab stuck for CLAIM_MAX_MS without a refresh loses its claim.
assert.equal(new FfaClaims(store, "s").claim(lobbies, 10 * 60_000 + 4 + CLAIM_MAX_MS, new Set(["q", "r", "s"]))?.gameID, "A");

// Broken storage: no crash, the first lobby.
const bad = new FfaClaims({ getItem: () => "{oops", setItem: () => { throw new Error("off"); } }, "x");
assert.equal(bad.claim(lobbies, 0)?.gameID, "A");
console.log("ffa-claim: ok");
