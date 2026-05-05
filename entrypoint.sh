#!/bin/sh
# Sync persistent apworlds into Archipelago's worlds directory on every container start
if [ -d /data/apworlds ]; then
    cp -u /data/apworlds/*.apworld /opt/archipelago/worlds/ 2>/dev/null || true
fi
mkdir -p /data/saves
exec node bot.js
