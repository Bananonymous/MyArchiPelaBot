const axios = require('axios');
const tmp = require('tmp');
const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  InteractionContextType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const config = require('../config.json');
const { dbInsert } = require('../database');
const yamlValidator = require('../lib/yamlValidator');
const archipelagoRunner = require('../lib/archipelagoRunner');

async function downloadToTemp(url, postfix) {
  const tempFile = tmp.fileSync({ prefix: 'upload-', postfix });
  const response = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    response.data
      .pipe(fs.createWriteStream(tempFile.name))
      .on('close', resolve)
      .on('error', reject);
  });
  return tempFile;
}

module.exports = {
  category: 'Game Generator',
  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-generate-solo')
        .setDescription('Validate and generate a solo Archipelago game from an uploaded YAML or ZIP.')
        .setContexts(InteractionContextType.Guild)
        .addAttachmentOption((opt) => opt
          .setName('config-file')
          .setDescription('Archipelago YAML or ZIP containing player YAML files')
          .setRequired(true))
        .addStringOption((opt) => opt
          .setName('name')
          .setDescription('A name for this game (defaults to filename)')
          .setRequired(false)),

      async execute(interaction) {
        await interaction.deferReply();

        const attachment = interaction.options.getAttachment('config-file');
        const gameName = interaction.options.getString('name', false)
          ?? path.basename(attachment.name, path.extname(attachment.name));

        const ext = path.extname(attachment.name).toLowerCase();
        const isZip = ext === '.zip';
        const isYaml = ext === '.yaml' || ext === '.yml';

        if (!isYaml && !isZip) {
          return interaction.followUp({ content: 'Only `.yaml`, `.yml`, or `.zip` files are accepted.' });
        }

        // Download the uploaded file
        let tempFile;
        try {
          tempFile = await downloadToTemp(attachment.url, ext);
        } catch (e) {
          return interaction.followUp({ content: `Failed to download the file: ${e.message}` });
        }

        // Validate YAML files (skip validation for ZIPs — Archipelago will catch errors)
        let players = [];
        if (isYaml) {
          const result = yamlValidator.validateFile(tempFile.name);
          if (!result.valid) {
            tempFile.removeCallback();
            const errorList = result.errors.map((e) => `• ${e}`).join('\n');
            return interaction.followUp({
              content: `**YAML validation failed:**\n${errorList}`,
            });
          }
          players = result.players;
        }

        // Set up output directory under dataPath/temp/<timestamp>
        const workDir = path.join(config.dataPath, 'temp', `gen-${Date.now()}`);
        fs.mkdirSync(workDir, { recursive: true });

        // For ZIP: pass as-is (Archipelago accepts zips); for YAML: wrap in array
        let generatedFile;
        try {
          generatedFile = await archipelagoRunner.generate([tempFile.name], workDir);
        } catch (e) {
          tempFile.removeCallback();
          fs.rmSync(workDir, { recursive: true, force: true });
          return interaction.followUp({
            content: `**Generation failed:**\n\`\`\`${e.message.slice(0, 1800)}\`\`\``,
          });
        }

        // Move generated file to archives
        const archivesDir = path.join(config.dataPath, 'archives');
        fs.mkdirSync(archivesDir, { recursive: true });
        const generatedExt = path.extname(generatedFile);
        const archiveName = `${Date.now()}-${gameName.replace(/[^a-zA-Z0-9_-]/g, '_')}${generatedExt}`;
        const archivePath = path.join(archivesDir, archiveName);
        fs.renameSync(generatedFile, archivePath);

        tempFile.removeCallback();
        fs.rmSync(workDir, { recursive: true, force: true });

        // Create game record
        const gameId = await dbInsert(
          `INSERT INTO games (guildId, gameFile, status, players, gameName, startedAt)
           VALUES (?, ?, 'pending', ?, ?, ?)`,
          [
            interaction.guildId,
            archivePath,
            JSON.stringify(players),
            gameName,
            Math.floor(Date.now() / 1000),
          ]
        );
        const game = { id: gameId };

        const embed = new EmbedBuilder()
          .setTitle(`Game Ready: ${gameName}`)
          .setColor(0x00b0f4)
          .addFields(
            { name: 'Game ID', value: String(game.id), inline: true },
            { name: 'Status', value: 'Pending', inline: true },
            {
              name: 'Players',
              value: players.length
                ? players.map((p) => `${p.name} (${p.game})`).join('\n')
                : '_Unknown (ZIP upload)_',
            }
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`startgame_${game.id}`)
            .setLabel('Start Game')
            .setStyle(ButtonStyle.Success)
        );

        return interaction.followUp({ embeds: [embed], components: [row] });
      },
    },
  ],
};
