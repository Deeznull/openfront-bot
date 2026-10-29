// Builds the optional openfront-helper layer for the userscript: the vendored
// sloppy-mode scripts concatenated in upstream INGAME_FILES order (glue last)
// inside one try/catch IIFE. Not bundled by esbuild: these are classic scripts
// that share one scope, not ES modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export const HELPER_FILES = [
  "00-shims.js",
  "anti-afk.js",
  "runtime.js",
  "shared-utils.js",
  "game-context.js",
  "alliances.js",
  "bot-markers.js",
  "gold-per-minute.js",
  "team-build-stats.js",
  "nuke-prediction.js",
  "boat-prediction.js",
  "boat-panel.js",
  "estate-panel.js",
  "auto-leave.js",
  "universal-path-finding.js",
  "sos-defense.js",
  "map-overlay-scheduler.js",
  "advisor-intel.js",
  "name-overlay.js",
  "attack-highlight.js",
  "nuke-trajectory.js",
  "advisor-panel.js",
  "attack-ratio-hotkey.js",
  "build-timer.js",
  "game-time-alert.js",
  "auto-donate.js",
  "zz-ofbot-glue.js",
];

export const HELPER_BANNER =
  "\n/* Optional helper layer: openfront-helper features (AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors;" +
  " see vendor/openfront-helper/README.md). All off until toggled via window.__ofbotHelper. */\n";

// Banner + IIFE. minify: an async (code, options) => ({ code }) transform such
// as esbuild.transform (script mode, no bundling); it gets the settings
// upstream uses for this same code (whitespace + identifiers, no syntax rewrites).
export async function buildHelperLayer({ minify } = {}) {
  const body = HELPER_FILES.map(
    (f) => `\n// ===== vendor/openfront-helper/${f} =====\n` + fs.readFileSync(path.join(dir, f), "utf8"),
  ).join("");
  let iife =
    "(function(){ try {\n" +
    body +
    '\n} catch (e) { console.warn("[ofbot] helper layer failed", e); } })();\n';
  if (minify) {
    iife = (
      await minify(iife, {
        minifyWhitespace: true,
        minifyIdentifiers: true,
        minifySyntax: false,
        legalComments: "none",
        charset: "utf8",
      })
    ).code;
  }
  return HELPER_BANNER + iife;
}
