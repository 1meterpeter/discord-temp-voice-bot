const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const { addGuildSetup } = require("../utils/store");

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
        .setName("category")
        .setDescription("Kategorie, in der neue Temp-Voices erstellt werden")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const setupName = interaction.options.getString("setup_name", true);
    const joinChannel = interaction.options.getChannel("join_channel", true);
    const category = interaction.options.getChannel("category", true);

    const setup = {
      setupId: `setup_${Date.now()}`,
      name: setupName,
      joinToCreateChannelId: joinChannel.id,
      tempCategoryId: category.id
    };

    addGuildSetup(interaction.guild.id, setup);

    await interaction.reply({
      content:
        `✅ Temp-Voice Setup gespeichert.\n\n` +
        `**Name:** ${setup.name}\n` +
        `**Join-to-Create:** ${joinChannel}\n` +
        `**Kategorie:** ${category}`,
      ephemeral: true
    });
  }
};