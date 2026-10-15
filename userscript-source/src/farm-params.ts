import type { BotParams } from "ofengine";

/**
 * Easy solo profile (the farm). Merged over PLAY_TWEAKS only in singleplayer
 * games on Easy; every other game keeps the general profile. minKeep stays
 * 0.2 (owner rule). Values: tuned by headless Easy sweeps (BOT_PROGRESS.md).
 *
 * selfDiff 1: the inherited nation behaviours (upgrades, SAM ratio, targets,
 * retaliation) run with Impossible logic instead of the lobby's Easy logic.
 * Sweep 2026-10-15 (World/Europe/Asia/NorthAmerica x 6 seeds, Easy): 24/24
 * wins either way, mean win 11.9 min vs 13.9 min without it. Keep, reserve,
 * trigMax, mirvSave and rate variants on top changed nothing or were slower.
 *
 * tribeKill 1: size tribe attacks to finish them in one go. Mean win 11.36
 * vs 11.93 (seeds f1-f6) and 11.90 vs 12.97 (fresh seeds g1-g6), 24/24 wins
 * each. defPost 1 on top added nothing (11.35).
 *
 * mirvSpend 0.5 + stackUp 3: keep building while a MIRV bank fills, and
 * stack City/Factory levels under SAM cover. Easy: neutral on win time
 * (24/24, 11.90 vs 11.93) but no hoarded gold (owner complaint). Not in
 * the general profile: on Impossible it lost (ab054: 58 and 55 wins vs 72).
 *
 * holdWin 32: solo XP is (50 + 17 per game minute up to 30 + win 15) x 0.25,
 * measured live 2026-10-15 (a 12-minute win paid about 60, a game past 30
 * minutes about 140). So the bot stops taking land near the 80% win line
 * until 32 game minutes (2 spare for the spawn phase); at Max speed that
 * costs little wall time, and only 5 solo games a day pay XP anyway.
 */
export const FARM_TWEAKS: Partial<BotParams> = { selfDiff: 1, tribeKill: 1, mirvSpend: 0.5, stackUp: 3, holdWin: 32 } as any;
