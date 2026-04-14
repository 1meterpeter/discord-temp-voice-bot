const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const { saveGuildConfig } = require("../utils/store");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-autosetup")
    .setDescription("Erstellt automatisch Kategorie + Join-Channel für Temp-Voices.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("category_name")
        .setDescription("Name der Temp-Voice-Kategorie")
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

    const categoryName =
      interaction.options.getString("category_name") || "🔊 Temp Voice";

    const joinChannelName =
      interaction.options.getString("join_channel_name") || "➕ Join to Create";

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
      const category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          }
        ]
      });

      const joinChannel = await guild.channels.create({
        name: joinChannelName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect
            ]
          },
          {
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          }
        ]
      });

      saveGuildConfig(guild.id, {
        joinToCreateChannelId: joinChannel.id,
        tempCategoryId: category.id
      });

      await interaction.reply({
        content:
          `✅ **Temp-Voice Auto-Setup erfolgreich**\n\n` +
          `**Kategorie:** ${category}\n` +
          `**Join-to-Create:** ${joinChannel}\n\n` +
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