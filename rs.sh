#!/bin/sh
# Restart helper. Snapshots the bot DB and AP savefiles BEFORE bringing the
# stack down, so a corrupt-on-shutdown save can be recovered after the fact.
# Backups are kept in data/backups/ — prune manually as needed.

set -eu

BACKUP_DIR="data/backups"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# bot.db: SQLite-safe online copy via .backup (handles in-flight writes correctly)
if [ -f data/bot.db ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 data/bot.db ".backup '$BACKUP_DIR/bot.db.$TS'"
  else
    cp data/bot.db "$BACKUP_DIR/bot.db.$TS"
  fi
  echo "[rs.sh] Snapshotted data/bot.db -> $BACKUP_DIR/bot.db.$TS"
fi

# AP savefiles live next to the multidata in data/archives/*.apsave (AP MultiServer
# ignores --savefile and uses the default). Copy them all so a partial-write at
# shutdown doesn't leave us empty-handed.
if ls data/archives/*.apsave >/dev/null 2>&1; then
  for f in data/archives/*.apsave; do
    base="$(basename "$f")"
    cp "$f" "$BACKUP_DIR/$base.$TS"
  done
  echo "[rs.sh] Snapshotted .apsave files into $BACKUP_DIR/"
fi

docker-compose down
docker-compose build
docker-compose up -d
docker exec archipelabot-archipelabot-1 node scripts/registerSlashCommands.js
