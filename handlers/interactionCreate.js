const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  LabelBuilder
} = require("discord.js");

const settings = require("../config/settings");
const { getTempChannel } = require("../utils/store");
const {
  setPrivacy,
  renameChannel,
  setUserLimit,
  transferOwnership,
  addToList,
  removeFromList,
  updatePanel
} = require("../services/tempChannelService");

function isManager(interaction, channelData) {
  if (!interaction.member) return false;
  return interaction.user.id === channelData.ownerId;
}

function buildEditModal(voiceChannelId, channelData) {
  const nameInput = new TextInputBuilder()
    .setCustomId("channel_name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(channelData.name.replace(/^🔊\s*/, "").slice(0, 80))
    .setMaxLength(80);

  const limitInput = new TextInputBuilder()
    .setCustomId("channel_limit")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(channelData.userLimit))
    .setMaxLength(2);

  const privacySelect = new StringSelectMenuBuilder()
    .setCustomId("channel_privacy")
    .setPlaceholder("Privacy auswählen")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions([
      { label: "Open", value: "open", default: !channelData.isPrivate },
      { label: "Private", value: "private", default: channelData.isPrivate }
    ]);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:edit:${voiceChannelId}`)
    .setTitle("Edit Channel")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Voice Name")
        .setTextInputComponent(nameInput),
      new LabelBuilder()
        .setLabel("Max Users (0-99)")
        .setTextInputComponent(limitInput),
      new LabelBuilder()
        .setLabel("Privacy")
        .setStringSelectMenuComponent(privacySelect)
    );
}

function buildOwnerSelectRow(voiceChannelId, members) {
  const options = members.slice(0, 25).map((member) => ({
    label: member.displayName.slice(0, 100),
    value: member.id,
    description: `ID: ${member.id}`.slice(0, 100)
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`tempvc_select:owner:${voiceChannelId}`)
      .setPlaceholder("Neuen Owner auswählen")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}

function buildListModal(voiceChannelId, type) {
  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId("list_action")
    .setPlaceholder("Aktion auswählen")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions([
      { label: "Add", value: "add" },
      { label: "Remove", value: "remove" }
    ]);

  const memberInput = new TextInputBuilder()
    .setCustomId("list_users")
    .setLabel("User IDs (mit Komma getrennt)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setPlaceholder("123456789, 987654321")
    .setMaxLength(1000);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:${type}:${voiceChannelId}`)
    .setTitle(type === "whitelist" ? "Whitelist verwalten" : "Blacklist verwalten")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Action")
        .setStringSelectMenuComponent(actionSelect),
      new LabelBuilder()
        .setLabel("Member IDs")
        .setTextInputComponent(memberInput)
    );
}

module.exports = async function handleInteractionCreate(interaction) {
  try {
    if (interaction.isButton()) {
      const [prefix, action, voiceChannelId] = interaction.customId.split(":");
      if (prefix !== "tempvc") return;

      const channelData = getTempChannel(interaction.guild.id, voiceChannelId);
      if (!channelData) {
        await interaction.reply({
          content: "Dieser Temp-Channel existiert nicht mehr.",
          ephemeral: true
        });
        return;
      }

      if (!isManager(interaction, channelData)) {
        await interaction.reply({
          content: "Nur der aktuelle Owner darf dieses Panel benutzen.",
          ephemeral: true
        });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!voiceChannel) {
        await interaction.reply({
          content: "Der Voice-Channel wurde nicht gefunden.",
          ephemeral: true
        });
        return;
      }

      if (action === "edit") {
        await interaction.showModal(buildEditModal(voiceChannelId, channelData));
        return;
      }

      if (action === "owner") {
        const membersInVoice = [...voiceChannel.members.values()]
          .filter((m) => !m.user.bot && m.id !== channelData.ownerId);

        if (membersInVoice.length === 0) {
          await interaction.reply({
            content: "Der Owner kann aktuell nicht gewechselt werden, weil niemand anderes im Voice-Channel ist.",
            ephemeral: true
          });
          return;
        }

        await interaction.reply({
          content: "Wähle den neuen Owner aus:",
          components: [buildOwnerSelectRow(voiceChannelId, membersInVoice)],
          ephemeral: true
        });
        return;
      }

      if (action === "whitelist") {
        await interaction.showModal(buildListModal(voiceChannelId, "whitelist"));
        return;
      }

      if (action === "blacklist") {
        await interaction.showModal(buildListModal(voiceChannelId, "blacklist"));
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const [prefix, action, voiceChannelId] = interaction.customId.split(":");
      if (prefix !== "tempvc_select") return;

      const channelData = getTempChannel(interaction.guild.id, voiceChannelId);
      if (!channelData) {
        await interaction.reply({
          content: "Dieser Temp-Channel existiert nicht mehr.",
          ephemeral: true
        });
        return;
      }

      if (!isManager(interaction, channelData)) {
        await interaction.reply({
          content: "Nur der aktuelle Owner darf dieses Panel benutzen.",
          ephemeral: true
        });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!voiceChannel) {
        await interaction.reply({
          content: "Der Voice-Channel wurde nicht gefunden.",
          ephemeral: true
        });
        return;
      }

      if (action === "owner") {
        const selectedOwnerId = interaction.values[0];

        const validMemberIds = [...voiceChannel.members.values()]
          .filter((m) => !m.user.bot && m.id !== channelData.ownerId)
          .map((m) => m.id);

        if (!validMemberIds.includes(selectedOwnerId)) {
          await interaction.update({
            content: "Der ausgewählte User ist nicht mehr im Voice-Channel.",
            components: []
          });
          return;
        }

        await transferOwnership(interaction.guild, voiceChannelId, selectedOwnerId);
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.update({
          content: `Ownership wurde an <@${selectedOwnerId}> übertragen.`,
          components: []
        });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(":");
      const prefix = parts[0];
      const action = parts[1];
      const voiceChannelId = parts[2];

      if (prefix !== "tempvc_modal") return;

      const channelData = getTempChannel(interaction.guild.id, voiceChannelId);
      if (!channelData) {
        await interaction.reply({
          content: "Dieser Temp-Channel existiert nicht mehr.",
          ephemeral: true
        });
        return;
      }

      if (!isManager(interaction, channelData)) {
        await interaction.reply({
          content: "Nur der aktuelle Owner darf dieses Panel benutzen.",
          ephemeral: true
        });
        return;
      }

      if (action === "edit") {
        const newName = interaction.fields.getTextInputValue("channel_name").trim();
        const rawLimit = interaction.fields.getTextInputValue("channel_limit").trim();
        const privacy = interaction.fields.getStringSelectValues("channel_privacy")[0];

        const limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
          await interaction.reply({
            content: "Bitte gib eine ganze Zahl zwischen 0 und 99 ein.",
            ephemeral: true
          });
          return;
        }

        await renameChannel(interaction.guild, voiceChannelId, newName);
        await setUserLimit(interaction.guild, voiceChannelId, limit);
        await setPrivacy(interaction.guild, voiceChannelId, privacy === "private");
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.reply({
          content: "Der Channel wurde aktualisiert.",
          ephemeral: true
        });
        return;
      }

      if (action === "whitelist" || action === "blacklist") {
        const listAction = interaction.fields.getStringSelectValues("list_action")[0];
        const rawIds = interaction.fields.getTextInputValue("list_users");

        const userIds = rawIds
          .split(",")
          .map((id) => id.trim())
          .filter((id) => /^\d{5,}$/.test(id));

        if (userIds.length === 0) {
          await interaction.reply({
            content: "Bitte gib mindestens eine gültige User-ID ein.",
            ephemeral: true
          });
          return;
        }

        if (listAction === "add") {
          await addToList(interaction.guild, voiceChannelId, action, userIds);
        } else {
          await removeFromList(interaction.guild, voiceChannelId, action, userIds);
        }

        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.reply({
          content: `${action === "whitelist" ? "Whitelist" : "Blacklist"} wurde aktualisiert.`,
          ephemeral: true
        });
      }
    }
  } catch (error) {
    console.error("Fehler bei InteractionCreate:", error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `Es ist ein Fehler aufgetreten: ${error.message}`,
        ephemeral: true
      }).catch(() => {});
    }
  }
};