const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const { addGuildSetup } = require("../utils/store");

/**
 * Manuelles Setup:
 * - Join-Channel wird angegeben
 * - Open-Kategorie wird angegeben
 * - Closed-Kategorie wird angegeben
 * - Source-Kategorie wird automatisch über die Parent-Kategorie des Join-Channels erkannt
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-setup")
    .setDescription("Fügt ein neues Temp-Voice-Setup für diesen Server hinzu.")
    .addStringOption((option) =>
      option
        .setName("setup_name")
        .setDescription("Interner Name für dieses Setup")
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("join_channel")
        .setDescription("Voice-Channel, der als Join-to-Create dienen soll")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("open_category")
        .setDescription("Kategorie, in der offene Talks abgelegt werden")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("closed_category")
        .setDescription("Kategorie, in die volle Talks verschoben werden")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const setupName = interaction.options.getString("setup_name", true);
    const joinChannel = interaction.options.getChannel("join_channel", true);
    const openCategory = interaction.options.getChannel("open_category", true);
    const closedCategory = interaction.options.getChannel("closed_category", true);

    const sourceCategoryId = joinChannel.parentId;

    if (!sourceCategoryId) {
      await interaction.reply({
        content:
          "❌ Der gewählte Join-Channel liegt in keiner Kategorie. " +
          "Bitte verwende einen Channel, der in einer Quell-Kategorie liegt.",
        ephemeral: true
      });
      return;
    }

    const setup = {
      setupId: `setup_${Date.now()}`,
      name: setupName,
      joinToCreateChannelId: joinChannel.id,
      sourceCategoryId,
      openCategoryId: openCategory.id,
      closedCategoryId: closedCategory.id
    };

    addGuildSetup(interaction.guild.id, setup);

    await interaction.reply({
      content:
        `✅ Temp-Voice Setup gespeichert.\n\n` +
        `**Name:** ${setup.name}\n` +
        `**Join-to-Create:** ${joinChannel}\n` +
        `**Source-Rechte von:** <#${sourceCategoryId}>\n` +
        `**Talks Open:** ${openCategory}\n` +
        `**Talks Closed:** ${closedCategory}`,
      ephemeral: true
    });
  }
};