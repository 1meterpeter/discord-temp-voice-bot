require("dotenv").config();

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const handleVoiceStateUpdate = require("./handlers/voiceStateUpdate");
const handleInteractionCreate = require("./handlers/interactionCreate");
const { getGuildData } = require("./utils/store");
const { deleteTempChannelSet } = require("./services/tempChannelService");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Bot online als ${readyClient.user.tag}`);

  setInterval(async () => {
    try {
      for (const guild of readyClient.guilds.cache.values()) {
        const guildData = getGuildData(guild.id);

        for (const voiceChannelId of Object.keys(guildData.channels || {})) {
          const channel = guild.channels.cache.get(voiceChannelId);

          if (!channel) {
            await deleteTempChannelSet(guild, voiceChannelId).catch(console.error);
            continue;
          }

          if (channel.members.size === 0) {
            await deleteTempChannelSet(guild, voiceChannelId).catch(console.error);
          }
        }
      }
    } catch (error) {
      console.error("Fehler im Cleanup-Intervall:", error);
    }
  }, 30000); // alle 30 Sekunden
});

client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
client.on(Events.InteractionCreate, handleInteractionCreate);

client.login(process.env.DISCORD_TOKEN);