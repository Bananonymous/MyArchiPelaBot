const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  InteractionContextType,
  EmbedBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const config = require('../config.json');
const { dbExecute, dbQueryOne, dbQueryAll } = require('../database');
const { isAdmin } = require('../lib/permissions');
const yamlValidator = require('../lib/yamlValidator');
const archipelagoRunner = require('../lib/archipelagoRunner');
const portManager = require('../lib/portManager');
const processManager = require('../lib/processManager');
const minecraftManager = require('../lib/minecraftManager');

async function buildStatusEmbed(lobby, players) {
  const playerLines = players && players.length
    ? players.map((p) => {
        const status = p.yamlPath ? `✅ ${p.playerName ?? 'unknown'} (${p.gameName ?? '?'})` : `⏳ <@${p.userId}> (no YAML yet)`;
        return status;
      }).join('\n')
    : '_No players yet — use /ap-lobby-join_';

  return new EmbedBuilder()
    .setTitle(`Lobby: ${lobby.name}`)
    .setColor(lobby.status === 'open' ? 0x00b0f4 : lobby.status === 'generating' ? 0xffa500 : 0x888888)
    .addFields(
      { name: 'Lobby ID', value: String(lobby.id), inline: true },
      { name: 'Status', value: lobby.status, inline: true },
      { name: 'Created by', value: `<@${lobby.creatorId}>`, inline: true },
      { name: `Players (${players?.length ?? 0})`, value: playerLines },
    )
    .setFooter({ text: 'Use /ap-lobby-join to submit your YAML • /ap-lobby-start to generate' })
    .setTimestamp();
}

async function refreshStatusMessage(interaction, lobby) {
  if (!lobby.statusMessageId || !lobby.channelId) return;
  try {
    const channel = await interaction.client.channels.fetch(lobby.channelId);
    const msg = await channel.messages.fetch(lobby.statusMessageId);
    const players = await dbQueryAll('SELECT * FROM lobby_players WHERE lobbyId = ?', [lobby.id]);
    await msg.edit({ embeds: [await buildStatusEmbed(lobby, players)] });
  } catch (_) {}
}

async function deleteStatusMessage(interaction, lobby) {
  if (!lobby.statusMessageId || !lobby.channelId) return;
  try {
    const channel = await interaction.client.channels.fetch(lobby.channelId);
    const msg = await channel.messages.fetch(lobby.statusMessageId);
    await msg.delete();
  } catch (_) {}
}

module.exports = {
  category: 'Lobby',
  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-lobby-create')
        .setDescription('Create a multiplayer lobby. Players join with /ap-lobby-join.')
        .setContexts(InteractionContextType.Guild)
        .addStringOption((opt) => opt
          .setName('name')
          .setDescription('Name for this game session')
          .setRequired(true)),
      async execute(interaction) {
        const name = interaction.options.getString('name');

        // Only one open lobby per channel
        const existing = await dbQueryOne(
          "SELECT id FROM lobbies WHERE guildId = ? AND channelId = ? AND status = 'open'",
          [interaction.guildId, interaction.channelId]
        );
        if (existing) {
          return interaction.reply({
            content: `There is already an open lobby in this channel (ID ${existing.id}). Cancel it first with \`/ap-lobby-cancel\`.`,
            ephemeral: true,
          });
        }

        await dbExecute(
          'INSERT INTO lobbies (guildId, channelId, creatorId, name, createdAt) VALUES (?,?,?,?,?)',
          [interaction.guildId, interaction.channelId, interaction.user.id, name, Math.floor(Date.now() / 1000)]
        );
        const lobby = await dbQueryOne(
          'SELECT * FROM lobbies WHERE channelId = ? ORDER BY id DESC LIMIT 1',
          [interaction.channelId]
        );

        const embed = await buildStatusEmbed(lobby, []);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`lobbystart_${lobby.id}`)
            .setLabel('Start Game')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`lobbycancel_${lobby.id}`)
            .setLabel('Cancel Lobby')
            .setStyle(ButtonStyle.Danger),
        );

        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        await dbExecute('UPDATE lobbies SET statusMessageId = ? WHERE id = ?', [msg.id, lobby.id]);
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-lobby-join')
        .setDescription('Submit a YAML to the open lobby. Use on-behalf to submit for another player.')
        .setContexts(InteractionContextType.Guild)
        .addAttachmentOption((opt) => opt
          .setName('yaml')
          .setDescription('Player YAML file')
          .setRequired(true))
        .addStringOption((opt) => opt
          .setName('on-behalf')
          .setDescription('Submit for this player name instead of yourself (lobby creator/admin only)')
          .setRequired(false)),
      async execute(interaction) {
        const lobby = await dbQueryOne(
          "SELECT * FROM lobbies WHERE guildId = ? AND channelId = ? AND status = 'open'",
          [interaction.guildId, interaction.channelId]
        );
        if (!lobby) {
          return interaction.reply({
            content: 'No open lobby in this channel. Create one with `/ap-lobby-create`.',
            ephemeral: true,
          });
        }

        const onBehalf = interaction.options.getString('on-behalf', false);
        if (onBehalf && lobby.creatorId !== interaction.user.id && !isAdmin(interaction.member)) {
          return interaction.reply({
            content: 'Only the lobby creator or an admin can submit on behalf of another player.',
            ephemeral: true,
          });
        }

        const attachment = interaction.options.getAttachment('yaml');
        const ext = path.extname(attachment.name).toLowerCase();
        if (ext !== '.yaml' && ext !== '.yml') {
          return interaction.reply({ content: 'Only `.yaml` / `.yml` files are accepted.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        // Use a stable key: Discord user ID for self, sanitised name for on-behalf slots
        const slotKey = onBehalf
          ? `behalf_${onBehalf.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
          : interaction.user.id;

        const lobbyDir = path.join(config.dataPath, 'temp', `lobby-${lobby.id}`);
        fs.mkdirSync(lobbyDir, { recursive: true });
        const yamlPath = path.join(lobbyDir, `${slotKey}${ext}`);

        try {
          const response = await axios.get(attachment.url, { responseType: 'stream' });
          await new Promise((resolve, reject) => {
            response.data.pipe(fs.createWriteStream(yamlPath)).on('close', resolve).on('error', reject);
          });
        } catch (e) {
          return interaction.followUp({ content: `Failed to download YAML: ${e.message}` });
        }

        // Validate
        const result = yamlValidator.validateFile(yamlPath);
        if (!result.valid) {
          fs.unlinkSync(yamlPath);
          return interaction.followUp({
            content: `**YAML validation failed:**\n${result.errors.map((e) => `• ${e}`).join('\n')}`,
          });
        }

        const player = result.players[0] ?? {};
        await dbExecute(
          `INSERT INTO lobby_players (lobbyId, userId, playerName, gameName, yamlPath, joinedAt)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(lobbyId, userId) DO UPDATE SET
             playerName = excluded.playerName,
             gameName   = excluded.gameName,
             yamlPath   = excluded.yamlPath,
             joinedAt   = excluded.joinedAt`,
          [lobby.id, slotKey, player.name ?? null, player.game ?? null, yamlPath, Math.floor(Date.now() / 1000)]
        );

        await refreshStatusMessage(interaction, lobby);
        const label = onBehalf ? `on behalf of **${onBehalf}**` : 'yourself';
        return interaction.followUp({
          content: `Submitted ${label} as **${player.name}** (${player.game}) in **${lobby.name}**.`,
        });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-lobby-leave')
        .setDescription('Leave the open lobby in this channel.')
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        const lobby = await dbQueryOne(
          "SELECT * FROM lobbies WHERE guildId = ? AND channelId = ? AND status = 'open'",
          [interaction.guildId, interaction.channelId]
        );
        if (!lobby) {
          return interaction.reply({ content: 'No open lobby in this channel.', ephemeral: true });
        }

        const entry = await dbQueryOne(
          'SELECT yamlPath FROM lobby_players WHERE lobbyId = ? AND userId = ?',
          [lobby.id, interaction.user.id]
        );
        if (!entry) {
          return interaction.reply({ content: "You haven't joined this lobby.", ephemeral: true });
        }

        if (entry.yamlPath && fs.existsSync(entry.yamlPath)) fs.unlinkSync(entry.yamlPath);
        await dbExecute('DELETE FROM lobby_players WHERE lobbyId = ? AND userId = ?', [lobby.id, interaction.user.id]);
        await refreshStatusMessage(interaction, lobby);
        return interaction.reply({ content: 'You have left the lobby.', ephemeral: true });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-lobby-status')
        .setDescription('Show the current lobby status in this channel.')
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        const lobby = await dbQueryOne(
          "SELECT * FROM lobbies WHERE guildId = ? AND channelId = ? AND status = 'open'",
          [interaction.guildId, interaction.channelId]
        );
        if (!lobby) {
          return interaction.reply({ content: 'No open lobby in this channel.', ephemeral: true });
        }
        const players = await dbQueryAll('SELECT * FROM lobby_players WHERE lobbyId = ?', [lobby.id]);
        return interaction.reply({ embeds: [await buildStatusEmbed(lobby, players)] });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-lobby-start')
        .setDescription('Generate and start the game from all submitted YAMLs.')
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        return startLobby(interaction, null);
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-lobby-cancel')
        .setDescription('Cancel the open lobby in this channel.')
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        return cancelLobby(interaction, null);
      },
    },
  ],

  // Called from button handlers in bot.js
  startLobbyHandler: (interaction, lobbyId) => startLobby(interaction, lobbyId),
  cancelLobbyHandler: (interaction, lobbyId) => cancelLobby(interaction, lobbyId),
};

async function startLobby(interaction, explicitLobbyId) {
  const lobby = explicitLobbyId
    ? await dbQueryOne("SELECT * FROM lobbies WHERE id = ? AND status = 'open'", [explicitLobbyId])
    : await dbQueryOne(
        "SELECT * FROM lobbies WHERE guildId = ? AND channelId = ? AND status = 'open'",
        [interaction.guildId, interaction.channelId]
      );

  if (!lobby) {
    return interaction.reply({ content: 'No open lobby found.', ephemeral: true });
  }
  if (lobby.creatorId !== interaction.user.id && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only the lobby creator or an admin can start the game.', ephemeral: true });
  }

  const players = await dbQueryAll('SELECT * FROM lobby_players WHERE lobbyId = ?', [lobby.id]);
  if (!players || players.length === 0) {
    return interaction.reply({ content: 'No players have joined yet.', ephemeral: true });
  }
  const missing = players.filter((p) => !p.yamlPath);
  if (missing.length) {
    return interaction.reply({
      content: `These players haven't submitted a YAML yet: ${missing.map((p) => `<@${p.userId}>`).join(', ')}`,
      ephemeral: true,
    });
  }

  await interaction.deferReply();
  await dbExecute("UPDATE lobbies SET status = 'generating' WHERE id = ?", [lobby.id]);
  await refreshStatusMessage(interaction, { ...lobby, status: 'generating' });

  const workDir = path.join(config.dataPath, 'temp', `gen-lobby-${lobby.id}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  let generatedFile;
  try {
    generatedFile = await archipelagoRunner.generate(players.map((p) => p.yamlPath), workDir);
  } catch (e) {
    await dbExecute("UPDATE lobbies SET status = 'open' WHERE id = ?", [lobby.id]);
    await refreshStatusMessage(interaction, { ...lobby, status: 'open' });
    fs.rmSync(workDir, { recursive: true, force: true });
    return interaction.followUp({
      content: `**Generation failed:**\n\`\`\`${e.message.slice(0, 1500)}\`\`\``,
    });
  }

  const archivesDir = path.join(config.dataPath, 'archives');
  fs.mkdirSync(archivesDir, { recursive: true });
  const ext = path.extname(generatedFile);
  const archiveName = `${Date.now()}-${lobby.name.replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
  const archivePath = path.join(archivesDir, archiveName);
  fs.renameSync(generatedFile, archivePath);
  fs.rmSync(workDir, { recursive: true, force: true });

  const playerData = players.map((p) => ({ name: p.playerName, game: p.gameName }));
  await dbExecute(
    `INSERT INTO games (guildId, gameFile, status, players, gameName, startedAt)
     VALUES (?,?,'pending',?,?,?)`,
    [interaction.guildId, archivePath, JSON.stringify(playerData), lobby.name, Math.floor(Date.now() / 1000)]
  );
  const game = await dbQueryOne('SELECT id FROM games WHERE gameFile = ?', [archivePath]);
  await dbExecute("UPDATE lobbies SET status = 'done' WHERE id = ?", [lobby.id]);

  // Start the server
  const port = portManager.allocate();
  if (!port) {
    return interaction.followUp({ content: 'No ports available. Stop a running game first.' });
  }

  let pid;
  try {
    pid = await processManager.start(game.id, archivePath, port);
  } catch (e) {
    portManager.release(port);
    return interaction.followUp({ content: `Generation succeeded but server failed to start: \`${e.message}\`` });
  }

  // Start Minecraft server if any player uses a Minecraft game
  let mcStarted = false;
  let mcError = null;
  if (minecraftManager.isMinecraftGame(playerData)) {
    try {
      await minecraftManager.start(game.id, archivePath, `${config.serverHost}:${port}`);
      mcStarted = true;
    } catch (e) {
      mcError = e.message;
      console.error(`[mc-${game.id}] Failed to start Minecraft server: ${e.message}`);
    }
  }

  let channelId = null;
  try {
    const safeName = `ap-${lobby.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 90)}`;
    const channel = await interaction.guild.channels.create({
      name: safeName,
      topic: `Archipelago: ${lobby.name} | ${config.serverHost}:${port}`,
    });
    channelId = channel.id;

    const fields = [
      { name: 'Connect', value: `\`${config.serverHost}:${port}\``, inline: false },
      { name: 'Players', value: playerData.map((p) => `${p.name} (${p.game})`).join('\n') },
    ];
    if (mcStarted) fields.push({ name: 'Minecraft Server', value: `\`${config.serverHost}:25565\``, inline: false });
    else if (mcError) fields.push({ name: 'Minecraft Server', value: `⚠️ Failed to start: ${mcError}`, inline: false });

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Game Started: ${lobby.name}`)
          .setColor(0x00cc44)
          .addFields(fields)
          .setTimestamp(),
      ],
    });

    // Post archive as downloadable attachment for players to get their patch files
    try {
      const stat = fs.statSync(archivePath);
      if (stat.size <= 25 * 1024 * 1024) {
        await channel.send({
          content: '📦 Game archive (contains patch files for each player):',
          files: [new AttachmentBuilder(archivePath, { name: path.basename(archivePath) })],
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

  await dbExecute(
    "UPDATE games SET status='running', port=?, pid=?, channelId=?, startedAt=? WHERE id=?",
    [port, pid, channelId, Math.floor(Date.now() / 1000), game.id]
  );

  // Remove the lobby status embed now that the game is live
  await deleteStatusMessage(interaction, lobby);

  return interaction.followUp({
    content: `**${lobby.name}** is live!\nConnect at: \`${config.serverHost}:${port}\`${channelId ? ` — <#${channelId}>` : ''}`,
  });
}

async function cancelLobby(interaction, explicitLobbyId) {
  const lobby = explicitLobbyId
    ? await dbQueryOne("SELECT * FROM lobbies WHERE id = ? AND status = 'open'", [explicitLobbyId])
    : await dbQueryOne(
        "SELECT * FROM lobbies WHERE guildId = ? AND channelId = ? AND status = 'open'",
        [interaction.guildId, interaction.channelId]
      );

  if (!lobby) {
    return interaction.reply({ content: 'No open lobby found.', ephemeral: true });
  }
  if (lobby.creatorId !== interaction.user.id && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only the lobby creator or an admin can cancel.', ephemeral: true });
  }

  // Clean up YAML files
  const players = await dbQueryAll('SELECT yamlPath FROM lobby_players WHERE lobbyId = ?', [lobby.id]);
  if (players) {
    for (const p of players) {
      if (p.yamlPath && fs.existsSync(p.yamlPath)) fs.unlinkSync(p.yamlPath);
    }
  }
  const lobbyDir = path.join(config.dataPath, 'temp', `lobby-${lobby.id}`);
  if (fs.existsSync(lobbyDir)) fs.rmSync(lobbyDir, { recursive: true, force: true });

  await dbExecute('DELETE FROM lobby_players WHERE lobbyId = ?', [lobby.id]);
  await dbExecute("UPDATE lobbies SET status = 'cancelled' WHERE id = ?", [lobby.id]);
  await deleteStatusMessage(interaction, lobby);

  return interaction.reply({ content: `Lobby **${lobby.name}** cancelled.` });
}
