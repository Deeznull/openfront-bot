// Builds dist/openfront-bot.user.js (main engine) or
// dist/openfront-bot-openfrontio.user.js (v34): the shadow engine (game engine + bot,
// bundled from ../OpenFrontIO) wrapped in a function, then the page script.
//   node build.mjs [--repo <path to OpenFrontIO checkout>]
// The same engine version as the site keeps the shadow game hash-identical to
// the real one. A later site version that drifts from it is followed in
// mirror mode (src/mirror.ts) until it differs too much; then rebuild.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Optional openfront-helper features (window.__ofbotHelper), vendored as plain
// scripts and inserted unbundled into the page part, ahead of the page bundle.
import { buildHelperLayer } from "./vendor/openfront-helper/assemble.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argRepo = process.argv.indexOf("--repo");
const repo = path.resolve(argRepo > 0 ? process.argv[argRepo + 1] : path.join(here, "..", "OpenFrontIO"));
const require = createRequire(path.join(repo, "package.json"));
const esbuild = require("esbuild");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

// Engine layout: the monorepo (packages/engine, this project's fork) or the
// single-package src/core layout that the live site (v0.34) runs. The matching
// adapter (src/engine-*.ts) gives shadow.ts one API for both.
const kind = fs.existsSync(path.join(repo, "packages", "engine")) ? "main" : "v34";
if (kind === "v34" && !fs.existsSync(path.join(repo, "src/core/execution/bot/BotExecution.ts"))) {
  console.error(
    `${repo} has no src/core/execution/bot/BotExecution.ts. Port the bot first (see README: "Building for the live site").`,
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
// the live build (v34, or a main-layout engine built with --live, e.g. the
// site's v0.35 tag) is for the live site, the main build for the fork and the dev
// client. If both get installed anyway, the first to load wins (guard below).
const live = kind === "v34" || process.argv.includes("--live");
const target =
  live
    ? {
        file: "openfront-bot-openfrontio.user.js",
        name: "OpenFront Bot",
        sites: [],
        // Any openfront.<tld> (openfront.io, openfront.com, openfront.co.uk, ...) and its subdomains.
        includes: [String.raw`/^https?:\/\/([a-z0-9-]+\.)*openfront\.[a-z]{2,}(\.[a-z]{2,})?(:\d+)?\//`],
        // Installed copies update themselves when a rebuilt script is pushed.
        update: "https://raw.githubusercontent.com/Deeznull/openfront-bot/main/openfront-bot.user.js",
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
${[...target.sites.map((m) => `// @match        ${m}`), ...(target.includes ?? []).map((m) => `// @include      ${m}`)].join("\n")}
${target.update ? `// @updateURL    ${target.update}\n// @downloadURL  ${target.update}\n` : ""}// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      api.ofstats.io
// @inject-into  page
// @noframes
// ==/UserScript==
`;

const helperLayer = await buildHelperLayer({ minify: common.minify && esbuild.transform });

// The @grant above (for the rank badges aid) makes userscript managers run the
// script in their sandbox instead of the page. So everything the bot runs is
// one function, __ofbotPage, that the loader below puts into the page as an
// inline <script> (openfront.io sends no script-src CSP): it runs there
// synchronously at document-start, exactly as the script did with @grant none.
// If that injection does not run (a CSP added later), it runs in place.
// The loader keeps only the GM_xmlhttpRequest bridge (src/aids/gm.ts): GET
// https://api.ofstats.io/ only, and only while the page has switched it on.
const loader = `
/* Loader: runs in the userscript manager's context. */
(function () {
  var d = document;
  if (typeof GM_xmlhttpRequest === "function") {
    var on = false;
    var OK = /^https:\\/\\/api\\.ofstats\\.io\\/[^\\s#]*$/;
    var reply = function (id, status, text) {
      d.dispatchEvent(new CustomEvent("ofbot:gm-res", { detail: JSON.stringify({ id: id, status: status, text: text }) }));
    };
    d.addEventListener("ofbot:gm-ctl", function (e) {
      on = e.detail === "on";
      if (on) d.dispatchEvent(new CustomEvent("ofbot:gm-ready"));
    });
    d.addEventListener("ofbot:gm-req", function (e) {
      var q;
      try { q = JSON.parse(String(e.detail)); } catch (_) { return; }
      if (!q || typeof q.id !== "number") return;
      if (!on || typeof q.url !== "string" || !OK.test(q.url)) return reply(q.id, null, "");
      var fail = function () { reply(q.id, null, ""); };
      try {
        GM_xmlhttpRequest({
          method: "GET", url: q.url, anonymous: true, timeout: 15000, headers: { accept: "application/json" },
          onload: function (r) { reply(q.id, r.status, String(r.responseText || "").slice(0, 2000000)); },
          onerror: fail, ontimeout: fail, onabort: fail
        });
      } catch (_) { fail(); }
    });
  }
  var ran = false;
  var mark = function () { ran = true; };
  d.addEventListener("ofbot:page-ran", mark);
  try {
    var s = d.createElement("script");
    s.textContent = "(" + __ofbotPage.toString() + ")();";
    (d.head || d.documentElement).appendChild(s);
    s.remove();
  } catch (_) {}
  d.removeEventListener("ofbot:page-ran", mark);
  if (!ran) {
    console.warn("[ofbot] could not inject into the page; running in the userscript context");
    __ofbotPage();
  }
})();
`;

const out =
  header +
  "\n/* Includes code adapted from devdanetra/openfront-pro (MIT, (c) 2026 devdanetra); see NOTICE in the source repository. */\n" +
  "\nfunction __ofbotPage() {\n" +
  'document.dispatchEvent(new CustomEvent("ofbot:page-ran"));\n' +
  "\n/* Shadow engine (game engine + bot), started in a Worker from this function's source. */\n" +
  "function __ofbotShadowMain() {\n" +
  shadow.outputFiles[0].text +
  "\n}\n\n/* Page script, once per page even if two builds are installed. */\n" +
  "if (window.__ofbotLoaded) {\n" +
  '  console.warn("[ofbot] build " + window.__ofbotLoaded + " is already running here; this one stays off.");\n' +
  "} else {\n" +
  `window.__ofbotLoaded = ${JSON.stringify(`${kind} ${commit}`)};\n` +
  helperLayer +
  page.outputFiles[0].text +
  "\n}\n}\n" +
  loader;

fs.mkdirSync(path.join(here, "dist"), { recursive: true });
const file = path.join(here, "dist", target.file);
fs.writeFileSync(file, out);
console.log(`wrote ${path.relative(process.cwd(), file)} (${(out.length / 1024).toFixed(0)} KiB, engine ${kind} ${commit})`);
