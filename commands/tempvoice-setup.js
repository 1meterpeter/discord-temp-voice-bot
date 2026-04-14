const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");
const { saveGuildConfig, getGuildConfig } = require("../utils/store");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-setup")
    .setDescription("Richtet Join-to-Create und Temp-Voice-Kategorie für diesen Server ein.")
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
    const joinChannel = interaction.options.getChannel("join_channel", true);
    const category = interaction.options.getChannel("category", true);

    saveGuildConfig(interaction.guild.id, {
      joinToCreateChannelId: joinChannel.id,
      tempCategoryId: category.id
    });

    await interaction.reply({
      content:
        `Temp-Voice Setup gespeichert.\n\n` +
        `**Join-to-Create:** ${joinChannel}\n` +
        `**Kategorie:** ${category}`,
      ephemeral: true
    });
  }
};