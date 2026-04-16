/**
 * Sendet eine normale Nachricht in einen Channel und löscht sie nach X ms wieder.
 *
 * @param {import("discord.js").TextBasedChannel} channel
 * @param {object} payload
 * @param {number} delay
 */
async function sendAndAutoDelete(channel, payload, delay = 10000) {
  try {
    const msg = await channel.send(payload);

    setTimeout(() => {
      msg.delete().catch(() => {});
    }, delay);

    return msg;
  } catch (err) {
    console.error("AutoDelete send error:", err);
    return null;
  }
}

/**
 * Antwortet auf eine Interaction und löscht die Antwort nach X ms wieder,
 * sofern sie NICHT ephemeral ist.
 *
 * Ephemeral-Nachrichten werden von Discord selbst verwaltet und müssen
 * nicht manuell gelöscht werden.
 *
 * @param {import("discord.js").BaseInteraction} interaction
 * @param {object} payload
 * @param {number} delay
 */
async function replyAndAutoDelete(interaction, payload, delay = 10000) {
  try {
    const msg = await interaction.reply({
      ...payload,
      fetchReply: true
    });

    if (payload.ephemeral) {
      return msg;
    }

    setTimeout(() => {
      msg.delete().catch(() => {});
    }, delay);

    return msg;
  } catch (err) {
    console.error("AutoDelete reply error:", err);
    return null;
  }
}

module.exports = {
  sendAndAutoDelete,
  replyAndAutoDelete
};