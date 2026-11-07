#!/bin/sh
# Keep the bot running through crashes and disconnects. Usage:
#   ./run.sh                # BOT_NAME defaults to Lexicoin
#   TOURNAMENT_ID=3 ./run.sh
cd "$(dirname "$0")" || exit 1
export BOT_NAME="${BOT_NAME:-Lexicoin}"
mkdir -p logs
while :; do
  echo "$(date -u +%FT%TZ) supervisor: starting bot"
  npx tsx src/index.ts 2>&1 | tee -a "logs/${BOT_NAME}.log"
  echo "$(date -u +%FT%TZ) supervisor: bot exited, restarting in 2s"
  sleep 2
done
