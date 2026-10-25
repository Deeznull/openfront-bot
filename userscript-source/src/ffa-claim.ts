// Several tabs farming on one account (owner 2026-10-24: 10 tabs once the
// solo games are used): each must join a different FFA game, since the
// server lets an account into a game once (a second join is a duplicate
// session). A tab claims the gameID it joins and holds the claim while it
// waits in the lobby or plays; other tabs skip claimed lobbies and wait for
// the next one.
//
// LockClaims (Web Locks) is the claim: one lock per gameID, taken only if
// free, held until the tab leaves the game or closes. Taking a lock is atomic
// across tabs and a lock dies with its page. FfaClaims (localStorage) is the
// fallback without Web Locks. It failed live (2026-10-25, 10 tabs opened in a
// second shared games): localStorage reaches other tabs asynchronously, so a
// tab could read a copy without the claim another tab had just written, and
// hidden tabs' throttled timers let claims lapse.

export const CLAIMS_KEY = "ofbot.ffaClaims";
export const GAME_LOCK = "ofbot-ffa-game-";
export const CLAIM_MS = 45_000;

type Lobby = { gameID?: string };

export interface Locks {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
}

export class LockClaims {
  mine: string | null = null;
  private release: (() => void) | null = null;
  constructor(private locks: Locks) {}

  // The lock on one gameID if no other tab holds it: its release, else null.
  private take(id: string): Promise<(() => void) | null> {
    return new Promise((resolve) => {
      this.locks
        .request(GAME_LOCK + id, { ifAvailable: true }, (lock) => {
          if (!lock) return resolve(null);
          return new Promise<void>((done) => resolve(done));
        })
        .catch(() => resolve(null));
    });
  }

  /** The first lobby no other tab holds, now held by this tab (null: all taken). */
  async claim<L extends Lobby>(lobbies: L[]): Promise<L | null> {
    for (const l of lobbies) {
      const id = l?.gameID;
      if (!id) continue;
      if (id === this.mine) return l;
      const release = await this.take(id);
      if (!release) continue;
      this.drop();
      this.mine = id;
      this.release = release;
      return l;
    }
    this.drop();
    return null;
  }

  drop() {
    this.release?.();
    this.release = null;
    this.mine = null;
  }
}

export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
type Claims = Record<string, { tab: string; at: number }>;

// Without Web Locks: claims in localStorage that lapse CLAIM_MS after their last refresh.
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

  /** The first lobby no other live tab holds, claimed for this tab (null: all taken). */
  claim<L extends Lobby>(lobbies: L[], now: number): L | null {
    const c = this.read();
    for (const id of Object.keys(c)) if (!(c[id] && c[id].tab !== this.tab && now - c[id].at < CLAIM_MS)) delete c[id];
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

  drop() {
    if (!this.mine) return;
    const c = this.read();
    if (c[this.mine]?.tab === this.tab) delete c[this.mine];
    this.write(c);
    this.mine = null;
  }
}
