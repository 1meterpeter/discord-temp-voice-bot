const {
  findOwnedChannelByUser,
  getTempChannel,
  getGuildConfig
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

    const guildConfig = getGuildConfig(guild.id);

    if (!guildConfig) {
      console.log(`[TempVoice] Keine Guild-Config gefunden für Guild ${guild.id}`);
      return;
    }

    const joinToCreateId = guildConfig.joinToCreateChannelId;
    const tempCategoryId = guildConfig.tempCategoryId;

    if (!joinToCreateId || !tempCategoryId) {
      console.log(
        `[TempVoice] Setup unvollständig für Guild ${guild.id}. joinToCreateId=${joinToCreateId}, tempCategoryId=${tempCategoryId}`
      );
      return;
    }

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
        console.log(
          `[TempVoice] ${member.user.tag} hat Join-to-Create betreten in Guild ${guild.id}`
        );

        const existing = findOwnedChannelByUser(guild.id, member.id);

        if (existing) {
          const existingChannel = guild.channels.cache.get(existing.voiceChannelId);
          if (existingChannel) {
            console.log(
              `[TempVoice] Existierender Temp-Channel gefunden für ${member.user.tag}: ${existing.voiceChannelId}`
            );
            await member.voice.setChannel(existingChannel).catch(console.error);
            return;
          }
        }

        const joinChannel = guild.channels.cache.get(joinToCreateId);
        if (!joinChannel) {
          console.log(
            `[TempVoice] Join-to-Create Channel ${joinToCreateId} wurde in Guild ${guild.id} nicht gefunden`
          );
          return;
        }

        await createTempChannel(member, joinChannel);
        console.log(`[TempVoice] Temp-Channel erfolgreich erstellt für ${member.user.tag}`);
      } catch (error) {
        console.error("[TempVoice] Fehler beim Erstellen des Temp-Channels:", error);
      } finally {
        setTimeout(() => creationLocks.delete(member.id), 1500);
      }

      return;
    }

    // Temp-Voice verlassen
    if (oldChannelId) {
      const tempData = getTempChannel(guild.id, oldChannelId);
      if (!tempData) return;

      const oldChannel = guild.channels.cache.get(oldChannelId);

      if (!oldChannel) {
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      if (oldChannel.members.size === 0) {
        console.log(`[TempVoice] Leerer Temp-Channel wird gelöscht: ${oldChannelId}`);
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      // Owner ist raus -> Ownership auf nächsten aktiven User
      if (tempData.ownerId === member.id) {
        const remainingMembers = [...oldChannel.members.values()].filter(
          (m) => !m.user.bot
        );

        if (remainingMembers.length > 0) {
          const newOwner = remainingMembers[0];
          console.log(
            `[TempVoice] Owner ${member.user.tag} hat Channel verlassen. Neuer Owner: ${newOwner.user.tag}`
          );
          await transferOwnership(guild, oldChannelId, newOwner.id).catch(console.error);
        }
      }
    }
  } catch (error) {
    console.error("Fehler in voiceStateUpdate:", error);
  }
};