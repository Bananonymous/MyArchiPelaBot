# 🏝️ Archipelago Bot — Quick Guide

## Starting a multiworld

1. `/ap-lobby-create name:<game name>` — open a lobby in the current channel
2. Everyone clicks **Join Lobby** or uses `/ap-lobby-join yaml:<file>` to submit their YAML settings
3. The lobby creator clicks **Start Game** (or `/ap-lobby-start`)
4. A private channel is created for your game — connect your AP client to the address shown there

## In the game channel

- Use the **dropdown** to choose what the bot posts: goals, progression items, all items, or full feed
- Click **Enable Priority Pings 🔔** to get pinged when one of *your* progression items is found

## Player commands

| Command | Description |
|---|---|
| `/ap-lobby-create name:` | Create a lobby in this channel |
| `/ap-lobby-join yaml:` | Join with a YAML file upload |
| `/ap-lobby-leave` | Leave the open lobby |
| `/ap-lobby-status` | Show current lobby and players |
| `/ap-lobby-cancel` | Cancel the lobby (creator or admin) |

## Admin commands

| Command | Description |
|---|---|
| `/ap-install-world apworld-file:` | Install a `.apworld` game file |
| `/ap-generate-solo config-file:` | Runs a room with the provided zip or yaml (if only yaml, starts a solo game) |
| `/ap-list` | List recent games and their status |
| `/ap-stop game-id:` | Stop a running game |
| `/ap-archive game-id:` | Archive a stopped game and remove its channel |
| `/ap-lobby-start` | Start the lobby via command instead of the button |
