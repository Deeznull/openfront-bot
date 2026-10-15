import type { BotParams } from "ofengine";

/**
 * Easy solo profile (the farm). Merged over PLAY_TWEAKS only in singleplayer
 * games on Easy; every other game keeps the general profile. minKeep stays
 * 0.2. Values: tuned by headless Easy sweeps.
 *
 * mirvSpend 0.5 + stackUp 3: keep building while a MIRV bank fills, and
 * stack City/Factory levels under SAM cover. Easy: neutral on win time
 * (24/24, 11.90 vs 11.93) but no hoarded gold. Not in the general profile:
 * on Impossible it lost (58 and 55 wins vs 72 of 160).
 *
 * selfDiff 1 and tribeKill 1 won faster on Easy sweeps but are held back
 * until a spawn death (selfDiff, World Easy) and a stall are fixed.
 */
export const FARM_TWEAKS: Partial<BotParams> = { mirvSpend: 0.5, stackUp: 3 } as any;
