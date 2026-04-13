const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "tempChannels.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ guilds: {} }, null, 2),
      "utf8"
    );
  }
}

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

function writeStore(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function ensureGuild(store, guildId) {
  if (!store.guilds[guildId]) {
    store.guilds[guildId] = {
      channels: {},
      profiles: {}
    };
  }

  if (!store.guilds[guildId].channels || typeof store.guilds[guildId].channels !== "object") {
    store.guilds[guildId].channels = {};
  }

  if (!store.guilds[guildId].profiles || typeof store.guilds[guildId].profiles !== "object") {
    store.guilds[guildId].profiles = {};
  }
}

function getGuildData(guildId) {
  const store = readStore();
  ensureGuild(store, guildId);
  writeStore(store);
  return store.guilds[guildId];
}

function getTempChannel(guildId, voiceChannelId) {
  const store = readStore();
  ensureGuild(store, guildId);
  return store.guilds[guildId].channels[voiceChannelId] || null;
}

function saveTempChannel(guildId, voiceChannelId, data) {
  const store = readStore();
  ensureGuild(store, guildId);
  store.guilds[guildId].channels[voiceChannelId] = data;
  writeStore(store);
}

function deleteTempChannel(guildId, voiceChannelId) {
  const store = readStore();
  ensureGuild(store, guildId);
  delete store.guilds[guildId].channels[voiceChannelId];
  writeStore(store);
}

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

function getUserProfile(guildId, userId) {
  const store = readStore();
  ensureGuild(store, guildId);
  return store.guilds[guildId].profiles[userId] || null;
}

function saveUserProfile(guildId, userId, profile) {
  const store = readStore();
  ensureGuild(store, guildId);
  store.guilds[guildId].profiles[userId] = profile;
  writeStore(store);
}

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
  getTempChannel,
  saveTempChannel,
  deleteTempChannel,
  findOwnedChannelByUser,
  getUserProfile,
  saveUserProfile,
  deleteUserProfile
};