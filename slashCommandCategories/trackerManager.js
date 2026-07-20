const {
  SlashCommandBuilder,
  InteractionContextType,
} = require('discord.js');
const { dbQueryOne } = require('../database');
const { buildGlobalEmbed, buildPersonalEmbed } = require('../lib/trackerUpdater');

async function resolveGame(interaction, gameId) {
  if (gameId) return dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
  const byChannel = await dbQueryOne(
    "SELECT * FROM games WHERE channelId = ? AND status = 'running'",
    [interaction.channelId]
  );
  if (byChannel) return byChannel;
  return dbQueryOne(
    "SELECT * FROM games WHERE guildId = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
    [interaction.guildId]
  );
}

module.exports = {
  category: 'Tracker',
  commands: [
    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-tracker')
        .setDescription('Show global progress tracker for the current Archipelago game.')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        await interaction.deferReply();
        const game = await resolveGame(interaction, interaction.options.getInteger('game-id'));
        if (!game) {
          return interaction.editReply({ content: 'No running game found. Specify a `game-id` or run this in a game channel.' });
        }
        return interaction.editReply({ embeds: [await buildGlobalEmbed(game.id)] });
      },
    },

    {
      commandBuilder: new SlashCommandBuilder()
        .setName('ap-tracker-personal')
        .setDescription('Show personal item and hint tracker for a player.')
        .setContexts(InteractionContextType.Guild)
        .addUserOption((opt) => opt
          .setName('user')
          .setDescription('Player to look up (defaults to you)')
          .setRequired(false))
        .addIntegerOption((opt) => opt
          .setName('game-id')
          .setDescription('Game ID (defaults to game in this channel)')
          .setRequired(false)),
      async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('user') ?? interaction.user;
        const game = await resolveGame(interaction, interaction.options.getInteger('game-id'));
        if (!game) {
          return interaction.editReply({ content: 'No running game found. Specify a `game-id` or run this in a game channel.' });
        }

        let players;
        try { players = JSON.parse(game.players ?? '[]'); } catch { players = []; }

        const player = players.find((p) => p.discordUserId === targetUser.id);
        if (!player) {
          return interaction.editReply({ content: `<@${targetUser.id}> is not a registered player in **${game.gameName}**.` });
        }

        return interaction.editReply({ embeds: [await buildPersonalEmbed(game.id, player)] });
      },
    },
  ],
};
