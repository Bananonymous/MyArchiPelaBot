const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config.json');
const { cachePartial } = require('./lib');
const { dbInit } = require('./database');
const { dbQueryOne } = require('./database');
const { generalErrorHandler } = require('./errorHandlers');
const portManager = require('./lib/portManager');
const fs = require('fs');

// Catch all unhandled errors
process.on('uncaughtException', (err) => generalErrorHandler(err));
process.on('unhandledRejection', (err) => generalErrorHandler(err));

process.on('SIGTERM', () => {
  console.info('SIGTERM received — shutting down.');
  const processManager = require('./lib/processManager');
  const entries = [...processManager.getAllRunning().values()];
  for (const entry of entries) {
    try { entry.client?.close(); } catch (_) {}
    try { entry.process?.kill('SIGINT'); } catch (_) {}
  }
  if (entries.length === 0) { process.exit(0); return; }
  // Wait for AP processes to save before exiting; force-exit after 8s
  const timeout = setTimeout(() => process.exit(0), 8000);
  let remaining = entries.length;
  for (const entry of entries) {
    entry.process.once('exit', () => {
      remaining--;
      if (remaining === 0) { clearTimeout(timeout); process.exit(0); }
    });
  }
});

async function init() {
  await dbInit();
  await portManager.init();
  require('./lib/webClientServer').start();
}

const client = new Client({
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
client.messageListeners = [];
client.channelDeletedListeners = [];
client.voiceStateListeners = [];
client.slashCommandCategories = [];
client.routines = [];

client.tempData = {
  apInterfaces: new Map(),
};

// Empty handler dirs don't survive a git clone (git doesn't track empty dirs),
// so create them on the fly instead of crashing on scandir ENOENT.
function readdirSyncSafe(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir);
}

// Load message listener files
readdirSyncSafe('./messageListeners').filter((file) => file.endsWith('.js')).forEach((listenerFile) => {
  const listener = require(`./messageListeners/${listenerFile}`);
  client.messageListeners.push(listener);
});

// Load channelDeleted listeners
readdirSyncSafe('./channelDeletedListeners').filter((file) => file.endsWith('.js')).forEach((listenerFile) => {
  const listener = require(`./channelDeletedListeners/${listenerFile}`);
  client.channelDeletedListeners.push(listener);
});

// Load slash command category files
readdirSyncSafe('./slashCommandCategories').filter((file) => file.endsWith('.js')).forEach((categoryFile) => {
  const slashCommandCategory = require(`./slashCommandCategories/${categoryFile}`);
  client.slashCommandCategories.push(slashCommandCategory);
});

// Load voice state listener files
readdirSyncSafe('./voiceStateListeners').filter((file) => file.endsWith('.js')).forEach((listenerFile) => {
  const listener = require(`./voiceStateListeners/${listenerFile}`);
  client.voiceStateListeners.push(listener);
});

// Load routines: game monitor runs every 60s; everything else runs hourly
readdirSyncSafe('./routines').filter((file) => file.endsWith('.js')).forEach((routineFile) => {
  const routine = require(`./routines/${routineFile}`);
  const intervalMs = routineFile === 'gameMonitor.js' ? 60_000 : 3_600_000;
  setInterval(() => {
    Promise.resolve()
      .then(() => routine(client))
      .catch((e) => console.error(`[routine:${routineFile}] error:`, e));
  }, intervalMs);
});

// Run messages through the listeners
client.on(Events.MessageCreate, async (msg) => {
  const message = await cachePartial(msg);
  if (message.member) { message.member = await cachePartial(message.member); }
  if (message.author) { message.author = await cachePartial(message.author); }
  if (message.author.bot) { return; }
  for (const listener of client.messageListeners) {
    try {
      // Allow both sync and async listeners; always await so errors are caught here.
      await listener(client, message);
    } catch (e) {
      console.error('[messageListener] error:', e);
    }
  }
});

// Run channelDelete events through their listeners
client.on(Events.ChannelDelete, async (channel) => {
  for (const listener of client.channelDeletedListeners) {
    try {
      await listener(client, channel);
    } catch (e) {
      console.error('[channelDeletedListener] error:', e);
    }
  }
});

// Run the voice states through the listeners
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  oldState.member = await cachePartial(oldState.member);
  newState.member = await cachePartial(newState.member);
  for (const listener of client.voiceStateListeners) {
    try {
      await listener(client, oldState, newState);
    } catch (e) {
      console.error('[voiceStateListener] error:', e);
    }
  }
});

// Run interactions through slash command and button handlers
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    for (const category of client.slashCommandCategories) {
      for (const listener of category.commands) {
        if (listener.commandBuilder.name === interaction.commandName) {
          return listener.execute(interaction);
        }
      }
    }
    console.warn(`Unknown slash command received: ${interaction.commandName}`);
    return interaction.reply('Unknown command.');
  }

  if (interaction.isButton()) {
    const [action, ...args] = interaction.customId.split('_');
    if (action === 'startgame') {
      const gameId = parseInt(args[0], 10);
      const { startGameHandler } = require('./slashCommandCategories/gameManager');
      await interaction.deferReply();
      return startGameHandler(interaction, gameId);
    }
    if (action === 'lobbystart') {
      const lobbyId = parseInt(args[0], 10);
      const { startLobbyHandler } = require('./slashCommandCategories/lobbyManager');
      return startLobbyHandler(interaction, lobbyId);
    }
    if (action === 'lobbycancel') {
      const lobbyId = parseInt(args[0], 10);
      const { cancelLobbyHandler } = require('./slashCommandCategories/lobbyManager');
      return cancelLobbyHandler(interaction, lobbyId);
    }
    if (action === 'notifping') {
      const gameId = parseInt(args[0], 10);
      const { handleNotifToggle } = require('./slashCommandCategories/gameManager');
      return handleNotifToggle(interaction, gameId);
    }
    if (action === 'webclient') {
      const gameId = parseInt(args[0], 10);
      const { handleWebClientLink } = require('./slashCommandCategories/gameManager');
      return handleWebClientLink(interaction, gameId);
    }
    if (action === 'trackerhide') {
      const gameId = parseInt(args[0], 10);
      const { handleTrackerHide } = require('./lib/trackerUpdater');
      return handleTrackerHide(interaction, gameId);
    }
    if (action === 'lobbyjoin') {
      const lobbyId = parseInt(args[0], 10);
      const { joinLobbyButtonHandler } = require('./slashCommandCategories/lobbyManager');
      return joinLobbyButtonHandler(interaction, lobbyId);
    }
    if (action === 'lobbyoptions') {
      const lobbyId = parseInt(args[0], 10);
      const { lobbyOptionsHandler } = require('./slashCommandCategories/lobbyManager');
      return lobbyOptionsHandler(interaction, lobbyId);
    }
    if (action === 'lobbyremove') {
      const lobbyId = parseInt(args[0], 10);
      const { lobbyRemoveHandler } = require('./slashCommandCategories/lobbyManager');
      return lobbyRemoveHandler(interaction, lobbyId);
    }
    if (action === 'joinchannel') {
      const channelId = args[0];
      try {
        // Intentionally open invite: anyone can join the *game* channel.
        // Security constraint: only allow this button to grant access to a channel that
        // is recorded as a game channel in the DB (prevents arbitrary channel escalation).
        const game = await dbQueryOne(
          "SELECT id FROM games WHERE channelId = ? AND status != 'archived' ORDER BY id DESC LIMIT 1",
          [channelId]
        );
        if (!game) {
          return interaction.reply({ content: 'This join link is no longer valid.', ephemeral: true });
        }

        const channel = await interaction.guild.channels.fetch(channelId);
        if (!channel || channel.guildId !== interaction.guildId) {
          return interaction.reply({ content: 'Could not grant access. Ask an admin.', ephemeral: true });
        }

        await channel.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        await interaction.reply({ content: `You now have access to <#${channelId}>!`, ephemeral: true });
      } catch (e) {
        await interaction.reply({ content: 'Could not grant access. Ask an admin.', ephemeral: true });
      }
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    const [action, ...args] = interaction.customId.split('_');
    if (action === 'lobbyjoinmodal') {
      const lobbyId = parseInt(args[0], 10);
      const { joinLobbyModalHandler } = require('./slashCommandCategories/lobbyManager');
      return joinLobbyModalHandler(interaction, lobbyId);
    }
  }

  if (interaction.isStringSelectMenu()) {
    const [action, ...args] = interaction.customId.split('_');
    if (action === 'feedlevel') {
      const gameId = parseInt(args[0], 10);
      const { handleFeedLevel } = require('./slashCommandCategories/gameManager');
      return handleFeedLevel(interaction, gameId);
    }
    if (action === 'lobbyopt') {
      const lobbyId = parseInt(args[args.length - 1], 10);
      const optKey = args.slice(0, -1).join('_'); // e.g. 'release', 'collect', 'remaining'
      const { lobbyOptSelectHandler } = require('./slashCommandCategories/lobbyManager');
      return lobbyOptSelectHandler(interaction, lobbyId, optKey);
    }
    if (action === 'lobbyremoveplayer') {
      const lobbyId = parseInt(args[0], 10);
      const { lobbyRemoveSelectHandler } = require('./slashCommandCategories/lobbyManager');
      return lobbyRemoveSelectHandler(interaction, lobbyId);
    }
  }
});

client.on(Events.Error, async (error) => generalErrorHandler(error));

client.once(Events.ClientReady, async () => {
  console.info(`Connected to Discord. Active in ${client.guilds.cache.size} guilds.`);
  const { recoverRunningGames } = require('./lib/recoveryManager');
  recoverRunningGames(client).catch((e) => console.error('[recovery] Fatal error:', e));
});

init().then(() => client.login(config.token)).catch((err) => {
  console.error('Initialization failed:', err);
  process.exit(1);
});
