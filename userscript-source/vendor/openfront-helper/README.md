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
| `bot-markers.js` | same name | Allied/teammate nations get a green dot instead of red, so the game's alliance icon stays readable; dots are smaller (9 px instead of 13 px) |
| `boat-prediction.js` | same name | `boatBoldTrails` flag (set by the glue's "Boat target marks" toggle): a hollow, semi-transparent ringed crosshair on every landing tile (yours blue, allies/teammates green, others red) and no always-on route line (the thin route still shows on hover) |
| `name-overlay.js` | same name | The blue "/max" troops label shows "current/max"; current is colored against your current troops and max against your max: within ±10% yellow, fewer red, more green (yours stays blue). Gold is gray below a Hydrogen Bomb's cost, yellow from it, bold gold with a glow from a MIRV's cost (costs from the game config, else 5M / 25M). Money and troop tags are about 20% smaller |
| `alliances.js`, `gold-per-minute.js`, `team-build-stats.js`, `nuke-prediction.js`, `boat-panel.js`, `estate-panel.js`, `map-overlay-scheduler.js`, `advisor-intel.js`, `attack-highlight.js`, `nuke-trajectory.js`, `advisor-panel.js`, `attack-ratio-hotkey.js`, `build-timer.js`, `game-time-alert.js` | same names | none |
| `universal-path-finding.js` | `auto-bot/nukeBehavior.js` (lines 95-321), `auto-bot/portutil.js` (`within`, lines 146-150) | Only the Bezier and parabola path-finder math that nuke-trajectory uses. Nothing else from the auto-bot. |
| `auto-leave.js`, `sos-defense.js` | same names | none (`sos-defense` gets `emojiId`/`enqueueSignal` from `00-shims.js`) |
| `auto-donate.js` | `auto-donate.js` | An empty target list means every friendly human player (teammate or ally, not nation bots) instead of nobody. `sendGamePacket` and the settings cache are shims (see below). |
| `anti-afk.js` | `anti-afk.js` | Rewritten around the upstream idea. Nothing runs at load; no Worker; no `setInterval`-to-Worker hub (page.ts already runs `window.setInterval` on a worker clock while the tab is hidden). The keep-alive re-runs the game's own ping callback instead of sending a hand-built JSON ping. |
| `00-shims.js` | not upstream, except `getTradeEventGoldAmount` from `trade-balances.js` | An English pass-through `tr()`, the one trade-balances helper that gold-per-minute needs, and for the acting features: `sendGamePacket` / `enqueueSignal` (both send through the bot's intent path), `emojiId` (the game's emoji table), and `_quickPanelSettingsCache` with the auto-donate defaults |
| `zz-ofbot-glue.js` | not upstream | `window.__ofbotHelper.features`: one `{ key, label, title, set(on) }` per feature, with teardown on `set(false)`; `window.__ofbotHelper.api` (set by page.ts) for the acting features |
| `assemble.mjs` | not upstream | File order and the IIFE wrapper |

## Not taken

- **ws-hook.js:** none of it. Since v0.35 the game's WebSocket messages are
  binary (zbin), and the server kicks a client whose message it can't decode
  (`SocketIngress.receive`). Upstream's hook sends JSON strings, so its
  `sendGamePacket`/`sendRawPacket` would get the player kicked; its skin
  unlocker (fetch and `JSON.parse` hooks) is not wanted. The features that used
  it send through the bot's intent path instead (below).
- **The rest of the networking and automation parts:** network/round loggers,
  bootstrap, panel-layout, quick-panel, auto-bot (apart from the path-finding
  math above), companion, helper-users-panel, signal-scheduler (replaced by the
  `enqueueSignal` shim), the selective trade policy (embargo),
  nuke-suggestions, silo-sam-tracker, right-click-conquest, boat-macro, the
  alliance-requests panel and spawn-heatmap.
- **trade-balances and heatmaps:** gold-per-minute needed only one small
  helper from them, which is copied into `00-shims.js`.
- **No toggle since 0.7.1:** the all-players / gold-per-minute panel (it hid
  the game's own leaderboard) and the advisor panel. `gold-per-minute.js` and
  `advisor-panel.js` stay in the build because other features share their
  helpers and constants.
- **No boats panel since 0.7.1.1:** `boat-panel.js`'s panel is never opened
  (the file stays in the build).
- **Removed in 0.7.2.2:** the "Boat + warship routes" toggle (its boat landing
  marks are covered by "Boat target marks"), `warship-routes.js` and the
  "Nuke-incoming alert" (`retaliation-hud.js`); both files are gone.

## Acting features

Four toggles act rather than only show things. All are off by default.

| Toggle (`key`) | What it does | Settings |
|---|---|---|
| Anti-AFK keep-alive (`antiAfk`) | While on, wraps `window.setInterval` (pass-through, same ids) only to recognise the game's own 5 s ping callback. Every 15 s while the tab is hidden, if that ping hasn't run for 12 s, it calls it once; the game encodes and sends the ping and checks the socket itself. Must be on before the match starts (the ping timer is made at game start). Off stops the timer and puts back the previous `window.setInterval` if nothing has wrapped it since; a ping callback already wrapped stays a plain pass-through. | fixed: 15 s check, 12 s stale |
| Auto-donate troops/gold (`autoDonate`) | Every 1 s. Troops: when yours are above `autoDonateKeepPct` of your max, sends `autoDonatePercentage` of them to the weakest (lowest troop %) target that is in a fight. Gold: above `autoDonateGoldThreshold`, sends `autoDonateGoldPercentage` to the poorest target. 3 s cooldown each; skipped where the game disables donations. | `autoDonateKeepPct` 40, `autoDonatePercentage` 25, `autoDonateTargets` "" , `autoDonateGoldThreshold` 5000000, `autoDonateGoldPercentage` 25, `autoDonateGoldTargets` "" (comma-separated name parts; empty = every friendly human player) |
| Auto-defend (SOS) (`sos`) | On the helper tick, while you are attacked by a non-friendly player: an 🆘 emoji to each ally/teammate (not nation bots) at most every 12 s, only with **Bot may send emojis** ticked, and a target mark on each attacker at most every 16 s per attacker (the game's target cooldown is 15 s). | fixed (upstream constants) |
| Auto-leave after a win (`autoLeave`) | Checks the end screen every 1 s; when it says you or your team won, goes to `/` once. The bot's game record is still saved (page.ts saves it on `pagehide`). | none |

The settings have no UI. To change them, put a JSON object with any of the
keys above in `localStorage["ofbot-helper-settings"]`; it is read each time
auto-donate is switched on (wrong-typed values are ignored).

How they send: auto-donate and auto-defend never touch the WebSocket. Their
intents (`donate_troops`, `donate_gold`, `emoji`, `targetPlayer`) go to
`window.__ofbotHelper.api`, which page.ts sets to its play-aid sender. That
path finds the game's EventBus and calls the game's own Transport handlers,
so the game encodes the messages, and it shares the bot's rate limiter (5/s
and 130/min in multiplayer, under the server's 10/s and 150/min), so helper
intents can't push the bot's moves over the server limit. Without that API
(page bundle not loaded, or no game) they send nothing.

## What runs at load

Load-time code only defines things, plus two small exceptions: four overlay
modules register a layer with the map-overlay scheduler (pure; draws nothing
until a flag is on), and auto-donate defines `window.__OFH_tickAutoDonate`
(does nothing unless the toggle is on). No vendored code hooks WebSocket,
fetch, XHR, `JSON.parse` or Worker, or posts to an extension. The only hook is
anti-AFK's pass-through `window.setInterval` wrapper, which exists only while
that toggle is on.
