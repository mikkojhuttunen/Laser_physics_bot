const express = require("express");
const axios = require("axios");
const app = express();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ⚠️  PASTE YOUR FILE IDS HERE (from the upload script output)
const COURSE_FILE_IDS = [
  "file_01Uo9GgkC17USnGcpmkjchgG",  // Chapter_1.pdf
  "file_01NRxJzjFnsDjPA1XKCjTuXW",  // Chapter_2.pdf
  "file_01TuDbxbCaDyRaHQsdXb6voL",  // Chapter_3.pdf
  "file_015umkYefmRXrH57UUbtQ4WY",  // Chapter_4.pdf
  "file_01KnZ21SxA1sfB81BZGWVbta",  // FYS_501_Laser_HW1.pdf
  "file_015focJn87VMLB5cMJ2Zm4BR",  // FYS_501_Laser_HW2.pdf
  "file_0179vTFcpg3emMfxWEJpA2n2",  // FYS_501_Laser_HW3.pdf
  "file_01MGzrruE4EJP12DQi52vCpT",  // FYS_501_Laser_HW4.pdf
  "file_01BFtfVpugNTNy9WtFj8vkNd",  // FYS_501_Laser_HW5.pdf
  "file_01KSmX5oM9dM3uYBDVSGZvdq",  // FYS_501_Laser_HW6.pdf
  "file_0185k1dUXySjwQDvLGqgscBf",  // Laser_Physics_Slides.pdf
  "file_01UiXgPkoSU29saK2y9mMU15",  // ._Chapter_1.pdf
  "file_01Dfm6qKVDf4ektb6n3W1Ege",  // ._Chapter_2.pdf
  "file_017LryQkNbYYQKtaR9qYFyNQ",  // ._Chapter_3.pdf
  "file_01E9GtpduYB7M1ApnL2rZmPm",  // ._Chapter_4.pdf
  "file_01WUagFWn3oxbXeDegzbDwxK",  // ._FYS_501_Laser_HW1.pdf
  "file_018KmAvdM5Xp6UXa2P6gGm7D",  // ._FYS_501_Laser_HW2.pdf
  "file_01XFX6UoZx5a6JKBM8ys9V3u",  // ._FYS_501_Laser_HW3.pdf
  "file_019ScsAB9beWRdQRiAyqxSkd",  // ._FYS_501_Laser_HW4.pdf
  "file_01WZPa4wViL3vW9V8JwkSc3h",  // ._FYS_501_Laser_HW5.pdf
  "file_01JaXgJUkf26KKTvuZGZHy4c",  // ._FYS_501_Laser_HW6.pdf
  "file_01E9e6gjwiJoCZUVHGg5QtWK",  // ._Laser_Physics_Slides.pdf
];

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("=== NEW MESSAGE ===");
    
    const message = req.body.message;
    if (!message || !message.text) {
      console.log("Not a text message, ignoring");
      return res.sendStatus(200);
    }

    const studentQuestion = message.text;
    const chatId = message.chat.id;

    console.log("From chat:", chatId);
    console.log("Message:", studentQuestion);

    if (!ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is missing!");
      return res.sendStatus(200);
    }
    if (!TELEGRAM_TOKEN) {
      console.error("TELEGRAM_TOKEN is missing!");
      return res.sendStatus(200);
    }

    console.log("Calling Claude with course files...");
    
    // Build message content with file references
    const messageContent = [
      // Add all course files
      ...COURSE_FILE_IDS.map(fileId => ({
        type: "document",
        source: {
          type: "file",
          file_id: fileId
        }
      })),
      // Add the student's question
      {
        type: "text",
        text: studentQuestion
      }
    ];

    let claudeResponse;
    try {
      claudeResponse = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-opus-4-1",
          max_tokens: 1024,
          system: `You are a helpful teaching assistant for FYS.501 Laser Physics.

You have access to course materials including lecture notes, PDFs, and homework assignments.

Guidelines:
- For homework questions: provide guidance and hints, NOT complete solutions
- Ask students guiding questions to help them understand
- Reference the course materials when relevant
- Be encouraging and supportive
- Keep responses brief (2-3 paragraphs max for Telegram)`,
          messages: [
            {
              role: "user",
              content: messageContent
            }
          ]
        },
        {
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          }
        }
      );
      console.log("✓ Claude API successful");
    } catch (claudeError) {
      console.error("✗ Claude API failed");
      console.error("Status:", claudeError.response?.status);
      console.error("Error details:", JSON.stringify(claudeError.response?.data, null, 2));
      throw claudeError;
    }

    const botReply = claudeResponse.data.content[0].text;
    console.log("Claude replied:", botReply.substring(0, 50) + "...");

    console.log("Sending to Telegram...");
    try {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: botReply
        }
      );
      console.log("✓ Telegram API successful");
    } catch (telegramError) {
      console.error("✗ Telegram API failed");
      console.error("Status:", telegramError.response?.status);
      console.error("Error details:", JSON.stringify(telegramError.response?.data, null, 2));
      throw telegramError;
    }

    console.log("=== SUCCESS ===\n");
    res.sendStatus(200);

  } catch (error) {
    console.error("FINAL ERROR:", error.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});      return res.sendStatus(200);
    }

    // Test 2: Call Claude API
    console.log("Calling Claude...");
    let claudeResponse;
    try {
      claudeResponse = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: "You are a helpful teaching assistant. Keep answers brief.",
          messages: [{ role: "user", content: studentQuestion }]
        },
        { 
          headers: { 
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          } 
        }
      );
      console.log("✓ Claude API successful");
    } catch (claudeError) {
      console.error("✗ Claude API failed");
      console.error("Status:", claudeError.response?.status);
      console.error("Error details:", JSON.stringify(claudeError.response?.data, null, 2));
      throw claudeError;
    }

    const botReply = claudeResponse.data.content[0].text;
    console.log("Claude replied:", botReply.substring(0, 50) + "...");

    // Test 3: Send to Telegram
    console.log("Sending to Telegram...");
    try {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { 
          chat_id: chatId, 
          text: botReply
        }
      );
      console.log("✓ Telegram API successful");
    } catch (telegramError) {
      console.error("✗ Telegram API failed");
      console.error("Status:", telegramError.response?.status);
      console.error("Error details:", JSON.stringify(telegramError.response?.data, null, 2));
      throw telegramError;
    }

    console.log("=== SUCCESS ===\n");
    res.sendStatus(200);

  } catch (error) {
    console.error("FINAL ERROR:", error.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
