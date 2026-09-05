const express = require("express");
const axios = require("axios");
const app = express();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PROJECT_ID = process.env.PROJECT_ID;

app.use(express.json());

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const studentQuestion = message.text;
    const chatId = message.chat.id;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-opus-4-1",
        max_tokens: 1024,
        system: `You are a helpful teaching assistant.\nFor homework: provide guidance and hints, NOT complete solutions.\nBe encouraging and supportive.\nKeep responses concise.`,
        messages: [{ role: "user", content: studentQuestion }]
      },
      { headers: { "x-api-key": ANTHROPIC_API_KEY } }
    );

    const botReply = response.data.content[0].text;
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: chatId, text: botReply, reply_to_message_id: message.message_id }
    );
    res.sendStatus(200);
  } catch (error) {
    console.error("Error:", error.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
