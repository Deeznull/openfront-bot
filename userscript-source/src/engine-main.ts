/**
 * Engine adapter for the monorepo layout (packages/engine, engine-api, …),
 * i.e. this project's fork. build.mjs aliases `ofengine` to this file when the
 * repo has packages/engine. The init message carries the map files, and the
 * engine can restore from a snapshot (used to resync after a desync).
 */
import { createGameRunner, createGameRunnerFromSnapshot } from "@openfront/engine/GameRunner";

export type { GameRunner } from "@openfront/engine/GameRunner";
export type { Game, Player } from "@openfront/engine/game/Game";
export { AUTOPLAY_PARAMS, BotExecution } from "@openfront/engine/execution/bot/BotExecution";
export type { BotParams } from "@openfront/engine/execution/bot/BotExecution";
export { Nation, UnitType } from "@openfront/engine-api/game/GameTypes";
export { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
export { PlayerImpl } from "@openfront/engine/game/PlayerImpl";
export { UnitImpl } from "@openfront/engine/game/UnitImpl";
export { AllianceRequestImpl } from "@openfront/engine/game/AllianceRequestImpl";
export { AttackExecution } from "@openfront/engine/execution/AttackExecution";
export { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
export { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
export { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
export { TargetPlayerExecution } from "@openfront/engine/execution/TargetPlayerExecution";
export { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
export { AllianceExtensionExecution } from "@openfront/engine/execution/alliance/AllianceExtensionExecution";
export { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
export { MirvExecution } from "@openfront/engine/execution/MIRVExecution";
export { NukeExecution } from "@openfront/engine/execution/NukeExecution";
export { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
export { EmojiExecution } from "@openfront/engine/execution/EmojiExecution";
export { QuickChatExecution } from "@openfront/engine/execution/QuickChatExecution";
export { DonateTroopsExecution } from "@openfront/engine/execution/DonateTroopExecution";
export { DonateGoldExecution } from "@openfront/engine/execution/DonateGoldExecution";

/** Where the shadow gets the map: here, the files from the init message. */
export interface MapSource {
  files?: any;
  assets?: { base: string; manifest: Record<string, string> };
  loader?: any;
}

export const ENGINE = "main";
export const CAN_SNAPSHOT = true;

export function createRunner(
  gameStartInfo: any,
  clientID: string | undefined,
  src: MapSource,
  cb: (gu: any) => void,
  snapshot?: Uint8Array,
) {
  if (!src.files) throw new Error("init message had no map files");
  const map = structuredClone(src.files);
  return snapshot !== undefined
    ? createGameRunnerFromSnapshot(gameStartInfo, snapshot, clientID, map, cb)
    : createGameRunner(gameStartInfo, clientID, map, cb);
}

/**
 * This engine keeps no AI state in statics, but the game's shared-water cache
 * rebuilds at most every 30 ticks on the first call, so a bot call at another
 * tick would move the nations' port and factory choices. Saves it and returns
 * a function that puts it back after the bot step.
 */
export function saveSharedAiState(g?: unknown): () => void {
  const c = (g as any)?._sharedWaterCache;
  if (!c) return () => {};
  const { tick, byPlayer } = c;
  return () => {
    c.tick = tick;
    c.byPlayer = byPlayer;
  };
}
