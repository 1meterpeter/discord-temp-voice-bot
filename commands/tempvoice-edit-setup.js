const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const {
  getGuildSetups,
  updateGuildSetup
} = require("../utils/store");

/**
 * Bearbeitet ein bestehendes Temp-Voice-Setup.
 *
 * Nur angegebene Werte werden geändert.
 * Dadurch kannst du z. B. nur die Open-/Closed-Kategorien wechseln,
 * ohne das komplette Setup neu anzulegen.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("tempvoice-edit-setup")
    .setDescription("Bearbeitet ein bestehendes Temp-Voice-Setup dieses Servers.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("setup_id")
        .setDescription("Die Setup-ID des zu bearbeitenden Setups")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("new_setup_name")
        .setDescription("Neuer Anzeigename des Setups")
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName("new_join_channel")
        .setDescription("Neuer Join-to-Create Voice-Channel")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName("new_source_category")
        .setDescription("Neue Quell-Kategorie, von der Rechte übernommen werden")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName("new_open_category")
        .setDescription("Neue Kategorie für offene Talks")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName("new_closed_category")
        .setDescription("Neue Kategorie für volle Talks")
        .addChannelTypes(ChannelType.GuildCategory)
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
    const newSetupName = interaction.options.getString("new_setup_name");
    const newJoinChannel = interaction.options.getChannel("new_join_channel");
    const newSourceCategory = interaction.options.getChannel("new_source_category");
    const newOpenCategory = interaction.options.getChannel("new_open_category");
    const newClosedCategory = interaction.options.getChannel("new_closed_category");

    const hasAnyUpdate =
      newSetupName ||
      newJoinChannel ||
      newSourceCategory ||
      newOpenCategory ||
      newClosedCategory;

    if (!hasAnyUpdate) {
      await interaction.reply({
        content: "❌ Du musst mindestens ein Feld angeben, das geändert werden soll.",
        ephemeral: true
      });
      return;
    }

    const updates = {};

    if (newSetupName) {
      updates.name = newSetupName;
    }

    if (newJoinChannel) {
      updates.joinToCreateChannelId = newJoinChannel.id;
    }

    if (newSourceCategory) {
      updates.sourceCategoryId = newSourceCategory.id;
    }

    if (newOpenCategory) {
      updates.openCategoryId = newOpenCategory.id;
    }

    if (newClosedCategory) {
      updates.closedCategoryId = newClosedCategory.id;
    }

    const updatedSetup = updateGuildSetup(interaction.guild.id, setupId, updates);

    if (!updatedSetup) {
      await interaction.reply({
        content: "❌ Das angegebene Setup wurde nicht gefunden.",
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content:
        `✅ **Temp-Voice-Setup aktualisiert**\n\n` +
        `**Name:** ${updatedSetup.name}\n` +
        `**Setup-ID:** \`${updatedSetup.setupId}\`\n` +
        `**Join-to-Create:** <#${updatedSetup.joinToCreateChannelId}>\n` +
        `**Source-Rechte von:** ${updatedSetup.sourceCategoryId ? `<#${updatedSetup.sourceCategoryId}>` : "—"}\n` +
        `**Talks Open:** <#${updatedSetup.openCategoryId}>\n` +
        `**Talks Closed:** <#${updatedSetup.closedCategoryId}>`,
      ephemeral: true
    });
  }
};