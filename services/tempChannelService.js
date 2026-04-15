const {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  OverwriteType
} = require("discord.js");

const settings = require("../config/settings");
const {
  saveTempChannel,
  getTempChannel,
  deleteTempChannel,
  getUserProfile,
  saveUserProfile,
  findGuildSetupById
} = require("../utils/store");
const {
  buildMainPanelComponents
} = require("../ui/panel");

/**
 * Baut einen sinnvollen Default-Namen für neue Talks.
 */
function createDisplayName(member) {
  return `${member.displayName}'s ${settings.defaultChannelName}`;
}

/**
 * Entfernt doppelte Einträge aus einer Liste.
 */
function dedupeList(arr) {
  return [...new Set(arr)];
}

/**
 * Sorgt dafür, dass White-/Blacklist konsistent bleiben.
 */
function normalizeLists(channelData) {
  channelData.whitelist = dedupeList((channelData.whitelist || []).filter(Boolean));
  channelData.blacklist = dedupeList((channelData.blacklist || []).filter(Boolean));

  // Ein User darf nicht gleichzeitig auf Whitelist und Blacklist sein.
  channelData.whitelist = channelData.whitelist.filter(
    (id) => !channelData.blacklist.includes(id)
  );

  // Owner nie in White-/Blacklist.
  channelData.whitelist = channelData.whitelist.filter((id) => id !== channelData.ownerId);
  channelData.blacklist = channelData.blacklist.filter((id) => id !== channelData.ownerId);
}

/**
 * Entfernt ungültige IDs, also User die nicht mehr im Guild-Cache gefunden werden.
 */
function filterValidMemberIds(guild, userIds) {
  return (userIds || []).filter((id) => guild.members.cache.has(id));
}

/**
 * Standard-Profil für User, die noch nie einen Temp-Voice erstellt haben.
 */
function getDefaultProfile(member) {
  return {
    name: `${settings.voicePrefix} ${createDisplayName(member)}`,
    userLimit: settings.defaultUserLimit,
    isPrivate: false,
    whitelist: [],
    blacklist: []
  };
}

/**
 * Extrahiert aus einem laufenden Temp-Channel wieder ein persönliches User-Profil.
 */
function serializeProfileFromChannel(channelData) {
  return {
    name: channelData.name,
    userLimit: channelData.userLimit,
    isPrivate: channelData.isPrivate,
    whitelist: channelData.whitelist || [],
    blacklist: channelData.blacklist || []
  };
}

/**
 * Speichert das Profil nur dann zurück, wenn der Channel noch an ein echtes User-Profil gebunden ist.
 *
 * Wichtig:
 * - Solange der ursprüngliche Ersteller Owner ist -> Änderungen landen im persönlichen Profil
 * - Nach Ownership-Transfer -> profileUserId = null -> Änderungen gelten nur noch talk-lokal
 */
function maybePersistProfile(channelData, guildId) {
  if (!channelData.profileUserId) return;

  saveUserProfile(
    guildId,
    channelData.profileUserId,
    serializeProfileFromChannel(channelData)
  );
}

/**
 * Kopiert die Permission-Overwrites aus der Ursprungs-Kategorie.
 *
 * Ziel:
 * - Talk landet in "Talks Open"
 * - aber Sichtbarkeit / Rollenrechte bleiben wie im Ursprungsbereich
 */
function cloneSourceCategoryOverwrites(sourceCategory) {
  if (!sourceCategory) return [];

  return [...sourceCategory.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield,
    type: overwrite.type
  }));
}

/**
 * Fügt/überschreibt ein Overwrite in einer Liste.
 * So können wir Source-Category-Rechte übernehmen und danach Bot-/Owner-Rechte gezielt darüberlegen.
 */
function upsertOverwrite(overwrites, newOverwrite) {
  const index = overwrites.findIndex((entry) => entry.id === newOverwrite.id);

  if (index === -1) {
    overwrites.push(newOverwrite);
    return;
  }

  overwrites[index] = {
    ...overwrites[index],
    ...newOverwrite
  };
}

/**
 * Baut die finalen Channel-Permissions:
 * - Basis aus Source-Category
 * - danach Bot
 * - danach Owner
 * - danach White-/Blacklist
 */
function buildChannelOverwrites(guild, channelData, sourceCategory) {
  const botMember = guild.members.me;
  const overwrites = cloneSourceCategoryOverwrites(sourceCategory);

  // Bot immer explizit freischalten, damit Kategorienwechsel / Moves / Panel sicher funktionieren.
  upsertOverwrite(overwrites, {
    id: botMember.id,
    type: OverwriteType.Member,
    allow:
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.Connect |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.MoveMembers |
      PermissionFlagsBits.ManageChannels,
    deny: 0n
  });

  // Owner bekommt volle Steuerung über den Talk.
  upsertOverwrite(overwrites, {
    id: channelData.ownerId,
    type: OverwriteType.Member,
    allow:
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.Connect |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.ManageChannels,
    deny: 0n
  });

  // Whitelist-User dürfen joinen/sehen.
  for (const userId of channelData.whitelist) {
    upsertOverwrite(overwrites, {
      id: userId,
      type: OverwriteType.Member,
      allow:
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.Connect |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.ReadMessageHistory,
      deny: 0n
    });
  }

  // Blacklist-User werden explizit ausgesperrt.
  for (const userId of channelData.blacklist) {
    upsertOverwrite(overwrites, {
      id: userId,
      type: OverwriteType.Member,
      allow: 0n,
      deny:
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.Connect |
        PermissionFlagsBits.SendMessages
    });
  }

  // Wenn der Talk "private" ist, sperren wir @everyone zusätzlich vom Connect aus.
  if (channelData.isPrivate) {
    upsertOverwrite(overwrites, {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: PermissionFlagsBits.Connect
    });
  } else {
    // Für offene Talks soll @everyone connecten dürfen,
    // falls die Source-Kategorie es nicht ohnehin strenger vorgibt.
    const everyoneIndex = overwrites.findIndex((entry) => entry.id === guild.roles.everyone.id);
    if (everyoneIndex !== -1) {
      const current = overwrites[everyoneIndex];
      current.allow = BigInt(current.allow || 0) | BigInt(PermissionFlagsBits.Connect);
      current.deny = BigInt(current.deny || 0) & ~BigInt(PermissionFlagsBits.Connect);
    } else {
      overwrites.push({
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        allow: PermissionFlagsBits.Connect,
        deny: 0n
      });
    }
  }

  return overwrites;
}

/**
 * Prüft, ob der Talk "voll" ist.
 */
function isChannelFull(voiceChannel, channelData) {
  if (!voiceChannel) return false;
  if (!channelData.userLimit || channelData.userLimit <= 0) return false;

  return voiceChannel.members.size >= channelData.userLimit;
}

/**
 * Verschiebt einen bestehenden Talk zwischen "Open" und "Closed".
 *
 * Wichtig:
 * - derselbe Channel bleibt erhalten
 * - User bleiben drin
 * - es wird nichts neu erstellt
 */
async function ensureChannelPlacement(guild, voiceChannelId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const setup = findGuildSetupById(guild.id, channelData.setupId);
  if (!setup) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  const shouldBeClosed =
    setup.closedCategoryId &&
    setup.closedCategoryId !== setup.openCategoryId &&
    isChannelFull(voiceChannel, channelData);

  const targetCategoryId = shouldBeClosed
    ? setup.closedCategoryId
    : setup.openCategoryId;

  if (!targetCategoryId) return false;
  if (voiceChannel.parentId === targetCategoryId) return false;

  await voiceChannel.setParent(targetCategoryId, {
    lockPermissions: false
  });

  return true;
}

/**
 * Erstellt einen neuen Temp-Voice.
 *
 * Flow:
 * 1. Setup finden
 * 2. Source-Category bestimmen
 * 3. User-Profil laden
 * 4. Talk in Open-Category erstellen
 * 5. Rechte aus Source-Category übernehmen
 */
async function createTempChannel(member, joinChannel, setup) {
  const guild = member.guild;
  const botMember = guild.members.me;

  if (!setup?.openCategoryId) {
    throw new Error("Für dieses Setup ist keine Open-Kategorie konfiguriert.");
  }

  if (!botMember) {
    throw new Error("Bot-Mitglied konnte in dieser Guild nicht gefunden werden.");
  }

  const openCategory = guild.channels.cache.get(setup.openCategoryId);
  if (!openCategory) {
    throw new Error(`Die Open-Kategorie ${setup.openCategoryId} wurde nicht gefunden.`);
  }

  // Ursprungs-Kategorie = der Bereich, aus dem die Rechte übernommen werden.
  const sourceCategoryId = setup.sourceCategoryId || joinChannel.parentId;
  const sourceCategory = sourceCategoryId
    ? guild.channels.cache.get(sourceCategoryId)
    : null;

  try {
    await guild.members.fetch();
  } catch (error) {
    console.warn("Guild members konnten nicht vollständig geladen werden:", error.message);
  }

  const savedProfile = getUserProfile(guild.id, member.id) || getDefaultProfile(member);

  const channelData = {
    ownerId: member.id,
    originalOwnerId: member.id,
    profileUserId: member.id,
    setupId: setup.setupId,
    sourceCategoryId: sourceCategoryId || null,
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

  const voiceOverwrites = buildChannelOverwrites(guild, channelData, sourceCategory);

  const voiceChannel = await guild.channels.create({
    name: channelData.name,
    type: ChannelType.GuildVoice,
    parent: setup.openCategoryId,
    userLimit: channelData.userLimit,
    permissionOverwrites: voiceOverwrites
  });

  channelData.voiceChannelId = voiceChannel.id;

  const panelMessage = await voiceChannel.send({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    components: buildMainPanelComponents(channelData)
  });

  channelData.panelMessageId = panelMessage.id;

  saveTempChannel(guild.id, voiceChannel.id, channelData);
  maybePersistProfile(channelData, guild.id);

  try {
    await member.voice.setChannel(voiceChannel);
  } catch (error) {
    console.error("[TempVoice] User konnte nicht in den neuen Temp-Channel verschoben werden.", error);

    try {
      await voiceChannel.send({
        content:
          "❌ Ich konnte dich nicht in den neuen Temp-Channel verschieben.\n" +
          "Bitte prüfe, ob ich die Berechtigung **„Mitglieder verschieben“** habe.",
        flags: MessageFlags.SuppressNotifications
      });
    } catch (sendError) {
      console.error("Konnte Fehlermeldung im Voice-Chat nicht senden:", sendError);
    }

    throw error;
  }

  // Falls der Talk direkt beim Erstellen voll wäre (z. B. Limit 1), korrekt einsortieren.
  await ensureChannelPlacement(guild, voiceChannel.id);

  return channelData;
}

/**
 * Aktualisiert das Panel im Voice-Textchat.
 */
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

/**
 * Rechnet die Rechte eines bestehenden Talks neu.
 * Wird z. B. nach Privacy-/Owner-/Whitelist-/Blacklist-Änderungen aufgerufen.
 */
async function applyPermissions(guild, voiceChannelId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return;

  const sourceCategory = channelData.sourceCategoryId
    ? guild.channels.cache.get(channelData.sourceCategoryId)
    : null;

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);
  saveTempChannel(guild.id, voiceChannelId, channelData);

  const overwrites = buildChannelOverwrites(guild, channelData, sourceCategory);
  await voiceChannel.permissionOverwrites.set(overwrites);
}

/**
 * Atomisches Update für Channel-Einstellungen.
 *
 * Vorteil:
 * - statt 3 einzelner Service-Calls nur 1
 * - weniger Race Conditions
 * - weniger Panel-/Permission-Refreshes
 */
async function updateChannelSettings(guild, voiceChannelId, updates) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  const nameChanged =
    typeof updates.name === "string" &&
    updates.name.trim().length > 0 &&
    `${settings.voicePrefix} ${updates.name.trim().slice(0, 90)}` !== channelData.name;

  if (nameChanged) {
    channelData.name = `${settings.voicePrefix} ${updates.name.trim().slice(0, 90)}`;
  }

  if (typeof updates.userLimit === "number") {
    channelData.userLimit = updates.userLimit;
  }

  if (typeof updates.isPrivate === "boolean") {
    channelData.isPrivate = updates.isPrivate;
  }

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);

  if (nameChanged) {
    await voiceChannel.setName(channelData.name);
  }

  if (typeof updates.userLimit === "number") {
    await voiceChannel.setUserLimit(channelData.userLimit);
  }

  saveTempChannel(guild.id, voiceChannelId, channelData);
  maybePersistProfile(channelData, guild.id);

  await applyPermissions(guild, voiceChannelId);
  await ensureChannelPlacement(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);

  return true;
}

/**
 * Setzt Privacy.
 */
async function setPrivacy(guild, voiceChannelId, isPrivate) {
  return updateChannelSettings(guild, voiceChannelId, { isPrivate });
}

/**
 * Setzt den Talknamen.
 */
async function renameChannel(guild, voiceChannelId, newName) {
  return updateChannelSettings(guild, voiceChannelId, { name: newName });
}

/**
 * Setzt das User-Limit.
 */
async function setUserLimit(guild, voiceChannelId, limit) {
  return updateChannelSettings(guild, voiceChannelId, { userLimit: limit });
}

/**
 * Ownership-Transfer.
 *
 * Wichtig:
 * - profileUserId wird gelöst
 * - ab jetzt sind Änderungen nur noch für diesen einen laufenden Talk gültig
 * - das persönliche Profil des neuen Owners bleibt unangetastet
 */
async function transferOwnership(guild, voiceChannelId, newOwnerId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  channelData.ownerId = newOwnerId;

  channelData.whitelist = (channelData.whitelist || []).filter((id) => id !== newOwnerId);
  channelData.blacklist = (channelData.blacklist || []).filter((id) => id !== newOwnerId);

  // Nach Ownership-Wechsel keine Profilbindung mehr.
  channelData.profileUserId = null;

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);

  saveTempChannel(guild.id, voiceChannelId, channelData);

  await applyPermissions(guild, voiceChannelId);
  await ensureChannelPlacement(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);

  return true;
}

/**
 * Fügt User zu White-/Blacklist hinzu.
 */
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
  maybePersistProfile(channelData, guild.id);

  await applyPermissions(guild, voiceChannelId);
  await ensureChannelPlacement(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);

  return channelData;
}

/**
 * Entfernt User aus White-/Blacklist.
 */
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
  maybePersistProfile(channelData, guild.id);

  await applyPermissions(guild, voiceChannelId);
  await ensureChannelPlacement(guild, voiceChannelId);
  await updatePanel(guild, voiceChannelId);

  return true;
}

/**
 * Löscht einen Temp-Channel vollständig.
 */
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
  ensureChannelPlacement,
  updateChannelSettings,
  setPrivacy,
  renameChannel,
  setUserLimit,
  transferOwnership,
  addToList,
  removeFromList,
  deleteTempChannelSet
};