# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the bot (development, with trace warnings)
npm run dev

# Register/update slash commands with Discord (guild-specific = instant; global = 1-hour delay)
npm run registerCommands
# or directly:
node scripts/registerSlashCommands.js

# Docker (primary deployment method)
docker compose build && docker compose up -d
docker compose restart          # reload JS changes without rebuild
docker compose logs --tail=50

# Re-register slash commands inside a running container
docker exec archipelabot-archipelabot-1 node scripts/registerSlashCommands.js
```

There are no tests. There is an ESLint config (`.eslintrc.json`) but no lint script defined in `package.json`.

## Architecture

### Bot structure (`bot.js`)
The bot auto-discovers handlers from four directories at startup by reading all `.js` files:
- `messageListeners/` — called on every non-bot message
- `channelDeletedListeners/` — called on channel deletion
- `voiceStateListeners/` — called on voice state changes
- `slashCommandCategories/` — each file exports `{ category, commands: [{ commandBuilder, execute }] }`
- `routines/` — `gameMonitor.js` runs every 60s; all others run hourly

Button interactions (`customId` format: `action_arg1_arg2`) are dispatched in `bot.js` directly to `startGameHandler`, `startLobbyHandler`, or `cancelLobbyHandler`.

### Self-hosted game management (added on top of upstream)
The upstream bot only called the archipelago.gg API. This fork runs everything locally:

1. **Generation**: `lib/archipelagoRunner.js` wraps the `ArchipelagoGenerate` shell command (a venv wrapper at `/usr/local/bin/ArchipelagoGenerate` pointing to `/opt/archipelago/Generate.py`).
2. **Server processes**: `lib/processManager.js` spawns `ArchipelagoServer` child processes (one per game), keyed by `gameId`.
3. **Port pool**: `lib/portManager.js` allocates from `config.portRange` (default 38281–38380), initialized from the `games` DB table on startup.
4. **Game lifecycle**: `slashCommandCategories/gameManager.js` — `/ap-start` allocates a port, spawns the server, creates a Discord channel, stores everything in DB. `/ap-stop` kills the process and releases the port. `/ap-archive` deletes the channel.
5. **Crash detection**: `routines/gameMonitor.js` TCP-pings every running game's port every 60s and marks crashed games.

### Lobby system
`slashCommandCategories/lobbyManager.js` — multi-player YAML collection before generation. Players join with `/ap-lobby-join` (admin can use `on-behalf` to submit for others). The lobby owner triggers generation via the Start button or `/ap-lobby-start`, which calls `gameGenerator.js` internally.

### Minecraft Dig integration
`lib/minecraftManager.js` — detects Minecraft Dig players via `config.minecraftGameNames`, starts a Forge server from `config.minecraftServerPath` using `bash run.sh` (modern Forge uses `run.sh` not a direct JAR), kills the whole process group on stop (not just bash). Before starting, `scripts/apply_minecraft_patch.py` extracts the `.apmcdig` from the multiworld zip, writes `APData/` with the correct `.apmc` file and `archipelago.json` (with `server` field pre-filled), and syncs the mod jar from the installed apworld.

### Web client
`lib/webClientServer.js` — serves a prebuilt static copy of [tophers-archipelago-web-client](https://github.com/christopherwk210/tophers-archipelago-web-client) (a Vue SPA, hash-routed, no server-side logic needed) on `config.webClientPort`. The Dockerfile clones and builds it at image build time into `/opt/webclient`; only the built `dist/` ships in the final image. Started from `bot.js`'s `init()` alongside the Discord client — unrelated to and independent of it.

Game-started embeds (`gameManager.js`, `lobbyManager.js`) get an "Open Web Client" button (`webclient_<gameId>`) when `config.webClientPort` is set. `gameManager.js`'s `handleWebClientLink` looks up the clicking user's AP slot name via `games.players[].discordUserId` and replies ephemerally with a link prefilled via the client's `?url=host:port&slot=name` query params (the client auto-connects on load with these).

### Python scripts
All Python scripts in `scripts/` must inject a no-op `ModuleUpdate` into `sys.modules` before importing anything from `/opt/archipelago`, otherwise Archipelago's interactive version-check calls `input()` and crashes non-interactively.

```python
import types, sys
_mu = types.ModuleType("ModuleUpdate")
_mu.update = lambda: None
sys.modules["ModuleUpdate"] = _mu
sys.path.insert(0, "/opt/archipelago")
```

### Database (`database.js`)
SQLite via `sqlite3` npm package. Tables: `readySystems`, `readyChecks` (upstream), `games`, `lobbies`, `lobby_players`, `apworlds` (added). `dbQueryAll` returns `null` (not `[]`) when no rows match — all callers must guard for this.

### Config (`config.json`)
See `config.json.example` for all fields. Key self-hosted additions: `serverHost`, `portRange`, `dataPath`, `maxConcurrentGames`, `adminRoles` (array of role IDs), `guildId` (enables instant guild-scoped command registration), `minecraftServerPath`, `minecraftJvmArgs`, `minecraftGameNames`, `webClientPort` (0/omit disables the bundled web client).

Admin check is in `lib/permissions.js`: Administrator permission OR a role in `config.adminRoles`.

### Docker
`network_mode: host` exposes all game ports without individual port mappings. `entrypoint.sh` syncs `/data/apworlds/*.apworld` into `/opt/archipelago/worlds/` on every start. APWorlds installed via `/ap-install-world` are written to both locations immediately. The Minecraft server directory is bind-mounted from `~/Minecraft` on the host to `/opt/minecraft` in the container.
