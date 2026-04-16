const {
  findOwnedChannelByUser,
  getTempChannel,
  findGuildSetupByJoinChannel
} = require("../utils/store");

const {
  createTempChannel,
  deleteTempChannelSet,
  transferOwnership,
  ensureChannelPlacement,
  syncActiveChatAccess
} = require("../services/tempChannelService");

/**
 * Verhindert doppelte Channel-Erstellung, wenn Discord kurz nacheinander
 * mehrere VoiceStateUpdates für denselben User feuert.
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
     * ------------------------------------------------------------
     * 1) JOIN-TO-CREATE CHECK
     * ------------------------------------------------------------
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
     * ------------------------------------------------------------
     * 2) USER JOINT EINEN CREATE-CHANNEL -> TEMPTALK ERSTELLEN
     * ------------------------------------------------------------
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
         * Falls schon ein eigener Temp-Channel existiert:
         * - wiederverwenden, wenn er noch existiert und zum selben Setup gehört
         * - sonst alten / kaputten Eintrag entfernen
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

            await syncActiveChatAccess(guild, existing.voiceChannelId).catch(console.error);
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
          await syncActiveChatAccess(guild, created.voiceChannelId).catch(console.error);
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
     * ------------------------------------------------------------
     * 3) USER VERLÄSST EINEN TEMPTALK
     * ------------------------------------------------------------
     */
    if (oldChannelId) {
      const tempData = getTempChannel(guild.id, oldChannelId);

      if (tempData) {
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

        /**
         * Wenn der Owner geht:
         * - ersten verbleibenden Nicht-Bot als neuen Owner wählen
         * - Name wird im Service automatisch an den neuen Owner angepasst
         */
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

        // Nach jedem Leave den aktiven Chat-Zugriff neu synchronisieren.
        await syncActiveChatAccess(guild, oldChannelId).catch(console.error);
        await ensureChannelPlacement(guild, oldChannelId).catch(console.error);
      }
    }

    /**
     * ------------------------------------------------------------
     * 4) USER JOINT EINEN BESTEHENDEN TEMPTALK
     * ------------------------------------------------------------
     */
    if (newChannelId) {
      const tempData = getTempChannel(guild.id, newChannelId);

      if (tempData) {
        console.log(
          `[TempVoice] Joined existing temp channel -> checking placement and chat access | channel=${newChannelId}`
        );

        await syncActiveChatAccess(guild, newChannelId).catch(console.error);
        await ensureChannelPlacement(guild, newChannelId).catch(console.error);
      }
    }
  } catch (error) {
    console.error("Fehler in voiceStateUpdate:", error);
  }
};