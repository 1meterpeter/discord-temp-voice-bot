const {
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const { getGuildSetups } = require("../utils/store");

/**
 * Zeigt alle aktuell gespeicherten Temp-Voice-Setups einer Guild an.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-config")
    .setDescription("Zeigt alle aktuellen Temp-Voice-Setups dieses Servers an.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const setups = getGuildSetups(interaction.guild.id);

    if (!setups.length) {
      await interaction.reply({
        content: "Für diesen Server ist noch kein Temp-Voice-Setup gespeichert.",
        ephemeral: true
      });
      return;
    }

    const lines = setups.map((setup, index) => {
      return [
        `**${index + 1}. ${setup.name}**`,
        `Setup-ID: \`${setup.setupId}\``,
        `Join-to-Create: <#${setup.joinToCreateChannelId}>`,
        `Source-Rechte von: ${setup.sourceCategoryId ? `<#${setup.sourceCategoryId}>` : "—"}`,
        `Talks Open: <#${setup.openCategoryId}>`,
        `Talks Closed: <#${setup.closedCategoryId}>`
      ].join("\n");
    });

    await interaction.reply({
      content: `**Aktuelle Temp-Voice-Setups**\n\n${lines.join("\n\n")}`,
      ephemeral: true
    });
  }
};