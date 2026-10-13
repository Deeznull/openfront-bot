// Builds dist/openfront-bot.user.js (main engine) or
// dist/openfront-bot-openfrontio.user.js (v34): the shadow engine (game engine + bot,
// bundled from ../OpenFrontIO) wrapped in a function, then the page script.
//   node build.mjs [--repo <path to OpenFrontIO checkout>]
// The engine must be the same version the site runs, or the shadow game
// drifts from the real one (the script detects that and stops).
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argRepo = process.argv.indexOf("--repo");
const repo = path.resolve(argRepo > 0 ? process.argv[argRepo + 1] : path.join(here, "..", "OpenFrontIO"));
const require = createRequire(path.join(repo, "package.json"));
const esbuild = require("esbuild");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

// Engine layout: the monorepo (packages/engine, this project's fork) or the
// single-package src/core layout that openfront.io v0.34 runs. The matching
// adapter (src/engine-*.ts) gives shadow.ts one API for both.
const kind = fs.existsSync(path.join(repo, "packages", "engine")) ? "main" : "v34";
if (kind === "v34" && !fs.existsSync(path.join(repo, "src/core/execution/bot/BotExecution.ts"))) {
  console.error(
    `${repo} has no src/core/execution/bot/BotExecution.ts. Port the bot first (see README: "Building for openfront.io").`,
  );
  process.exit(1);
}

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
  const tag = execSync("git tag --points-at HEAD", { cwd: repo }).toString().trim().split(/\s+/)[0];
  if (tag) commit = `${tag}-${commit}`;
} catch {}

const common = {
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2020",
  nodePaths: [path.join(repo, "node_modules")],
  logLevel: "warning",
  legalComments: "none",
  // Minified by default so the file is small enough to paste/install; names
  // kept so stack traces stay readable. --no-minify for a debug build.
  minify: !process.argv.includes("--no-minify"),
  keepNames: true,
  alias: {
    ofrepo: repo,
    ofengine: path.join(here, `src/engine-${kind}.ts`),
    ofenums: path.join(here, `src/enums-${kind}.ts`),
    "ofengine-node": path.join(here, `test/node-${kind}.ts`),
  },
  define: { __OFBOT_VERSION__: JSON.stringify(`${pkg.version}+engine.${commit}`) },
};

if (process.argv.includes('--test')) {
  for (const name of ['sim', 'shadow-thread']) {
    await esbuild.build({
      ...common,
      write: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      entryPoints: [path.join(here, `test/${name}.ts`)],
      outfile: path.join(here, `test-dist/${name}.mjs`),
      define: { ...common.define, __REPO__: JSON.stringify(repo) },
      banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    });
  }
  console.log(`wrote test-dist/sim.mjs + shadow-thread.mjs (engine ${kind} ${commit})`);
  process.exit(0);
}


const shadow = await esbuild.build({ ...common, entryPoints: [path.join(here, "src/shadow-entry.ts")] });
const page = await esbuild.build({ ...common, entryPoints: [path.join(here, "src/page.ts")] });

// One script per engine, each matching only the sites that run that engine:
// the v34 build is for openfront.io, the main build for the fork and the dev
// client. If both get installed anyway, the first to load wins (guard below).
const target =
  kind === "v34"
    ? {
        file: "openfront-bot-openfrontio.user.js",
        name: "OpenFront Bot",
        sites: ["https://openfront.io/*", "https://*.openfront.io/*"],
        // Any openfront.<tld> (openfront.com, openfront.co.uk, ...) and its subdomains.
        includes: [String.raw`/^https?:\/\/([a-z0-9-]+\.)*openfront\.[a-z]{2,}(\.[a-z]{2,})?(:\d+)?\//`],
      }
    : {
        file: "openfront-bot.user.js",
        name: "OpenFront Bot (dev client)",
        sites: ["http://localhost:9000/*"],
      };

const header = `// ==UserScript==
// @name         ${target.name}
// @namespace    ofbot.local
// @version      ${pkg.version}
// @description  Plays as you with the trained OpenFront code bot when you press Start. Engine ${kind} ${commit}.
${target.sites.map((m) => `// @match        ${m}`).join("\n")}${(target.includes ?? []).map((m) => `\n// @include      ${m}`).join("")}
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==
`;

const out =
  header +
  "\n/* Shadow engine (game engine + bot), started in a Worker from this function's source. */\n" +
  "function __ofbotShadowMain() {\n" +
  shadow.outputFiles[0].text +
  "\n}\n\n/* Page script, once per page even if two builds are installed. */\n" +
  "if (window.__ofbotLoaded) {\n" +
  '  console.warn("[ofbot] build " + window.__ofbotLoaded + " is already running here; this one stays off.");\n' +
  "} else {\n" +
  `window.__ofbotLoaded = ${JSON.stringify(`${kind} ${commit}`)};\n` +
  page.outputFiles[0].text +
  "\n}\n";

fs.mkdirSync(path.join(here, "dist"), { recursive: true });
const file = path.join(here, "dist", target.file);
fs.writeFileSync(file, out);
console.log(`wrote ${path.relative(process.cwd(), file)} (${(out.length / 1024).toFixed(0)} KiB, engine ${kind} ${commit})`);
