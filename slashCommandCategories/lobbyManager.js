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
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config.json');
const { dbExecute, dbInsert, dbQueryOne, dbQueryAll } = require('../database');
const { isAdmin } = require('../lib/permissions');
const yamlValidator = require('../lib/yamlValidator');
const archipelagoRunner = require('../lib/archipelagoRunner');
const portManager = require('../lib/portManager');
const processManager = require('../lib/processManager');
const minecraftManager = require('../lib/minecraftManager');
const { attachGameNotifier } = require('../lib/gameNotifier');
const { setupTrackers } = require('../lib/trackerUpdater');
const { readLocationCounts } = require('../lib/locationCountReader');

const DEFAULT_OPTIONS = {
  release_mode: 'goal',
  collect_mode: 'goal',
  remaining_mode: 'goal',
  hint_cost: 10,
};

function parseOptions(optionsStr) {
  try { return { ...DEFAULT_OPTIONS, ...JSON.parse(optionsStr ?? '{}') }; } catch { return { ...DEFAULT_OPTIONS }; }
}

const RELEASE_OPTIONS = [
  { label: 'Disabled',      description: '!release is never available',                         value: 'disabled' },
  { label: 'Manual always', description: 'Players can use !release at any time',                value: 'enabled' },
  { label: 'After goal',    description: 'Players can use !release after completing their goal', value: 'goal' },
  { label: 'Auto on goal',  description: 'Items auto-released when goal is completed',           value: 'auto' },
  { label: 'Auto + manual', description: 'Auto-released on goal and always available',           value: 'auto-enabled' },
];
const COLLECT_OPTIONS = [
  { label: 'Disabled',      description: '!collect is never available',                          value: 'disabled' },
  { label: 'Manual always', description: 'Players can use !collect at any time',                 value: 'enabled' },
  { label: 'After goal',    description: 'Players can use !collect after completing their goal',  value: 'goal' },
  { label: 'Auto on goal',  description: 'Items auto-collected when goal is completed',           value: 'auto' },
  { label: 'Auto + manual', description: 'Auto-collected on goal and always available',           value: 'auto-enabled' },
];
const REMAINING_OPTIONS = [
  { label: 'Disabled',   description: '!remaining is never available',             value: 'disabled' },
  { label: 'After goal', description: '!remaining available after completing goal', value: 'goal' },
  { label: 'Always',     description: '!remaining is always available',             value: 'enabled' },
];

function buildOptionsPanel(lobby) {
  const opts = parseOptions(lobby.options);
  const label = (list, val) => list.find((o) => o.value === val)?.label ?? val;
  const withDefault = (list, current) => list.map((o) => ({ ...o, default: o.value === current }));

  const embed = new EmbedBuilder()
    .setTitle('Lobby Options')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Release mode',   value: label(RELEASE_OPTIONS,   opts.release_mode),   inline: true },
      { name: 'Collect mode',   value: label(COLLECT_OPTIONS,   opts.collect_mode),   inline: true },
      { name: 'Remaining mode', value: label(REMAINING_OPTIONS, opts.remaining_mode), inline: true },
      { name: 'Hint cost',      value: `${opts.hint_cost} points`,                    inline: true },
    )
    .setFooter({ text: 'Changes apply immediately' });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lobbyopt_release_${lobby.id}`)
          .setPlaceholder('Release mode')
          .addOptions(withDefault(RELEASE_OPTIONS, opts.release_mode))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lobbyopt_collect_${lobby.id}`)
          .setPlaceholder('Collect mode')
          .addOptions(withDefault(COLLECT_OPTIONS, opts.collect_mode))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lobbyopt_remaining_${lobby.id}`)
          .setPlaceholder('Remaining mode')
          .addOptions(withDefault(REMAINING_OPTIONS, opts.remaining_mode))
      ),
    ],
  };
}

async function buildStatusEmbed(lobby, players) {
  const playerLines = players && players.length
    ? players.map((p) => {
        const status = p.yamlPath ? `✅ ${p.playerName ?? 'unknown'} (${p.gameName ?? '?'})` : `⏳ <@${p.userId}> (no YAML yet)`;
        return status;
      }).join('\n')
    : '_No players yet — use /ap-lobby-join_';

  const opts = parseOptions(lobby.options);
  const optSummary = `Release: **${RELEASE_OPTIONS.find((o) => o.value === opts.release_mode)?.label ?? opts.release_mode}** | Collect: **${COLLECT_OPTIONS.find((o) => o.value === opts.collect_mode)?.label ?? opts.collect_mode}** | Remaining: **${REMAINING_OPTIONS.find((o) => o.value === opts.remaining_mode)?.label ?? opts.remaining_mode}** | Hint cost: **${opts.hint_cost}**`;

  return new EmbedBuilder()
    .setTitle(`Lobby: ${lobby.name}`)
    .setColor(lobby.status === 'open' ? 0x00b0f4 : lobby.status === 'generating' ? 0xffa500 : 0x888888)
    .addFields(
      { name: 'Lobby ID', value: String(lobby.id), inline: true },
      { name: 'Status', value: lobby.status, inline: true },
      { name: 'Created by', value: `<@${lobby.creatorId}>`, inline: true },
      { name: `Players (${players?.length ?? 0})`, value: playerLines },
      { name: 'Options', value: optSummary },
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

async function joinLobbyButton(interaction, lobbyId) {
  const lobby = await dbQueryOne("SELECT * FROM lobbies WHERE id = ? AND status = 'open'", [lobbyId]);
  if (!lobby) return interaction.reply({ content: 'This lobby is no longer open.', ephemeral: true });

  const modal = new ModalBuilder()
    .setCustomId(`lobbyjoinmodal_${lobbyId}`)
    .setTitle(`Join: ${lobby.name.slice(0, 40)} (ID:${lobby.id})`);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('yaml_content')
        .setLabel('Paste your YAML settings here')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('name: MyPlayer\ngame: A Link to the Past\n...')
        .setMaxLength(4000)
    )
  );

  await interaction.showModal(modal);
}

async function joinLobbyModal(interaction, lobbyId) {
  const lobby = await dbQueryOne("SELECT * FROM lobbies WHERE id = ? AND status = 'open'", [lobbyId]);
  if (!lobby) return interaction.reply({ content: 'This lobby is no longer open.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const yamlContent = interaction.fields.getTextInputValue('yaml_content');
  const lobbyDir = path.join(config.dataPath, 'temp', `lobby-${lobbyId}`);
  fs.mkdirSync(lobbyDir, { recursive: true });
  const yamlPath = path.join(lobbyDir, `${interaction.user.id}.yaml`);
  fs.writeFileSync(yamlPath, yamlContent, 'utf8');

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
    [lobbyId, interaction.user.id, player.name ?? null, player.game ?? null, yamlPath, Math.floor(Date.now() / 1000)]
  );

  await refreshStatusMessage(interaction, lobby);
  return interaction.followUp({
    content: `Joined as **${player.name}** (${player.game}) in **${lobby.name}** (ID:${lobby.id}).`,
  });
}

module.exports = {
  category: 'Lobby',
  joinLobbyButtonHandler: (interaction, lobbyId) => joinLobbyButton(interaction, lobbyId),
  joinLobbyModalHandler: (interaction, lobbyId) => joinLobbyModal(interaction, lobbyId),
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

        const lobbyId = await dbInsert(
          'INSERT INTO lobbies (guildId, channelId, creatorId, name, createdAt) VALUES (?,?,?,?,?)',
          [interaction.guildId, interaction.channelId, interaction.user.id, name, Math.floor(Date.now() / 1000)]
        );
        const lobby = await dbQueryOne('SELECT * FROM lobbies WHERE id = ?', [lobbyId]);

        const embed = await buildStatusEmbed(lobby, []);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`lobbyjoin_${lobby.id}`)
            .setLabel('Join Lobby')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`lobbyoptions_${lobby.id}`)
            .setLabel('⚙️ Options')
            .setStyle(ButtonStyle.Secondary),
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
          content: `Submitted ${label} as **${player.name}** (${player.game}) in **${lobby.name}** (ID:${lobby.id}).`,
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
  lobbyOptionsHandler: (interaction, lobbyId) => lobbyOptions(interaction, lobbyId),
  lobbyOptSelectHandler: (interaction, lobbyId, optKey) => lobbyOptSelect(interaction, lobbyId, optKey),
};

async function lobbyOptions(interaction, lobbyId) {
  const lobby = await dbQueryOne("SELECT * FROM lobbies WHERE id = ? AND status = 'open'", [lobbyId]);
  if (!lobby) return interaction.reply({ content: 'This lobby is no longer open.', ephemeral: true });
  if (lobby.creatorId !== interaction.user.id && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only the lobby creator or an admin can change options.', ephemeral: true });
  }
  return interaction.reply({ ...buildOptionsPanel(lobby), ephemeral: true });
}

async function lobbyOptSelect(interaction, lobbyId, optKey) {
  const lobby = await dbQueryOne("SELECT * FROM lobbies WHERE id = ? AND status = 'open'", [lobbyId]);
  if (!lobby) return interaction.update({ content: 'This lobby is no longer open.', embeds: [], components: [] });
  if (lobby.creatorId !== interaction.user.id && !isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only the lobby creator or an admin can change options.', ephemeral: true });
  }

  const opts = parseOptions(lobby.options);
  opts[`${optKey}_mode`] = interaction.values[0];
  await dbExecute('UPDATE lobbies SET options = ? WHERE id = ?', [JSON.stringify(opts), lobbyId]);

  const updatedLobby = { ...lobby, options: JSON.stringify(opts) };
  await refreshStatusMessage(interaction, updatedLobby);
  return interaction.update(buildOptionsPanel(updatedLobby));
}

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

  // Archipelago Generate fails late if two YAMLs share the same `name`. Catch it early.
  const nameCounts = new Map();
  for (const p of players) {
    if (!p.playerName) continue;
    nameCounts.set(p.playerName, (nameCounts.get(p.playerName) ?? 0) + 1);
  }
  const duplicates = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicates.length) {
    return interaction.reply({
      content: `Duplicate player names in YAMLs (must be unique): ${duplicates.map((n) => `\`${n}\``).join(', ')}`,
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
  const lobbyYamlDir = path.join(config.dataPath, 'temp', `lobby-${lobby.id}`);
  fs.rmSync(lobbyYamlDir, { recursive: true, force: true });

  const locationCounts = await readLocationCounts(archivePath, players.map((p) => p.playerName));
  const playerData = players.map((p) => ({
    name: p.playerName,
    game: p.gameName,
    discordUserId: /^\d+$/.test(p.userId) ? p.userId : null,
  }));
  const newGameId = await dbInsert(
    `INSERT INTO games (guildId, gameFile, status, players, gameName, startedAt, locationCounts)
     VALUES (?,?,'pending',?,?,?,?)`,
    [interaction.guildId, archivePath, JSON.stringify(playerData), lobby.name, Math.floor(Date.now() / 1000), JSON.stringify(locationCounts)]
  );
  const game = { id: newGameId };
  await dbExecute("UPDATE lobbies SET status = 'done' WHERE id = ?", [lobby.id]);

  // Start the server
  const port = portManager.allocate();
  if (!port) {
    return interaction.followUp({ content: 'No ports available. Stop a running game first.' });
  }

  let pid;
  try {
    pid = await processManager.start(game.id, archivePath, port, playerData, parseOptions(lobby.options));
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

  // Real Discord user IDs (numeric) — excludes on-behalf behalf_xxx keys
  const discordUserIds = players
    .map((p) => p.userId)
    .filter((id) => /^\d+$/.test(id));

  let channelId = null;
  try {
    const safeName = `ap-${lobby.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 90)}`;
    const channel = await interaction.guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      topic: `Archipelago: ${lobby.name} | ${config.serverHost}:${port}`,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...discordUserIds.map((userId) => ({
          id: userId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        })),
        {
          id: interaction.client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages],
        },
      ],
    });
    channelId = channel.id;

    const fields = [
      { name: 'Connect', value: `\`${config.serverHost}:${port}\`${config.ssl?.cert ? ' (WSS enabled)' : ''}`, inline: false },
      { name: 'Players', value: playerData.map((p) => `${p.name} (${p.game})`).join('\n') },
    ];
    if (mcStarted) fields.push({ name: 'Minecraft Server', value: `\`${config.serverHost}:25565\``, inline: false });
    else if (mcError) fields.push({ name: 'Minecraft Server', value: `⚠️ Failed to start: ${mcError}`, inline: false });

    const startEmbed = new EmbedBuilder()
      .setTitle(`Game Started: ${lobby.name} (ID:${lobby.id})`)
      .setColor(0x00cc44)
      .addFields(fields)
      .setTimestamp();

    const controlsRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`feedlevel_${game.id}`)
        .setPlaceholder('Game feed: Pings only (default)')
        .addOptions([
          { label: 'Pings only', description: 'No automatic messages — only priority item pings', value: 'none' },
          { label: 'Goals + Hints', description: 'Post goal completions and hint messages', value: 'goals' },
          { label: 'Progression items', description: 'Post when a progression item is found', value: 'items_prog' },
          { label: 'All items', description: 'Post every item send', value: 'items_all' },
          { label: 'Full feed', description: 'Post everything: items, joins, parts, chat, hints', value: 'full' },
        ])
    );
    const pingRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`notifping_${game.id}`)
        .setLabel('Enable Priority Pings 🔔')
        .setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ embeds: [startEmbed], components: [controlsRow, pingRow] });
    attachGameNotifier(game.id, channel);
    setupTrackers(game.id, channel, playerData);

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
    "UPDATE games SET status='running', port=?, pid=?, channelId=?, startedAt=?, gameOptions=? WHERE id=?",
    [port, pid, channelId, Math.floor(Date.now() / 1000), JSON.stringify(parseOptions(lobby.options)), game.id]
  );

  // Update the lobby status embed: mark as started and add a Join Channel button
  if (lobby.statusMessageId && lobby.channelId) {
    try {
      const lobbyChannel = await interaction.client.channels.fetch(lobby.channelId);
      const msg = await lobbyChannel.messages.fetch(lobby.statusMessageId);
      const startedEmbed = new EmbedBuilder()
        .setTitle(`Game Started: ${lobby.name} (ID:${lobby.id})`)
        .setColor(0x00cc44)
        .addFields(
          { name: 'Status', value: 'Running', inline: true },
          { name: 'Players', value: playerData.map((p) => `${p.name} (${p.game})`).join('\n') },
        )
        .setFooter({ text: 'Use the button below to join the private game channel' })
        .setTimestamp();
      const components = channelId ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`joinchannel_${channelId}`)
            .setLabel('Join Channel')
            .setStyle(ButtonStyle.Primary),
        ),
      ] : [];
      await msg.edit({ embeds: [startedEmbed], components });
    } catch (_) {}
  }

  return interaction.followUp({
    content: `**${lobby.name}** (ID:${lobby.id}) is live!\nConnect at: \`${config.serverHost}:${port}\`${channelId ? ` — <#${channelId}>` : ''}`,
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

  return interaction.reply({ content: `Lobby **${lobby.name}** (ID:${lobby.id}) cancelled.` });
}
