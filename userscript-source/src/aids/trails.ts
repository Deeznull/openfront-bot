/**
 * Solid boat trails: draws the game's own transport-ship trails without
 * transparency. The client draws all trails in one WebGL pass whose alpha is a
 * fixed render setting (mapOverlay.trailAlpha, 0.588) with no user override.
 *
 * At load we wrap four WebGL2 calls (pass-through for everything else):
 * - shaderSource: in the trail fragment shader only, adds `uOfbotSolid` and
 *   makes boat texels (not nuke texels) use mix(uTrailAlpha, 1, uOfbotSolid).
 *   A new uniform reads 0, so the shader draws exactly as before until set.
 * - attachShader / getUniformLocation: remember which program and which
 *   uTrailAlpha location belong to that shader.
 * - uniform1f: when the game sets that uTrailAlpha (every frame), also sets
 *   uOfbotSolid to 1 or 0 from the toggle.
 * The hook must exist before the match builds its renderer, so it is installed
 * when the script loads; the checkbox only flips the flag, any time.
 */
import type { Aid } from "./core";

const ALPHA_DECL = "uniform float uTrailAlpha;";
const ALPHA_OUT = "fragColor = vec4(color, uTrailAlpha);";

let solid = false;

function install() {
  const P = (window as any).WebGL2RenderingContext?.prototype;
  if (!P || P.__ofbotTrails) return;
  P.__ofbotTrails = true;
  const patchedShaders = new WeakSet<object>();
  const patchedPrograms = new WeakSet<object>();
  const solidLoc = new WeakMap<object, WebGLUniformLocation>();

  const shaderSource = P.shaderSource;
  P.shaderSource = function (this: WebGL2RenderingContext, sh: WebGLShader, src: string) {
    if (
      typeof src === "string" &&
      src.includes(ALPHA_DECL) &&
      src.includes(ALPHA_OUT) &&
      src.includes("isNuke")
    ) {
      src = src
        .replace(ALPHA_DECL, `${ALPHA_DECL}\nuniform float uOfbotSolid;`)
        .replace(
          ALPHA_OUT,
          "fragColor = vec4(color, isNuke == 1u ? uTrailAlpha : mix(uTrailAlpha, 1.0, uOfbotSolid));",
        );
      patchedShaders.add(sh);
    }
    return shaderSource.call(this, sh, src);
  };

  const attachShader = P.attachShader;
  P.attachShader = function (this: WebGL2RenderingContext, prog: WebGLProgram, sh: WebGLShader) {
    if (sh && patchedShaders.has(sh)) patchedPrograms.add(prog);
    return attachShader.call(this, prog, sh);
  };

  const getUniformLocation = P.getUniformLocation;
  P.getUniformLocation = function (this: WebGL2RenderingContext, prog: WebGLProgram, name: string) {
    const loc = getUniformLocation.call(this, prog, name);
    if (loc && name === "uTrailAlpha" && patchedPrograms.has(prog)) {
      const s = getUniformLocation.call(this, prog, "uOfbotSolid");
      if (s) solidLoc.set(loc, s);
    }
    return loc;
  };

  const uniform1f = P.uniform1f;
  P.uniform1f = function (this: WebGL2RenderingContext, loc: WebGLUniformLocation | null, v: number) {
    const r = uniform1f.call(this, loc, v);
    const s = loc && solidLoc.get(loc);
    if (s) uniform1f.call(this, s, solid ? 1 : 0);
    return r;
  };
}

try {
  install();
} catch (e) {
  console.warn("[ofbot] trail hook failed", e);
}

export const trailsAid: Aid = {
  key: "solidTrails",
  label: "Solid boat trails",
  title:
    "Draws the game's transport-boat trails fully opaque instead of see-through. " +
    "Nuke trails stay as they are. Needs the script loaded before the match starts (it is, unless installed mid-game).",
  def: false,
  start() {
    solid = true;
  },
  stop() {
    solid = false;
  },
};
