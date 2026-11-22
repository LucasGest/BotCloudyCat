const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBalance } = require('../../utils/economy');
const { VIOLET_CLAIR } = require('../../utils/palette');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('solde')
    .setDescription('Affiche ton solde de pattes (ou celui d\'un autre membre).')
    .addUserOption((option) => option.setName('membre').setDescription('Le membre dont tu veux voir le solde')),

  async execute(interaction) {
    const target = interaction.options.getUser('membre') ?? interaction.user;
    const balance = await getBalance(target.id);

    const embed = new EmbedBuilder()
      .setColor(VIOLET_CLAIR)
      .setDescription(`🐾 **${target.username}** possède **${balance}** patte(s).`);

    await interaction.reply({ embeds: [embed] });
  }
};
