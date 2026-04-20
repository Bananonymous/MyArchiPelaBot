const tmp = require('tmp');
const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  InteractionContextType,
  AttachmentBuilder,
  EmbedBuilder,
} = require('discord.js');
const archipelagoRunner = require('../lib/archipelagoRunner');

module.exports = {
  category: 'YAML Templates',
  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-template')
        .setDescription('Get a starter YAML template for an Archipelago game.')
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption((opt) => opt
          .setName('game')
          .setDescription('Game name (leave empty to list available games)')
          .setRequired(false))
        .addStringOption((opt) => opt
          .setName('username')
          .setDescription('Your Archipelago player name (pre-fills the name field)')
          .setRequired(false)),

      async execute(interaction) {
        await interaction.deferReply();

        const gameName = interaction.options.getString('game', false);
        const username = interaction.options.getString('username', false);

        // No game specified — list available games
        if (!gameName) {
          let games;
          try {
            games = await archipelagoRunner.listGames();
          } catch (e) {
            return interaction.followUp({ content: `Failed to list games: \`${e.message}\`` });
          }

          if (!games.length) {
            return interaction.followUp({ content: 'No games are installed yet. Use `/ap-install-world` to add APWorlds.' });
          }

          const embed = new EmbedBuilder()
            .setTitle('Available Games')
            .setColor(0x00b0f4)
            .setDescription(
              games.map((g) => `• ${g}`).join('\n').slice(0, 4000)
            )
            .setFooter({ text: 'Use /ap-template game:<name> to get a YAML template' });

          return interaction.followUp({ embeds: [embed] });
        }

        // Generate the template to a temp directory
        const tempDir = tmp.dirSync({ prefix: 'ap-template-', unsafeCleanup: true });
        let templatePath;
        try {
          templatePath = await archipelagoRunner.generateTemplate(gameName, tempDir.name, username);
        } catch (e) {
          tempDir.removeCallback();
          if (e.message.includes('not found')) {
            let games;
            try { games = await archipelagoRunner.listGames(); } catch (_) { games = []; }
            const embed = new EmbedBuilder()
              .setTitle(`Game \`${gameName}\` not found`)
              .setColor(0xff3333);
            if (games.length) {
              const list = games.map((g) => `• ${g}`).join('\n');
              // Embed description limit is 4096; split into fields if needed
              const chunks = [];
              let chunk = '';
              for (const line of list.split('\n')) {
                if (chunk.length + line.length + 1 > 1000) { chunks.push(chunk); chunk = ''; }
                chunk += (chunk ? '\n' : '') + line;
              }
              if (chunk) chunks.push(chunk);
              embed.addFields(chunks.map((c, i) => ({
                name: i === 0 ? 'Available games' : '\u200b',
                value: c,
              })));
            }
            return interaction.followUp({ embeds: [embed] });
          }
          return interaction.followUp({ content: `Failed to generate template: \`${e.message.slice(0, 800)}\`` });
        }

        const attachment = new AttachmentBuilder(templatePath, {
          name: path.basename(templatePath),
        });

        await interaction.followUp({
          content: `Here is your YAML template for **${gameName}**:`,
          files: [attachment],
        });

        tempDir.removeCallback();
      },
    },
  ],
};
