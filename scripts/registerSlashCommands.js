const { REST, Routes } = require('discord.js');
const config = require('../config.json');
const fs = require('node:fs');
const path = require('path');

const slashCommands = [];

// Find all .js files in the /slashCommandCategories directory
const slashCommandFiles = fs.readdirSync(path.resolve(__filename, '..', '..', 'slashCommandCategories'))
  .filter(file => file.endsWith('.js'));

// Load each command file into memory
for (const file of slashCommandFiles) {
  const commandFile = require(path.resolve(__filename, '..', '..', 'slashCommandCategories', file));

  // Load all slash commands from each command file
  for (const command of commandFile.commands) {
    slashCommands.push(command.commandBuilder.toJSON());
  }
}

(async () => {
  try {
    console.log(`Started refreshing ${slashCommands.length} application (slash) commands.`);

    const rest = new REST({ version: '10' }).setToken(config.token);

    // Guild registration is instant; global registration takes up to 1 hour.
    // When using guild registration, also clear any stale global commands so they
    // don't appear as duplicates in the Discord UI.
    if (config.guildId) {
      await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
    }
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.clientId, config.guildId)
      : Routes.applicationCommands(config.clientId);
    const data = await rest.put(route, { body: slashCommands });

    console.log(`Successfully reloaded ${data.length} application (slash) commands.`);
  } catch (error) {
    console.error(error);
  }
})();
