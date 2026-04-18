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
 * Verhindert doppelte Channel-Erstellung, wenn Discord sehr kurz hintereinander
 * mehrere VoiceStateUpdates für denselben User feuert.
 *
 * Beispiel:
 * Beim Join in einen Join-to-Create-Channel kann Discord in kurzer Folge
 * mehrere Events auslösen. Mit diesem Lock verhindern wir doppelte TempChannels.
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
     * Wichtige Zustände:
     *
     * hasChannelChanged:
     * - true, wenn der User den Voicechannel tatsächlich gewechselt hat
     * - false, wenn nur Stream/Mute/Kamera/etc. geändert wurde
     *
     * hasLeftChannel:
     * - true, wenn User vorher in einem Channel war und nun entweder draußen
     *   oder in einem anderen Channel ist
     *
     * hasJoinedChannel:
     * - true, wenn User jetzt in einem Channel ist und vorher entweder draußen
     *   oder in einem anderen Channel war
     */
    const hasChannelChanged = oldChannelId !== newChannelId;
    const hasLeftChannel = !!oldChannelId && hasChannelChanged;
    const hasJoinedChannel = !!newChannelId && hasChannelChanged;

    console.log(
      `[TempVoice] VoiceStateUpdate | guild=${guild.id} | user=${member.user.tag} | old=${oldChannelId ?? "none"} | new=${newChannelId ?? "none"} | changed=${hasChannelChanged}`
    );

    /**
     * Wenn sich der eigentliche Voicechannel NICHT geändert hat,
     * ignorieren wir das Event vollständig.
     *
     * Dadurch verhindern wir Bugs bei:
     * - Stream starten / stoppen
     * - Kamera an / aus
     * - Mute / Unmute
     * - Deaf / Undeaf
     * - sonstigen Voice-State-Änderungen innerhalb desselben Channels
     */
    if (!hasChannelChanged) {
      return;
    }

    /**
     * ------------------------------------------------------------
     * 1) JOIN-TO-CREATE CHECK
     * ------------------------------------------------------------
     *
     * Nur relevant, wenn der User wirklich in einen neuen Channel gejoint ist.
     */
    const matchedSetup = hasJoinedChannel
      ? findGuildSetupByJoinChannel(guild.id, newChannelId)
      : null;

    if (hasJoinedChannel) {
      console.log(
        `[TempVoice] Join-Check | channel=${newChannelId} | setup=${matchedSetup ? matchedSetup.setupId : "none"}`
      );
    }

    /**
     * ------------------------------------------------------------
     * 2) USER JOINT EINEN JOIN-TO-CREATE CHANNEL
     * ------------------------------------------------------------
     *
     * Dann soll entweder:
     * - ein bestehender eigener TempChannel wiederverwendet werden
     * - oder ein neuer TempChannel erstellt werden
     */
    if (
      matchedSetup &&
      hasJoinedChannel &&
      !creationLocks.has(member.id)
    ) {
      creationLocks.add(member.id);

      try {
        console.log(
          `[TempVoice] Matched setup "${matchedSetup.name}" (${matchedSetup.setupId}) for user ${member.user.tag}`
        );

        const existing = findOwnedChannelByUser(guild.id, member.id);

        /**
         * Falls bereits ein eigener TempVoice für diesen User existiert:
         *
         * Fall A:
         * - Channel existiert nicht mehr -> Store-Eintrag bereinigen
         *
         * Fall B:
         * - Channel existiert und gehört zum selben Setup -> wiederverwenden
         *
         * Fall C:
         * - Channel existiert, gehört aber zu anderem Setup -> alten löschen
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
              console.error(
                "[TempVoice] Fehler beim Zurückverschieben in bestehenden Temp-Channel:",
                error
              );
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
     * 3) USER VERLÄSST EINEN BESTEHENDEN TEMPVOICE
     * ------------------------------------------------------------
     *
     * Dieser Block läuft jetzt NUR bei echtem Leave / Move.
     * Genau das behebt den Bug mit Stream / Kamera / Mute usw.
     */
    if (hasLeftChannel) {
      const tempData = getTempChannel(guild.id, oldChannelId);

      if (tempData) {
        const oldChannel = guild.channels.cache.get(oldChannelId);

        /**
         * Falls der Channel im Cache nicht mehr existiert,
         * wird der Store bereinigt.
         */
        if (!oldChannel) {
          console.log(
            `[TempVoice] Old temp channel no longer exists -> cleaning store | channel=${oldChannelId}`
          );
          await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
          return;
        }

        /**
         * Wenn der Channel leer ist, wird er gelöscht.
         */
        if (oldChannel.members.size === 0) {
          console.log(
            `[TempVoice] Temp channel empty -> deleting | channel=${oldChannelId}`
          );
          await deleteTempChannelSet(guild, oldChannelId).catch(console.error);
          return;
        }

        /**
         * Wenn der Owner den TempVoice wirklich verlassen hat,
         * wird Ownership an den ersten verbleibenden Nicht-Bot übertragen.
         *
         * Wichtig:
         * Dieser Block läuft NICHT mehr bei Stream/Mute/Kamera,
         * weil wir oben bereits auf echten Channel-Wechsel prüfen.
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

        /**
         * Nach jedem echten Leave:
         * - Textchat-Zugriff neu berechnen
         * - Channel ggf. zwischen Open/Closed verschieben
         */
        await syncActiveChatAccess(guild, oldChannelId).catch(console.error);
        await ensureChannelPlacement(guild, oldChannelId).catch(console.error);
      }
    }

    /**
     * ------------------------------------------------------------
     * 4) USER JOINT EINEN BEREITS BESTEHENDEN TEMPVOICE
     * ------------------------------------------------------------
     *
     * Dann müssen wir:
     * - aktiven Textchat-Zugriff neu berechnen
     * - prüfen, ob der Channel jetzt voll ist
     */
    if (hasJoinedChannel) {
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