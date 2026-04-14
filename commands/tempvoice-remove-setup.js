const {
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const {
  getGuildSetups,
  removeGuildSetup
} = require("../utils/store");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-remove-setup")
    .setDescription("Entfernt ein gespeichertes Temp-Voice-Setup dieses Servers.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("setup_id")
        .setDescription("Die Setup-ID des zu entfernenden Setups")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addBooleanOption((option) =>
      option
        .setName("delete_channels")
        .setDescription("Löscht auch Join-Channel und Kategorie, falls vorhanden")
        .setRequired(false)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused().toLowerCase();
    const setups = getGuildSetups(interaction.guild.id);

    const filtered = setups
      .filter((setup) => {
        return (
          setup.setupId.toLowerCase().includes(focusedValue) ||
          (setup.name || "").toLowerCase().includes(focusedValue)
        );
      })
      .slice(0, 25)
      .map((setup) => ({
        name: `${setup.name} (${setup.setupId})`.slice(0, 100),
        value: setup.setupId
      }));

    await interaction.respond(filtered);
  },

  async execute(interaction) {
    const setupId = interaction.options.getString("setup_id", true);
    const deleteChannels = interaction.options.getBoolean("delete_channels") ?? false;

    const setups = getGuildSetups(interaction.guild.id);
    const targetSetup = setups.find((setup) => setup.setupId === setupId);

    if (!targetSetup) {
      await interaction.reply({
        content: "❌ Das angegebene Setup wurde nicht gefunden.",
        ephemeral: true
      });
      return;
    }

    let deletedJoinChannel = false;
    let deletedCategory = false;
    const errors = [];

    if (deleteChannels) {
      const joinChannel = interaction.guild.channels.cache.get(
        targetSetup.joinToCreateChannelId
      );

      if (joinChannel) {
        try {
          await joinChannel.delete("Temp-Voice-Setup wurde entfernt");
          deletedJoinChannel = true;
        } catch (error) {
          console.error("Fehler beim Löschen des Join-Channels:", error);
          errors.push("Join-Channel konnte nicht gelöscht werden");
        }
      }

      const category = interaction.guild.channels.cache.get(
        targetSetup.tempCategoryId
      );

      if (category) {
        try {
          await category.delete("Temp-Voice-Setup wurde entfernt");
          deletedCategory = true;
        } catch (error) {
          console.error("Fehler beim Löschen der Kategorie:", error);
          errors.push("Kategorie konnte nicht gelöscht werden");
        }
      }
    }

    const removedSetup = removeGuildSetup(interaction.guild.id, setupId);

    if (!removedSetup) {
      await interaction.reply({
        content: "❌ Das Setup konnte nicht aus der Konfiguration entfernt werden.",
        ephemeral: true
      });
      return;
    }

    const lines = [
      `✅ **Temp-Voice-Setup entfernt**`,
      ``,
      `**Name:** ${removedSetup.name}`,
      `**Setup-ID:** \`${removedSetup.setupId}\``
    ];

    if (deleteChannels) {
      lines.push(
        ``,
        `**Join-Channel gelöscht:** ${deletedJoinChannel ? "Ja" : "Nein"}`,
        `**Kategorie gelöscht:** ${deletedCategory ? "Ja" : "Nein"}`
      );
    }

    if (errors.length > 0) {
      lines.push(
        ``,
        `⚠️ **Hinweise:**`,
        ...errors.map((err) => `- ${err}`)
      );
    }

    await interaction.reply({
      content: lines.join("\n"),
      ephemeral: true
    });
  }
};