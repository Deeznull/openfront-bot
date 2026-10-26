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

type Lobby = { gameID?: string; numClients?: number; startsAt?: number; gameConfig?: { trusted?: boolean; maxPlayers?: number } };

export interface Locks {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
}

/** A Web Lock if no other tab holds it: its release, else null. Held until released or the page dies. */
export function holdLock(locks: Locks, name: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(null);
        return new Promise<void>((done) => resolve(done));
      })
      .catch(() => resolve(null));
  });
}

// The live list (2026-10-25) has lobbies only trusted accounts may join
// (validateAndJoin then just opens a modal) and lobbies that fill up, and a
// join can fail by itself (turnstile, a lobby that closed). A tab skips those,
// and when its join doesn't lead into the lobby it gives the claim up and
// skips that lobby for a while instead of retrying it.
export const JOIN_WAIT_MS = 15_000;
export const SKIP_MS = 5 * 60_000;

// A join lands seconds after the click (auth, turnstile, the socket; longer in
// a background tab), and the server refuses a player whose join comes just
// after the start or into a full lobby ("You didn't enter the game in time",
// live 2026-10-26). So a tab skips the active lobby once it starts within
// MIN_LEFT_MS, and lobbies about to fill (a full lobby starts at once); the
// queued lobbies (no startsAt yet) start later and are safe.
export const MIN_LEFT_MS = 20_000;
export const MIN_FREE = 2;

/** The lobbies this tab could join, in the list's order. serverNow: the server's clock now (ms). */
export function joinable<L extends Lobby>(
  lobbies: L[],
  trusted: boolean,
  skip: Map<string, number>,
  now: number,
  serverNow?: number,
): L[] {
  for (const [id, until] of skip) if (now >= until) skip.delete(id);
  return lobbies.filter((l) => {
    if (!l?.gameID || skip.has(l.gameID)) return false;
    if (l.gameConfig?.trusted === true && !trusted) return false;
    const startsAt = Number(l.startsAt);
    if (serverNow !== undefined && startsAt > 0 && startsAt - serverNow < MIN_LEFT_MS) return false;
    const max = Number(l.gameConfig?.maxPlayers);
    return !(max > 0 && Number(l.numClients) > max - MIN_FREE);
  });
}

export class LockClaims {
  mine: string | null = null;
  private release: (() => void) | null = null;
  constructor(private locks: Locks) {}

  /** The first lobby no other tab holds, now held by this tab (null: all taken). */
  async claim<L extends Lobby>(lobbies: L[]): Promise<L | null> {
    for (const l of lobbies) {
      const id = l?.gameID;
      if (!id) continue;
      if (id === this.mine) return l;
      const release = await holdLock(this.locks, GAME_LOCK + id);
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
