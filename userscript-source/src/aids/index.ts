/**
 * All play aids: ours, then the overlays vendored from openfront-helper
 * (vendor/openfront-helper, a plain script build.mjs puts before this bundle;
 * it lists its toggles on window.__ofbotHelper).
 */
import type { Aid, AidApi } from "./core";
import { macros } from "./macros";
import { ranksAid } from "./ranks";
import { trailsAid } from "./trails";
import { troopsAid } from "./troops";
import { trollAid } from "./troll";

export type { Aid, AidApi, Intent } from "./core";

export function allAids(): Aid[] {
  const out: Aid[] = [macros, troopsAid, trailsAid, ranksAid, trollAid];
  const helper = (window as any).__ofbotHelper?.features ?? [];
  for (const f of helper) {
    if (!f || typeof f.key !== "string" || typeof f.set !== "function") continue;
    out.push({
      key: `h.${f.key}`,
      label: String(f.label ?? f.key),
      title: String(f.title ?? ""),
      def: false,
      start: () => f.set(true),
      stop: () => f.set(false),
    });
  }
  return out;
}

const running = new Set<string>();

/** Starts or stops one aid; errors stay inside it. */
export function setAid(a: Aid, on: boolean, api: AidApi) {
  if (on === running.has(a.key)) return;
  try {
    if (on) {
      a.start(api);
      running.add(a.key);
    } else {
      running.delete(a.key);
      a.stop();
    }
  } catch (e) {
    console.warn(`[ofbot] aid ${a.key} failed`, e);
  }
}
