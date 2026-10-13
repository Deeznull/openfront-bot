/**
 * Stand-in for an online human in a simulated public FFA lobby: a Human-type
 * player (human troop/gold rules, no Nation bonuses) whose decisions are the
 * Impossible Nation AI. The game's global difficulty stays Medium (the real
 * public-FFA setting, used by the real Nations), so the stand-in sees the game
 * through a view whose gameConfig().difficulty reads Impossible.
 *
 * It spawns like a human: picks a scored spot (free land, tribes, away from
 * others) at a random moment of the spawn phase, via BotExecution.chooseSpawn.
 */
import type { Game } from "@openfront/engine/game/Game";
import { Difficulty, Nation } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import {
  BotExecution,
  DEFAULT_PARAMS,
} from "@openfront/engine/execution/bot/BotExecution";

/**
 * A view of `obj` whose methods run on `obj` itself, with some keys overridden.
 * A plain object with pre-bound methods and forwarding accessors: same behavior
 * as a Proxy, but without a trap on every property read (the Proxy cost ~7% of
 * a roulette game's CPU).
 */
function view<T extends object>(obj: T, overrides: Record<PropertyKey, unknown>): T {
  const v: Record<PropertyKey, unknown> = {};
  const seen = new Set<PropertyKey>(Object.keys(overrides));
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Reflect.ownKeys(o)) {
      if (k === "constructor" || seen.has(k)) continue;
      seen.add(k);
      const d = Object.getOwnPropertyDescriptor(o, k)!;
      if (typeof d.value === "function") {
        v[k as string] = (d.value as (...a: unknown[]) => unknown).bind(obj);
      } else {
        Object.defineProperty(v, k, {
          get: () => Reflect.get(obj, k, obj),
          set: (x) => Reflect.set(obj, k, x, obj),
          enumerable: true,
        });
      }
    }
  }
  Object.assign(v, overrides);
  return v as T;
}

function withDifficulty(game: Game, difficulty: Difficulty): Game {
  const cfg = game.config();
  const gc = { ...cfg.gameConfig(), difficulty };
  const cfgView = view(cfg, { gameConfig: () => gc });
  return view(game, { config: () => cfgView });
}

export class StandInExecution extends BotExecution {
  constructor(gameID: string, nation: Nation) {
    const r = new PseudoRandom(simpleHash(gameID) + simpleHash(nation.playerInfo.id));
    // Same ranges as an Impossible NationExecution (trigger 50-60%, reserve
    // 30-40%, expand 10-20%, attack every 30-50 ticks); everything else is the
    // plain Nation AI (DEFAULT_PARAMS turn every bot feature off).
    super(gameID, nation, {
      ...DEFAULT_PARAMS,
      trigger: r.nextInt(50, 60) / 100,
      reserve: r.nextInt(30, 40) / 100,
      expand: r.nextInt(10, 20) / 100,
      rate: r.nextInt(30, 50),
      spawnDelay: r.nextInt(5, 150),
      spawnSamples: 150,
    });
  }

  /** Fair comparisons: ignore our bot's spawn so enemy spawns are the same for every param set. */
  ignoreSpawnOf(clientID: string): this {
    this.spawnIgnore = clientID;
    return this;
  }

  init(mg: Game) {
    super.init(withDifficulty(mg, Difficulty.Impossible));
  }
}
