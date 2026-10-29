# OpenFront bot

A code bot/script for the OpenFront game which works at client side, trained by running many headless games on CPU and keeping only the changes that win more. It also comes with a Tampermonkey userscript that lets the bot play in the game in your browser.

Developed to beat human players in online games. So far it has only been tested against the game's Impossible AI, not yet in online games. To contribute, see [below](#contributing).

Questions, ideas and bug reports are welcome on the [Discord server](https://discord.gg/WhVXHbD6rd).

This repository does not include the game's source code. The game can be downloaded from the [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) repository.

## Contents
- `openfront-bot.user.js`: the ready-to-install Tampermonkey script.
- `bot/BotExecution.ts`: the bot (game version v0.35.6).
- `bot/harness/`: headless game runner (`BotGame.ts`), stand-in opponents, evaluation and tuning scripts (`Eval.mjs`, `Tune.mjs`, `stats.mjs`).
- `bot/tests/`: unit tests.
- `bot/v34/`: the bot ported to game version v0.34.24.
- `engine-patch/autoplay.patch`: a small game patch that lets the bot play solo games.
- `userscript-source/`: the source code and build script of the Tampermonkey script.
- `review-tools/`: scripts for studying replays and game data.
- `results/online-ffa-mix/`: online FFA map mix used to pick training lobbies (`ffa_cells_v035.json` for v0.35.0).

## 1. Using the bot in a game (Tampermonkey)
1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Edge, Firefox, ...). In Chrome, open the extension's details and turn on **Allow User Scripts**.
2. Open [`openfront-bot.user.js`](openfront-bot.user.js) and click the **Copy raw file** button. In Tampermonkey, choose **Create a new script**, replace everything in the editor with what you copied, and save (Ctrl+S).
3. Open the game website, start or join a game (any mode) and press **Start bot** in the panel at the top right.

- **Modes:** the general mode plays online games. Solo games on Easy switch to a farm mode by themselves.
- **Farm option:** plays the 5 Easy solo games per UTC day that give XP, at Max speed, each held until 30+ game minutes for the most XP. Then it joins public FFA games; untick **…then public FFA games** to stop after the solo games.
- **How to farm XP fast:** open the game in several tabs of the same browser (5 to 10 tabs work), start the bot in each, and tick **Farm: Easy solo games on repeat** and **…then public FFA games**. One tab plays the daily solo games, and every tab joins a different public FFA game, so the bot keeps farming games on its own. This can get an account to level 100 in about a day.
- **Panel:** **–/+** folds the panel; **Options** hides the checkboxes.
- **Play aids** 20+ Quality of Life features
  
On newer versions it keeps playing by following the live game, until a version changes too much; then it must be rebuilt (see `userscript-source/README.md`). Installed copies update themselves when a rebuilt script is pushed here.

## 2. Training
### Setup
The game itself is open source, so setup downloads it from the official repository (tag `v0.35.6`) and adds the bot on top. Needs git, Node.js 24 and bash (Git Bash on Windows).

```
bash setup.sh
cd tools/game
npx tsx tests/bot/BotGame.ts --seed s1 --roulette --bot us --autoplay
```

### Commands (run in `tools/game`)
- One game: `npx tsx tests/bot/BotGame.ts --seed s1 --roulette --bot us --autoplay`
- Compare bot settings on the same 64 games (first set = current bot):
  `node tests/bot/Eval.mjs --seeds 64 --maxMin 75 --jobs 16 --tag test1 --metric fit --extra "--roulette --bot us --autoplay --hopeless" --sets '[{},{"pvpRatio":2.2}]'`
- Tune settings automatically:
  `node tests/bot/Tune.mjs --name tune1 --gens 8 --pop 12 --seeds 6 --maxMin 12 --jobs 16 --extra "--roulette --bot us --autoplay --hopeless"`
- Full log of one game (to study a loss): add `--trace` to the one-game command and save the output to a file.

Results go to `tools/bot_runs/`.

### Training with AI agents (e.g. Claude Code)
The games run on CPU; an AI agent only plans, reads results and edits the bot. That keeps token use low. Open the repository in the agent and give it a prompt like:

> Read README.md. Goal: raise the bot's win rate. Loop: (1) run a few `--trace` games and find why the bot lost; send long logs to a cheaper sub-agent and read only its summary. (2) Add the fix as a new setting in `bot/BotExecution.ts` (off by default) with a unit test. (3) Compare it with `Eval.mjs` against the current bot on the same seeds. Keep it only if the confidence interval is above 0. (4) Write every result and next step into PROGRESS.md so the next session can continue.

Tips:
- Always compare on the same seeds (same maps and enemies); single games are very noisy.
- Short games (`--maxMin 12` or `15`) are fine for early-game changes; mid/late-game changes need full games.
- Never let the agent play games itself in real time; it should only run the scripts.

## Results
Each test game is a full free-for-all on a random map from the online 30+ player lobby mix (30-125 players). The 30+ limit follows TrackerFront, whose FFA win leaderboards count only lobbies of 30+ players. Every other player slot is the game's **Impossible** AI. The map's nations and tribes are added as in online lobbies. The table is the final test of bot version 0.6.3 (the bot in userscript 0.6.3.x) on game version v0.35.4 with the v0.35 map mix: 200 FFA games and 200 default solo games, all on new seeds never used in training, run once.

| Lobby size | Games | Bot wins | Bot win rate | Impossible AI win rate | Bot vs Impossible |
|---|---|---|---|---|---|
| 30-49 players | 75 | 21 | ~28% | 2.8% | ~10x |
| 50-79 players | 70 | 21 | ~30% | 1.7% | ~18x |
| 80-125 players | 55 | 15 | ~27% | 1.0% | ~27x |
| **All FFAs** | **200** | **57** | **~29%** | **1.92%** | **~15x** |
| Default solo game (World, 72 nations, Impossible mode) | 200 | 10 | ~5% | 1.4% | ~4x |

Older results on game version v0.34.24 (with its own map mix) can't be compared directly with these: bot 0.5.5 won 99 of 200 FFAs there (~50%, ~26x) and 23 of 200 default solo games (~12%). Farm mode (default solo game on Easy, held to 30+ game minutes) won 10 of 10 games with 0.5.5, each between 32 and 36 game minutes; it hasn't been re-tested on v0.35.

The bot was not trained by reading or exploiting the Impossible AI's source code. The Impossible AI is only used as an opponent. The goal was strategy that also works against human players in online games.

## Contributing
Run training (section 2), and open a pull request with a bot change once it wins more on the same seeds. Bug reports and ideas are welcome as Issues.

The replays, game data and analysis outputs used for training (about 4 GB) aren't in this repository. Contact **deeznull** on Discord to obtain them.

## Disclaimer
This is an independent, unofficial project. It is not affiliated with, endorsed by or sponsored by the OpenFront developers or any game operator. "OpenFront" and related names belong to their respective owners and are used here only to describe what the software works with.

This project is provided as is, without warranty. You use it at your own risk. The authors and contributors are not responsible for how anyone uses this code or the userscript, or for any account action, ban or other consequence. Users are responsible for following the terms and rules of any game or site they use it on.

## License
AGPL-3.0. See `LICENSE` and `NOTICE`. Parts of this project build on AGPL-3.0 code from the OpenFront game; that code stays the copyright of its original authors. If you share a built userscript, you must also offer its source.
