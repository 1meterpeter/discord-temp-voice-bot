require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Events, Collection } = require("discord.js");
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

client.commands = new Collection();

const commandsPath = path.join(__dirname, "commands");
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.warn(`Die Command-Datei ${file} ist unvollständig.`);
    }
  }
}

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
  }, 30000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`Kein Command mit Namen ${interaction.commandName} gefunden.`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "Beim Ausführen des Commands ist ein Fehler aufgetreten.",
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: "Beim Ausführen des Commands ist ein Fehler aufgetreten.",
          ephemeral: true
        });
      }
    }

    return;
  }

  await handleInteractionCreate(interaction);
});

client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);

client.login(process.env.DISCORD_TOKEN);