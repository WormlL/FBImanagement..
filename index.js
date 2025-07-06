import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
import path from "path";
import fetch from "node-fetch";

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Files and paths (only these files allowed for read/write)
const REPEATS_FILE = "./repeats.json";
const FAILCOUNTS_FILE = "./failCounts.json";
const COMMANDLOGS_FILE = "./commandLogs.json";

const ALLOWED_FILES = [
  path.resolve(REPEATS_FILE),
  path.resolve(FAILCOUNTS_FILE),
  path.resolve(COMMANDLOGS_FILE),
];

// Helpers to securely load/save JSON
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

function saveJson(filePath, data) {
  const absPath = path.resolve(filePath);
  if (!ALLOWED_FILES.includes(absPath)) {
    throw new Error("Access to this file is not allowed.");
  }
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2));
}

// Load saved data or defaults
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
const MANAGEMENT_ROLE_ID = process.env.MANAGEMENT_ROLE_ID;
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

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

  // New /summarize command
  new SlashCommandBuilder()
    .setName("summarize")
    .setDescription("Summarize recent messages in this channel"),

  // New /status command
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show latest flagged status word in this channel"),
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

  // Restart repeats on startup
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

// Extract role IDs like <@&123> from message content
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
  return (
    roles.has(COMMAND_ROLE) ||
    roles.has(SUPERVISOR_ROLE) ||
    roles.has(MANAGEMENT_ROLE_ID)
  );
}

// Fetch last N messages sorted oldest → newest
async function fetchRecentMessages(channel, limit = 50) {
  const messages = await channel.messages.fetch({ limit });
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Summarize text via Hugging Face API
async function summarizeText(text) {
  if (!HUGGINGFACE_API_KEY) throw new Error("Hugging Face API key missing");

  const response = await fetch(
    "https://api-inference.huggingface.co/models/facebook/bart-large-cnn",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text }),
    },
  );
  if (!response.ok) throw new Error(`HF API error: ${response.statusText}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data[0]?.summary_text || "No summary generated.";
}

// Find latest flagged word in messages
function findLatestFlaggedWord(messages, flaggedWords) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content.toLowerCase();
    for (const word of flaggedWords) {
      if (content.includes(word.toLowerCase())) {
        return word;
      }
    }
  }
  return null;
}

client.pendingConfirms = new Map();

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle buttons for /say confirmation
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
      await interaction.reply({ content: "Message sent!", ephemeral: true });
      await confirmData.channel.send({
        content: confirmData.message,
        allowedMentions: { roles: extractRoleMentions(confirmData.message) },
      });
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
          content: `Repeating every ${confirmData.interval} min.\nRepeat ID: ${repeatId}`,
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
        content: "Message sending canceled.",
        ephemeral: true,
      });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  const id = interaction.user.id;

  // Log command usage
  client.commandLogs.push({
    command: name,
    user: interaction.user.tag,
    id,
    time: new Date().toLocaleString(),
  });
  saveJson(COMMANDLOGS_FILE, client.commandLogs);

  if (!hasFullAccess(interaction)) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  if (name === "say") {
    const message = interaction.options.getString("message");
    const repeat = interaction.options.getBoolean("repeat");
    const interval = interaction.options.getInteger("interval");

    // Large pings require confirmation (>=5 roles pinged)
    const roleMentions = extractRoleMentions(message);
    const largePing = roleMentions.length >= 5;

    if (largePing) {
      // Show confirm buttons
      const confirmId = `${interaction.id}_${Date.now()}`;
      client.pendingConfirms.set(confirmId, {
        userId: interaction.user.id,
        message,
        repeat,
        interval,
        channel: interaction.channel,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirmSay_${confirmId}`)
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cancelSay_${confirmId}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      );

      return interaction.reply({
        content:
          "⚠️ Your message pings 5 or more roles. Please confirm sending.",
        components: [row],
        ephemeral: true,
      });
    }

    // Otherwise send directly
    await interaction.reply({ content: "Message sent!", ephemeral: true });
    await interaction.channel.send({
      content: message,
      allowedMentions: { roles: roleMentions },
    });

    if (repeat && interval && interval > 0) {
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
      return interaction.followUp({
        content: `Repeating every ${interval} minutes.\nRepeat ID: ${repeatId}`,
        ephemeral: true,
      });
    }
  } else if (name === "stoprepeat") {
    const repeatId = interaction.options.getString("id");
    const repeat = client.repeats.get(repeatId);
    if (!repeat) {
      return interaction.reply({
        content: `No repeating message found with ID \`${repeatId}\`.`,
        ephemeral: true,
      });
    }
    clearInterval(repeat.task);
    client.repeats.delete(repeatId);
    saveJson(REPEATS_FILE, [...client.repeats.values()]);
    return interaction.reply({
      content: `Stopped repeating message with ID \`${repeatId}\`.`,
      ephemeral: true,
    });
  } else if (name === "commandlogs") {
    const userFilter = interaction.options.getUser("user");
    const filteredLogs = userFilter
      ? client.commandLogs.filter((log) => log.id === userFilter.id)
      : client.commandLogs;

    if (filteredLogs.length === 0) {
      return interaction.reply({
        content: "No command logs found for that user.",
        ephemeral: true,
      });
    }

    const recentLogs = filteredLogs
      .slice(-10)
      .map((log) => `${log.time} — ${log.user} — \`${log.command}\``)
      .join("\n");

    return interaction.reply({
      content: `Recent command logs:\n${recentLogs}`,
      ephemeral: true,
    });
  } else if (name === "trainingresults") {
    const user = interaction.options.getUser("user");
    // Placeholder for your existing training results logic
    // Here just acknowledge
    return interaction.reply({
      content: `Training results would be sent to ${user.tag} (not implemented).`,
      ephemeral: true,
    });
  } else if (name === "summarize") {
    // Fetch recent messages
    try {
      const messages = await fetchRecentMessages(interaction.channel, 50);
      const combinedText = messages
        .map((m) => m.content)
        .filter((txt) => txt.length > 0)
        .join("\n");

      if (!combinedText.trim()) {
        return interaction.reply({
          content: "No text found to summarize.",
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const summary = await summarizeText(combinedText);

      return interaction.editReply({ content: summary });
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: `Error summarizing messages: ${err.message}`,
        ephemeral: true,
      });
    }
  } else if (name === "status") {
    try {
      const flaggedWords = ["accepted", "denied", "on hold", "waiting for hr"];

      const messages = await fetchRecentMessages(interaction.channel, 50);
      const foundWord = findLatestFlaggedWord(messages, flaggedWords);

      if (!foundWord) {
        return interaction.reply({
          content: "No flagged status word found recently.",
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: `Latest flagged status: **${foundWord}**`,
        ephemeral: true,
      });
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: `Error checking status: ${err.message}`,
        ephemeral: true,
      });
    }
  }
});

client.login(TOKEN);
