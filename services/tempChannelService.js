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
 * Baut einen sprechenden Default-Namen für einen User.
 *
 * Beispiel:
 * "Peter" -> "Peter's Talk"
 */
function createDisplayName(member) {
  return `${member.displayName}'s ${settings.defaultChannelName}`;
}

/**
 * Stellt sicher, dass der sichtbare Channelname immer den Voice-Prefix trägt.
 *
 * Beispiel:
 * "Peter's Talk" -> "🔊 Peter's Talk"
 */
function withVoicePrefix(name) {
  return `${settings.voicePrefix} ${String(name || "").trim()}`.trim();
}

/**
 * Entfernt einen vorhandenen Prefix am Anfang.
 *
 * Das ist nützlich, wenn aus einem gespeicherten Kanalnamen wieder
 * ein "roher" Name extrahiert werden soll.
 */
function stripVoicePrefix(name) {
  const escapedPrefix = settings.voicePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(name || "").replace(new RegExp(`^${escapedPrefix}\\s*`), "").trim();
}

/**
 * Normalisiert einen Benutzernamen-Eingabewert aus dem Edit-Modal.
 *
 * Die Funktion sorgt dafür:
 * - dass der Prefix korrekt gesetzt wird
 * - dass der Name nicht zu lang wird
 */
function normalizeStoredChannelNameFromInput(rawName) {
  const clean = String(rawName || "").trim().slice(0, 90);
  return withVoicePrefix(clean);
}

/**
 * Gibt das Standardprofil zurück, falls ein User noch kein eigenes Profil besitzt.
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
 * Serialisiert einen laufenden Temp-Talk zurück in ein persönliches User-Profil.
 *
 * Wichtiger Punkt:
 * - Nur der "profilgebundene" Owner speichert Änderungen in sein Profil zurück
 * - Nach Ownership-Transfer ist profileUserId = null und es wird nichts gespeichert
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
 * Speichert das persönliche Profil nur dann zurück,
 * wenn der laufende Channel noch an ein echtes User-Profil gebunden ist.
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
 * Ermittelt den Namen, den ein Channel beim Owner-Wechsel bekommen soll.
 *
 * Priorität:
 * 1. Profilname des neuen Owners (falls vorhanden)
 * 2. sinnvoller Default aus displayName
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
 * ALLGEMEINE LISTEN- / MEMBER-HILFSFUNKTIONEN
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
 * - keine doppelten Einträge
 * - keine ungültigen Werte
 * - niemand gleichzeitig auf White- und Blacklist
 * - Owner nie auf White-/Blacklist
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
 * Entfernt IDs, die im Guild-Cache nicht (mehr) als Member vorhanden sind.
 */
function filterValidMemberIds(guild, userIds) {
  return (userIds || []).filter((id) => guild.members.cache.has(id));
}

/**
 * Gibt alle aktuell aktiven, nicht-bot User-IDs in einem Voicechannel zurück.
 *
 * Diese Liste nutzen wir für Punkt 3:
 * Nur aktive Voice-Mitglieder sollen den Textchat lesen/schreiben dürfen.
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
 * Kopiert die Permission-Overwrites der Source-Kategorie.
 *
 * Das ist die Basis für:
 * - Rollensichtbarkeit
 * - spezielle Rollenrechte
 * - private Serverstrukturen
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
 * Fügt ein Overwrite in eine Liste ein oder überschreibt ein bestehendes.
 *
 * Vorteil:
 * - wir können zuerst die Source-Rechte übernehmen
 * - und danach einzelne Ziel-Overwrites gezielt anpassen
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
 * Gibt das Everyone-Overwrite der Source-Kategorie zurück, falls vorhanden.
 */
function getSourceEveryoneOverwrite(sourceCategory, guild) {
  if (!sourceCategory) return null;
  return sourceCategory.permissionOverwrites.cache.get(guild.roles.everyone.id) || null;
}

/**
 * Baut ein "sauberes" Basis-Overwrite für @everyone.
 *
 * Ziel:
 * - Sichtbarkeit aus der Source-Kategorie möglichst sauber erhalten
 * - fremde Rechte aus der Zielkategorie nicht ungewollt erben
 * - Textchat standardmässig sperren
 *
 * Verhalten:
 * - ViewChannel: wird aus Source-@everyone abgeleitet
 * - Connect: im Open-Modus aus Source-@everyone, im Private-Modus explizit denied
 * - SendMessages/ReadMessageHistory: standardmässig denied
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

  // Textchat soll standardmässig NICHT für alle zugänglich sein.
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
 * Entfernt Textchat-Rechte von Rollen und passt ggf. Connect für Private an.
 *
 * Das ist wichtig für zwei Ziele:
 *
 * 1. Nur aktive User im Voice sollen den Textchat lesen/schreiben können
 * 2. Private Talks sollen NICHT plötzlich wegen Rollenrechten wieder offen joinbar sein
 */
function sanitizeRoleOverwriteForTempVoice(roleOverwrite, guild, isPrivate) {
  const updated = {
    ...roleOverwrite,
    allow: BigInt(roleOverwrite.allow || 0n),
    deny: BigInt(roleOverwrite.deny || 0n)
  };

  // Voice-Textchat für Rollen grundsätzlich abschalten.
  updated.allow &= ~BigInt(PermissionFlagsBits.SendMessages);
  updated.allow &= ~BigInt(PermissionFlagsBits.ReadMessageHistory);

  updated.deny |= BigInt(PermissionFlagsBits.SendMessages);
  updated.deny |= BigInt(PermissionFlagsBits.ReadMessageHistory);

  // Im Private-Modus sollen Rollen nicht einfach weiter connecten dürfen.
  if (isPrivate && updated.id !== guild.roles.everyone.id) {
    updated.allow &= ~BigInt(PermissionFlagsBits.Connect);
    updated.deny |= BigInt(PermissionFlagsBits.Connect);
  }

  return updated;
}

/**
 * Baut die finalen Overwrites für einen laufenden Temp-Talk.
 *
 * Zentrale Ziele:
 * - Sichtbarkeit / Rollenstruktur aus der Source-Kategorie erhalten
 * - Privacy darf Sichtbarkeit NICHT zerstören
 * - nur aktive Voice-Mitglieder lesen/schreiben im TempVoice-Textchat
 * - Owner / Bot / Whitelist / Blacklist werden korrekt berücksichtigt
 */
function buildChannelOverwrites(guild, channelData, sourceCategory, activeMemberIds = []) {
  const botMember = guild.members.me;
  const overwrites = cloneSourceCategoryOverwrites(sourceCategory);

  if (!botMember) {
    throw new Error("Bot-Mitglied konnte nicht gefunden werden.");
  }

  /**
   * 1) Everyone-Basis explizit setzen
   *
   * Damit verhindern wir, dass eine offene Zielkategorie (Talks Open)
   * plötzlich Sichtbarkeit oder Connect-Rechte "reinvererbt",
   * die in der Source-Kategorie gar nicht vorgesehen waren.
   */
  upsertOverwrite(
    overwrites,
    buildEveryoneBaselineOverwrite(guild, sourceCategory, channelData.isPrivate)
  );

  /**
   * 2) Alle Rollen-Overwrites so anpassen, dass:
   * - Textchat nicht für ganze Rollen offen bleibt
   * - Private nicht durch Rollenrechte wieder "aufgeht"
   */
  for (let i = 0; i < overwrites.length; i++) {
    if (overwrites[i].type === OverwriteType.Role) {
      overwrites[i] = sanitizeRoleOverwriteForTempVoice(
        overwrites[i],
        guild,
        channelData.isPrivate
      );
    }
  }

  /**
   * 3) Bot immer freischalten
   */
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

  /**
   * 4) Owner immer vollständig freischalten
   */
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

  /**
   * 5) Aktive Voice-Mitglieder dürfen den Textchat lesen/schreiben.
   *
   * Das ist die technische Umsetzung von Punkt 3.
   */
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

  /**
   * 6) Whitelist:
   * Diese User dürfen den Talk grundsätzlich sehen/joinen.
   * Textchat gibt es aber erst, wenn sie tatsächlich im Voice sind.
   */
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

  /**
   * 7) Blacklist:
   * Vollständig aussperren.
   */
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
 * Prüft, ob der Talk aktuell "voll" ist.
 */
function isChannelFull(voiceChannel, channelData) {
  if (!voiceChannel) return false;
  if (!channelData.userLimit || channelData.userLimit <= 0) return false;

  return voiceChannel.members.size >= channelData.userLimit;
}

/**
 * Aktualisiert die Position des Channels:
 * - offen -> openCategoryId
 * - voll  -> closedCategoryId
 *
 * Dabei bleibt es IMMER derselbe Channel.
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
 * CREATE / PANEL / PERMISSIONS
 * ------------------------------------------------------------
 */

/**
 * Erstellt einen neuen Temp-Voice-Channel.
 *
 * Ablauf:
 * 1. Setup prüfen
 * 2. Source-Kategorie bestimmen
 * 3. gespeichertes User-Profil laden
 * 4. Channel in Open-Kategorie erstellen
 * 5. Rechte auf Basis der Source-Kategorie anwenden
 * 6. Panel senden
 * 7. User verschieben
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

  // Falls sourceCategoryId nicht explizit im Setup steht,
  // verwenden wir die Parent-Kategorie des Join-Channels.
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

  // Zu Erstellungszeitpunkt ist nur der Ersteller aktiv im Channel.
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
 * Rechnet alle Overwrites eines bestehenden Temp-Talks neu.
 *
 * Diese Funktion ist der zentrale Punkt für:
 * - Privacy
 * - Owner-Wechsel
 * - White-/Blacklist
 * - aktiven Textchat-Zugriff
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
 * Komfortfunktion, damit der aktive Chat-Zugriff nach Join/Leave schnell
 * neu synchronisiert werden kann.
 *
 * Technisch macht sie aktuell dasselbe wie applyPermissions(),
 * aber der Name macht den Aufruf im VoiceState-Handler lesbarer.
 */
async function syncActiveChatAccess(guild, voiceChannelId) {
  await applyPermissions(guild, voiceChannelId);
}

/**
 * Atomisches Update für Name / Limit / Privacy.
 *
 * Vorteil:
 * - weniger Race Conditions
 * - weniger unnötige Einzelupdates
 * - sauberere Fehlerbehandlung
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
 * Setzt die Privacy.
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
 * Wichtige Regeln:
 * - der laufende Talk behält seine sonstigen Einstellungen
 * - profileUserId wird gelöst -> Änderungen gelten nur noch für diesen Talk
 * - der Channelname wird an den neuen Owner angepasst
 */
async function transferOwnership(guild, voiceChannelId, newOwnerId) {
  const channelData = getTempChannel(guild.id, voiceChannelId);
  if (!channelData) return false;

  const voiceChannel = guild.channels.cache.get(channelData.voiceChannelId);
  if (!voiceChannel) return false;

  channelData.ownerId = newOwnerId;

  channelData.whitelist = (channelData.whitelist || []).filter((id) => id !== newOwnerId);
  channelData.blacklist = (channelData.blacklist || []).filter((id) => id !== newOwnerId);

  // Nach Ownership-Wechsel keine Profilbindung mehr:
  // Der neue Owner soll NICHT versehentlich sein persönliches Profil überschreiben.
  channelData.profileUserId = null;

  // Nur der Name wird an den neuen Owner angepasst.
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
  await updatePanel(guild, voiceChannelId);

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