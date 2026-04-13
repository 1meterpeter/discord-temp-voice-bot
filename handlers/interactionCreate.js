const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
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
  if (interaction.user.id === channelData.ownerId) return true;

  return (
    settings.allowAdminsToManage &&
    interaction.member.permissions.has(PermissionFlagsBits.Administrator)
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

function buildOwnerModal(voiceChannelId) {
  const ownerSelect = new UserSelectMenuBuilder()
    .setCustomId("new_owner")
    .setPlaceholder("Mitglied auswählen")
    .setMinValues(1)
    .setMaxValues(1);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:owner:${voiceChannelId}`)
    .setTitle("Change Owner")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Member")
        .setUserSelectMenuComponent(ownerSelect)
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

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("list_users")
    .setPlaceholder("Mitglieder auswählen")
    .setMinValues(1)
    .setMaxValues(10);

  return new ModalBuilder()
    .setCustomId(`tempvc_modal:${type}:${voiceChannelId}`)
    .setTitle(type === "whitelist" ? "Whitelist Member" : "Blacklist Member")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Action")
        .setStringSelectMenuComponent(actionSelect),
      new LabelBuilder()
        .setLabel("Member")
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
        await interaction.reply({
          content: "Dieser Temp-Channel existiert nicht mehr.",
          ephemeral: true
        });
        return;
      }

      if (!isManager(interaction, channelData)) {
        await interaction.reply({
          content: "Nur der Besitzer oder ein Admin darf dieses Panel benutzen.",
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
            content: "Der Besitzer kann aktuell nicht gewechselt werden, weil niemand anderes im Voice-Channel ist.",
            ephemeral: true
          });
          return;
        }

        await interaction.showModal(buildOwnerModal(voiceChannelId));
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
          content: "Nur der Besitzer oder ein Admin darf dieses Panel benutzen.",
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
        const selectedUsers = interaction.fields.getSelectedUsers("new_owner");
        const newOwnerId = selectedUsers?.first()?.id;

        if (!newOwnerId) {
          await interaction.reply({
            content: "Es wurde kein neuer Besitzer ausgewählt.",
            ephemeral: true
          });
          return;
        }

        const validMemberIds = [...voiceChannel.members.values()]
          .filter((m) => !m.user.bot && m.id !== channelData.ownerId)
          .map((m) => m.id);

        if (!validMemberIds.includes(newOwnerId)) {
          await interaction.reply({
            content: "Der neue Besitzer muss aktuell im Voice-Channel anwesend sein.",
            ephemeral: true
          });
          return;
        }

        await transferOwnership(interaction.guild, voiceChannelId, newOwnerId);
        await updatePanel(interaction.guild, voiceChannelId);

        await interaction.reply({
          content: `Der Besitzer wurde an <@${newOwnerId}> übertragen.`,
          ephemeral: true
        });
        return;
      }

      if (action === "whitelist" || action === "blacklist") {
        const listAction = interaction.fields.getStringSelectValues("list_action")[0];
        const selectedUsers = interaction.fields.getSelectedUsers("list_users");
        const userIds = selectedUsers ? [...selectedUsers.keys()] : [];

        if (userIds.length === 0) {
          await interaction.reply({
            content: "Es wurden keine Nutzer ausgewählt.",
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