import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
} from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
import path from "path";
dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// File paths
const REPEATS_FILE = "./repeats.json";
const FAILCOUNTS_FILE = "./failCounts.json";
const COMMANDLOGS_FILE = "./commandLogs.json";

// Allowed data files (absolute paths)
const ALLOWED_FILES = [
  path.resolve(REPEATS_FILE),
  path.resolve(FAILCOUNTS_FILE),
  path.resolve(COMMANDLOGS_FILE),
];

// Secure Load JSON helper
function loadJson(filePath, defaultData) {
  const absPath = path.resolve(filePath);
  if (!ALLOWED_FILES.includes(absPath)) {
    throw new Error("Access to this file is not allowed.");
  }
  try {
    if (!fs.existsSync(absPath)) return defaultData;
    const data = fs.readFileSync(absPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return defaultData;
  }
}
// Secure Save JSON helper
function saveJson(filePath, data) {
  const absPath = path.resolve(filePath);
  if (!ALLOWED_FILES.includes(absPath)) {
    throw new Error("Access to this file is not allowed.");
  }
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2));
}

// Load stored data on startup
client.repeats = new Map(loadJson(REPEATS_FILE, []).map((r) => [r.id, r]));
client.failCounts = loadJson(FAILCOUNTS_FILE, {});
client.commandLogs = loadJson(COMMANDLOGS_FILE, []);
client.repeatIdCounter = client.repeats.size
  ? Math.max(
      ...[...client.repeats.keys()].map((id) => parseInt(id.split("_")[1])),
    ) + 1
  : 1;

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const COMMAND_ROLE = process.env.FBI_COMMAND_ROLE;
const SUPERVISOR_ROLE = process.env.FBI_SUPERVISOR_ROLE;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const ALLOWED_USER_ID_2 = process.env.ALLOWED_USER_ID_2;

const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot say a message")
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Message content")
        .setRequired(true),
    )
    .addBooleanOption((opt) =>
      opt.setName("repeat").setDescription("Repeat this message?"),
    )
    .addIntegerOption((opt) =>
      opt.setName("interval").setDescription("Interval in minutes for repeats"),
    ),
  new SlashCommandBuilder()
    .setName("stoprepeat")
    .setDescription("Stop a repeating message")
    .addStringOption((opt) =>
      opt.setName("id").setDescription("Repeat ID to stop").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("commandlogs")
    .setDescription("View command usage logs")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Filter logs by user"),
    ),
  new SlashCommandBuilder()
    .setName("trainingresults")
    .setDescription("Send FBI BFTC training results")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Trainee to send results to")
        .setRequired(true),
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("🔁 Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("❌ Error registering commands:", error);
  }
})();

client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  // Restart all repeats on boot
  for (const repeat of client.repeats.values()) {
    const channel = client.channels.cache.get(repeat.channelId);
    if (!channel) continue;

    repeat.task = setInterval(() => {
      channel.send({
        content: repeat.message,
        allowedMentions: { roles: extractRoleMentions(repeat.message) },
      });
    }, repeat.interval * 60000);
  }
});

// Utility: get role IDs from a message string like <@&123>
function extractRoleMentions(message) {
  const regex = /<@&(\d+)>/g;
  const roles = [];
  let match;
  while ((match = regex.exec(message)) !== null) {
    roles.push(match[1]);
  }
  return roles;
}

function hasFullAccess(interaction) {
  const id = interaction.user.id;
  if (id === ALLOWED_USER_ID || id === ALLOWED_USER_ID_2) return true;
  const roles = interaction.member.roles.cache;
  return roles.has(COMMAND_ROLE) || roles.has(SUPERVISOR_ROLE);
}

// Confirmation state for large pings
client.pendingConfirms = new Map();

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle confirmation button clicks
  if (interaction.isButton()) {
    if (interaction.customId.startsWith("confirmSay_")) {
      const confirmId = interaction.customId.split("_")[1];
      const confirmData = client.pendingConfirms.get(confirmId);
      if (!confirmData) {
        return interaction.reply({
          content: "Confirmation expired or invalid.",
          ephemeral: true,
        });
      }
      if (interaction.user.id !== confirmData.userId) {
        return interaction.reply({
          content: "You cannot confirm this action.",
          ephemeral: true,
        });
      }
      // Send message now
      await interaction.reply({ content: "✅ Message sent!", ephemeral: true });
      await confirmData.channel.send({
        content: confirmData.message,
        allowedMentions: { roles: extractRoleMentions(confirmData.message) },
      });
      // If repeat was requested, start it now
      if (confirmData.repeat && confirmData.interval) {
        const repeatId = `repeat_${client.repeatIdCounter++}`;
        const task = setInterval(() => {
          confirmData.channel.send({
            content: confirmData.message,
            allowedMentions: {
              roles: extractRoleMentions(confirmData.message),
            },
          });
        }, confirmData.interval * 60000);
        client.repeats.set(repeatId, {
          id: repeatId,
          message: confirmData.message,
          interval: confirmData.interval,
          channelId: confirmData.channel.id,
          task,
        });
        saveJson(REPEATS_FILE, [...client.repeats.values()]);
        await interaction.followUp({
          content: `🔁 Repeating every ${confirmData.interval} min.\n**Repeat ID:** \`${repeatId}\``,
          ephemeral: true,
        });
      }
      client.pendingConfirms.delete(confirmId);
      return;
    }
    if (interaction.customId.startsWith("cancelSay_")) {
      const confirmId = interaction.customId.split("_")[1];
      client.pendingConfirms.delete(confirmId);
      return interaction.reply({
        content: "❌ Message sending canceled.",
        ephemeral: true,
      });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  const id = interaction.user.id;
  client.commandLogs.push({
    command: name,
    user: interaction.user.tag,
    id,
    time: new Date().toLocaleString(),
  });
  saveJson(COMMANDLOGS_FILE, client.commandLogs);

  if (!hasFullAccess(interaction)) {
    return interaction.reply({
      content: "**:x: You do not have permission to use this command. :x:**",
      ephemeral: true,
    });
  }

  if (name === "say") {
    const message = interaction.options.getString("message");
    const repeat = interaction.options.getBoolean("repeat");
    const interval = interaction.options.getInteger("interval");

    // Check for large ping (>5 role mentions)
    const roleMentions = extractRoleMentions(message);
    const largePing = roleMentions.length >= 5;

    if (largePing) {
      // Ask for confirmation with buttons
      const {
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
      } = require("discord.js");
      const confirmId = `${interaction.id}_${Date.now()}`;
      client.pendingConfirms.set(confirmId, {
        userId: id,
        message,
        repeat,
        interval,
        channel: interaction.channel,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirmSay_${confirmId}`)
          .setLabel("Yes, send it")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cancelSay_${confirmId}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      );

      return interaction.reply({
        content: `⚠️ Your message mentions **${roleMentions.length} roles**. Are you sure you want to send it?`,
        components: [row],
        ephemeral: true,
      });
    }

    // No large ping, just send
    await interaction.reply({
      content: `✅ Message sent${repeat ? " and will repeat." : "."}`,
      ephemeral: true,
    });
    await interaction.channel.send({
      content: message,
      allowedMentions: { roles: roleMentions },
    });

    if (repeat && interval) {
      const repeatId = `repeat_${client.repeatIdCounter++}`;
      const task = setInterval(() => {
        interaction.channel.send({
          content: message,
          allowedMentions: { roles: roleMentions },
        });
      }, interval * 60000);

      client.repeats.set(repeatId, {
        id: repeatId,
        message,
        interval,
        channelId: interaction.channel.id,
        task,
      });
      saveJson(REPEATS_FILE, [...client.repeats.values()]);

      await interaction.followUp({
        content: `🔁 Repeating every ${interval} minutes.\nRepeat ID: \`${repeatId}\``,
        ephemeral: true,
      });
    }
  }

  if (name === "stoprepeat") {
    const repeatId = interaction.options.getString("id");
    if (!client.repeats.has(repeatId)) {
      return interaction.reply({
        content: `❌ No repeat found with ID \`${repeatId}\`.`,
        ephemeral: true,
      });
    }
    const repeat = client.repeats.get(repeatId);
    clearInterval(repeat.task);
    client.repeats.delete(repeatId);
    saveJson(REPEATS_FILE, [...client.repeats.values()]);
    return interaction.reply({
      content: `🛑 Repeat with ID \`${repeatId}\` stopped.`,
      ephemeral: true,
    });
  }

  if (name === "commandlogs") {
    const userFilter = interaction.options.getUser("user");
    let filteredLogs = client.commandLogs;
    if (userFilter) {
      filteredLogs = filteredLogs.filter((log) => log.id === userFilter.id);
    }
    if (filteredLogs.length === 0) {
      return interaction.reply({
        content: "No command logs found for that user.",
        ephemeral: true,
      });
    }
    const logsText = filteredLogs
      .slice(-10)
      .map(
        (log) => `\`${log.time}\` - **${log.user}** used \`/${log.command}\``,
      )
      .join("\n");
    return interaction.reply({
      content: `Last 10 command logs:\n${logsText}`,
      ephemeral: true,
    });
  }

  if (name === "trainingresults") {
    // Show modal to send training results to a user
    const modal = new ModalBuilder()
      .setCustomId("trainingResultsModal")
      .setTitle("FBI BFTC Training Results");

    const userInput = new TextInputBuilder()
      .setCustomId("traineeId")
      .setLabel("Trainee Discord ID")
      .setStyle(TextInputStyle.Short)
      .setValue(interaction.options.getUser("user").id)
      .setRequired(true);

    const resultsInput = new TextInputBuilder()
      .setCustomId("results")
      .setLabel("Training results details")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Enter training results here...")
      .setRequired(true);

    const firstRow = new ActionRowBuilder().addComponents(userInput);
    const secondRow = new ActionRowBuilder().addComponents(resultsInput);

    modal.addComponents(firstRow, secondRow);
    await interaction.showModal(modal);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.type !== InteractionType.ModalSubmit) return;

  if (interaction.customId === "trainingResultsModal") {
    const traineeId = interaction.fields.getTextInputValue("traineeId");
    const results = interaction.fields.getTextInputValue("results");

    try {
      const user = await client.users.fetch(traineeId);
      await user.send(`📄 **FBI BFTC Training Results:**\n${results}`);
      await interaction.reply({
        content: `✅ Training results sent to ${user.tag}`,
        ephemeral: true,
      });
    } catch {
      await interaction.reply({
        content: `❌ Could not send results. Check the trainee ID.`,
        ephemeral: true,
      });
    }
  }
});

client.login(TOKEN);
