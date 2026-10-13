# OpenFront bot

A code bot/script for the OpenFront game, trained by running many headless games on CPU and keeping only the changes that win more. It also comes with a Tampermonkey userscript that lets the bot play in the game in your browser.

Developed to beat human players in online games. So far it has only been tested against the game's Impossible AI, not yet in online games. To contribute, see [below](#contributing).

This repository does not include the game's source code. The game can be downloaded from the [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) repository.

## What's here
- `openfront-bot.user.js`: the ready-to-install Tampermonkey script.
- `bot/BotExecution.ts`: the bot.
- `bot/harness/`: headless game runner (`BotGame.ts`), stand-in opponents, evaluation and tuning scripts (`Eval.mjs`, `Tune.mjs`, `stats.mjs`).
- `bot/tests/`: unit tests.
- `bot/v34/`: the bot ported to game version v0.34.24.
- `engine-patch/autoplay.patch`: a small game patch that lets the bot play solo games.
- `userscript/`: the userscript's source and build script.
- `review-tools/`: scripts for studying replays and game data.
- `results/online-ffa-mix/`: online FFA map mix used to pick training lobbies.

## 1. Using the bot in a game (Tampermonkey)
1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Edge, Firefox, ...). In Chrome, open the extension's details and turn on **Allow User Scripts**.
2. Open [`openfront-bot.user.js`](openfront-bot.user.js) and click the **Copy raw file** button. In Tampermonkey, choose **Create a new script**, replace everything in the editor with what you copied, and save (Ctrl+S).
3. Enter the game website, start or join a game (any mode) and press **Start bot** in the panel at the top right.

The script is made for game version v0.34.24. If the site moves to a new version, the script must be rebuilt for it (see `userscript/README.md`).

## 2. Training
### Setup
The game itself is open source, so setup downloads it from the official repository (commit `a1513835`) and adds the bot on top. Needs git, Node.js and bash (Git Bash on Windows).

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
Each test game is a full free-for-all on a random map from the online 30+ player lobby mix (30-125 players). Every other player slot is the game's **Impossible** AI. The map's nations and tribes are added as in online lobbies. All games use the latest bot version.

| Lobby size | Games | Bot wins | Bot win rate | Impossible AI win rate | Bot vs Impossible |
|---|---|---|---|---|---|
| 30-49 players | 49 | 10 | 20% | 2.8% | ~7x |
| 50-79 players | 49 | 8 | 16% | 1.7% | ~10x |
| 80-125 players | 30 | 5 | 17% | 1.0% | ~16x |
| **All FFAs** | **128** | **23** | **18%** | **2.0%** | **~9x** |
| Default solo game (World, 72 nations) | 100 | 8 | 8% | 1.4% | ~6x |

The bot was not trained by reading or exploiting the Impossible AI's source code. The Impossible AI is only used as an opponent. The goal was strategy that also works against human players in online games.

## Training data
The replays and game data used for training (about 1 GB) aren't in this repository. Contact **deeznull** on Discord to get them.

## Contributing
Run training (section 2), and open a pull request with a bot change once it wins more on the same seeds. Bug reports and ideas are welcome as issues.

## Disclaimer
This is an independent, unofficial project. It is not affiliated with, endorsed by or sponsored by the OpenFront developers or any game operator. "OpenFront" and related names belong to their respective owners and are used here only to describe what the software works with.

This project is provided as is, without warranty. You use it at your own risk. The authors and contributors are not responsible for how anyone uses this code or the userscript, or for any account action, ban or other consequence. Users are responsible for following the terms and rules of any game or site they use it on.

## License
AGPL-3.0. See `LICENSE` and `NOTICE`. Parts of this project build on AGPL-3.0 code from the OpenFront game; that code stays the copyright of its original authors. If you share a built userscript, you must also offer its source.
