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
dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// File paths
const REPEATS_FILE = "./repeats.json";
const FAILCOUNTS_FILE = "./failCounts.json";
const COMMANDLOGS_FILE = "./commandLogs.json";

// Load JSON helper
function loadJson(path, defaultData) {
  try {
    if (!fs.existsSync(path)) return defaultData;
    const data = fs.readFileSync(path, "utf-8");
    return JSON.parse(data);
  } catch {
    return defaultData;
  }
}
// Save JSON helper
function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
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
        content: `🔁 Repeating every ${interval} min.\n**Repeat ID:** \`${repeatId}\``,
        ephemeral: true,
      });
    }
  } else if (name === "stoprepeat") {
    const repeatId = interaction.options.getString("id");
    const repeat = client.repeats.get(repeatId);
    if (repeat) {
      clearInterval(repeat.task);
      client.repeats.delete(repeatId);
      saveJson(REPEATS_FILE, [...client.repeats.values()]);
      await interaction.reply({
        content: `🛑 Repeat \`${repeatId}\` stopped.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: `❌ Repeat ID \`${repeatId}\` not found.`,
        ephemeral: true,
      });
    }
  } else if (name === "commandlogs") {
    const filterUser = interaction.options.getUser("user");
    const logs =
      client.commandLogs
        .filter((l) => !filterUser || l.id === filterUser.id)
        .slice(-10)
        .reverse()
        .map((l) => `**${l.user}** used \`/${l.command}\` at ${l.time}`)
        .join("\n") || "No command logs found.";
    await interaction.reply({
      content: `📜 **Command Logs:**\n${logs}`,
      ephemeral: true,
    });
  } else if (name === "trainingresults") {
    const trainee = interaction.options.getUser("user");

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("selectTrainingStatus")
      .setPlaceholder("Select training result")
      .addOptions(
        { label: "PASS", value: "P" },
        { label: "FAIL", value: "F" },
        { label: "ON HOLD", value: "O" },
        { label: "PARTIAL RETAKE NEEDED", value: "R" },
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    client.selectedTrainees = client.selectedTrainees || {};
    client.selectedTrainees[interaction.user.id] = trainee;

    await interaction.reply({
      content: "Select a result for this training:",
      components: [row],
      ephemeral: true,
    });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === "selectTrainingStatus"
  ) {
    const status = interaction.values[0];
    const trainee = client.selectedTrainees?.[interaction.user.id];
    if (!trainee)
      return interaction.reply({
        content: "No trainee found.",
        ephemeral: true,
      });

    const modal = new ModalBuilder()
      .setCustomId("trainingNotesModal")
      .setTitle("FBI Training Result");

    const noteInput = new TextInputBuilder()
      .setCustomId("notes")
      .setLabel(
        status === "O"
          ? "Why was this put on hold?"
          : status === "R"
            ? "What needs to be retaken?"
            : "Instructor Notes",
      )
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(noteInput);
    modal.addComponents(row);
    interaction.client.trainingResults =
      interaction.client.trainingResults || {};
    interaction.client.trainingResults[interaction.user.id] = {
      trainee,
      status,
    };

    await interaction.showModal(modal);
  } else if (
    interaction.type === InteractionType.ModalSubmit &&
    interaction.customId === "trainingNotesModal"
  ) {
    const { trainee, status } =
      interaction.client.trainingResults?.[interaction.user.id] || {};
    if (!trainee)
      return interaction.reply({
        content: "No trainee selected.",
        ephemeral: true,
      });

    const notes = interaction.fields.getTextInputValue("notes");

    if (status === "F") {
      client.failCounts[trainee.id] = (client.failCounts[trainee.id] || 0) + 1;
      saveJson(FAILCOUNTS_FILE, client.failCounts);
    }

    const embed = {
      title: "📝 FBI BFTC Results",
      color: status === "P" ? 0x00ff00 : status === "F" ? 0xff0000 : 0xffaa00,
      fields: [
        { name: "👤 Trainee", value: `<@${trainee.id}>`, inline: false },
        {
          name: "📌 Status",
          value:
            status === "P"
              ? "✅ PASS"
              : status === "F"
                ? "❌ FAIL"
                : status === "O"
                  ? "⏸️ ON HOLD"
                  : "🔁 PARTIAL RETAKE NEEDED",
          inline: true,
        },
        {
          name:
            status === "O"
              ? "📥 Instructor Notes / Reason for On Hold"
              : status === "R"
                ? "📥 Sections to Retake"
                : "📥 Instructor Notes",
          value: notes,
          inline: false,
        },
        {
          name: "📘 Result Key",
          value: "P - PASS\nF - FAIL\nO - ON HOLD\nR - PARTIAL RETAKE NEEDED",
          inline: false,
        },
      ],
      timestamp: new Date(),
      footer: { text: "FBI Academy Training System" },
    };

    await interaction.reply({
      content: `<@${trainee.id}>`,
      embeds: [embed],
      allowedMentions: { users: [trainee.id] },
    });
  }
});

client.login(TOKEN);
