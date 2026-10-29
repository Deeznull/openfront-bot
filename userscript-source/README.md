# OpenFront bot userscript

Plays OpenFront in your browser tab with this project's `BotExecution`,
the same bot that runs in `tests/bot/BotGame.ts`. It sends normal player
intents (attack, boat, build, alliance, …) through the game client, the same
way your clicks would.

Works in every game mode (Singleplayer, Private and Public lobbies). It stays
off only when you have no player of your own (replays, spectating).

## Install

A ready-built script for the live site is in the repository root:
`openfront-bot.user.js`. Install Tampermonkey (in Chrome, turn on "Allow
User Scripts" in the extension's details page), open the file on GitHub, click
**Raw** and then **Install**. To build it yourself instead, see "Building for
the live site" below; then add `dist/openfront-bot-openfrontio.user.js` with
Tampermonkey's **Dashboard → Utilities → Import from file**.

1. (Dev client only) `node build.mjs` writes `dist/openfront-bot.user.js`
   for the fork and the dev client.
2. Install the script as above.
3. Open the site. A small "OpenFront bot" panel appears at the top right, under the timer bar.
   - **Start bot** turns it on for the current game. Before a game, the button
     reads "Start bot (next game)" and arms the bot for the next game.
   - **Auto-start in each game** keeps the bot on for every allowed game.
   - **Bot may send emojis** is off by default.
   - **Farm** (off by default) plays game after game. With **Easy solo only**,
     from the homepage it starts an Easy solo game, the bot plays it at Max
     speed with turbo (the next turn starts as soon as the last one is done,
     also in a background tab), and after the game ends it goes home and
     starts the next one. **XP: Easy solo, then public FFA** plays the day's
     XP-paying solo games that way, then public FFA games. **Public FFA only**
     joins public FFA lobbies one after another (the next one after the bot
     dies or the game ends). The panel counts the games.
   - **Export game log** downloads a record of each online game played in
     this browser, then clears the log. A record holds the game and replay
     IDs, our player in the replay, the ticks the bot was on, the moves it
     sent, sync problems and errors, the place, and a checkpoint every 30 s
     (land, troops, gold, buildings, allies, who attacked us and whom we
     attacked, with their replay IDs).
   - The panel can be dragged and collapsed. Its settings are saved in
     `localStorage`.
   - **Play aids ▸** unfolds a list of optional helpers for your own play,
     all off by default. They work with the bot on or off. Each box they
     open can be dragged by its header and folded with –. The **All** switch
     turns every aid on or off at once; switching it on leaves Script chat
     off (tick that one by itself).
     - **Hold-key macros**: hold X and left-click the map to launch as many
       Atom Bombs as the gold pays for (max 50, the game's limit per
       intent); hold Z / V / H and click to build a Port / SAM Launcher /
       Missile Silo, or upgrade ours there by up to 50 levels. The click
       doesn't reach the game while the key is held. B (the game's boat key)
       is left alone, so the silo is on H. The intents go out ahead of the
       bot's, through the same rate limiter.
     - **Troop timing + safe donation**: troops against the cap, the mark
       where troop growth is fastest, growth per second, a wait/attack cue,
       what an attack at the current ratio sends, and the troops above a 35%
       reserve that are safe to donate.
     - **Solid boat trails**: the game's own transport-boat trails are drawn
       fully opaque instead of at the game's fixed 59% opacity; nuke trails
       are unchanged. At load the script wraps four WebGL2 calls to add one
       uniform to the game's trail shader (it reads 0 and draws as before
       until the toggle is on), so the script must be loaded before the match
       starts; the toggle itself works any time.
     - **Rank badges (ofstats.io)**: an ofstats.io rank (top %, win rate or
       "new") next to human player names on the hover card and the
       leaderboard. Sends player names, and the matching ofstats player ids,
       to api.ofstats.io; answers are cached for 10-30 minutes and requests
       are rate-limited. Off when the lobby anonymizes names. ofstats sends
       no CORS headers, so the requests go through the script manager's
       `GM_xmlhttpRequest` (see below).
     - **Script chat (Nostr)**: a chat box for players of this script in the
       same game. Messages are signed and sent to public Nostr relays
       (primal, nos.lol, nostr.mom, snort), which see your IP. Paused while
       you are alive in a free-for-all game. A fresh key per game is kept in
       `localStorage`; senders can be muted, floods are muted for a minute.
     - The overlays from `vendor/openfront-helper` (one checkbox each; the
       list is in that folder's README).
     - The script asks for `@grant GM_xmlhttpRequest` and `@connect
       api.ofstats.io` for the rank badges. That makes script managers run it
       in their sandbox, so a small loader puts the whole script into the page
       as an inline script, where it runs as before. The loader only forwards
       GET requests to `https://api.ofstats.io/`, and only while the rank
       badges are on.
   - **Multi-tab bypass (anti-vigilant mode):** the game's multi-tab detector
     (the pop-up that freezes you for 10 s when it sees another tab) is
     neutralized in every mode, public included, so the bot can run in several
     tabs at once. The detector is purely client-side, and the IP/device/
     "reported" values it shows are fake values generated locally, never sent
     anywhere.

Each build matches only the sites that run its engine: the live-site build
matches any `openfront.<tld>` domain and
its subdomains; the other one matches only the
`localhost:9000` (dev client). To add a host, edit `target` in `build.mjs` and
rebuild. If two builds are installed and both match a page, the first one to
load runs and the other stays off.

## Site updates (version tolerance)

The bot runs a **shadow copy** of the game: the site's own worker and the
shadow receive the same turns, and every 10 ticks the script compares state
hashes. Built from the site's engine version, the two stay identical. The
header's `@description` records the engine and commit.

- **Engines with snapshots** (the live site from v0.35.0, and the fork): on a mismatch the shadow reloads from
  a snapshot of the real game. If that keeps failing (more than 4 times in
  3 minutes), the bot stops and says the engine versions differ.
- **Engines without snapshots** (older sites on v0.34): the bot switches to
  **mirror mode** instead of stopping. The page forwards the real worker's
  per-tick updates; after each tick the shadow takes over the real tile owners,
  troops and gold, then runs the bot. The panel shows "mirror mode, N% in sync"
  (the share of changed tiles the shadow predicted right, last minute). If the
  updates can't be read, or our own territory or the agreement stays badly
  off, the bot stops with "game version changed too much — rebuild needed".
- Small changes are tolerated: hash updates are found by shape when the enum
  moves, unknown intent types are skipped (logged once), and maps the bundled
  engine doesn't know are loaded by name.
- The live-site build has `@updateURL`, so installed copies update
  themselves when a rebuilt script is pushed to this repository.

Mirror mode does not correct units (boats, warships, buildings) or troops in
running attacks, so the bot plays somewhat worse in it. Rebuild against the
new site version when you can.

## Building for the live site

The live site runs v0.35.6 (script 0.7 on; 0.6.3.9-0.6.4.0 were built on v0.35.4, whose engine code is the same), which uses the package layout (`packages/engine/…`).
Build from a checkout of that tag with the bot copied in (run from the
repository root; `bash setup.sh` makes the same checkout in `tools/game`):

```bash
git clone --branch v0.35.6 https://github.com/openfrontio/OpenFrontIO.git tools/OpenFrontIO-v0.35.6
mkdir -p tools/OpenFrontIO-v0.35.6/packages/engine/src/execution/bot
cp bot/BotExecution.ts tools/OpenFrontIO-v0.35.6/packages/engine/src/execution/bot/
cd tools/OpenFrontIO-v0.35.6 && npm ci --ignore-scripts --engine-strict=false && cd ../..
node userscript-source/build.mjs --repo tools/OpenFrontIO-v0.35.6 --live
```

For a site still on v0.34.24 (older single-package layout, `src/core/…`), use
the v0.34 port of the bot instead:

```bash
git clone --branch v0.34.24 https://github.com/openfrontio/OpenFrontIO.git tools/OpenFrontIO-v0.34.24
mkdir -p tools/OpenFrontIO-v0.34.24/src/core/execution/bot
cp bot/v34/BotExecution.ts tools/OpenFrontIO-v0.34.24/src/core/execution/bot/
cd tools/OpenFrontIO-v0.34.24 && npm install && cd ../..
node userscript-source/build.mjs --repo tools/OpenFrontIO-v0.34.24
```

If the site moves to a new version and mirror mode can't follow it, repeat this with the new tag (the page
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
  - Frozen training set (0.5.0; also in `AUTOPLAY_PARAMS`): `pvpRatio: 2`
    (the AI's own attacks on players need 2x their troops), `allyVid: 1`
    (video-backed ally rules: never ally the top two humans after 5:00, at
    most 2 strong Nations before 3:00, re-ask hot humans), `reserve: 0.13`,
    `nukeGate: 0.9` + `nukeProv: 1` (no nuke at a much stronger player),
    `lapseStrike: 0.8` (hit a weaker ex-ally when the alliance lapses),
    `earlyCity: 2` from minute 3, and `traitorK: 1` (graded strike on a
    bordering traitor or AFK player while the 30 s debuff runs).
  - Play-only (no sim signal; kept because replays and videos back them):
    - `renewLead: 26`: renewals go out once 26 s are left, inside the 30 s
      prompt window, so a late intent still lands. Kept allies only, strongest
      first.
    - `humanAccept: 1`: a request from a traitor, or from a bordering human
      under half our land, is refused unless that human is strong (in replays,
      humans refuse requesters under half their size).
    - `doomAware: 1`: in a Doomsday Clock lobby, when our land is under (or
      within 60 s of) the bar and we don't lead, troops the drain would take
      go into land: free land first, then the cheapest tribe or a beatable
      neighbour. The bar comes from the engine's `DoomsdayClock` (v0.34).
    - `natWin` (Nation ask limit by lobby difficulty) exists but is off: on
      Impossible it would change the sim-tested ask logic.
    - `emojiMode: 1`: positive emojis only.

## Test

Headless check: a real `GameRunner` acts as the site, the shadow runs the bot,
and the bot's intents are fed back as turns.

```bash
node build.mjs --test
```

(add `--repo <checkout>` to test another engine, e.g. `../OpenFrontIO-v0.34.24`)

```bash
node test-dist/sim.mjs --min 6 --map World --difficulty Impossible
```

The shadow runs in a worker thread, as it does in the browser (the v0.34
engine caches the map per process, so two games can't share one). The test
passes when all hashes match (including after a mid-game snapshot resync on
engines that have one), neither game reports errors, and the bot still owns
land. A lost game against Impossible nations fails the last check without
meaning a script bug, so try another `--seed`. `--noresync` skips the resync;
`--nobot` runs the shadow without the bot. `--drift` changes troops and gold
in the real game only (like a newer site version) to test mirror mode;
`--drift --nocorrect` shows the same game without corrections.

To test in a real browser, run the dev client (`npm run dev` in the repository,
then http://localhost:9000), install the script, and start a Singleplayer game.

## Files

| File | Purpose |
|---|---|
| `src/page.ts` | Worker hook, game gate, desync/resync, intent sending, panel UI |
| `src/shadow.ts` | Shadow engine and bot step; turns captured executions into intents |
| `src/mirror.ts` | Mirror mode: follows the real game when hashes differ (no-snapshot engines) |
| `src/feed.ts` | Reads hashes and the per-tick update the mirror needs, tolerant of format changes |
| `src/shadow-entry.ts` | Worker or page entry point for the shadow bundle |
| `src/engine-main.ts`, `src/engine-v34.ts` | One engine API for both repository layouts (picked by `build.mjs`) |
| `src/aids/` | Play aids: hold-key macros, troop timing + donation box, solid boat trails (WebGL trail-shader hook), ofstats rank badges, Nostr chat (`vendor/nostr-crypto.js` from openfront-pro), the panel list |
| `vendor/openfront-helper/` | Overlays from openfront-helper-userscript (AGPL-3.0-or-later), a plain script put before the bundle |
| `build.mjs` | esbuild bundle that writes the userscript (`--test` builds the test) |
| `test/sim.ts` | Headless integration test |
| `test/shadow-thread.ts`, `test/node-*.ts` | Test shadow worker thread; map loading per engine |
