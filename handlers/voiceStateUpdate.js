const { findOwnedChannelByUser, getGuildData, getTempChannel } = require("../utils/store");
const { createTempChannel, deleteTempChannelSet, transferOwnership } = require("../services/tempChannelService");

const creationLocks = new Set();

module.exports = async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const joinToCreateId = process.env.JOIN_TO_CREATE_CHANNEL_ID;
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // Join-to-create
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

    // Prüfen, ob jemand einen Temp-Channel verlassen hat
    if (oldChannelId) {
      const tempData = getTempChannel(guild.id, oldChannelId);
      if (!tempData) return;

      const oldChannel = guild.channels.cache.get(oldChannelId);

      // Channel existiert nicht mehr
      if (!oldChannel) {
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      // Leer -> löschen
      if (oldChannel.members.size === 0) {
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      // Owner ist raus -> Ownership an nächsten aktiven User übertragen
      if (tempData.ownerId === member.id) {
        const remainingMembers = [...oldChannel.members.values()]
          .filter((m) => !m.user.bot);

        if (remainingMembers.length > 0) {
          const newOwner = remainingMembers[0];
          await transferOwnership(guild, oldChannelId, newOwner.id).catch(console.error);
        }
      }
    }
  } catch (error) {
    console.error("Fehler in voiceStateUpdate:", error);
  }
};