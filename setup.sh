#!/usr/bin/env bash
# Downloads the official OpenFront game at the version this bot was built on,
# adds the bot files and installs. Run from this repo: bash setup.sh
set -e
GAME_COMMIT=v0.35.6
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p tools
git clone https://github.com/openfrontio/OpenFrontIO.git tools/game
cd tools/game
git checkout "$GAME_COMMIT"
git apply "$HERE/engine-patch/autoplay.patch"
mkdir -p packages/engine/src/execution/bot tests/bot tests/replay
cp "$HERE/bot/BotExecution.ts" packages/engine/src/execution/bot/
cp "$HERE"/bot/harness/* tests/bot/
cp "$HERE"/bot/tests/Bot*.test.ts tests/
cp "$HERE/bot/tests/Resim.ts" tests/replay/
npm ci --ignore-scripts --engine-strict=false

echo "Done. Try: cd tools/game && npx tsx tests/bot/BotGame.ts --seed s1 --roulette --bot us --autoplay"
