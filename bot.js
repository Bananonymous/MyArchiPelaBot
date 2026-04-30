const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config.json');
const { cachePartial } = require('./lib');
const { dbInit } = require('./database');
const { generalErrorHandler } = require('./errorHandlers');
const portManager = require('./lib/portManager');
const fs = require('fs');

// Catch all unhandled errors
process.on('uncaughtException', (err) => generalErrorHandler(err));
process.on('unhandledRejection', (err) => generalErrorHandler(err));

process.on('SIGTERM', () => {
  console.info('SIGTERM received — shutting down.');
  const processManager = require('./lib/processManager');
  for (const [gameId, entry] of processManager.getAllRunning()) {
    try { entry.client?.close(); } catch (_) {}
    try { entry.process?.kill('SIGTERM'); } catch (_) {}
  }
  process.exit(0);
});

async function init() {
  await dbInit();
  await portManager.init();
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

// Load message listener files
fs.readdirSync('./messageListeners').filter((file) => file.endsWith('.js')).forEach((listenerFile) => {
  const listener = require(`./messageListeners/${listenerFile}`);
  client.messageListeners.push(listener);
});

// Load channelDeleted listeners
fs.readdirSync('./channelDeletedListeners').filter((file) => file.endsWith('.js')).forEach((listenerFile) => {
  const listener = require(`./channelDeletedListeners/${listenerFile}`);
  client.channelDeletedListeners.push(listener);
});

// Load slash command category files
fs.readdirSync('./slashCommandCategories').filter((file) => file.endsWith('.js')).forEach((categoryFile) => {
  const slashCommandCategory = require(`./slashCommandCategories/${categoryFile}`);
  client.slashCommandCategories.push(slashCommandCategory);
});

// Load voice state listener files
fs.readdirSync('./voiceStateListeners').filter((file) => file.endsWith('.js')).forEach((listenerFile) => {
  const listener = require(`./voiceStateListeners/${listenerFile}`);
  client.voiceStateListeners.push(listener);
});

// Load routines: game monitor runs every 60s; everything else runs hourly
fs.readdirSync('./routines').filter((file) => file.endsWith('.js')).forEach((routineFile) => {
  const routine = require(`./routines/${routineFile}`);
  const intervalMs = routineFile === 'gameMonitor.js' ? 60_000 : 3_600_000;
  setInterval(() => routine(client), intervalMs);
});

// Run messages through the listeners
client.on(Events.MessageCreate, async (msg) => {
  const message = await cachePartial(msg);
  if (message.member) { message.member = await cachePartial(message.member); }
  if (message.author) { message.author = await cachePartial(message.author); }
  if (message.author.bot) { return; }
  return client.messageListeners.forEach((listener) => listener(client, message));
});

// Run channelDelete events through their listeners
client.on(Events.ChannelDelete, async (channel) => {
  client.channelDeletedListeners.forEach((listener) => listener(client, channel));
});

// Run the voice states through the listeners
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  oldState.member = await cachePartial(oldState.member);
  newState.member = await cachePartial(newState.member);
  client.voiceStateListeners.forEach((listener) => listener(client, oldState, newState));
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
