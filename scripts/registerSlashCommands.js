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

    // Normalise: support both legacy single guildId and new guildIds array
    const guildIds = config.guildIds
      ?? (config.guildId ? [config.guildId] : []);

    if (guildIds.length > 0) {
      // Guild registration is instant.
      // Clear stale global commands first so they don't appear as duplicates.
      await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
      for (const guildId of guildIds) {
        const data = await rest.put(
          Routes.applicationGuildCommands(config.clientId, guildId),
          { body: slashCommands }
        );
        console.log(`Reloaded ${data.length} commands in guild ${guildId}.`);
      }
    } else {
      // Global registration — takes up to 1 hour to propagate
      const data = await rest.put(Routes.applicationCommands(config.clientId), { body: slashCommands });
      console.log(`Successfully reloaded ${data.length} global application (slash) commands.`);
    }
  } catch (error) {
    console.error(error);
  }
})();
