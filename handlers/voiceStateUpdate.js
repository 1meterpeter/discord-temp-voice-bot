const {
  findOwnedChannelByUser,
  getTempChannel,
  findGuildSetupByJoinChannel
} = require("../utils/store");

const {
  createTempChannel,
  deleteTempChannelSet,
  transferOwnership,
  ensureChannelPlacement
} = require("../services/tempChannelService");

/**
 * Kleiner Lock, damit beim Join-to-create nicht mehrfach gleichzeitig Channels erstellt werden.
 */
const creationLocks = new Set();

module.exports = async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    /**
     * Prüfen, ob der neue Channel ein Join-to-create Channel aus einem Setup ist.
     */
    const matchedSetup = newChannelId
      ? findGuildSetupByJoinChannel(guild.id, newChannelId)
      : null;

    /**
     * User joint einen Setup-Channel -> Temp-Voice erstellen.
     */
    if (
      matchedSetup &&
      oldChannelId !== newChannelId &&
      !creationLocks.has(member.id)
    ) {
      creationLocks.add(member.id);

      try {
        const existing = findOwnedChannelByUser(guild.id, member.id);

        // Falls der User schon einen eigenen Temp-Voice hat, wird er wieder dorthin verschoben.
        if (existing) {
          const existingChannel = guild.channels.cache.get(existing.voiceChannelId);
          if (existingChannel) {
            await member.voice.setChannel(existingChannel).catch(console.error);
            await ensureChannelPlacement(guild, existing.voiceChannelId).catch(console.error);
            return;
          }
        }

        const joinChannel = guild.channels.cache.get(matchedSetup.joinToCreateChannelId);
        if (!joinChannel) return;

        const created = await createTempChannel(member, joinChannel, matchedSetup);

        if (created?.voiceChannelId) {
          await ensureChannelPlacement(guild, created.voiceChannelId).catch(console.error);
        }
      } catch (error) {
        console.error("[TempVoice] Fehler beim Erstellen des Temp-Channels:", error);
      } finally {
        setTimeout(() => creationLocks.delete(member.id), 1500);
      }

      return;
    }

    /**
     * Wenn jemand einen Temp-Channel verlässt:
     * - leer -> löschen
     * - Owner weg -> Ownership übertragen
     * - danach ggf. zwischen Open/Closed verschieben
     */
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

      await ensureChannelPlacement(guild, oldChannelId).catch(console.error);
    }

    /**
     * Wenn jemand einen bestehenden Temp-Channel joint:
     * -> eventuell ist er jetzt "voll" und muss nach Talks Closed verschoben werden
     */
    if (newChannelId) {
      const tempData = getTempChannel(guild.id, newChannelId);
      if (tempData) {
        await ensureChannelPlacement(guild, newChannelId).catch(console.error);
      }
    }
  } catch (error) {
    console.error("Fehler in voiceStateUpdate:", error);
  }
};