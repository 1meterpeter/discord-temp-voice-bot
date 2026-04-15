const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const { addGuildSetup } = require("../utils/store");

/**
 * Auto-Setup:
 * - erstellt Source-Kategorie + Join-Channel
 * - nutzt bestehende Open/Closed-Kategorien
 *
 * WICHTIG:
 * Discord verlangt, dass required Optionen VOR optionalen Optionen definiert werden.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-autosetup")
    .setDescription("Erstellt automatisch Source-Kategorie + Join-Channel und verknüpft sie mit Open/Closed.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    // REQUIRED Optionen müssen zuerst kommen
    .addStringOption((option) =>
      option
        .setName("setup_name")
        .setDescription("Interner Name dieses Setups")
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("open_category")
        .setDescription("Kategorie für offene Talks")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("closed_category")
        .setDescription("Kategorie für volle Talks")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )

    // OPTIONALE Optionen erst danach
    .addStringOption((option) =>
      option
        .setName("source_category_name")
        .setDescription("Name der Quell-Kategorie")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("join_channel_name")
        .setDescription("Name des Join-to-Create Channels")
        .setRequired(false)
    ),

  async execute(interaction) {
    const guild = interaction.guild;
    const botMember = guild.members.me;

    if (!guild || !botMember) {
      await interaction.reply({
        content: "Guild oder Bot-Mitglied konnte nicht gefunden werden.",
        ephemeral: true
      });
      return;
    }

    const setupName = interaction.options.getString("setup_name", true);
    const sourceCategoryName =
      interaction.options.getString("source_category_name") || `🎙️ ${setupName}`;
    const joinChannelName =
      interaction.options.getString("join_channel_name") || "➕ Join to Create";

    const openCategory = interaction.options.getChannel("open_category", true);
    const closedCategory = interaction.options.getChannel("closed_category", true);

    const missingPermissions = [];

    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      missingPermissions.push("Kanäle verwalten");
    }

    if (!botMember.permissions.has(PermissionFlagsBits.MoveMembers)) {
      missingPermissions.push("Mitglieder verschieben");
    }

    if (!botMember.permissions.has(PermissionFlagsBits.ViewChannel)) {
      missingPermissions.push("Kanäle anzeigen");
    }

    if (!botMember.permissions.has(PermissionFlagsBits.Connect)) {
      missingPermissions.push("Verbinden");
    }

    if (!botMember.permissions.has(PermissionFlagsBits.SendMessages)) {
      missingPermissions.push("Nachrichten senden");
    }

    if (!botMember.permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
      missingPermissions.push("Nachrichtenverlauf lesen");
    }

    if (missingPermissions.length > 0) {
      await interaction.reply({
        content:
          `❌ **Ich habe nicht genug Rechte für das Auto-Setup.**\n\n` +
          `**Fehlende Berechtigungen:**\n- ${missingPermissions.join("\n- ")}`,
        ephemeral: true
      });
      return;
    }

    try {
      // Source-Kategorie: von hier werden später die Rechte übernommen.
      const sourceCategory = await guild.channels.create({
        name: sourceCategoryName,
        type: ChannelType.GuildCategory
      });

      // Join-Channel liegt in der Source-Kategorie.
      const joinChannel = await guild.channels.create({
        name: joinChannelName,
        type: ChannelType.GuildVoice,
        parent: sourceCategory.id
      });

      const setup = {
        setupId: `setup_${Date.now()}`,
        name: setupName,
        joinToCreateChannelId: joinChannel.id,
        sourceCategoryId: sourceCategory.id,
        openCategoryId: openCategory.id,
        closedCategoryId: closedCategory.id
      };

      addGuildSetup(guild.id, setup);

      await interaction.reply({
        content:
          `✅ **Temp-Voice Auto-Setup erfolgreich**\n\n` +
          `**Setup-Name:** ${setup.name}\n` +
          `**Source-Kategorie:** ${sourceCategory}\n` +
          `**Join-to-Create:** ${joinChannel}\n` +
          `**Talks Open:** ${openCategory}\n` +
          `**Talks Closed:** ${closedCategory}\n\n` +
          `Die Konfiguration wurde gespeichert.`,
        ephemeral: true
      });
    } catch (error) {
      console.error("Fehler in tempvoice-autosetup:", error);

      await interaction.reply({
        content:
          `Beim Auto-Setup ist ein Fehler aufgetreten.\n` +
          `**Fehler:** ${error.message}`,
        ephemeral: true
      });
    }
  }
};