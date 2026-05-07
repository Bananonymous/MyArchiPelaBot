const net = require('net');
const { EmbedBuilder } = require('discord.js');
const { dbQueryAll, dbExecute } = require('../database');
const portManager = require('../lib/portManager');
const processManager = require('../lib/processManager');
const minecraftManager = require('../lib/minecraftManager');

function tcpPing(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 2000 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

module.exports = async function gameMonitor(client) {
  const runningGames = await dbQueryAll("SELECT * FROM games WHERE status = 'running'");
  if (!runningGames) return;

  for (const game of runningGames) {
    const alive = processManager.isAlive(game.id) && await tcpPing(game.port);
    if (alive) continue;

    // Game has crashed or stopped
    const now = Math.floor(Date.now() / 1000);
    await dbExecute(
      "UPDATE games SET status = 'crashed', endedAt = ? WHERE id = ?",
      [now, game.id]
    );
    await portManager.release(game.port);
    minecraftManager.stop(game.id);

    if (game.channelId) {
      try {
        const channel = await client.channels.fetch(game.channelId);
        if (channel) {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(`Game Crashed: ${game.gameName}`)
                .setColor(0xff3333)
                .setDescription('The Archipelago server process has stopped unexpectedly.')
                .addFields({ name: 'Game ID', value: String(game.id), inline: true })
                .setTimestamp(),
            ],
          });
        }
      } catch (e) {
        console.error(`gameMonitor: could not post crash notice for game ${game.id}: ${e.message}`);
      }
    }

    console.warn(`[gameMonitor] Game ${game.id} (${game.gameName}) detected as crashed.`);
  }
};
