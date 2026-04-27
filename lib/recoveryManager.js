const { dbQueryAll, dbExecute } = require('../database');
const processManager = require('./processManager');
const minecraftManager = require('./minecraftManager');
const { attachGameNotifier } = require('./gameNotifier');
const { scheduleTrackerUpdate } = require('./trackerUpdater');
const { readLocationCounts } = require('./locationCountReader');
const config = require('../config.json');

async function recoverRunningGames(discordClient) {
  const games = await dbQueryAll("SELECT * FROM games WHERE status = 'running'");
  if (!games?.length) return;

  console.log(`[recovery] ${games.length} running game(s) to recover.`);

  for (const game of games) {
    let players;
    try { players = JSON.parse(game.players ?? '[]'); } catch { players = []; }
    let options;
    try { options = JSON.parse(game.gameOptions ?? '{}'); } catch { options = {}; }

    console.log(`[recovery] Recovering game ${game.id} (${game.gameName}) on port ${game.port}…`);

    // Refresh location counts from the game file in case the column was null before
    if (!game.locationCounts) {
      const counts = await readLocationCounts(game.gameFile);
      if (Object.keys(counts).length > 0) {
        await dbExecute('UPDATE games SET locationCounts = ? WHERE id = ?', [JSON.stringify(counts), game.id]);
      }
    }

    let newPid;
    try {
      newPid = await processManager.start(game.id, game.gameFile, game.port, players, options);
      await dbExecute('UPDATE games SET pid = ? WHERE id = ?', [newPid, game.id]);
    } catch (e) {
      console.error(`[recovery] Failed to restart game ${game.id}: ${e.message}`);
      await dbExecute(
        "UPDATE games SET status = 'crashed', endedAt = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000), game.id]
      );
      continue;
    }

    if (game.channelId) {
      try {
        const channel = await discordClient.channels.fetch(game.channelId);
        if (channel) {
          attachGameNotifier(game.id, channel);
          scheduleTrackerUpdate(game.id, channel);
          await channel.send({
            content: `🔄 Bot restarted — **${game.gameName}** re-launched on port \`${game.port}\`. AP clients will reconnect automatically.`,
          });
        }
      } catch (e) {
        console.warn(`[recovery] Could not attach to channel for game ${game.id}: ${e.message}`);
      }
    }

    if (minecraftManager.isMinecraftGame(players)) {
      try {
        await minecraftManager.start(game.id, game.gameFile, `${config.serverHost}:${game.port}`);
        console.log(`[recovery] MC server for game ${game.id} restarted.`);
      } catch (e) {
        console.warn(`[recovery] Could not restart MC for game ${game.id}: ${e.message}`);
      }
    }

    console.log(`[recovery] Game ${game.id} recovered (pid ${newPid}).`);
  }
}

module.exports = { recoverRunningGames };
