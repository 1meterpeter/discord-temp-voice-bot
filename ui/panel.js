const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder
} = require("discord.js");

/**
 * Baut eine kompakte Mention-Liste.
 *
 * Beispiel:
 * - 1-3 User -> alle erwähnen
 * - mehr -> erste zwei anzeigen, Rest als +X
 */
function formatCompactUserList(userIds) {
  if (!userIds || userIds.length === 0) return "—";

  const mentions = userIds.map((id) => `<@${id}>`);

  if (mentions.length <= 3) {
    return mentions.join(", ");
  }

  const preview = mentions.slice(0, 2).join(", ");
  const rest = mentions.length - 2;
  return `${preview}, +${rest}`;
}

/**
 * Baut die sichtbaren Panel-Komponenten für den Textchat des Voicechannels.
 *
 * Das Panel zeigt:
 * - Owner
 * - Privacy / Limit
 * - Whitelist
 * - Blacklist
 * - Buttons für Bearbeitung
 */
function buildMainPanelComponents(channelData) {
  const title = new TextDisplayBuilder().setContent("## 🎛️ Temp Voice Panel");

  const ownerBlock = new TextDisplayBuilder().setContent(
    [
      "### 👑 Owner",
      `<@${channelData.ownerId}>`
    ].join("\n")
  );

  const settingsBlock = new TextDisplayBuilder().setContent(
    [
      "### ⚙️ Settings",
      `**Privacy:** ${channelData.isPrivate ? "🔒 Private" : "🌐 Open"}`,
      `**Limit:** 👥 ${channelData.userLimit === 0 ? "Unbegrenzt" : channelData.userLimit}`
    ].join("\n")
  );

  const whitelistBlock = new TextDisplayBuilder().setContent(
    [
      "### ✅ Whitelist",
      `${formatCompactUserList(channelData.whitelist)}`
    ].join("\n")
  );

  const blacklistBlock = new TextDisplayBuilder().setContent(
    [
      "### ⛔ Blacklist",
      `${formatCompactUserList(channelData.blacklist)}`
    ].join("\n")
  );

  const separator = new SeparatorBuilder().setDivider(true);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tempvc:edit:${channelData.voiceChannelId}`)
      .setLabel("✏️ Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`tempvc:owner:${channelData.voiceChannelId}`)
      .setLabel("👑 Owner")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tempvc:whitelist:${channelData.voiceChannelId}`)
      .setLabel("✅ Whitelist")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tempvc:blacklist:${channelData.voiceChannelId}`)
      .setLabel("⛔ Blacklist")
      .setStyle(ButtonStyle.Danger)
  );

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      title,
      ownerBlock,
      settingsBlock,
      whitelistBlock,
      blacklistBlock
    )
    .addSeparatorComponents(separator)
    .addActionRowComponents(row1, row2);

  return [container];
}

module.exports = {
  buildMainPanelComponents
};