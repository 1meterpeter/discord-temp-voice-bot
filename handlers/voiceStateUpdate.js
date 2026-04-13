const { findOwnedChannelByUser, getGuildData } = require("../utils/store");
const { createTempChannel, deleteTempChannelSet } = require("../services/tempChannelService");

const creationLocks = new Set();

module.exports = async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const member = newState.member;
    if (!member || member.user.bot) return;

    const joinToCreateId = process.env.JOIN_TO_CREATE_CHANNEL_ID;
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (
      newChannelId === joinToCreateId &&
      oldChannelId !== joinToCreateId &&
      !creationLocks.has(member.id)
    ) {
      creationLocks.add(member.id);

      try {
        const existing = findOwnedChannelByUser(guild.id, member.id);

        if (existing) {
          const existingChannel = guild.channels.cache.get(existing.voiceChannelId);
          if (existingChannel) {
            await member.voice.setChannel(existingChannel).catch(console.error);
            return;
          }
        }

        const joinChannel = guild.channels.cache.get(joinToCreateId);
        if (!joinChannel) return;

        await createTempChannel(member, joinChannel);
      } finally {
        setTimeout(() => creationLocks.delete(member.id), 1500);
      }

      return;
    }

    if (oldChannelId) {
      const guildData = getGuildData(guild.id);
      const tempData = guildData.channels?.[oldChannelId];

      if (tempData) {
        const oldChannel = guild.channels.cache.get(oldChannelId);

        if (!oldChannel || oldChannel.members.size === 0) {
          await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        }
      }
    }
  } catch (error) {
    console.error("Fehler in voiceStateUpdate:", error);
  }
};