const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  InteractionContextType,
  EmbedBuilder,
} = require('discord.js');
const config = require('../config.json');
const { dbExecute, dbQueryAll, dbQueryOne } = require('../database');
const { isAdmin } = require('../lib/permissions');

module.exports = {
  category: 'APWorld Manager',
  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-install-world')
        .setDescription('Install an APWorld file on the server. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addAttachmentOption((opt) => opt
          .setName('apworld-file')
          .setDescription('.apworld file to install')
          .setRequired(true)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to install APWorlds.', ephemeral: true });
        }

        const attachment = interaction.options.getAttachment('apworld-file');
        if (!attachment.name.endsWith('.apworld')) {
          return interaction.reply({ content: 'Only `.apworld` files are accepted.', ephemeral: true });
        }

        await interaction.deferReply();

        const apworldsDir = path.join(config.dataPath, 'apworlds');
        fs.mkdirSync(apworldsDir, { recursive: true });
        const destPath = path.join(apworldsDir, attachment.name);

        try {
          const response = await axios.get(attachment.url, { responseType: 'stream' });
          await new Promise((resolve, reject) => {
            response.data
              .pipe(fs.createWriteStream(destPath))
              .on('close', resolve)
              .on('error', reject);
          });
        } catch (e) {
          return interaction.followUp({ content: `Failed to download APWorld: ${e.message}` });
        }

        const worldName = path.basename(attachment.name, '.apworld');

        // Also copy into Archipelago's own worlds/ dir so it's immediately usable
        // without a container restart (entrypoint.sh handles this on startup)
        const archipelagoWorldsDir = '/opt/archipelago/worlds';
        try {
          fs.copyFileSync(destPath, path.join(archipelagoWorldsDir, attachment.name));
        } catch (e) {
          console.warn(`Could not copy apworld to Archipelago dir: ${e.message}`);
        }

        await dbExecute(
          `INSERT INTO apworlds (name, filePath, installedAt)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET filePath = excluded.filePath, installedAt = excluded.installedAt`,
          [worldName, destPath, Math.floor(Date.now() / 1000)]
        );

        return interaction.followUp({ content: `**${worldName}** installed successfully.` });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-list-worlds')
        .setDescription('List installed APWorld files.')
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        const apworldsDir = path.join(config.dataPath, 'apworlds');
        let files = [];
        if (fs.existsSync(apworldsDir)) {
          files = fs.readdirSync(apworldsDir).filter((f) => f.endsWith('.apworld'));
        }

        if (files.length === 0) {
          return interaction.reply({ content: 'No APWorlds installed. Use `/ap-install-world` to add one.' });
        }

        const embed = new EmbedBuilder()
          .setTitle('Installed APWorlds')
          .setColor(0x00b0f4)
          .setDescription(files.map((f) => `• ${path.basename(f, '.apworld')}`).join('\n'));

        return interaction.reply({ embeds: [embed] });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-remove-world')
        .setDescription('Remove an installed APWorld. (Admin only)')
        .setContexts(InteractionContextType.Guild)
        .addStringOption((opt) => opt
          .setName('name')
          .setDescription('APWorld name (without .apworld extension)')
          .setRequired(true)),
      async execute(interaction) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need Administrator permissions to remove APWorlds.', ephemeral: true });
        }

        const name = interaction.options.getString('name');
        const apworldsDir = path.join(config.dataPath, 'apworlds');
        const filePath = path.join(apworldsDir, `${name}.apworld`);

        if (!fs.existsSync(filePath)) {
          return interaction.reply({ content: `APWorld \`${name}\` not found.`, ephemeral: true });
        }

        fs.unlinkSync(filePath);
        await dbExecute('DELETE FROM apworlds WHERE name = ?', [name]);
        return interaction.reply({ content: `**${name}** removed.` });
      },
    },
  ],
};
