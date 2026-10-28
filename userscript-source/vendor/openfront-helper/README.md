# Vendored openfront-helper features

Optional in-game helper features taken from the openfront-helper userscript and
offered as toggles through `window.__ofbotHelper`. Every feature is off until
it is switched on.

- Source: https://github.com/nguyenvancaokyfpt/openfront-helper-userscript
- Upstream commit: `a4c695720ac19e546ba688659120131ef1c21cb0`
- License: AGPL-3.0-or-later, copyright nguyenvancaokyfpt and contributors.
  This project is AGPL as well. Each copied file starts with a header naming
  its upstream path and any trims.

## How it is built

`assemble.mjs` lists the files in upstream `INGAME_FILES` order, with
`00-shims.js` first and `zz-ofbot-glue.js` last. `build.mjs` concatenates them
into one `(function(){ try { ... } catch (e) { ... } })();` block. That block
sits in the page part of the userscript, after the `__ofbotLoaded` guard and
before the page bundle.

- The files are classic sloppy-mode scripts that share one scope. They are not
  bundled as ES modules.
- In minified builds the block goes through `esbuild.transform` with
  upstream's own settings: whitespace and identifiers only, no syntax rewrites.

## Files

| File here | Upstream (`engine/ingame/`) | Changes |
|---|---|---|
| `runtime.js` | `runtime.js` | Removed `PAGE_SOURCE`/`EXTENSION_SOURCE`, `postToExtension`, the load-time `public-lobbies-update` listener, the auto-renew `localStorage` read (now `false`), and the trade/heatmap-only helpers (`canStationTradeWith`, `getHeatmapTypePriority`, `addEconomicSource` and its index) |
| `shared-utils.js` | `shared-utils.js` | none |
| `game-context.js` | `selective-trade-policy.js` (lines 1-89, 178-186, 488-579) | Keeps only game-context discovery (`getOpenFrontGameContext` and helpers, `isTeamGame`, `getGameConfig`, `isHumanPlayer`). All embargo / selective-trade code, the `report*`/`refresh*` functions and the custom/solo/cheats checks are gone. |
| `alliances.js`, `bot-markers.js`, `gold-per-minute.js`, `team-build-stats.js`, `nuke-prediction.js`, `boat-prediction.js`, `warship-routes.js`, `boat-panel.js`, `estate-panel.js`, `map-overlay-scheduler.js`, `advisor-intel.js`, `name-overlay.js`, `attack-highlight.js`, `nuke-trajectory.js`, `advisor-panel.js`, `retaliation-hud.js`, `attack-ratio-hotkey.js`, `build-timer.js`, `game-time-alert.js` | same names | none |
| `universal-path-finding.js` | `auto-bot/nukeBehavior.js` (lines 95-321), `auto-bot/portutil.js` (`within`, lines 146-150) | Only the Bezier and parabola path-finder math that nuke-trajectory uses. Nothing else from the auto-bot. |
| `00-shims.js` | not upstream, except `getTradeEventGoldAmount` from `trade-balances.js` | An English pass-through `tr()`, plus the one trade-balances helper that gold-per-minute needs |
| `zz-ofbot-glue.js` | not upstream | `window.__ofbotHelper.features`: one `{ key, label, title, set(on) }` per feature, with teardown on `set(false)` |
| `assemble.mjs` | not upstream | File order and the IIFE wrapper |

## Not taken

- **The networking and automation parts of the helper:** anti-afk, ws-hook,
  network/round loggers, bootstrap, panel-layout, quick-panel, auto-bot (apart
  from the path-finding math above), companion, auto-donate, sos-defense,
  helper-users-panel, signal-scheduler, the selective trade policy (embargo),
  auto-leave, nuke-suggestions, silo-sam-tracker, right-click-conquest,
  boat-macro, the alliance-requests panel and spawn-heatmap.
- **trade-balances and heatmaps:** gold-per-minute needed only one small
  helper from them, which is copied into `00-shims.js`.

No vendored code sends game intents, hooks WebSocket/fetch/XHR/timers/Worker,
or posts to an extension. Load-time code only defines things. The one
exception is that four overlay modules register a layer with the map-overlay
scheduler. That registration is pure and draws nothing until a flag is on.
