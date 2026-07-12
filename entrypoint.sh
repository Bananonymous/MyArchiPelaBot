#!/bin/sh
# Sync persistent apworlds into Archipelago's worlds directory on every container start
if [ -d /data/apworlds ]; then
    for f in /data/apworlds/*.apworld; do
        [ -e "$f" ] || continue
        name=$(basename "$f" .apworld)
        # Remove any stale expanded world dir so it can't shadow/conflict with the zip
        rm -rf "/opt/archipelago/worlds/$name"
        cp -u "$f" /opt/archipelago/worlds/
    done
fi
mkdir -p /data/saves
exec node bot.js
