const fs = require("fs");
const path = require("path");

/**
 * Zentrale JSON-Datei für persistente Bot-Daten.
 *
 * Wichtige Info:
 * - Diese Datei liegt im Projekt unter /data/tempChannels.json
 * - Wenn dein Hosting ein persistentes Volume auf /app/data mapped,
 *   bleibt der Inhalt auch nach Neustarts erhalten
 */
const DATA_FILE = path.join(__dirname, "..", "data", "tempChannels.json");

/**
 * Stellt sicher, dass die JSON-Datei überhaupt existiert.
 *
 * Falls die Datei beim ersten Start noch nicht vorhanden ist,
 * wird sie mit einer leeren Grundstruktur angelegt.
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
 * Liest den kompletten Store aus der JSON-Datei.
 *
 * Rückgabeformat:
 * {
 *   guilds: {
 *     [guildId]: {
 *       config: { setups: [...] },
 *       channels: { ... },
 *       profiles: { ... }
 *     }
 *   }
 * }
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
 * Schreibt den kompletten Store zurück in die JSON-Datei.
 *
 * Hinweis:
 * - Das ist eine "vollständige" Schreiboperation
 * - Es wird also nicht teilweise gepatcht, sondern das gesamte Objekt gespeichert
 */
function writeStore(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Migriert alte Configs auf die neue Struktur mit setups[].
 *
 * Alter Stand:
 * {
 *   joinToCreateChannelId,
 *   tempCategoryId
 * }
 *
 * Neuer Stand:
 * {
 *   setups: [
 *     {
 *       setupId,
 *       name,
 *       joinToCreateChannelId,
 *       sourceCategoryId,
 *       openCategoryId,
 *       closedCategoryId
 *     }
 *   ]
 * }
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
 * Stellt sicher, dass eine Guild-Struktur im Store existiert.
 *
 * Pro Guild speichern wir:
 * - config   -> Setups / allgemeine Konfiguration
 * - channels -> laufende Temp-Channels
 * - profiles -> persönliche User-Profile
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
 * Speichert die komplette Guild-Config.
 *
 * Wichtiger Punkt:
 * - vorhandene Felder bleiben erhalten
 * - setups werden nur überschrieben, wenn wirklich ein setups-Array übergeben wurde
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
 *
 * Beispiel:
 * updateGuildSetup(guildId, setupId, { openCategoryId: "123" })
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
 * Findet ein Setup anhand seiner setupId.
 */
function findGuildSetupById(guildId, setupId) {
  const setups = getGuildSetups(guildId);
  return setups.find((setup) => setup.setupId === setupId) || null;
}

/**
 * Gibt die Daten eines aktiven Temp-Channels zurück.
 *
 * Rückgabe:
 * - channelData Objekt
 * - oder null, wenn der Channel nicht mehr im Store existiert
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
 * Findet den aktuell von einem User "besessenen" Temp-Channel.
 *
 * Das wird verwendet, wenn jemand erneut in einen Join-to-Create joint
 * und geprüft werden soll, ob schon ein laufender Temp-Talk für ihn existiert.
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
 * Lädt das persönliche Profil eines Users.
 *
 * Dieses Profil enthält z. B.:
 * - bevorzugter Talkname
 * - Userlimit
 * - Privacy
 * - White-/Blacklist
 */
function getUserProfile(guildId, userId) {
  const store = readStore();
  ensureGuild(store, guildId);
  return store.guilds[guildId].profiles[userId] || null;
}

/**
 * Speichert das persönliche Profil eines Users.
 */
function saveUserProfile(guildId, userId, profile) {
  const store = readStore();
  ensureGuild(store, guildId);
  store.guilds[guildId].profiles[userId] = profile;
  writeStore(store);
}

/**
 * Entfernt ein User-Profil.
 */
function deleteUserProfile(guildId, userId) {
  const store = readStore();
  ensureGuild(store, guildId);
  delete store.guilds[guildId].profiles[userId];
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