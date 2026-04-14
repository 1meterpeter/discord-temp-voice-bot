const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  LabelBuilder,
  UserSelectMenuBuilder
} = require("discord.js");

const { getTempChannel } = require("../utils/store");
const { replyAndAutoDelete } = require("../utils/autoDelete");
const {
  updateChannelSettings,
  transferOwnership,
  addToList,
  removeFromList,
  updatePanel
} = require("../services/tempChannelService");

function isManager(interaction, channelData) {
  if (!interaction.member) return false;
  return interaction.user.id === channelData.ownerId;
}

function getActiveVoiceMembers(voiceChannel, ownerId = null) {
  return [...voiceChannel.members.values()].filter(
    (member) => !member.user.bot && member.id !== ownerId
  );
}

function sanitizeExistingList(channelData, listName) {
  return (channelData[listName] || []).filter((id) => id && id !== channelData.ownerId);
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

function buildOwnerModal(voiceChannelId, members) {
  const options = members.slice(0, 25).map((member) => ({
    label: member.displayName.slice(0, 100),
    value: member.id,
    description: "Aktiv im Voice"
  }));

  const ownerSelect = new StringSelectMenuBuilder()
    .setCustomId("new_owner")
    .setPlaceholder("Neuen Owner auswählen")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:owner:${voiceChannelId}`)
    .setTitle("Change Owner")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Active Members")
        .setStringSelectMenuComponent(ownerSelect)
    );
}

function buildListModal(voiceChannelId, listName, channelData) {
  const existing = sanitizeExistingList(channelData, listName).slice(0, 25);

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("list_users")
    .setPlaceholder("Mitglieder auswählen oder abwählen")
    .setMinValues(0)
    .setMaxValues(25)
    .setRequired(false);

  if (existing.length > 0) {
    userSelect.setDefaultUsers(existing);
  }

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:${listName}:${voiceChannelId}`)
    .setTitle(listName === "whitelist" ? "Manage Whitelist" : "Manage Blacklist")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Server Members")
        .setUserSelectMenuComponent(userSelect)
    );
}

module.exports = async function handleInteractionCreate(interaction) {
  try {
    if (interaction.isButton()) {
      const [prefix, action, voiceChannelId] = interaction.customId.split(":");
      if (prefix !== "tempvc") return;

      const channelData = getTempChannel(interaction.guild.id, voiceChannelId);
      if (!channelData) {
        await replyAndAutoDelete(interaction, {
          content: "Dieser Temp-Channel existiert nicht mehr.",
          ephemeral: false
        });
        return;
      }

      if (!isManager(interaction, channelData)) {
        await replyAndAutoDelete(interaction, {
          content: "Nur der aktuelle Owner darf dieses Panel benutzen.",
          ephemeral: false
        });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!voiceChannel) {
        await replyAndAutoDelete(interaction, {
          content: "Der Voice-Channel wurde nicht gefunden.",
          ephemeral: false
        });
        return;
      }

      if (action === "edit") {
        await interaction.showModal(buildEditModal(voiceChannelId, channelData));
        return;
      }

      if (action === "owner") {
        const membersInVoice = getActiveVoiceMembers(voiceChannel, channelData.ownerId);

        if (membersInVoice.length === 0) {
          await replyAndAutoDelete(interaction, {
            content:
              "Der Owner kann aktuell nicht gewechselt werden, weil niemand anderes im Voice-Channel ist.",
            ephemeral: false
          });
          return;
        }

        await interaction.showModal(buildOwnerModal(voiceChannelId, membersInVoice));
        return;
      }

      if (action === "whitelist") {
        await interaction.showModal(buildListModal(voiceChannelId, "whitelist", channelData));
        return;
      }

      if (action === "blacklist") {
        await interaction.showModal(buildListModal(voiceChannelId, "blacklist", channelData));
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
        await replyAndAutoDelete(interaction, {
          content: "Dieser Temp-Channel existiert nicht mehr.",
          ephemeral: false
        });
        return;
      }

      if (!isManager(interaction, channelData)) {
        await replyAndAutoDelete(interaction, {
          content: "Nur der aktuelle Owner darf dieses Panel benutzen.",
          ephemeral: false
        });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!voiceChannel) {
        await replyAndAutoDelete(interaction, {
          content: "Der Voice-Channel wurde nicht gefunden.",
          ephemeral: false
        });
        return;
      }

      if (action === "edit") {
        const newName = interaction.fields.getTextInputValue("channel_name").trim();
        const rawLimit = interaction.fields.getTextInputValue("channel_limit").trim();
        const privacy = interaction.fields.getStringSelectValues("channel_privacy")[0];

        const limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
          await replyAndAutoDelete(interaction, {
            content: "Bitte gib eine ganze Zahl zwischen 0 und 99 ein.",
            ephemeral: false
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        await updateChannelSettings(interaction.guild, voiceChannelId, {
          name: newName,
          userLimit: limit,
          isPrivate: privacy === "private"
        });

        await interaction.editReply({
          content: "Der Channel wurde aktualisiert."
        });
        return;
      }

      if (action === "owner") {
        const selectedOwnerId = interaction.fields.getStringSelectValues("new_owner")[0];

        const validMemberIds = getActiveVoiceMembers(voiceChannel, channelData.ownerId).map(
          (member) => member.id
        );

        if (!validMemberIds.includes(selectedOwnerId)) {
          await replyAndAutoDelete(interaction, {
            content: "Der ausgewählte User ist nicht mehr im Voice-Channel.",
            ephemeral: false
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        await transferOwnership(interaction.guild, voiceChannelId, selectedOwnerId);
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.editReply({
          content: `Ownership wurde an <@${selectedOwnerId}> übertragen.`
        });
        return;
      }

      if (action === "whitelist" || action === "blacklist") {
        const listName = action;
        const currentIds = sanitizeExistingList(channelData, listName);

        const selectedUsers = interaction.fields.getSelectedUsers("list_users");
        const selectedIds = selectedUsers ? [...selectedUsers.keys()] : [];

        const desiredIds = [...new Set(selectedIds.filter((id) => id !== channelData.ownerId))];

        const addIds = desiredIds.filter((id) => !currentIds.includes(id));
        const removeIds = currentIds.filter((id) => !desiredIds.includes(id));

        await interaction.deferReply({ ephemeral: true });

        if (addIds.length > 0) {
          await addToList(interaction.guild, voiceChannelId, listName, addIds);
        }

        if (removeIds.length > 0) {
          await removeFromList(interaction.guild, voiceChannelId, listName, removeIds);
        }

        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.editReply({
          content: `${listName === "whitelist" ? "Whitelist" : "Blacklist"} wurde aktualisiert.`
        });
        return;
      }
    }
  } catch (error) {
    console.error("Fehler bei InteractionCreate:", error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await replyAndAutoDelete(interaction, {
        content: `Es ist ein Fehler aufgetreten: ${error.message}`,
        ephemeral: false
      }).catch(() => {});
      return;
    }

    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({
        content: `Es ist ein Fehler aufgetreten: ${error.message}`
      }).catch(() => {});
    }
  }
};