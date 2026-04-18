const fs = require("fs");
const path = require("path");

/**
 * Zentrale JSON-Datei für persistente Bot-Daten.
 *
 * Struktur grob:
 * {
 *   guilds: {
 *     [guildId]: {
 *       config: { setups: [...] },
 *       channels: { ...laufende TempVoices... },
 *       profiles: {
 *         [userId]: {
 *           global?: {...altes Profil/Fallback...},
 *           scoped?: {
 *             [profileScopeKey]: {...profil für bestimmtes Setup...}
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 */
const DATA_FILE = path.join(__dirname, "..", "data", "tempChannels.json");

/**
 * Stellt sicher, dass die JSON-Datei existiert.
 */
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ guilds: {} }, null, 2),
      "utf8"
    );
  }
}

/**
 * Liest den kompletten Store.
 */
function readStore() {
  ensureDataFile();

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    if (!parsed.guilds || typeof parsed.guilds !== "object") {
      parsed.guilds = {};
    }

    return parsed;
  } catch (error) {
    console.error("Fehler beim Lesen des Stores:", error);
    return { guilds: {} };
  }
}

/**
 * Schreibt den kompletten Store zurück.
 */
function writeStore(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Migriert alte Configs auf die neue Setup-Struktur.
 */
function migrateLegacyConfig(config) {
  if (!config || typeof config !== "object") {
    return { setups: [] };
  }

  if (Array.isArray(config.setups)) {
    return config;
  }

  const migrated = { setups: [] };

  if (config.joinToCreateChannelId && config.tempCategoryId) {
    migrated.setups.push({
      setupId: "default",
      name: "Default Setup",
      joinToCreateChannelId: config.joinToCreateChannelId,
      sourceCategoryId: null,
      openCategoryId: config.tempCategoryId,
      closedCategoryId: config.tempCategoryId
    });
  }

  return migrated;
}

/**
 * Migriert alte User-Profile auf die neue Struktur.
 *
 * Alt:
 * profiles[userId] = {
 *   name,
 *   userLimit,
 *   isPrivate,
 *   whitelist,
 *   blacklist
 * }
 *
 * Neu:
 * profiles[userId] = {
 *   global: { ... },
 *   scoped: { ... }
 * }
 */
function migrateLegacyUserProfile(profileValue) {
  if (!profileValue || typeof profileValue !== "object") {
    return {
      global: null,
      scoped: {}
    };
  }

  // Neue Struktur bereits vorhanden
  if (
    Object.prototype.hasOwnProperty.call(profileValue, "global") ||
    Object.prototype.hasOwnProperty.call(profileValue, "scoped")
  ) {
    return {
      global:
        profileValue.global && typeof profileValue.global === "object"
          ? profileValue.global
          : null,
      scoped:
        profileValue.scoped && typeof profileValue.scoped === "object"
          ? profileValue.scoped
          : {}
    };
  }

  // Alte Struktur -> in global verschieben
  return {
    global: profileValue,
    scoped: {}
  };
}

/**
 * Stellt sicher, dass eine Guild-Struktur im Store existiert.
 */
function ensureGuild(store, guildId) {
  if (!store.guilds[guildId]) {
    store.guilds[guildId] = {
      config: {
        setups: []
      },
      channels: {},
      profiles: {}
    };
  }

  store.guilds[guildId].config = migrateLegacyConfig(store.guilds[guildId].config);

  if (!store.guilds[guildId].channels || typeof store.guilds[guildId].channels !== "object") {
    store.guilds[guildId].channels = {};
  }

  if (!store.guilds[guildId].profiles || typeof store.guilds[guildId].profiles !== "object") {
    store.guilds[guildId].profiles = {};
  }

  // Bestehende Profile in neue Struktur migrieren
  for (const [userId, profileValue] of Object.entries(store.guilds[guildId].profiles)) {
    store.guilds[guildId].profiles[userId] = migrateLegacyUserProfile(profileValue);
  }
}

/**
 * Gibt die komplette Guild-Struktur zurück.
 */
function getGuildData(guildId) {
  const store = readStore();
  ensureGuild(store, guildId);
  writeStore(store);
  return store.guilds[guildId];
}

/**
 * Gibt nur die Config einer Guild zurück.
 */
function getGuildConfig(guildId) {
  const store = readStore();
  ensureGuild(store, guildId);
  return store.guilds[guildId].config;
}

/**
 * Speichert eine komplette Guild-Config.
 */
function saveGuildConfig(guildId, config) {
  const store = readStore();
  ensureGuild(store, guildId);

  const currentConfig = migrateLegacyConfig(store.guilds[guildId].config);

  store.guilds[guildId].config = {
    ...currentConfig,
    ...config,
    setups: Array.isArray(config.setups)
      ? config.setups
      : currentConfig.setups
  };

  writeStore(store);
  return store.guilds[guildId].config;
}

/**
 * Gibt alle Setups einer Guild zurück.
 */
function getGuildSetups(guildId) {
  const config = getGuildConfig(guildId);
  return config.setups || [];
}

/**
 * Fügt ein neues Setup hinzu.
 */
function addGuildSetup(guildId, setup) {
  const store = readStore();
  ensureGuild(store, guildId);

  const setups = store.guilds[guildId].config.setups || [];
  setups.push(setup);
  store.guilds[guildId].config.setups = setups;

  writeStore(store);
  return setup;
}

/**
 * Entfernt ein Setup anhand der setupId.
 */
function removeGuildSetup(guildId, setupId) {
  const store = readStore();
  ensureGuild(store, guildId);

  const setups = store.guilds[guildId].config.setups || [];
  const index = setups.findIndex((setup) => setup.setupId === setupId);

  if (index === -1) {
    return null;
  }

  const removed = setups[index];
  store.guilds[guildId].config.setups.splice(index, 1);

  writeStore(store);
  return removed;
}

/**
 * Aktualisiert ein bestehendes Setup teilweise.
 */
function updateGuildSetup(guildId, setupId, updates) {
  const store = readStore();
  ensureGuild(store, guildId);

  const setups = store.guilds[guildId].config.setups || [];
  const index = setups.findIndex((setup) => setup.setupId === setupId);

  if (index === -1) {
    return null;
  }

  const updatedSetup = {
    ...setups[index],
    ...updates
  };

  store.guilds[guildId].config.setups[index] = updatedSetup;
  writeStore(store);

  return updatedSetup;
}

/**
 * Findet das passende Setup zu einem Join-to-Create-Channel.
 */
function findGuildSetupByJoinChannel(guildId, joinChannelId) {
  const setups = getGuildSetups(guildId);
  return setups.find((setup) => setup.joinToCreateChannelId === joinChannelId) || null;
}

/**
 * Findet ein Setup per setupId.
 */
function findGuildSetupById(guildId, setupId) {
  const setups = getGuildSetups(guildId);
  return setups.find((setup) => setup.setupId === setupId) || null;
}

/**
 * Gibt Daten eines aktiven Temp-Channels zurück.
 */
function getTempChannel(guildId, voiceChannelId) {
  const store = readStore();
  ensureGuild(store, guildId);
  return store.guilds[guildId].channels[voiceChannelId] || null;
}

/**
 * Speichert Daten eines aktiven Temp-Channels.
 */
function saveTempChannel(guildId, voiceChannelId, data) {
  const store = readStore();
  ensureGuild(store, guildId);
  store.guilds[guildId].channels[voiceChannelId] = data;
  writeStore(store);
}

/**
 * Entfernt einen aktiven Temp-Channel aus dem Store.
 */
function deleteTempChannel(guildId, voiceChannelId) {
  const store = readStore();
  ensureGuild(store, guildId);
  delete store.guilds[guildId].channels[voiceChannelId];
  writeStore(store);
}

/**
 * Findet den aktuell von einem User geowneten Temp-Channel.
 */
function findOwnedChannelByUser(guildId, userId) {
  const store = readStore();
  ensureGuild(store, guildId);

  for (const [voiceChannelId, data] of Object.entries(store.guilds[guildId].channels)) {
    if (data.ownerId === userId) {
      return {
        voiceChannelId,
        data
      };
    }
  }

  return null;
}

/**
 * Gibt den Profil-Scope-Key zurück.
 *
 * Der Scope basiert auf setupId, weil Setups in deinem Bot die beste
 * Zuordnung zu "pro Kategorie / Bereich" sind.
 */
function normalizeProfileScopeKey(profileScopeKey) {
  if (!profileScopeKey || typeof profileScopeKey !== "string") {
    return null;
  }

  return profileScopeKey.trim() || null;
}

/**
 * Lädt das persönliche User-Profil.
 *
 * Verhalten:
 * - Wenn profileScopeKey gesetzt ist, wird zuerst scoped[profileScopeKey] gesucht
 * - Falls nicht vorhanden, wird auf global zurückgefallen
 * - Ohne Scope wird direkt global geladen
 */
function getUserProfile(guildId, userId, profileScopeKey = null) {
  const store = readStore();
  ensureGuild(store, guildId);

  const normalizedScopeKey = normalizeProfileScopeKey(profileScopeKey);
  const profileContainer = store.guilds[guildId].profiles[userId];

  if (!profileContainer) {
    return null;
  }

  const migratedProfileContainer = migrateLegacyUserProfile(profileContainer);

  if (normalizedScopeKey) {
    return migratedProfileContainer.scoped[normalizedScopeKey] || migratedProfileContainer.global || null;
  }

  return migratedProfileContainer.global || null;
}

/**
 * Speichert das persönliche User-Profil.
 *
 * Verhalten:
 * - Mit profileScopeKey -> scoped speichern
 * - Ohne profileScopeKey -> global speichern
 */
function saveUserProfile(guildId, userId, profile, profileScopeKey = null) {
  const store = readStore();
  ensureGuild(store, guildId);

  const normalizedScopeKey = normalizeProfileScopeKey(profileScopeKey);
  const currentContainer = migrateLegacyUserProfile(store.guilds[guildId].profiles[userId]);

  if (normalizedScopeKey) {
    currentContainer.scoped[normalizedScopeKey] = profile;
  } else {
    currentContainer.global = profile;
  }

  store.guilds[guildId].profiles[userId] = currentContainer;
  writeStore(store);
}

/**
 * Entfernt ein User-Profil.
 *
 * Verhalten:
 * - Mit profileScopeKey -> nur dieses scoped Profil löschen
 * - Ohne profileScopeKey -> gesamtes Profil des Users löschen
 */
function deleteUserProfile(guildId, userId, profileScopeKey = null) {
  const store = readStore();
  ensureGuild(store, guildId);

  const normalizedScopeKey = normalizeProfileScopeKey(profileScopeKey);

  if (!store.guilds[guildId].profiles[userId]) {
    return;
  }

  if (!normalizedScopeKey) {
    delete store.guilds[guildId].profiles[userId];
    writeStore(store);
    return;
  }

  const currentContainer = migrateLegacyUserProfile(store.guilds[guildId].profiles[userId]);
  delete currentContainer.scoped[normalizedScopeKey];

  const hasGlobal = !!currentContainer.global;
  const hasScoped = Object.keys(currentContainer.scoped).length > 0;

  if (!hasGlobal && !hasScoped) {
    delete store.guilds[guildId].profiles[userId];
  } else {
    store.guilds[guildId].profiles[userId] = currentContainer;
  }

  writeStore(store);
}

module.exports = {
  readStore,
  writeStore,
  getGuildData,
  getGuildConfig,
  saveGuildConfig,
  getGuildSetups,
  addGuildSetup,
  removeGuildSetup,
  updateGuildSetup,
  findGuildSetupByJoinChannel,
  findGuildSetupById,
  getTempChannel,
  saveTempChannel,
  deleteTempChannel,
  findOwnedChannelByUser,
  getUserProfile,
  saveUserProfile,
  deleteUserProfile
};