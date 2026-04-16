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
 * ------------------------------------------------------------
 * HILFSFUNKTIONEN FÜR NAMEN / PROFILE
 * ------------------------------------------------------------
 */

/**
 * Baut einen sinnvollen Standardnamen für einen User.
 * Beispiel:
 * Peter -> Peter's Talk
 */
function createDisplayName(member) {
  return `${member.displayName}'s ${settings.defaultChannelName}`;
}

/**
 * Setzt den globalen Voice-Prefix vor einen Namen.
 * Beispiel:
 * Peter's Talk -> 🔊 Peter's Talk
 */
function withVoicePrefix(name) {
  return `${settings.voicePrefix} ${String(name || "").trim()}`.trim();
}

/**
 * Entfernt den Prefix wieder vom Anfang eines Namens.
 * Das wird z. B. verwendet, um Edit-Werte sauber im Modal anzuzeigen.
 */
function stripVoicePrefix(name) {
  const escapedPrefix = settings.voicePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(name || "").replace(new RegExp(`^${escapedPrefix}\\s*`), "").trim();
}

/**
 * Normalisiert einen vom User eingegebenen Namen aus dem Edit-Modal.
 * - trimmt Leerzeichen
 * - begrenzt die Länge
 * - setzt den Voice-Prefix sauber davor
 */
function normalizeStoredChannelNameFromInput(rawName) {
  const clean = String(rawName || "").trim().slice(0, 90);
  return withVoicePrefix(clean);
}

/**
 * Gibt ein Standardprofil zurück, falls der User noch nie
 * einen TempVoice erstellt hat.
 */
function getDefaultProfile(member) {
  return {
    name: withVoicePrefix(createDisplayName(member)),
    userLimit: settings.defaultUserLimit,
    isPrivate: false,
    whitelist: [],
    blacklist: []
  };
}

/**
 * Wandelt laufende Talk-Daten wieder in ein User-Profil um.
 * Dieses Profil wird nur gespeichert, solange der Talk noch
 * an den ursprünglichen Owner gebunden ist.
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
 * Speichert Änderungen nur dann zurück ins persönliche User-Profil,
 * wenn der laufende Talk noch an profileUserId gebunden ist.
 *
 * Nach einem Ownership-Transfer ist profileUserId = null,
 * damit der neue Owner sein eigenes Profil nicht überschreibt.
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
 * Bestimmt, wie der Channel nach einem Owner-Wechsel heissen soll.
 *
 * Priorität:
 * 1. Profilname des neuen Owners
 * 2. generierter Standardname anhand displayName
 */
function resolveChannelNameForNewOwner(guild, newOwnerId) {
  const member = guild.members.cache.get(newOwnerId);
  if (!member) {
    return withVoicePrefix(`${settings.defaultChannelName}`);
  }

  const savedProfile = getUserProfile(guild.id, newOwnerId);
  if (savedProfile?.name) {
    return savedProfile.name;
  }

  return withVoicePrefix(createDisplayName(member));
}

/**
 * ------------------------------------------------------------
 * LISTEN / MEMBER-HILFSFUNKTIONEN
 * ------------------------------------------------------------
 */

/**
 * Entfernt doppelte Einträge aus einer Liste.
 */
function dedupeList(arr) {
  return [...new Set(arr)];
}

/**
 * Hält White-/Blacklist konsistent.
 *
 * Regeln:
 * - keine doppelten IDs
 * - keine leeren Werte
 * - niemand gleichzeitig auf White- und Blacklist
 * - Owner nie in White-/Blacklist
 */
function normalizeLists(channelData) {
  channelData.whitelist = dedupeList((channelData.whitelist || []).filter(Boolean));
  channelData.blacklist = dedupeList((channelData.blacklist || []).filter(Boolean));

  channelData.whitelist = channelData.whitelist.filter(
    (id) => !channelData.blacklist.includes(id)
  );

  channelData.whitelist = channelData.whitelist.filter((id) => id !== channelData.ownerId);
  channelData.blacklist = channelData.blacklist.filter((id) => id !== channelData.ownerId);
}

/**
 * Entfernt IDs, die nicht mehr als Guild-Member vorhanden sind.
 */
function filterValidMemberIds(guild, userIds) {
  return (userIds || []).filter((id) => guild.members.cache.has(id));
}

/**
 * Gibt die aktuell aktiven, nicht-bot Voice-Mitglieder zurück.
 * Diese User sollen den Textchat lesen/schreiben dürfen.
 */
function getActiveVoiceMemberIds(voiceChannel) {
  if (!voiceChannel) return [];

  return [...voiceChannel.members.values()]
    .filter((member) => !member.user.bot)
    .map((member) => member.id);
}

/**
 * ------------------------------------------------------------
 * PERMISSION-LOGIK
 * ------------------------------------------------------------
 */

/**
 * Kopiert die Overwrites der Source-Kategorie.
 * Diese bilden die Basis für Rollenrechte und Sichtbarkeit.
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
 * Fügt ein Overwrite neu ein oder überschreibt ein vorhandenes.
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
 * Holt das @everyone Overwrite der Source-Kategorie, falls vorhanden.
 */
function getSourceEveryoneOverwrite(sourceCategory, guild) {
  if (!sourceCategory) return null;
  return sourceCategory.permissionOverwrites.cache.get(guild.roles.everyone.id) || null;
}

/**
 * Baut ein gezieltes Baseline-Overwrite für @everyone.
 *
 * Ziel:
 * - Sichtbarkeit aus Source erhalten
 * - Connect bei Private sperren
 * - Textchat standardmässig nicht global sichtbar machen
 */
function buildEveryoneBaselineOverwrite(guild, sourceCategory, isPrivate) {
  const sourceEveryone = getSourceEveryoneOverwrite(sourceCategory, guild);

  let allow = 0n;
  let deny = 0n;

  const canEveryoneViewSource =
    sourceEveryone?.allow?.has(PermissionFlagsBits.ViewChannel) || false;

  const canEveryoneConnectSource =
    sourceEveryone?.allow?.has(PermissionFlagsBits.Connect) || false;

  if (canEveryoneViewSource) {
    allow |= BigInt(PermissionFlagsBits.ViewChannel);
  } else {
    deny |= BigInt(PermissionFlagsBits.ViewChannel);
  }

  if (isPrivate) {
    deny |= BigInt(PermissionFlagsBits.Connect);
  } else if (canEveryoneConnectSource) {
    allow |= BigInt(PermissionFlagsBits.Connect);
  } else {
    deny |= BigInt(PermissionFlagsBits.Connect);
  }

  deny |= BigInt(PermissionFlagsBits.SendMessages);
  deny |= BigInt(PermissionFlagsBits.ReadMessageHistory);

  return {
    id: guild.roles.everyone.id,
    type: OverwriteType.Role,
    allow,
    deny
  };
}

/**
 * Entfernt Textchat-Rechte aus Rollen-Overwrites.
 * Zusätzlich wird im Private-Modus Connect auf Rollenebene gesperrt,
 * damit der Talk nicht doch wieder ungewollt offen ist.
 */
function sanitizeRoleOverwriteForTempVoice(roleOverwrite, guild, isPrivate) {
  const updated = {
    ...roleOverwrite,
    allow: BigInt(roleOverwrite.allow || 0n),
    deny: BigInt(roleOverwrite.deny || 0n)
  };

  updated.allow &= ~BigInt(PermissionFlagsBits.SendMessages);
  updated.allow &= ~BigInt(PermissionFlagsBits.ReadMessageHistory);

  updated.deny |= BigInt(PermissionFlagsBits.SendMessages);
  updated.deny |= BigInt(PermissionFlagsBits.ReadMessageHistory);

  if (isPrivate && updated.id !== guild.roles.everyone.id) {
    updated.allow &= ~BigInt(PermissionFlagsBits.Connect);
    updated.deny |= BigInt(PermissionFlagsBits.Connect);
  }

  return updated;
}

/**
 * Baut die finalen Overwrites für den laufenden TempVoice.
 *
 * Ziele:
 * - Sichtbarkeit aus Source-Kategorie erhalten
 * - Private soll nur Connect sperren, nicht globale Sichtbarkeit erzeugen
 * - nur aktive Voice-Mitglieder sehen den Textchat
 * - Owner / Bot / White-/Blacklist korrekt berücksichtigen
 */
function buildChannelOverwrites(guild, channelData, sourceCategory, activeMemberIds = []) {
  const botMember = guild.members.me;
  const overwrites = cloneSourceCategoryOverwrites(sourceCategory);

  if (!botMember) {
    throw new Error("Bot-Mitglied konnte nicht gefunden werden.");
  }

  upsertOverwrite(
    overwrites,
    buildEveryoneBaselineOverwrite(guild, sourceCategory, channelData.isPrivate)
  );

  for (let i = 0; i < overwrites.length; i++) {
    if (overwrites[i].type === OverwriteType.Role) {
      overwrites[i] = sanitizeRoleOverwriteForTempVoice(
        overwrites[i],
        guild,
        channelData.isPrivate
      );
    }
  }

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

  for (const userId of activeMemberIds) {
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

  for (const userId of channelData.whitelist) {
    upsertOverwrite(overwrites, {
      id: userId,
      type: OverwriteType.Member,
      allow:
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.Connect,
      deny:
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.ReadMessageHistory
    });
  }

  for (const userId of channelData.blacklist) {
    upsertOverwrite(overwrites, {
      id: userId,
      type: OverwriteType.Member,
      allow: 0n,
      deny:
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.Connect |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.ReadMessageHistory
    });
  }

  return overwrites;
}

/**
 * Prüft, ob der Channel aktuell voll ist.
 */
function isChannelFull(voiceChannel, channelData) {
  if (!voiceChannel) return false;
  if (!channelData.userLimit || channelData.userLimit <= 0) return false;

  return voiceChannel.members.size >= channelData.userLimit;
}

/**
 * Verschiebt den bestehenden Talk je nach Füllstand zwischen
 * Open- und Closed-Kategorie.
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
 * ------------------------------------------------------------
 * PANEL-VERWALTUNG
 * ------------------------------------------------------------
 */

/**
 * Sendet ein komplett neues Panel in den Voice-Textchat
 * und speichert die neue panelMessageId.
 *
 * Optional kann versucht werden, das alte Panel zu löschen.
 *
 * Diese Funktion ist wichtig für Fälle wie:
 * - Owner-Wechsel
 * - altes Panel wurde gelöscht
 * - neuer Owner konnte die alte Nachricht nie zuverlässig sehen
 */
async function sendFreshPanelMessage(guild, voiceChannelId, deleteOldPanel = false) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return null;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return null;

  const oldPanelMessageId = channelData.panelMessageId;

  const newPanelMessage = await voiceChannel.send({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    components: buildMainPanelComponents(channelData)
  });

  channelData.panelMessageId = newPanelMessage.id;
  saveTempChannel(guild.id, voiceChannelId, channelData);

  if (deleteOldPanel && oldPanelMessageId && oldPanelMessageId !== newPanelMessage.id) {
    try {
      const oldMsg = await voiceChannel.messages.fetch(oldPanelMessageId);
      await oldMsg.delete().catch(() => {});
    } catch {
      // Ignorieren, falls die alte Nachricht bereits fehlt oder nicht löschbar ist
    }
  }

  return newPanelMessage;
}

/**
 * Aktualisiert das bestehende Panel.
 *
 * Falls die alte Panel-Nachricht nicht mehr existiert,
 * wird automatisch ein neues Panel erstellt.
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
    console.error("Panel konnte nicht aktualisiert werden, neues Panel wird erstellt:", error.message);
    await sendFreshPanelMessage(guild, voiceChannelId, false).catch(console.error);
  }
}

/**
 * ------------------------------------------------------------
 * CREATE / PERMISSIONS / SETTINGS
 * ------------------------------------------------------------
 */

/**
 * Erstellt einen neuen TempVoice.
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

  const activeMemberIds = [member.id];

  const voiceOverwrites = buildChannelOverwrites(
    guild,
    channelData,
    sourceCategory,
    activeMemberIds
  );

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

  await ensureChannelPlacement(guild, voiceChannel.id);
  return channelData;
}

/**
 * Rechnet die Channel-Rechte komplett neu.
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

  const activeMemberIds = getActiveVoiceMemberIds(voiceChannel);

  const overwrites = buildChannelOverwrites(
    guild,
    channelData,
    sourceCategory,
    activeMemberIds
  );

  await voiceChannel.permissionOverwrites.set(overwrites);
}

/**
 * Hilfsfunktion, um die Textchat-Sichtbarkeit für aktive Voice-Mitglieder
 * nach Join/Leave sofort neu zu berechnen.
 */
async function syncActiveChatAccess(guild, voiceChannelId) {
  await applyPermissions(guild, voiceChannelId);
}

/**
 * Führt mehrere Channel-Änderungen gesammelt in einem Update aus.
 */
async function updateChannelSettings(guild, voiceChannelId, updates) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  const nextName =
    typeof updates.name === "string" && updates.name.trim().length > 0
      ? normalizeStoredChannelNameFromInput(updates.name)
      : channelData.name;

  const nameChanged = nextName !== channelData.name;

  if (nameChanged) {
    channelData.name = nextName;
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
 * Setzt den Kanalnamen.
 */
async function renameChannel(guild, voiceChannelId, newName) {
  return updateChannelSettings(guild, voiceChannelId, { name: newName });
}

/**
 * Setzt das Userlimit.
 */
async function setUserLimit(guild, voiceChannelId, limit) {
  return updateChannelSettings(guild, voiceChannelId, { userLimit: limit });
}

/**
 * Überträgt Ownership an einen anderen aktiven User.
 *
 * Wichtige Zusätze:
 * - profileUserId wird gelöst
 * - Name wird an den neuen Owner angepasst
 * - es wird ein FRISCHES Panel erstellt, damit der neue Owner
 *   garantiert ein sichtbares Panel im Chat hat
 */
async function transferOwnership(guild, voiceChannelId, newOwnerId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  channelData.ownerId = newOwnerId;

  channelData.whitelist = (channelData.whitelist || []).filter((id) => id !== newOwnerId);
  channelData.blacklist = (channelData.blacklist || []).filter((id) => id !== newOwnerId);

  channelData.profileUserId = null;

  const newChannelName = resolveChannelNameForNewOwner(guild, newOwnerId);
  const nameChanged = newChannelName !== channelData.name;

  channelData.name = newChannelName;

  normalizeLists(channelData);
  channelData.whitelist = filterValidMemberIds(guild, channelData.whitelist);
  channelData.blacklist = filterValidMemberIds(guild, channelData.blacklist);

  saveTempChannel(guild.id, voiceChannelId, channelData);

  if (nameChanged) {
    await voiceChannel.setName(channelData.name);
  }

  await applyPermissions(guild, voiceChannelId);
  await ensureChannelPlacement(guild, voiceChannelId);

  /**
   * Sehr wichtig:
   * Statt nur das alte Panel zu editieren, senden wir beim Owner-Wechsel
   * ein frisches Panel und ersetzen die gespeicherte panelMessageId.
   *
   * Dadurch sieht der neue Owner das Panel zuverlässig.
   */
  await sendFreshPanelMessage(guild, voiceChannelId, true);

  return true;
}

/**
 * Fügt User zu White- oder Blacklist hinzu.
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
 * Entfernt User aus White- oder Blacklist.
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
 * Löscht einen TempVoice vollständig und entfernt ihn aus dem Store.
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
  syncActiveChatAccess,
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