const {
  SlashCommandBuilder,
  InteractionContextType,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config.json');
const { dbExecute, dbQueryOne, dbQueryAll } = require('../database');
const portManager = require('../lib/portManager');
const processManager = require('../lib/processManager');
const minecraftManager = require('../lib/minecraftManager');
const { isAdmin } = require('../lib/permissions');

const STATUS_COLORS = {
  pending: 0xffa500,
  running: 0x00cc44,
  completed: 0x0099ff,
  archived: 0x888888,
  crashed: 0xff3333,
};

async function doStartGame(interaction, gameId) {
  const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) {
    return interaction.reply({ content: `No game found with ID **${gameId}**.`, ephemeral: true });
  }
  if (game.status === 'running') {
    return interaction.reply({
      content: `Game **${game.gameName}** is already running on port **${game.port}**.`,
      ephemeral: true,
    });
  }
  if (!['pending', 'archived'].includes(game.status)) {
    return interaction.reply({
      content: `Game **${game.gameName}** has status \`${game.status}\` and cannot be started.`,
      ephemeral: true,
    });
  }

  // Check concurrent game limit
  const runningCount = (await dbQueryAll("SELECT id FROM games WHERE status = 'running'"))?.length ?? 0;
  if (runningCount >= (config.maxConcurrentGames ?? 10)) {
    return interaction.reply({
      content: `Maximum concurrent games (${config.maxConcurrentGames}) reached. Stop a game first.`,
      ephemeral: true,
    });
  }

  const port = portManager.allocate();
  if (!port) {
    return interaction.reply({ content: 'No ports available. Stop a running game first.', ephemeral: true });
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: `Starting **${game.gameName}**…`, embeds: [], components: [] });
  } else {
    await interaction.deferReply();
  }

  let pid;
  try {
    pid = await processManager.start(gameId, game.gameFile, port);
  } catch (e) {
    portManager.release(port);
    return interaction.followUp({ content: `Failed to start server: \`${e.message}\`` });
  }

  // Start Minecraft server if any player is using a Minecraft Dig game
  let players;
  try { players = JSON.parse(game.players ?? '[]'); } catch (_) { players = []; }

  let mcStarted = false;
  let mcError = null;
  if (minecraftManager.isMinecraftGame(players)) {
    try {
      await minecraftManager.start(gameId, game.gameFile, `${config.serverHost}:${port}`);
      mcStarted = true;
    } catch (e) {
      mcError = e.message;
      console.error(`[mc-${gameId}] Failed to start Minecraft server: ${e.message}`);
    }
  }

  // Create a dedicated Discord channel for this game
  let channelId = null;
  try {
    const safeName = `ap-${game.gameName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 90)}`;
    const channel = await interaction.guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      topic: `Archipelago game: ${game.gameName} | Server: ${config.serverHost}:${port}`,
    });
    channelId = channel.id;

    const fields = [
      { name: 'Game ID', value: String(gameId), inline: true },
      { name: 'AP Port', value: String(port), inline: true },
      { name: 'AP Connect', value: `\`${config.serverHost}:${port}\``, inline: false },
      {
        name: 'Players',
        value: players.length ? players.map((p) => `${p.name} (${p.game})`).join('\n') : '_Unknown_',
      },
    ];

    if (mcStarted) {
      fields.push({ name: 'Minecraft Server', value: `\`${config.serverHost}:25565\``, inline: false });
    } else if (mcError) {
      fields.push({ name: 'Minecraft Server', value: `⚠️ Failed to start: ${mcError}`, inline: false });
    }

    const embed = new EmbedBuilder()
      .setTitle(`Game Started: ${game.gameName}`)
      .setColor(STATUS_COLORS.running)
      .addFields(fields)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Could not create game channel:', e.message);
  }

  await dbExecute(
    `UPDATE games SET status = 'running', port = ?, pid = ?, channelId = ?, startedAt = ?
     WHERE id = ?`,
    [port, pid, channelId, Math.floor(Date.now() / 1000), gameId]
  );

  return interaction.followUp({
    content: `**${game.gameName}** is running!\nConnect at: \`${config.serverHost}:${port}\`${channelId ? ` — <#${channelId}>` : ''}`,
  });
}

module.exports = {
  category: 'Game Manager',
  startGameHandler: doStartGame,

  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-start')
        .setDescription('Start a generated Archipelago game.')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID from /ap-generate')
          .setRequired(true)),
      async execute(interaction) {
        const gameId = interaction.options.getInteger('game-id');
        return doStartGame(interaction, gameId);
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-stop')
        .setDescription('Stop a running Archipelago game. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID to stop')
          .setRequired(true)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to stop games.', ephemeral: true });
        }
        const gameId = interaction.options.getInteger('game-id');
        const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
        if (!game) {
          return interaction.reply({ content: `No game found with ID **${gameId}**.`, ephemeral: true });
        }
        if (game.status !== 'running') {
          return interaction.reply({ content: `Game **${game.gameName}** is not running.`, ephemeral: true });
        }

        processManager.stop(gameId);
        minecraftManager.stop(gameId);
        portManager.release(game.port);
        const now = Math.floor(Date.now() / 1000);
        await dbExecute(
          "UPDATE games SET status = 'archived', endedAt = ? WHERE id = ?",
          [now, gameId]
        );

        if (game.channelId) {
          try {
            const ch = await interaction.guild.channels.fetch(game.channelId);
            if (ch) {
              await ch.send({ embeds: [
                new EmbedBuilder()
                  .setTitle(`Game Stopped: ${game.gameName}`)
                  .setColor(STATUS_COLORS.archived)
                  .setDescription(`Stopped by <@${interaction.user.id}>.`)
                  .setTimestamp(),
              ]});
            }
          } catch (_) {}
        }

        return interaction.reply({ content: `Game **${game.gameName}** (ID ${gameId}) has been stopped.` });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-list')
        .setDescription('List recent Archipelago games and their status.')
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        const games = await dbQueryAll(
          "SELECT * FROM games WHERE guildId = ? AND status != 'archived' ORDER BY id DESC LIMIT 15",
          [interaction.guildId]
        );

        if (!games) {
          return interaction.reply({ content: 'No games found.' });
        }

        const embed = new EmbedBuilder()
          .setTitle('Archipelago Games')
          .setColor(0x00b0f4)
          .setDescription(
            games.map((g) => {
              const when = g.startedAt ? `<t:${g.startedAt}:R>` : '_unknown_';
              return `**#${g.id}** ${g.gameName} — \`${g.status}\`${g.port ? ` :${g.port}` : ''} — ${when}`;
            }).join('\n')
          );

        return interaction.reply({ embeds: [embed] });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-archive')
        .setDescription('Mark a game as archived. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID to archive')
          .setRequired(true)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to archive games.', ephemeral: true });
        }
        const gameId = interaction.options.getInteger('game-id');
        const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
        if (!game) {
          return interaction.reply({ content: `No game found with ID **${gameId}**.`, ephemeral: true });
        }
        if (game.status === 'running') {
          return interaction.reply({
            content: 'Stop the game first with `/ap-stop` before archiving.',
            ephemeral: true,
          });
        }
        await dbExecute("UPDATE games SET status = 'archived' WHERE id = ?", [gameId]);

        if (game.channelId) {
          try {
            const ch = await interaction.guild.channels.fetch(game.channelId);
            if (ch) await ch.delete(`Archived game #${gameId}`);
          } catch (_) {}
        }

        return interaction.reply({ content: `Game **${game.gameName}** (ID ${gameId}) archived and channel removed.` });
      },
    },
  ],
};
