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
} from "discord.js";
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.get("/", (_req, res) => res.send("Bot is online."));
app.listen(3000, () => console.log("🌐 Web server running for uptime"));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.repeats = new Map();
client.repeatIdCounter = 1;
client.commandLogs = [];
client.failCounts = {};

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
});

function hasFullAccess(interaction) {
  const id = interaction.user.id;
  if (id === ALLOWED_USER_ID || id === ALLOWED_USER_ID_2) return true;
  const roles = interaction.member.roles.cache;
  return roles.has(COMMAND_ROLE) || roles.has(SUPERVISOR_ROLE);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  const id = interaction.user.id;
  client.commandLogs.push({
    command: name,
    user: interaction.user.tag,
    id,
    time: new Date().toLocaleString(),
  });

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

    await interaction.reply({
      content: `✅ Message sent${repeat ? " and will repeat." : "."}`,
      ephemeral: true,
    });
    await interaction.channel.send(message);

    if (repeat && interval) {
      const repeatId = `repeat_${client.repeatIdCounter++}`;
      const task = setInterval(() => {
        interaction.channel.send(message);
      }, interval * 60000);

      client.repeats.set(repeatId, task);

      await interaction.followUp({
        content: `🔁 Repeating every ${interval} min.\n**Repeat ID:** \`${repeatId}\``,
        ephemeral: true,
      });
    }
  } else if (name === "stoprepeat") {
    const repeatId = interaction.options.getString("id");
    if (client.repeats.has(repeatId)) {
      clearInterval(client.repeats.get(repeatId));
      client.repeats.delete(repeatId);
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
    interaction.isModalSubmit() &&
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
