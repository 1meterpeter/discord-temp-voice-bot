const {
  findOwnedChannelByUser,
  getTempChannel,
  findGuildSetupByJoinChannel
} = require("../utils/store");

const {
  createTempChannel,
  deleteTempChannelSet,
  transferOwnership
} = require("../services/tempChannelService");

const creationLocks = new Set();

module.exports = async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    const matchedSetup = newChannelId
      ? findGuildSetupByJoinChannel(guild.id, newChannelId)
      : null;

    if (
      matchedSetup &&
      oldChannelId !== newChannelId &&
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

        const joinChannel = guild.channels.cache.get(matchedSetup.joinToCreateChannelId);
        if (!joinChannel) return;

        await createTempChannel(member, joinChannel, matchedSetup);
      } catch (error) {
        console.error("[TempVoice] Fehler beim Erstellen des Temp-Channels:", error);
      } finally {
        setTimeout(() => creationLocks.delete(member.id), 1500);
      }

      return;
    }

    if (oldChannelId) {
      const tempData = getTempChannel(guild.id, oldChannelId);
      if (!tempData) return;

      const oldChannel = guild.channels.cache.get(oldChannelId);

      if (!oldChannel) {
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      if (oldChannel.members.size === 0) {
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

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