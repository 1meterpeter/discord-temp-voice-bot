const {
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");
const { getGuildConfig } = require("../utils/store");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-config")
    .setDescription("Zeigt die aktuelle Temp-Voice-Konfiguration dieses Servers an.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const config = getGuildConfig(interaction.guild.id);

    await interaction.reply({
      content:
        `**Aktuelle Temp-Voice Konfiguration**\n\n` +
        `**Join-to-Create:** ${config?.joinToCreateChannelId ? `<#${config.joinToCreateChannelId}>` : "Nicht gesetzt"}\n` +
        `**Kategorie:** ${config?.tempCategoryId ? `<#${config.tempCategoryId}>` : "Nicht gesetzt"}`,
      ephemeral: true
    });
  }
};