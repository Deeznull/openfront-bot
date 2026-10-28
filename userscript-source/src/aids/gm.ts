/**
 * Page side of the GM_xmlhttpRequest bridge. The userscript's loader (emitted
 * by build.mjs) runs in the manager's sandbox, injects the bot into the page
 * and keeps one listener there: while switched on, it fetches GET requests to
 * https://api.ofstats.io/ (and nothing else) for the rank badges aid, since
 * ofstats sends no CORS headers and a page fetch is blocked.
 *
 * Events on `document`, details are JSON strings (strings cross the
 * sandbox/page boundary in every manager):
 *   page -> loader  ofbot:gm-ctl  "on" | "off"
 *   loader -> page  ofbot:gm-ready (answer to "on", synchronous)
 *   page -> loader  ofbot:gm-req  {id, url}
 *   loader -> page  ofbot:gm-res  {id, status, text}
 */

export interface GmResponse {
  status: number;
  text: string;
}

let seq = 0;
let ready = false;
let listening = false;
const pending = new Map<number, (r: GmResponse | null) => void>();

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("ofbot:gm-ready", () => {
    ready = true;
  });
  document.addEventListener("ofbot:gm-res", (e) => {
    let d: any;
    try {
      d = JSON.parse(String((e as CustomEvent).detail));
    } catch {
      return;
    }
    const done = pending.get(d?.id);
    if (!done) return;
    pending.delete(d.id);
    done(typeof d.status === "number" ? { status: d.status, text: String(d.text ?? "") } : null);
  });
}

/** Switches the loader's ofstats fetching on/off; true when a loader answered "on". */
export function gmSwitch(on: boolean): boolean {
  listen();
  ready = false;
  document.dispatchEvent(new CustomEvent("ofbot:gm-ctl", { detail: on ? "on" : "off" }));
  if (!on) {
    for (const done of pending.values()) done(null);
    pending.clear();
  }
  return ready;
}

/** GET through the loader; null on any failure (no bridge, network, timeout). */
export function gmGet(url: string, timeoutMs = 20000): Promise<GmResponse | null> {
  listen();
  if (!ready) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    document.dispatchEvent(new CustomEvent("ofbot:gm-req", { detail: JSON.stringify({ id, url }) }));
  });
}
