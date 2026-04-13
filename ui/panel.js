const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder
} = require("discord.js");

function formatInlineUserList(userIds) {
  if (!userIds || userIds.length === 0) return "—";
  return userIds.map((id) => `<@${id}>`).join(", ");
}

function buildMainPanelComponents(channelData) {
  const title = new TextDisplayBuilder().setContent("## 🎛️ Temp Voice Panel");

  const subtitle = new TextDisplayBuilder().setContent(
    "*Verwalte deinen temporären Voice-Channel über die Optionen unten.*"
  );

  const ownerBlock = new TextDisplayBuilder().setContent(
    `### 👑 Owner\n<@${channelData.ownerId}>`
  );

  const settingsBlock = new TextDisplayBuilder().setContent(
    [
      "### ⚙️ Einstellungen",
      `**Privacy:** ${channelData.isPrivate ? "Private" : "Open"}`,
      `**Limit:** ${channelData.userLimit === 0 ? "Unbegrenzt" : channelData.userLimit}`
    ].join("\n")
  );

  const whitelistBlock = new TextDisplayBuilder().setContent(
    [
      "### ✅ Whitelist",
      formatInlineUserList(channelData.whitelist)
    ].join("\n")
  );

  const blacklistBlock = new TextDisplayBuilder().setContent(
    [
      "### ⛔ Blacklist",
      formatInlineUserList(channelData.blacklist)
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
      subtitle,
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