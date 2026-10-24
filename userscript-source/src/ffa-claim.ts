// Several tabs farming on one account (owner 2026-10-24: 10 tabs once the
// solo games are used): each must join a different FFA game, since the
// server lets an account into a game once (a second join is a duplicate
// session). A tab claims the gameID it joins in shared storage (localStorage
// is shared by all the site's tabs) and keeps the claim alive while it waits
// in the lobby or plays; other tabs skip claimed lobbies and wait for the
// next one. A claim dies with its page (reload after each game, closed tab)
// within CLAIM_MS.

export const CLAIMS_KEY = "ofbot.ffaClaims";
export const CLAIM_MS = 45_000;

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

  private read(now: number): Claims {
    let c: Claims = {};
    try {
      c = JSON.parse(this.store.getItem(CLAIMS_KEY) ?? "{}") ?? {};
    } catch {
      /* none */
    }
    for (const id of Object.keys(c)) if (!(now - c[id]?.at < CLAIM_MS)) delete c[id];
    return c;
  }

  private write(c: Claims) {
    try {
      this.store.setItem(CLAIMS_KEY, JSON.stringify(c));
    } catch {
      /* storage off: tabs can't coordinate */
    }
  }

  /** The first lobby no other live tab holds, claimed for this tab (null: all taken). */
  claim<L extends { gameID?: string }>(lobbies: L[], now: number): L | null {
    const c = this.read(now);
    for (const id of Object.keys(c)) if (c[id].tab === this.tab) delete c[id];
    const lobby = lobbies.find((l) => l?.gameID && !c[l.gameID]) ?? null;
    this.mine = lobby?.gameID ?? null;
    if (this.mine) c[this.mine] = { tab: this.tab, at: now };
    this.write(c);
    return lobby;
  }

  /** Refresh our claim (unless another tab won it in a race). */
  keepAlive(now: number) {
    if (!this.mine) return;
    const c = this.read(now);
    if (c[this.mine] && c[this.mine].tab !== this.tab) return;
    c[this.mine] = { tab: this.tab, at: now };
    this.write(c);
  }

  drop(now: number) {
    if (!this.mine) return;
    const c = this.read(now);
    if (c[this.mine]?.tab === this.tab) delete c[this.mine];
    this.write(c);
    this.mine = null;
  }
}
