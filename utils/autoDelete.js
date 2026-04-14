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