/**
 * Engine adapter for the single-package layout (src/core/…) that openfront.io
 * v0.34.x runs. build.mjs aliases `ofengine` to this file when the repo has
 * src/core/GameRunner.ts, and `ofrepo` to the repo root. The bot is the
 * project's BotExecution, ported to src/core/execution/bot/ (imports only).
 *
 * Differences from the monorepo engine: the worker's init message carries no
 * map (the worker fetches it from the CDN, so the shadow does the same), and
 * there is no snapshot/restore, so a desync can't be repaired.
 */
import { createGameRunner } from "ofrepo/src/core/GameRunner";
import { FetchGameMapLoader } from "ofrepo/src/core/game/FetchGameMapLoader";
import { NationMIRVBehavior } from "ofrepo/src/core/execution/nation/NationMIRVBehavior";

export type { GameRunner } from "ofrepo/src/core/GameRunner";
export type { Game, Player } from "ofrepo/src/core/game/Game";
export { AUTOPLAY_PARAMS, BotExecution } from "ofrepo/src/core/execution/bot/BotExecution";
export type { BotParams } from "ofrepo/src/core/execution/bot/BotExecution";
export { Nation, UnitType } from "ofrepo/src/core/game/Game";
export { GameUpdateType } from "ofrepo/src/core/game/GameUpdates";
export { PlayerImpl } from "ofrepo/src/core/game/PlayerImpl";
export { UnitImpl } from "ofrepo/src/core/game/UnitImpl";
export { AllianceRequestImpl } from "ofrepo/src/core/game/AllianceRequestImpl";
export { AttackExecution } from "ofrepo/src/core/execution/AttackExecution";
export { TransportShipExecution } from "ofrepo/src/core/execution/TransportShipExecution";
export { ConstructionExecution } from "ofrepo/src/core/execution/ConstructionExecution";
export { MoveWarshipExecution } from "ofrepo/src/core/execution/MoveWarshipExecution";
export { TargetPlayerExecution } from "ofrepo/src/core/execution/TargetPlayerExecution";
export { SpawnExecution } from "ofrepo/src/core/execution/SpawnExecution";
export { AllianceExtensionExecution } from "ofrepo/src/core/execution/alliance/AllianceExtensionExecution";
export { AllianceRequestExecution } from "ofrepo/src/core/execution/alliance/AllianceRequestExecution";
export { MirvExecution } from "ofrepo/src/core/execution/MIRVExecution";
export { NukeExecution } from "ofrepo/src/core/execution/NukeExecution";
export { UpgradeStructureExecution } from "ofrepo/src/core/execution/UpgradeStructureExecution";
export { EmojiExecution } from "ofrepo/src/core/execution/EmojiExecution";
export { QuickChatExecution } from "ofrepo/src/core/execution/QuickChatExecution";
export { DonateTroopsExecution } from "ofrepo/src/core/execution/DonateTroopExecution";
export { DonateGoldExecution } from "ofrepo/src/core/execution/DonateGoldExecution";

/**
 * Where the shadow gets the map: `assets` = the site's asset base URL and its
 * content-hashed asset manifest (browser), or `loader` = a GameMapLoader
 * (headless test).
 */
export interface MapSource {
  files?: any;
  assets?: { base: string; manifest: Record<string, string> };
  loader?: any;
}

export const ENGINE = "v34";
export const CAN_SNAPSHOT = false;

export function createRunner(
  gameStartInfo: any,
  clientID: string | undefined,
  src: MapSource,
  cb: (gu: any) => void,
  snapshot?: Uint8Array,
) {
  if (snapshot !== undefined) throw new Error("this engine has no snapshot restore");
  let loader = src.loader;
  if (!loader) {
    const a = src.assets;
    if (!a) throw new Error("no map source (asset base unknown)");
    const base = a.base.replace(/\/+$/, "");
    // Same lookup as the game's assetUrl(): hashed name from the manifest,
    // plain path otherwise.
    loader = new FetchGameMapLoader((p: string) => {
      const key = `maps/${p}`;
      const hashed = a.manifest[key];
      return hashed ? `${base}${hashed}` : `${base}/${key}`;
    });
  }
  return createGameRunner(gameStartInfo, clientID, loader, cb);
}

/**
 * Saves the AI state that is shared between nations through statics (here the
 * MIRV pile-on cooldown map) and returns a function that puts it back. The bot
 * step runs between the two, so whatever it records never reaches the nations.
 */
export function saveSharedAiState(): () => void {
  const m = (NationMIRVBehavior as any).recentMirvTargets as Map<string, number> | undefined;
  if (!m) return () => {};
  const copy = new Map(m);
  return () => {
    m.clear();
    for (const [k, v] of copy) m.set(k, v);
  };
}
