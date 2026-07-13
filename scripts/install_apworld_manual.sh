#!/usr/bin/env bash
# Manually install a .apworld that's too big for Discord's attachment limit,
# bypassing /ap-install-world entirely. Run on the deploy host (not in the container).
#
# Usage: scripts/install_apworld_manual.sh /path/to/world.apworld
set -euo pipefail

CONTAINER="${AP_CONTAINER:-archipelabot-archipelabot-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AP_DATA_DIR:-$SCRIPT_DIR/data}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 /path/to/world.apworld" >&2
  exit 1
fi

SRC="$1"
if [ ! -f "$SRC" ]; then
  echo "File not found: $SRC" >&2
  exit 1
fi

FILENAME="$(basename "$SRC")"
NAME="${FILENAME%.apworld}"

mkdir -p "$DATA_DIR/apworlds"
cp "$SRC" "$DATA_DIR/apworlds/$FILENAME"
echo "[1/4] Persisted to $DATA_DIR/apworlds/$FILENAME"

docker cp "$SRC" "$CONTAINER:/opt/archipelago/worlds/$FILENAME"
echo "[2/4] Loaded into running container (usable immediately, no restart)."

STALE_DIR=$(docker exec "$CONTAINER" find /opt/archipelago/worlds -maxdepth 1 -type d -iname "$NAME" 2>/dev/null || true)
if [ -n "$STALE_DIR" ]; then
  echo "[3/4] WARNING: stale expanded world dir shadows the new zip: $STALE_DIR"
  read -r -p "        Remove it now? [y/N] " CONFIRM
  if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    docker exec "$CONTAINER" rm -rf "$STALE_DIR"
    echo "        Removed."
  fi
else
  echo "[3/4] No stale expanded dir found."
fi

TMP_JS="$(mktemp)"
cat > "$TMP_JS" <<JSEOF
const {dbExecute} = require('./database');
dbExecute(
  "INSERT INTO apworlds (name, filePath, installedAt) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET filePath=excluded.filePath, installedAt=excluded.installedAt",
  ['$NAME', '/data/apworlds/$FILENAME', Math.floor(Date.now()/1000)]
).then(()=>console.log('registered'));
JSEOF
docker cp "$TMP_JS" "$CONTAINER:/app/_install_apworld_tmp.js"
docker exec "$CONTAINER" node /app/_install_apworld_tmp.js
docker exec "$CONTAINER" rm -f /app/_install_apworld_tmp.js
rm -f "$TMP_JS"
echo "[4/4] Registered in DB as '$NAME'."

echo "Done: $NAME installed."
