# 🏝️ Archipelago Bot — Quick Guide

## Starting a multiworld

1. `/ap-lobby-create name:<game name>` — open a lobby in the current channel
2. Everyone clicks **Join Lobby** or uses `/ap-lobby-join yaml:<file>` to submit their YAML settings
3. The lobby creator clicks **Start Game** (or `/ap-lobby-start`)
4. A private channel is created for your game — connect your AP client to the address shown there

## In the game channel

- Use the **dropdown** to choose what the bot posts: goals, progression items, all items, or full feed
- Click **Enable Priority Pings 🔔** to get pinged when one of *your* progression items is found
- Click **Enable Priority Pings 🔔** again to disable pings

## Player commands

| Command | Description |
|---|---|
| `/ap-lobby-create name:` | Create a lobby in this channel |
| `/ap-lobby-join yaml:` | Join with a YAML file upload |
| `/ap-lobby-leave` | Leave the open lobby |
| `/ap-lobby-status` | Show current lobby and players |
| `/ap-lobby-cancel` | Cancel the lobby (creator or admin) |
| `/ap-template game:` | Get a starter YAML template for a game |
| `/ap-tracker` | Show the global progress tracker for this game |
| `/ap-tracker-personal` | Show your personal item and hint tracker |

## Admin commands

| Command | Description |
|---|---|
| `/ap-install-world apworld-file:` | Install a `.apworld` game file |
| `/ap-remove-world` | Remove an installed APworld |
| `/ap-list-worlds` | List custom installed APworlds |
| `/ap-generate-solo config-file:` | Run a room from a zip or yaml file |
| `/ap-list` | List recent games and their status |
| `/ap-start game-id:` | Start a pending game |
| `/ap-stop game-id:` | Stop a running game |
| `/ap-archive game-id:` | Archive a stopped game and remove its channel |
| `/ap-lobby-start` | Start the lobby via command instead of the button |
| `/ap-mc-restart game-id:` | Restart the Minecraft server for a running game |
| `/ap-cmd command:` | Send a command to the AP server in this channel (e.g. `!hint Player "Item"`) |
