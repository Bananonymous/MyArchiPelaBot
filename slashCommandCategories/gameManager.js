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
const webClientServer = require('../lib/webClientServer');

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

  const port = await portManager.allocateForGame(gameId);
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
    await portManager.release(port);
    return interaction.followUp({ content: `Failed to start server: \`${e.message}\`` });
  }

  // Start Minecraft server if any player is using a Minecraft Dig game

  let mcStarted = false;
  let mcError = null;
  let mcPort = null;
  if (minecraftManager.isMinecraftGame(players)) {
    try {
      ({ port: mcPort } = await minecraftManager.start(gameId, game.gameFile, `${config.serverHost}:${port}`));
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
      { name: 'AP Connect', value: config.ssl?.cert ? `\`wss://${config.serverHost}:${port}\`` : `\`${config.serverHost}:${port}\``, inline: false },
      {
        name: 'Players',
        value: players.length ? players.map((p) => `${p.name} (${p.game})`).join('\n') : '_Unknown_',
      },
    ];

    if (mcStarted) {
      fields.push({ name: 'Minecraft Server', value: `\`${config.serverHost}:${mcPort}\``, inline: false });
    } else if (mcError) {
      fields.push({ name: 'Minecraft Server', value: `⚠️ Failed to start: ${mcError}`, inline: false });
    }

    if (config.webClientPort && players.some((p) => p.name)) {
      fields.push({ name: 'Web Clients', value: players.filter((p) => p.name).map((p) => p.name).join(', ') });
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
    const webClientRows = buildWebClientButtonRows(config, port, players);
    await channel.send({ embeds: [embed], components: [controlsRow, pingRow, ...webClientRows] });
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

  const locationCounts = await readLocationCounts(game.gameFile, players.map((p) => p.name));
  await dbExecute(
    `UPDATE games SET status = 'running', port = ?, pid = ?, channelId = ?, startedAt = ?, gameOptions = ?, locationCounts = ?
     WHERE id = ?`,
    [port, pid, channelId, Math.floor(Date.now() / 1000), '{}', JSON.stringify(locationCounts), gameId]
  );

  return interaction.followUp({
    content: `**${game.gameName}** is running!\nConnect at: \`${config.serverHost}:${port}\`${channelId ? ` — <#${channelId}>` : ''}`,
  });
}

// One small Link button per player, each pre-filled with that player's own slot name.
// Link buttons are static (no interaction fires on click), so this is the only way to
// get both "one click opens the browser" and "auto-fills the right player" at once —
// a single shared button can't know who clicked it.
function buildWebClientButtonRows(config, apPort, players) {
  if (!config.webClientPort || !Array.isArray(players) || players.length === 0) return [];
  // Message component limit: 5 rows total, 2 already used by controlsRow/pingRow.
  const named = players.filter((p) => p.name).slice(0, 15);
  const rows = [];
  for (let i = 0; i < named.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        named.slice(i, i + 5).map((p) =>
          new ButtonBuilder()
            .setURL(webClientServer.buildLink(config, apPort, p.name))
            .setLabel(`🌐 ${p.name}`.slice(0, 80))
            .setStyle(ButtonStyle.Link)
        )
      )
    );
  }
  return rows;
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
        await portManager.release(game.port);
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
        let mcPort;
        try {
          ({ port: mcPort } = await minecraftManager.start(gameId, game.gameFile, `${config.serverHost}:${game.port}`));
        } catch (e) {
          return interaction.followUp({ content: `Failed to restart Minecraft server: \`${e.message}\`` });
        }

        return interaction.followUp({ content: `Minecraft server for **${game.gameName}** restarted. Connect at \`${config.serverHost}:${mcPort}\`.` });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-archive')
        .setDescription('Stop (if running) and archive a game. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to archive games.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        const explicitGameId = interaction.options.getInteger('game-id');
        const gameId = explicitGameId ?? (
          await dbQueryOne("SELECT id FROM games WHERE channelId = ? AND status != 'archived' ORDER BY id DESC LIMIT 1", [interaction.channelId])
        )?.id;
        if (!gameId) {
          return interaction.editReply({ content: 'No game found in this channel. Specify a `game-id`.' });
        }
        const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
        if (!game) {
          return interaction.editReply({ content: `No game found with ID **${gameId}**.` });
        }

        // Stop first if needed (same behavior as /ap-stop)
        if (game.status === 'running') {
          try { processManager.stop(gameId); } catch (_) {}
          try { minecraftManager.stop(gameId); } catch (_) {}
          if (game.port) {
            try { await portManager.release(game.port); } catch (_) {}
          } else {
            // In case port wasn't persisted for some reason, also clear any reservation.
            try { await portManager.releaseByGameId(gameId); } catch (_) {}
          }
        }

        const now = Math.floor(Date.now() / 1000);
        await dbExecute("UPDATE games SET status = 'archived', endedAt = ? WHERE id = ?", [now, gameId]);

        // Channel deletion behavior:
        // - If /ap-archive is run *inside* a game channel (no game-id provided), delete the current channel.
        // - If a game-id is provided, delete the game's recorded channelId.
        const targetChannelId = explicitGameId ? game.channelId : interaction.channelId;
        if (targetChannelId) {
          try {
            const ch = await interaction.guild.channels.fetch(targetChannelId);
            if (ch) await ch.delete(`Archived game #${gameId}`);
          } catch (_) {}
        }

        return interaction.editReply({ content: `Game **${game.gameName}** (ID ${gameId}) archived and channel removed.` });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-cmd')
        .setDescription('Send a command to the running AP server in this channel. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addStringOption((opt) => opt
          .setName('command')
          .setDescription('Server console command, e.g. /hint Bananonymous Empowering Jumps')
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
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-recover')
        .setDescription('Re-send items from DB to AP server (use after save loss). (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID to recover (defaults to game in this channel)'))
        .addStringOption((opt) => opt
          .setName('player')
          .setDescription('Player name to recover (defaults to all players)')),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        let gameId = interaction.options.getInteger('game-id');
        if (!gameId) {
          const game = await dbQueryOne(
            "SELECT id FROM games WHERE channelId = ? AND status = 'running'",
            [interaction.channelId]
          );
          if (!game) return interaction.editReply({ content: 'No running game found in this channel.' });
          gameId = game.id;
        }

        const playerFilter = interaction.options.getString('player');

        // Primary: restore by location (restores check count + sends item to receiver)
        const locRows = playerFilter
          ? await dbQueryAll('SELECT DISTINCT senderName, locationName FROM game_items WHERE gameId = ? AND senderName = ? AND locationName IS NOT NULL', [gameId, playerFilter])
          : await dbQueryAll('SELECT DISTINCT senderName, locationName FROM game_items WHERE gameId = ? AND locationName IS NOT NULL', [gameId]);

        // Fallback: items with no locationName recorded — restore by receiver
        const itemRows = playerFilter
          ? await dbQueryAll('SELECT receiverName, itemName, COUNT(*) as cnt FROM game_items WHERE gameId = ? AND receiverName = ? AND locationName IS NULL GROUP BY receiverName, itemName', [gameId, playerFilter])
          : await dbQueryAll('SELECT receiverName, itemName, COUNT(*) as cnt FROM game_items WHERE gameId = ? AND locationName IS NULL GROUP BY receiverName, itemName', [gameId]);

        if ((!locRows || locRows.length === 0) && (!itemRows || itemRows.length === 0)) {
          return interaction.editReply({ content: 'No items found in DB for this game.' });
        }

        const commands = [
          ...(locRows ?? []).map((r) => `/send_location ${r.senderName} ${r.locationName}`),
          ...(itemRows ?? []).map((r) => `/send_multiple ${r.cnt} ${r.receiverName} ${r.itemName}`),
        ];

        // Snapshot game_items to game_items_backup BEFORE any destructive op,
        // so /ap-recover-undo can restore if the resends don't repopulate.
        const recoveryRunId = Date.now();
        const now = Math.floor(Date.now() / 1000);
        if (playerFilter) {
          await dbExecute(
            `INSERT INTO game_items_backup
               (recoveryRunId, gameId, originalId, senderName, receiverName, itemName, locationName, flags, sentAt, backedUpAt)
             SELECT ?, gameId, id, senderName, receiverName, itemName, locationName, flags, sentAt, ?
             FROM game_items WHERE gameId = ? AND (senderName = ? OR receiverName = ?)`,
            [recoveryRunId, now, gameId, playerFilter, playerFilter]
          );
        } else {
          await dbExecute(
            `INSERT INTO game_items_backup
               (recoveryRunId, gameId, originalId, senderName, receiverName, itemName, locationName, flags, sentAt, backedUpAt)
             SELECT ?, gameId, id, senderName, receiverName, itemName, locationName, flags, sentAt, ?
             FROM game_items WHERE gameId = ?`,
            [recoveryRunId, now, gameId]
          );
        }

        const ok = processManager.sendBatch(gameId, commands);
        if (!ok) return interaction.editReply({ content: 'Server process not found — game may have crashed. (No DB changes made.)' });

        // Clear DB so AP-refired ItemSend events repopulate without double-counting.
        // The snapshot above can be restored via /ap-recover-undo if refire fails.
        if (playerFilter) {
          await dbExecute('DELETE FROM game_items WHERE gameId = ? AND (senderName = ? OR receiverName = ?)', [gameId, playerFilter, playerFilter]);
        } else {
          await dbExecute('DELETE FROM game_items WHERE gameId = ?', [gameId]);
        }

        const senders = [...new Set((locRows ?? []).map((r) => r.senderName))];
        const totalLoc = locRows?.length ?? 0;
        const totalItem = (itemRows ?? []).reduce((s, r) => s + r.cnt, 0);
        return interaction.editReply({
          content:
            `Recovery sent: ${totalLoc} location checks (${senders.join(', ')}) + ${totalItem} fallback items.\n` +
            `Snapshot saved — recovery ID **${recoveryRunId}**.\n` +
            `If items don't repopulate after a few seconds, run \`/ap-recover-undo recovery-id:${recoveryRunId}\` to restore.`,
        });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-recover-undo')
        .setDescription('Restore game_items from a recovery snapshot. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('recovery-id')
          .setDescription('Recovery ID returned by /ap-recover (defaults to most recent for this game)')
          .setRequired(false))
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        let gameId = interaction.options.getInteger('game-id');
        if (!gameId) {
          const game = await dbQueryOne(
            "SELECT id FROM games WHERE channelId = ?",
            [interaction.channelId]
          );
          if (!game) return interaction.editReply({ content: 'No game found in this channel.' });
          gameId = game.id;
        }

        let recoveryRunId = interaction.options.getInteger('recovery-id');
        if (!recoveryRunId) {
          const latest = await dbQueryOne(
            'SELECT recoveryRunId FROM game_items_backup WHERE gameId = ? ORDER BY recoveryRunId DESC LIMIT 1',
            [gameId]
          );
          if (!latest) return interaction.editReply({ content: 'No recovery snapshots found for this game.' });
          recoveryRunId = latest.recoveryRunId;
        }

        const snap = await dbQueryAll(
          'SELECT * FROM game_items_backup WHERE gameId = ? AND recoveryRunId = ?',
          [gameId, recoveryRunId]
        );
        if (!snap) return interaction.editReply({ content: `No snapshot found for game ${gameId}, recovery ${recoveryRunId}.` });

        // Wipe current rows and re-insert from snapshot. Do NOT touch the snapshot
        // itself so a second undo is still possible.
        await dbExecute('DELETE FROM game_items WHERE gameId = ?', [gameId]);
        for (const row of snap) {
          await dbExecute(
            `INSERT INTO game_items (gameId, senderName, receiverName, itemName, locationName, flags, sentAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [row.gameId, row.senderName, row.receiverName, row.itemName, row.locationName, row.flags, row.sentAt]
          );
        }

        return interaction.editReply({
          content: `Restored ${snap.length} item rows for game ${gameId} from recovery snapshot ${recoveryRunId}.`,
        });
      },
    },
  ],
};
