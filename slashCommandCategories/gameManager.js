const {
  SlashCommandBuilder,
  InteractionContextType,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config.json');
const { dbExecute, dbQueryOne, dbQueryAll } = require('../database');
const portManager = require('../lib/portManager');
const processManager = require('../lib/processManager');
const minecraftManager = require('../lib/minecraftManager');
const { isAdmin } = require('../lib/permissions');
const { attachGameNotifier } = require('../lib/gameNotifier');
const { setupTrackers } = require('../lib/trackerUpdater');
const { readLocationCounts } = require('../lib/locationCountReader');

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

  let players;
  try { players = JSON.parse(game.players ?? '[]'); } catch (_) { players = []; }

  let pid;
  try {
    pid = await processManager.start(gameId, game.gameFile, port, players);
  } catch (e) {
    portManager.release(port);
    return interaction.followUp({ content: `Failed to start server: \`${e.message}\`` });
  }

  // Start Minecraft server if any player is using a Minecraft Dig game

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
      { name: 'AP Connect', value: `\`${config.serverHost}:${port}\`${config.ssl?.cert ? ' (WSS enabled)' : ''}`, inline: false },
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

    const controlsRow = buildGameControlsRow(gameId);
    const pingRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`notifping_${gameId}`)
        .setLabel('Enable Priority Pings 🔔')
        .setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ embeds: [embed], components: [controlsRow, pingRow] });
    attachGameNotifier(gameId, channel);
    setupTrackers(gameId, channel, players);

    // Post the archive as a downloadable attachment (patch files for players)
    try {
      const fs = require('fs');
      const path = require('path');
      const stat = fs.statSync(game.gameFile);
      if (stat.size <= 25 * 1024 * 1024) { // Discord's 25 MB limit
        await channel.send({
          content: '📦 Game archive (contains patch files for each player):',
          files: [new AttachmentBuilder(game.gameFile, { name: path.basename(game.gameFile) })],
        });
      } else {
        await channel.send({ content: `📦 Game archive is too large to attach (${(stat.size / 1024 / 1024).toFixed(1)} MB). Ask the host for the file.` });
      }
    } catch (e) {
      console.error('Could not attach archive:', e.message);
    }
  } catch (e) {
    console.error('Could not create game channel:', e.message);
  }

  const locationCounts = await readLocationCounts(game.gameFile);
  await dbExecute(
    `UPDATE games SET status = 'running', port = ?, pid = ?, channelId = ?, startedAt = ?, gameOptions = ?, locationCounts = ?
     WHERE id = ?`,
    [port, pid, channelId, Math.floor(Date.now() / 1000), '{}', JSON.stringify(locationCounts), gameId]
  );

  return interaction.followUp({
    content: `**${game.gameName}** is running!\nConnect at: \`${config.serverHost}:${port}\`${channelId ? ` — <#${channelId}>` : ''}`,
  });
}

function buildGameControlsRow(gameId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`feedlevel_${gameId}`)
      .setPlaceholder('Game feed: Pings only (default)')
      .addOptions([
        { label: 'Pings only', description: 'No automatic messages — only priority item pings', value: 'none' },
        { label: 'Goals + Hints', description: 'Post goal completions and hint messages', value: 'goals' },
        { label: 'Progression items', description: 'Post when a progression item is found', value: 'items_prog' },
        { label: 'All items', description: 'Post every item send', value: 'items_all' },
        { label: 'Full feed', description: 'Post everything: items, joins, parts, chat, hints', value: 'full' },
      ])
  );
}

async function handleNotifToggle(interaction, gameId) {
  const userId = interaction.user.id;
  const game = await dbQueryOne('SELECT players FROM games WHERE id = ?', [gameId]);
  if (!game) return interaction.reply({ content: 'Game not found.', ephemeral: true });

  let players;
  try { players = JSON.parse(game.players ?? '[]'); } catch { players = []; }
  const isPlayer = players.some((p) => p.discordUserId === userId);
  if (!isPlayer && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'You are not a player in this game.', ephemeral: true });
  }

  const existing = await dbQueryOne(
    'SELECT enabled FROM notifications WHERE userId = ? AND gameId = ?',
    [userId, gameId]
  );
  if (!existing) {
    await dbExecute('INSERT INTO notifications (userId, gameId, enabled) VALUES (?,?,1)', [userId, gameId]);
    return interaction.reply({ content: '🔔 Priority pings enabled! You will be pinged when a progression item belonging to you is found.', ephemeral: true });
  }
  const newEnabled = existing.enabled ? 0 : 1;
  await dbExecute(
    'UPDATE notifications SET enabled = ? WHERE userId = ? AND gameId = ?',
    [newEnabled, userId, gameId]
  );
  return interaction.reply({
    content: newEnabled ? '🔔 Priority pings enabled!' : '🔕 Priority pings disabled.',
    ephemeral: true,
  });
}

async function handleFeedLevel(interaction, gameId) {
  const userId = interaction.user.id;
  const game = await dbQueryOne('SELECT players FROM games WHERE id = ?', [gameId]);
  if (!game) return interaction.reply({ content: 'Game not found.', ephemeral: true });

  let players;
  try { players = JSON.parse(game.players ?? '[]'); } catch { players = []; }
  const isPlayer = players.some((p) => p.discordUserId === userId);
  if (!isPlayer && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'You are not a player in this game.', ephemeral: true });
  }

  const level = interaction.values[0];
  await dbExecute('UPDATE games SET feedLevel = ? WHERE id = ?', [level, gameId]);

  const labels = {
    none: 'Pings only',
    goals: 'Goals + Hints',
    items_prog: 'Progression items',
    items_all: 'All items',
    full: 'Full feed',
  };
  return interaction.reply({ content: `Feed level set to **${labels[level] ?? level}**.`, ephemeral: true });
}

module.exports = {
  category: 'Game Manager',
  startGameHandler: doStartGame,
  handleNotifToggle,
  handleFeedLevel,

  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-start')
        .setDescription('Start a generated Archipelago game.')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        const gameId = interaction.options.getInteger('game-id') ?? (
          await dbQueryOne("SELECT id FROM games WHERE channelId = ? AND status = 'pending'", [interaction.channelId])
        )?.id;
        if (!gameId) {
          return interaction.reply({ content: 'No pending game found in this channel. Specify a `game-id`.', ephemeral: true });
        }
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
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to stop games.', ephemeral: true });
        }
        const gameId = interaction.options.getInteger('game-id') ?? (
          await dbQueryOne("SELECT id FROM games WHERE channelId = ? AND status = 'running'", [interaction.channelId])
        )?.id;
        if (!gameId) {
          return interaction.reply({ content: 'No running game found in this channel. Specify a `game-id`.', ephemeral: true });
        }
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
              return `**#${g.id}** ${g.gameName} — \`${g.status}\`${g.port ? ` (port ${g.port})` : ''} — ${when}`;
            }).join('\n')
          );

        return interaction.reply({ embeds: [embed] });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-mc-restart')
        .setDescription('Restart the Minecraft server for a running game. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to restart the Minecraft server.', ephemeral: true });
        }

        const gameId = interaction.options.getInteger('game-id') ?? (
          await dbQueryOne("SELECT id FROM games WHERE channelId = ? AND status = 'running'", [interaction.channelId])
        )?.id;

        if (!gameId) {
          return interaction.reply({ content: 'No running game found in this channel. Specify a `game-id`.', ephemeral: true });
        }

        if (!minecraftManager.isRunning(gameId)) {
          return interaction.reply({ content: 'No Minecraft server is running for this game.', ephemeral: true });
        }

        const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
        await interaction.deferReply();

        minecraftManager.stop(gameId);
        try {
          await minecraftManager.start(gameId, game.gameFile, `${config.serverHost}:${game.port}`);
        } catch (e) {
          return interaction.followUp({ content: `Failed to restart Minecraft server: \`${e.message}\`` });
        }

        return interaction.followUp({ content: `Minecraft server for **${game.gameName}** restarted. Connect at \`${config.serverHost}:25565\`.` });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-archive')
        .setDescription('Mark a game as archived. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to archive games.', ephemeral: true });
        }
        const gameId = interaction.options.getInteger('game-id') ?? (
          await dbQueryOne("SELECT id FROM games WHERE channelId = ? AND status != 'archived'", [interaction.channelId])
        )?.id;
        if (!gameId) {
          return interaction.reply({ content: 'No game found in this channel. Specify a `game-id`.', ephemeral: true });
        }
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

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-cmd')
        .setDescription('Send a command to the running AP server in this channel. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addStringOption((opt) => opt
          .setName('command')
          .setDescription('Command to send, e.g. !hint Bananonymous "Empowering Jumps"')
          .setRequired(true)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to run server commands.', ephemeral: true });
        }
        const game = await dbQueryOne(
          "SELECT id, gameName FROM games WHERE channelId = ? AND status = 'running'",
          [interaction.channelId]
        );
        if (!game) {
          return interaction.reply({ content: 'No running game found in this channel.', ephemeral: true });
        }
        const cmd = interaction.options.getString('command');
        await interaction.deferReply({ ephemeral: true });
        const lines = await processManager.sendCommand(game.id, cmd);
        if (lines === null) {
          return interaction.editReply({ content: 'Server process not found — the game may have crashed.' });
        }
        const output = lines.join('\n').trim();
        return interaction.editReply({
          content: output
            ? `**${game.gameName}** › \`${cmd}\`\n\`\`\`${output.slice(0, 1900)}\`\`\``
            : `Sent \`${cmd}\` — no output.`,
        });
      },
    },
  ],
};
