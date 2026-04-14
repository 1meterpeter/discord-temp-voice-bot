const {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits
} = require("discord.js");

const settings = require("../config/settings");
const {
  saveTempChannel,
  getTempChannel,
  deleteTempChannel,
  getUserProfile,
  saveUserProfile,
  getGuildConfig
} = require("../utils/store");
const {
  buildMainPanelComponents
} = require("../ui/panel");

function createDisplayName(member) {
  return `${member.displayName}'s ${settings.defaultChannelName}`;
}

function dedupeList(arr) {
  return [...new Set(arr)];
}

function normalizeLists(channelData) {
  channelData.whitelist = dedupeList((channelData.whitelist || []).filter(Boolean));
  channelData.blacklist = dedupeList((channelData.blacklist || []).filter(Boolean));

  channelData.whitelist = channelData.whitelist.filter(
    (id) => !channelData.blacklist.includes(id)
  );

  channelData.whitelist = channelData.whitelist.filter((id) => id !== channelData.ownerId);
  channelData.blacklist = channelData.blacklist.filter((id) => id !== channelData.ownerId);
}

function filterValidMemberIds(guild, userIds) {
  return (userIds || []).filter((id) => guild.members.cache.has(id));
}

function getDefaultProfile(member) {
  return {
    name: `${settings.voicePrefix} ${createDisplayName(member)}`,
    userLimit: settings.defaultUserLimit,
    isPrivate: false,
    whitelist: [],
    blacklist: []
  };
}

function persistOwnerProfile(guildId, channelData) {
  saveUserProfile(guildId, channelData.ownerId, {
    name: channelData.name,
    userLimit: channelData.userLimit,
    isPrivate: channelData.isPrivate,
    whitelist: channelData.whitelist || [],
    blacklist: channelData.blacklist || []
  });
}

async function createTempChannel(member, joinChannel) {
  const guild = member.guild;
  const guildConfig = getGuildConfig(guild.id);
  const botMember = guild.members.me;

  if (!guildConfig?.tempCategoryId) {
    throw new Error("Für diesen Server ist keine Temp-Voice-Kategorie konfiguriert.");
  }

  if (!botMember) {
    throw new Error("Bot-Mitglied konnte in dieser Guild nicht gefunden werden.");
  }

  const tempCategory = guild.channels.cache.get(guildConfig.tempCategoryId);

  if (!tempCategory) {
    throw new Error(
      `Die konfigurierte Temp-Kategorie ${guildConfig.tempCategoryId} wurde nicht gefunden.`
    );
  }

  try {
    await guild.members.fetch();
  } catch (error) {
    console.warn("Guild members konnten nicht vollständig geladen werden:", error.message);
  }

  const savedProfile = getUserProfile(guild.id, member.id) || getDefaultProfile(member);

  const channelData = {
    ownerId: member.id,
    voiceChannelId: null,
    panelMessageId: null,
    name: savedProfile.name,
    userLimit: savedProfile.userLimit,
    isPrivate: savedProfile.isPrivate,
    whitelist: savedProfile.whitelist || [],
    blacklist: savedProfile.blacklist || []
  };

  normalizeLists(channelData);

  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);

  const voiceOverwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        ...(channelData.isPrivate ? [] : [PermissionFlagsBits.Connect])
      ],
      deny: channelData.isPrivate ? [PermissionFlagsBits.Connect] : []
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.MoveMembers,
        PermissionFlagsBits.ManageChannels
      ]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  for (const userId of channelData.whitelist) {
    voiceOverwrites.push({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  for (const userId of channelData.blacklist) {
    voiceOverwrites.push({
      id: userId,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages
      ]
    });
  }

  console.log(
    `[TempVoice] Erstelle Channel in Guild ${guild.id} unter Kategorie ${guildConfig.tempCategoryId}`
  );

  const voiceChannel = await guild.channels.create({
    name: channelData.name,
    type: ChannelType.GuildVoice,
    parent: guildConfig.tempCategoryId,
    userLimit: channelData.userLimit,
    permissionOverwrites: voiceOverwrites
  });

  channelData.voiceChannelId = voiceChannel.id;

  const panelMessage = await voiceChannel.send({
    flags: MessageFlags.IsComponentsV2,
    components: buildMainPanelComponents(channelData)
  });

  channelData.panelMessageId = panelMessage.id;

  saveTempChannel(guild.id, voiceChannel.id, channelData);
  persistOwnerProfile(guild.id, channelData);

  try {
    await member.voice.setChannel(voiceChannel);
  } catch (error) {
    console.error(
      `[TempVoice] User konnte nicht in den neuen Temp-Channel verschoben werden.`
    );

    try {
      await voiceChannel.send({
        content:
          "❌ Ich konnte dich nicht in den neuen Temp-Channel verschieben.\n" +
          "Bitte prüfe, ob ich die Berechtigung **„Mitglieder verschieben“** habe."
      });
    } catch (sendError) {
      console.error("Konnte Fehlermeldung im Voice-Chat nicht senden:", sendError);
    }

    throw error;
  }

  return channelData;
}

async function updatePanel(guild, voiceChannelId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return;

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);
  saveTempChannel(guild.id, voiceChannelId, channelData);

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return;

  try {
    const msg = await voiceChannel.messages.fetch(channelData.panelMessageId);
    await msg.edit({
      components: buildMainPanelComponents(channelData)
    });
  } catch (error) {
    console.error("Panel konnte nicht aktualisiert werden:", error);
  }
}

async function applyPermissions(guild, voiceChannelId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return;

  const botMember = guild.members.me;
  if (!botMember) return;

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);
  saveTempChannel(guild.id, voiceChannelId, channelData);

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return;

  const baseOverwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        ...(channelData.isPrivate ? [] : [PermissionFlagsBits.Connect])
      ],
      deny: channelData.isPrivate ? [PermissionFlagsBits.Connect] : []
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.MoveMembers,
        PermissionFlagsBits.ManageChannels
      ]
    },
    {
      id: channelData.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  for (const userId of channelData.whitelist) {
    baseOverwrites.push({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  for (const userId of channelData.blacklist) {
    baseOverwrites.push({
      id: userId,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages
      ]
    });
  }

  await voiceChannel.permissionOverwrites.set(baseOverwrites);
}

async function setPrivacy(guild, voiceChannelId, isPrivate) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  channelData.isPrivate = isPrivate;
  saveTempChannel(guild.id, voiceChannelId, channelData);
  persistOwnerProfile(guild.id, channelData);

  await applyPermissions(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);
  return true;
}

async function renameChannel(guild, voiceChannelId, newName) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  const cleanName = newName.trim().slice(0, 90);
  const finalName = `${settings.voicePrefix} ${cleanName}`;

  await voiceChannel.setName(finalName);

  channelData.name = finalName;
  saveTempChannel(guild.id, voiceChannelId, channelData);
  persistOwnerProfile(guild.id, channelData);

  await updatePanel(guild, voiceChannelId);
  return true;
}

async function setUserLimit(guild, voiceChannelId, limit) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  await voiceChannel.setUserLimit(limit);

  channelData.userLimit = limit;
  saveTempChannel(guild.id, voiceChannelId, channelData);
  persistOwnerProfile(guild.id, channelData);

  await updatePanel(guild, voiceChannelId);
  return true;
}

async function transferOwnership(guild, voiceChannelId, newOwnerId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const previousOwnerId = channelData.ownerId;
  channelData.ownerId = newOwnerId;

  channelData.whitelist = (channelData.whitelist || []).filter((id) => id !== newOwnerId);
  channelData.blacklist = (channelData.blacklist || []).filter((id) => id !== newOwnerId);

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);
  saveTempChannel(guild.id, voiceChannelId, channelData);

  persistOwnerProfile(guild.id, channelData);

  if (previousOwnerId && previousOwnerId !== newOwnerId) {
    saveUserProfile(guild.id, previousOwnerId, {
      name: channelData.name,
      userLimit: channelData.userLimit,
      isPrivate: channelData.isPrivate,
      whitelist: channelData.whitelist || [],
      blacklist: channelData.blacklist || []
    });
  }

  await applyPermissions(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);
  return true;
}

async function addToList(guild, voiceChannelId, listName, userIds) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const validUserIds = filterValidMemberIds(guild, userIds);
  const otherList = listName === "whitelist" ? "blacklist" : "whitelist";

  for (const userId of validUserIds) {
    if (userId === channelData.ownerId) continue;

    channelData[listName] = dedupeList([...(channelData[listName] || []), userId]);
    channelData[otherList] = (channelData[otherList] || []).filter((id) => id !== userId);
  }

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);
  saveTempChannel(guild.id, voiceChannelId, channelData);
  persistOwnerProfile(guild.id, channelData);

  await applyPermissions(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);

  return channelData;
}

async function removeFromList(guild, voiceChannelId, listName, userIds) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  channelData[listName] = (channelData[listName] || []).filter(
    (id) => !userIds.includes(id)
  );

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);
  saveTempChannel(guild.id, voiceChannelId, channelData);
  persistOwnerProfile(guild.id, channelData);

  await applyPermissions(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);

  return true;
}

async function deleteTempChannelSet(guild, voiceChannelId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);

  try {
    if (voiceChannel) {
      await voiceChannel.delete("Temp-Voice wird gelöscht");
    }
  } catch (error) {
    console.error("Voicechannel konnte nicht gelöscht werden:", error);
  }

  deleteTempChannel(guild.id, voiceChannelId);
  return true;
}

module.exports = {
  createTempChannel,
  updatePanel,
  applyPermissions,
  setPrivacy,
  renameChannel,
  setUserLimit,
  transferOwnership,
  addToList,
  removeFromList,
  deleteTempChannelSet,
  persistOwnerProfile
};