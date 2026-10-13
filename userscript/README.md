# OpenFront bot userscript

Plays OpenFront in your browser tab with this project's `BotExecution`,
the same bot that runs in `tests/bot/BotGame.ts`. It sends normal player
intents (attack, boat, build, alliance, …) through the game client, the same
way your clicks would.

Works in every game mode (Singleplayer, Private and Public lobbies). It stays
off only when you have no player of your own (replays, spectating).

## Install

1. Build it (needs the repo's `node_modules`):
   ```bash
   node build.mjs
   ```
   This writes `dist/openfront-bot.user.js` (the fork and the dev client).
   For openfront.io, build `dist/openfront-bot-openfrontio.user.js` instead
   (see "Building for openfront.io").
2. Install a userscript manager (Tampermonkey or Violentmonkey). In Chrome,
   turn on "Allow User Scripts" in the extension's details page. Don't paste
   the file: it is about 0.85 MB and often gets cut off. Serve it instead:
   ```bash
   python -m http.server 8765 --bind 127.0.0.1 --directory dist
   ```
   Then open http://127.0.0.1:8765/openfront-bot.user.js (or
   `openfront-bot-openfrontio.user.js`) and click **Install**.
3. Open the site. A small "OpenFront bot" panel appears at the top right, under the timer bar.
   - **Start bot** turns it on for the current game. Before a game, the button
     reads "Start bot (next game)" and arms the bot for the next game.
   - **Auto-start in each game** keeps the bot on for every allowed game.
   - **Bot may send emojis** is off by default.
   - The panel can be dragged and collapsed. Its settings are saved in
     `localStorage`.

Each build matches only the sites that run its engine: the openfront.io build
matches any `openfront.<tld>` domain (openfront.io, openfront.com, ...) and
its subdomains; the other one matches only the
`localhost:9000` (dev client). To add a host, edit `target` in `build.mjs` and
rebuild. If two builds are installed and both match a page, the first one to
load runs and the other stays off.

## The engine version must match the site

The bot runs a **shadow copy** of the game: the site's own worker and the
shadow receive the same turns. The shadow must therefore run *exactly* the
same engine code as the site. Build from the matching commit:

```bash
node build.mjs --repo "C:/path/to/OpenFrontIO-at-site-commit"
```

The header's `@description` records the engine and commit it was built from.
Every 10 ticks the script compares state hashes. On a mismatch, it reloads the
shadow from a snapshot of the real game. If that keeps failing (more than 4
times in 3 minutes), it stops and tells you that the engine versions differ.
Engines without snapshots (v0.34) can't be reloaded, so the bot stops at the
first mismatch.

## Building for openfront.io

openfront.io runs v0.34.24, which uses the older single-package layout
(`src/core/…`). Build from a checkout of that tag with the bot copied in:

```bash
git -C ../OpenFrontIO -c core.longpaths=true worktree add --detach ../OpenFrontIO-v0.34.24 v0.34.24
```

```bash
npm --prefix ../OpenFrontIO-v0.34.24 ci --ignore-scripts --no-audit --no-fund --engine-strict=false
```

```bash
mkdir -p ../OpenFrontIO-v0.34.24/src/core/execution/bot && sed -e 's#@openfront/engine-api/game/GameTypes#../../game/Game#' -e 's#@openfront/engine-api/game/GameMap#../../game/GameMap#' -e 's#@openfront/engine-lib/PseudoRandom#../../PseudoRandom#' -e 's#@openfront/engine-lib/Util#../../Util#' ../OpenFrontIO/packages/engine/src/execution/bot/BotExecution.ts > ../OpenFrontIO-v0.34.24/src/core/execution/bot/BotExecution.ts
```

```bash
node build.mjs --repo ../OpenFrontIO-v0.34.24
```

If the site moves to a new version, repeat this with the new tag (the page
footer and the `@description` show the versions). The bot must still compile
there (`npx tsc --noEmit` in that checkout).

## How it works

- At `document-start` the script wraps `window.Worker`. When the game creates
  its engine worker, the script copies the `init` and `turn` messages into
  the shadow engine. The shadow runs in its own Web Worker, or on the page if
  blob workers are blocked.
- After each tick, the shadow runs `BotExecution` for your player. It does not
  apply what the bot decides. Instead, it captures the executions the bot would
  add and turns them into intents. The shadow game is never changed by the bot,
  so the hashes stay equal.
- The page sends the intents through the client's own `Transport` handlers,
  found on the game's `EventBus`. Sending is rate-limited to stay under the
  server's limits: 5 per second and 130 per minute in multiplayer games, 10 per
  second in Singleplayer. Duplicate intents and intents older than 2.5 s are
  dropped.
- Game gate (`src/page.ts`, `onInit`): without our own `clientID` (spectating
  or a replay) the shadow never starts. Turns, sync and sending all check
  `ctx.allowed`.
- Tribes (the small gray `PlayerType.Bot` players) are food only. The shadow
  drops every alliance, extension, break, embargo, target and emoji intent
  aimed at one. If we are allied with a tribe anyway, it also drops attacks
  and boats on it, so there's no betrayal. Boats to a tribe we border by land
  are dropped too, because a land attack gets there sooner.
- The bot never betrays. The shadow drops every `breakAlliance` intent and
  every attack or boat on an ally, and the bot closes all of the Nation AI's
  betrayal paths. Renewals we already agreed to are not sent again.
- `PLAY_TWEAKS` in `src/shadow.ts` changes the tuned set for play:
  - `snipeWeak: 0.3` (boat-snipe only losing players) and `snipeAlly: 1` (also
    snipe far players we could ally with, then ask them for an alliance right
    away; a boat that lands on an ally takes the tile without an attack).
  - `allySelect: 1`: diplomacy by situation instead of accepting everyone.
    Players with ≥ 0.7× our troops are threats: accept them, renew first and
    ask at any distance. Bordering players under 0.4× are food: no alliance.
    The alliance count stays under the Impossible/Hard cap (nations refuse
    anyone allied with ≥ 25% / 50% of players), so the renewals that matter
    get accepted. Renewals go out in the in-game renewal window. A refused
    ask is retried after 30 s, then 1, 2, 4 and 8 min. Troops stay home
    against an ally whose alliance is about to run out unrenewed. The Nation
    AI's own accept/renew/ask logic is switched off.
  - `tribeSteal: 1`, `finishK: 0.05`: join a tribe kill someone else (an ally
    too) is making, and finish any bordering tribe that is now cheap to kill.
  - `factLink: 1`: factories only where the rail preview links them to a city,
    port or factory (anyone's).
  - War tactics, only when the politics allow it (we are not weaker, no other
    strong non-ally borders us, nobody else is hitting us hard):
    - `warSnipe: 1`: boat-snipe the war enemy's coastal cities and ports.
    - `snipeBurst: 3`: send up to 3 boats when the landing is close and an
      enemy warship guards it.
    - `landPush: 1`: push by land when our boat lands, so their counter-push
      can't wipe the beachhead.
    - While the war gains ground we don't ask that enemy for an alliance. A
      stalled war can end in one.
  - `boatCounter: 1`: when an enemy boat lands, attack the lander at once. Our
    attack cancels the landing 1:1.
  - `navy: 1`: against a serious naval invasion (a strong invader, or ≥ 10%
    of our troops on boats), move our nearest warship to it or build one.
    On an island (no land neighbor but tribes), keep one guard warship by the
    biggest port once the gold is spare.

## Test

Headless check: a real `GameRunner` acts as the site, the shadow runs the bot,
and the bot's intents are fed back as turns.

```bash
node build.mjs --test
```

(add `--repo ../OpenFrontIO-v0.34.24` to test the openfront.io engine)

```bash
node test-dist/sim.mjs --min 6 --map World --difficulty Impossible
```

The shadow runs in a worker thread, as it does in the browser (the v0.34
engine caches the map per process, so two games can't share one). The test
passes when all hashes match (including after a mid-game snapshot resync on
engines that have one), neither game reports errors, and the bot still owns
land. A lost game against Impossible nations fails the last check without
meaning a script bug, so try another `--seed`. `--noresync` skips the resync;
`--nobot` runs the shadow without the bot.

To test in a real browser, run the dev client (`npm run dev` in the repo,
then http://localhost:9000), install the script, and start a Singleplayer game.

## Files

| File | Purpose |
|---|---|
| `src/page.ts` | Worker hook, game gate, desync/resync, intent sending, panel UI |
| `src/shadow.ts` | Shadow engine and bot step; turns captured executions into intents |
| `src/shadow-entry.ts` | Worker or page entry point for the shadow bundle |
| `src/engine-main.ts`, `src/engine-v34.ts` | One engine API for both repo layouts (picked by `build.mjs`) |
| `build.mjs` | esbuild bundle that writes the userscript (`--test` builds the test) |
| `test/sim.ts` | Headless integration test |
| `test/shadow-thread.ts`, `test/node-*.ts` | Test shadow worker thread; map loading per engine |
