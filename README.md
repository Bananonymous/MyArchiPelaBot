# ArchipelaBot

Discord bot for self-hosting [Archipelago](https://archipelago.gg) multiworld games. Manages game generation, server processes, ports, and Discord channels — all from slash commands.

## Features

- Generate single- or multi-player Archipelago games
- Lobby system: collect player YAMLs before generating
- Spawn and manage Archipelago server processes per game
- Auto-create private Discord channels per game with live item feeds
- Priority pings when your progression items are found
- Minecraft Dig integration (starts a Forge server alongside AP)
- APworld install/remove via Discord
- ROM file auto-deletion
- Crash detection: TCP-pings running games every 60s

## Prerequisites

- Node.js + npm
- Archipelago installed at `/opt/archipelago` with `ArchipelagoGenerate` and `ArchipelagoServer` on `PATH`
- Docker + Docker Compose (recommended for deployment)

## Configuration

Copy `config.json.example` to `config.json` and fill in your values:

```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN",
  "clientId": "YOUR_APPLICATION_CLIENT_ID",
  "guildIds": ["YOUR_DISCORD_SERVER_ID"],
  "sqliteFile": "/data/bot.db",
  "serverHost": "your.server.ip.or.domain",
  "portRange": { "min": 38281, "max": 38380 },
  "dataPath": "/data",
  "maxConcurrentGames": 10,
  "adminRoles": ["ROLE_ID_1"],

  "minecraftServerPath": "/opt/minecraft",
  "minecraftJvmArgs": "-Xmx2G -Xms1G",
  "minecraftGameNames": ["Minecraft", "Minecraft Dig"],

  "ssl": {
    "cert": "/path/to/fullchain.pem",
    "key": "/path/to/privkey.pem"
  }
}
```

`ssl` is optional — enables WSS on AP server ports (required for browser clients on HTTPS pages).

`adminRoles` is an array of Discord role IDs. Members with those roles (or the Administrator permission) can use admin commands.

## Docker (recommended)

```bash
docker compose build && docker compose up -d

# Reload JS changes without rebuild
docker compose restart

# Logs
docker compose logs --tail=50

# Re-register slash commands inside the container
docker exec archipelabot-archipelabot-1 node scripts/registerSlashCommands.js
```

The container uses `network_mode: host` to expose all game ports without individual port mappings.

On startup, `entrypoint.sh` syncs `/data/apworlds/*.apworld` into `/opt/archipelago/worlds/`.

## Manual setup

```bash
git clone <this-repo>
cd MyArchiPelaBot
npm install
cp config.json.example config.json
# edit config.json
node scripts/registerSlashCommands.js
npm run dev
```

Slash command registration is guild-scoped (instant) when `guildIds` is set; global registration takes ~1 hour.

## Discord permissions

Permissions integer: `274878032960`

Required permissions:
- View Channels
- Send Messages
- Send Messages in Threads
- Manage Messages
- Embed Links
- Attach Files
- Add Reactions
- Read Message History

## Commands

See [GUIDE.md](GUIDE.md) for full command reference.

### Player commands

| Command | Description |
|---|---|
| `/ap-lobby-create name:` | Open a lobby in this channel |
| `/ap-lobby-join yaml:` | Join with a YAML file |
| `/ap-lobby-leave` | Leave the open lobby |
| `/ap-lobby-status` | Show lobby and players |
| `/ap-lobby-cancel` | Cancel the lobby |
| `/ap-template game:` | Get a starter YAML for a game |
| `/ap-tracker` | Global progress tracker for this game |
| `/ap-tracker-personal` | Your personal item and hint tracker |

### Admin commands

| Command | Description |
|---|---|
| `/ap-install-world apworld-file:` | Install a `.apworld` file |
| `/ap-remove-world` | Remove an installed APworld |
| `/ap-list-worlds` | List installed APworlds |
| `/ap-generate-solo config-file:` | Run a room from a zip or yaml |
| `/ap-list` | List recent games and status |
| `/ap-start [game-id:]` | Start a pending game |
| `/ap-stop [game-id:]` | Stop a running game |
| `/ap-archive [game-id:]` | Archive a stopped game and remove its channel |
| `/ap-lobby-start` | Start lobby via command |
| `/ap-mc-restart game-id:` | Restart Minecraft server for a game |
| `/ap-cmd command:` | Send command to AP server (e.g. `!hint Player "Item"`) |
