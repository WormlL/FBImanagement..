import express from "express";

if (process.env.STATE === "DEVELOPMENT") {
  const app = express();

  app.get("/", (req, res) => {
    res.send("Bot is alive!");
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Web server running on port ${PORT}`);
  });
}
