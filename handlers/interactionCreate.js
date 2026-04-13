const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  LabelBuilder,
  UserSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

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

function getActiveVoiceMembers(voiceChannel, ownerId = null) {
  return [...voiceChannel.members.values()].filter(
    (member) => !member.user.bot && member.id !== ownerId
  );
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

function buildListChoiceMessage(listType, voiceChannelId) {
  const title = listType === "whitelist" ? "Whitelist" : "Blacklist";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tempvc:${listType}_add:${voiceChannelId}`)
      .setLabel("Add")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tempvc:${listType}_remove:${voiceChannelId}`)
      .setLabel("Remove")
      .setStyle(ButtonStyle.Danger)
  );

  return {
    content: `${title} verwalten:`,
    components: [row],
    ephemeral: true
  };
}

function buildListAddModal(voiceChannelId, type) {
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("list_users")
    .setPlaceholder("Mitglieder auswählen")
    .setMinValues(1)
    .setMaxValues(10);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:${type}_add:${voiceChannelId}`)
    .setTitle(type === "whitelist" ? "Add to Whitelist" : "Add to Blacklist")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Server Members")
        .setUserSelectMenuComponent(userSelect)
    );
}

function buildListRemoveModal(voiceChannelId, type, guild, listedUserIds) {
  const validIds = (listedUserIds || []).filter((id) => guild.members.cache.has(id));

  if (validIds.length === 0) {
    return null;
  }

  const options = validIds.slice(0, 25).map((userId) => {
    const member = guild.members.cache.get(userId);
    const label =
      member?.displayName?.slice(0, 100) ||
      member?.user?.username?.slice(0, 100) ||
      `User ${userId}`.slice(0, 100);

    return {
      label,
      value: userId,
      description: "Bereits auf der Liste"
    };
  });

  const removeSelect = new StringSelectMenuBuilder()
    .setCustomId("list_users")
    .setPlaceholder("Mitglieder auswählen")
    .setMinValues(1)
    .setMaxValues(Math.min(options.length, 10))
    .addOptions(options);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:${type}_remove:${voiceChannelId}`)
    .setTitle(type === "whitelist" ? "Remove from Whitelist" : "Remove from Blacklist")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Listed Members")
        .setStringSelectMenuComponent(removeSelect)
    );
}

module.exports = async function handleInteractionCreate(interaction) {
  try {
    // Button-Klicks
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
        const membersInVoice = getActiveVoiceMembers(voiceChannel, channelData.ownerId);

        if (membersInVoice.length === 0) {
          await interaction.reply({
            content: "Der Owner kann aktuell nicht gewechselt werden, weil niemand anderes im Voice-Channel ist.",
            ephemeral: true
          });
          return;
        }

        await interaction.showModal(buildOwnerModal(voiceChannelId, membersInVoice));
        return;
      }

      if (action === "whitelist") {
        await interaction.reply(buildListChoiceMessage("whitelist", voiceChannelId));
        return;
      }

      if (action === "blacklist") {
        await interaction.reply(buildListChoiceMessage("blacklist", voiceChannelId));
        return;
      }

      if (action === "whitelist_add") {
        await interaction.showModal(buildListAddModal(voiceChannelId, "whitelist"));
        return;
      }

      if (action === "blacklist_add") {
        await interaction.showModal(buildListAddModal(voiceChannelId, "blacklist"));
        return;
      }

      if (action === "whitelist_remove") {
        const removeModal = buildListRemoveModal(
          voiceChannelId,
          "whitelist",
          interaction.guild,
          channelData.whitelist || []
        );

        if (!removeModal) {
          await interaction.reply({
            content: "Die Whitelist ist aktuell leer.",
            ephemeral: true
          });
          return;
        }

        await interaction.showModal(removeModal);
        return;
      }

      if (action === "blacklist_remove") {
        const removeModal = buildListRemoveModal(
          voiceChannelId,
          "blacklist",
          interaction.guild,
          channelData.blacklist || []
        );

        if (!removeModal) {
          await interaction.reply({
            content: "Die Blacklist ist aktuell leer.",
            ephemeral: true
          });
          return;
        }

        await interaction.showModal(removeModal);
        return;
      }
    }

    // Modal-Submits
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

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!voiceChannel) {
        await interaction.reply({
          content: "Der Voice-Channel wurde nicht gefunden.",
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

      if (action === "owner") {
        const selectedOwnerId = interaction.fields.getStringSelectValues("new_owner")[0];

        const validMemberIds = getActiveVoiceMembers(voiceChannel, channelData.ownerId).map(
          (member) => member.id
        );

        if (!validMemberIds.includes(selectedOwnerId)) {
          await interaction.reply({
            content: "Der ausgewählte User ist nicht mehr im Voice-Channel.",
            ephemeral: true
          });
          return;
        }

        await transferOwnership(interaction.guild, voiceChannelId, selectedOwnerId);
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.reply({
          content: `Ownership wurde an <@${selectedOwnerId}> übertragen.`,
          ephemeral: true
        });
        return;
      }

      if (action === "whitelist_add" || action === "blacklist_add") {
        const listName = action === "whitelist_add" ? "whitelist" : "blacklist";
        const selectedUsers = interaction.fields.getSelectedUsers("list_users");
        const userIds = selectedUsers ? [...selectedUsers.keys()] : [];

        if (userIds.length === 0) {
          await interaction.reply({
            content: "Es wurden keine Mitglieder ausgewählt.",
            ephemeral: true
          });
          return;
        }

        await addToList(interaction.guild, voiceChannelId, listName, userIds);
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.reply({
          content: `${listName === "whitelist" ? "Whitelist" : "Blacklist"} wurde aktualisiert.`,
          ephemeral: true
        });
        return;
      }

      if (action === "whitelist_remove" || action === "blacklist_remove") {
        const listName = action === "whitelist_remove" ? "whitelist" : "blacklist";
        const userIds = interaction.fields.getStringSelectValues("list_users");

        if (!userIds || userIds.length === 0) {
          await interaction.reply({
            content: "Es wurden keine Mitglieder ausgewählt.",
            ephemeral: true
          });
          return;
        }

        await removeFromList(interaction.guild, voiceChannelId, listName, userIds);
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.reply({
          content: `${listName === "whitelist" ? "Whitelist" : "Blacklist"} wurde aktualisiert.`,
          ephemeral: true
        });
        return;
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