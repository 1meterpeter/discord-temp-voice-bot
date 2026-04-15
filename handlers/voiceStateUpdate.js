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
 * Verhindert doppelte Channel-Erstellung, wenn Discord kurz hintereinander
 * mehrere VoiceState-Updates feuert.
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

    console.log(
      `[TempVoice] VoiceStateUpdate | guild=${guild.id} | user=${member.user.tag} | old=${oldChannelId ?? "none"} | new=${newChannelId ?? "none"}`
    );

    /**
     * Prüfen, ob der neue Channel ein Join-to-create Channel aus einem Setup ist.
     */
    const matchedSetup = newChannelId
      ? findGuildSetupByJoinChannel(guild.id, newChannelId)
      : null;

    if (newChannelId) {
      console.log(
        `[TempVoice] Join-Check | channel=${newChannelId} | setup=${matchedSetup ? matchedSetup.setupId : "none"}`
      );
    }

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
        console.log(
          `[TempVoice] Matched setup "${matchedSetup.name}" (${matchedSetup.setupId}) for user ${member.user.tag}`
        );

        const existing = findOwnedChannelByUser(guild.id, member.id);

        /**
         * Falls bereits ein Temp-Channel existiert:
         * - nur wiederverwenden, wenn er noch existiert UND zum selben Setup gehört
         * - sonst stale Channel ignorieren / löschen
         */
        if (existing) {
          const existingChannel = guild.channels.cache.get(existing.voiceChannelId);
          const existingData = existing.data;

          console.log(
            `[TempVoice] Existing owned channel found | channel=${existing.voiceChannelId} | setup=${existingData?.setupId ?? "none"}`
          );

          if (!existingChannel) {
            console.log(
              `[TempVoice] Existing channel missing in cache -> removing stale store entry`
            );
            await deleteTempChannelSet(guild, existing.voiceChannelId).catch(console.error);
          } else if (existingData?.setupId === matchedSetup.setupId) {
            console.log(
              `[TempVoice] Reusing existing temp channel ${existing.voiceChannelId} for same setup`
            );

            await member.voice.setChannel(existingChannel).catch((error) => {
              console.error("[TempVoice] Fehler beim Zurückverschieben in bestehenden Temp-Channel:", error);
            });

            await ensureChannelPlacement(guild, existing.voiceChannelId).catch(console.error);
            return;
          } else {
            console.log(
              `[TempVoice] Existing channel belongs to different setup -> deleting old channel and creating a new one`
            );

            await deleteTempChannelSet(guild, existing.voiceChannelId).catch(console.error);
          }
        }

        const joinChannel = guild.channels.cache.get(matchedSetup.joinToCreateChannelId);
        if (!joinChannel) {
          console.log(
            `[TempVoice] Join channel from setup not found | id=${matchedSetup.joinToCreateChannelId}`
          );
          return;
        }

        console.log(
          `[TempVoice] Creating new temp channel | setup=${matchedSetup.setupId} | openCategory=${matchedSetup.openCategoryId} | closedCategory=${matchedSetup.closedCategoryId} | sourceCategory=${matchedSetup.sourceCategoryId}`
        );

        const created = await createTempChannel(member, joinChannel, matchedSetup);

        if (created?.voiceChannelId) {
          console.log(
            `[TempVoice] Temp channel created successfully | channel=${created.voiceChannelId}`
          );
          await ensureChannelPlacement(guild, created.voiceChannelId).catch(console.error);
        } else {
          console.log("[TempVoice] createTempChannel returned no channel data");
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
        console.log(
          `[TempVoice] Old temp channel no longer exists -> cleaning store | channel=${oldChannelId}`
        );
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      if (oldChannel.members.size === 0) {
        console.log(
          `[TempVoice] Temp channel empty -> deleting | channel=${oldChannelId}`
        );
        await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
        return;
      }

      if (tempData.ownerId === member.id) {
        const remainingMembers = [...oldChannel.members.values()]
          .filter((m) => !m.user.bot);

        if (remainingMembers.length > 0) {
          const newOwner = remainingMembers[0];
          console.log(
            `[TempVoice] Owner left -> transferring ownership | old=${member.user.tag} | new=${newOwner.user.tag}`
          );
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
        console.log(
          `[TempVoice] Joined existing temp channel -> checking placement | channel=${newChannelId}`
        );
        await ensureChannelPlacement(guild, newChannelId).catch(console.error);
      }
    }
  } catch (error) {
    console.error("Fehler in voiceStateUpdate:", error);
  }
};