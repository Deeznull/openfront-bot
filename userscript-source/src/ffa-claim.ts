// Several tabs farming on one account (owner 2026-10-24: 10 tabs once the
// solo games are used): each must join a different FFA game, since the
// server lets an account into a game once (a second join is a duplicate
// session). A tab claims the gameID it joins in shared storage (localStorage
// is shared by all the site's tabs) and keeps the claim while it waits in the
// lobby or plays; other tabs skip claimed lobbies and wait for the next one.
//
// A claim lives as long as its tab: each tab holds a Web Lock named
// TAB_LOCK + its id for its whole life, and a picking tab asks which of those
// are held (live). Timestamps alone failed live (2026-10-25: tabs shared a
// game): Chrome throttles hidden tabs' timers to about once a minute, so a
// claim refreshed every 10 s went stale and another tab took its game.
// Without Web Locks, a claim lapses CLAIM_MS after its last refresh.

export const CLAIMS_KEY = "ofbot.ffaClaims";
export const TAB_LOCK = "ofbot-tab-";
export const CLAIM_MS = 45_000;
// A live tab's claim with no refresh for this long is dropped too (a stuck tab).
export const CLAIM_MAX_MS = 4 * 60 * 60_000;

export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
type Claims = Record<string, { tab: string; at: number }>;

export class FfaClaims {
  mine: string | null = null;
  constructor(
    private store: Store,
    readonly tab: string,
  ) {}

  private read(): Claims {
    try {
      const c = JSON.parse(this.store.getItem(CLAIMS_KEY) ?? "{}");
      return c && typeof c === "object" ? c : {};
    } catch {
      return {};
    }
  }

  private write(c: Claims) {
    try {
      this.store.setItem(CLAIMS_KEY, JSON.stringify(c));
    } catch {
      /* storage off: tabs can't coordinate */
    }
  }

  /** The first lobby no other live tab holds, claimed for this tab (null: all taken).
   *  live: ids of the open tabs (from Web Locks); null when unknown. */
  claim<L extends { gameID?: string }>(lobbies: L[], now: number, live: Set<string> | null = null): L | null {
    const c = this.read();
    for (const id of Object.keys(c)) {
      const e = c[id];
      const ok = e && e.tab !== this.tab && (live ? live.has(e.tab) && now - e.at < CLAIM_MAX_MS : now - e.at < CLAIM_MS);
      if (!ok) delete c[id];
    }
    const lobby = lobbies.find((l) => l?.gameID && !c[l.gameID]) ?? null;
    this.mine = lobby?.gameID ?? null;
    if (this.mine) c[this.mine] = { tab: this.tab, at: now };
    this.write(c);
    return lobby;
  }

  /** Refresh our claim (unless another tab won it in a race); others' claims are left as they are. */
  keepAlive(now: number) {
    if (!this.mine) return;
    const c = this.read();
    if (c[this.mine] && c[this.mine].tab !== this.tab) return;
    c[this.mine] = { tab: this.tab, at: now };
    this.write(c);
  }

  drop(_now: number) {
    if (!this.mine) return;
    const c = this.read();
    if (c[this.mine]?.tab === this.tab) delete c[this.mine];
    this.write(c);
    this.mine = null;
  }
}
