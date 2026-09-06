/**
 * FYS.501 Laser Physics — Telegram teaching-assistant bot
 * With video references integration for FYS.240 Optics and FYS.501 Laser Physics
 *
 * Key features:
 *   1. Course material from course_corpus.txt (cached)
 *   2. Video references for direct playlist/video links
 *   3. LaTeX equation rendering (optional)
 *   4. Conversation history & rate limiting
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const { extractAndSendLatex } = require("./latex-renderer");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------- config ----
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CACHE_TTL = process.env.CACHE_TTL || "1h";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "900", 10);
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();
const LATEX_ENABLED = process.env.LATEX_ENABLED !== "false";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ------------------------------------------------------- course material ----
const CORPUS_PATH = path.join(__dirname, "course_corpus.txt");
let COURSE_CORPUS = "";
try {
  COURSE_CORPUS = fs.readFileSync(CORPUS_PATH, "utf8");
  console.log(
    `Loaded course corpus: ${COURSE_CORPUS.length.toLocaleString()} chars ` +
    `(~${Math.round(COURSE_CORPUS.length / 3.7).toLocaleString()} tokens)`
  );
} catch (e) {
  console.error(`WARNING: could not read ${CORPUS_PATH} — ${e.message}`);
}

// ------------------------------------------------- video references ----
const VIDEO_REFS_PATH = path.join(__dirname, "video_references.json");
let VIDEO_REFERENCES = {};
try {
  VIDEO_REFERENCES = JSON.parse(fs.readFileSync(VIDEO_REFS_PATH, "utf8"));
  console.log(
    `Loaded video references: ${Object.keys(VIDEO_REFERENCES.courses).length} courses`
  );
} catch (e) {
  console.error(`WARNING: could not read ${VIDEO_REFS_PATH} — ${e.message}`);
  console.error("Bot will work without video reference suggestions.");
}

// ------------------------------------------------------ build system ----
const TA_INSTRUCTIONS = `You are the teaching assistant bot for FYS.501 Laser Physics, answering students in a Telegram group.

WHAT YOU KNOW
- Course material: lecture slides, textbook Chapters 1–4, homework assignment sheets
- Video resources: 
  * FYS.240 Optics: playlists organized by chapter (2-10)
  * FYS.501 Laser Physics: individual video lectures organized by chapter and topic
- Ground answers in course material and cite which chapter/section
- You do NOT have homework solutions

WHEN TO SUGGEST VIDEOS
If a student asks about a topic that's covered in videos, suggest the relevant video/playlist:
- For FYS.240: "That's covered in Chapter X of the Optics course. Watch the playlist: [link]"
- For FYS.501: "Check out this video on [topic]: [link]"
- For related topics: "You might also find this helpful: [link]"

HOW TO HELP
**LENGTH**: ONE OR TWO SHORT SENTENCES/PARAGRAPH ONLY. Never use section headers, bullets, tables, or sub-points. No "Step 1, Step 2". No "Key insight:". Just talk to them like a person.
**HOMEWORK**: Give hints, not answers. Name the relevant equation or concept, point to the section, suggest a video if available, ask ONE guiding question.
**CONCEPTUAL**: Answer directly and briefly. If they ask about something that has a video, mention it: "That's explained in Video X.X: [link]. In short, ..."
**VIDEO REFERENCES**: When appropriate, include direct YouTube links. Say which chapter/video number so they can find it easily.
**STUDENT ATTEMPTS**: If they show work, check it quickly, point at one specific error. Don't rewrite the whole thing.
**REDIRECT**: If it's outside course scope, say "That's beyond FYS.501, ask Mikko during discussions".

FORMAT
- Plain text for Telegram.
${LATEX_ENABLED 
  ? `- Write EQUATIONS in LaTeX between double dollar signs: $$E = mc^2$$
- These will be automatically rendered as readable images`
  : `- Use UNICODE SYMBOLS ONLY: α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω`
}
- Include YouTube links when suggesting videos
- 2-3 short paragraphs maximum
- Answer in the language the student writes in (English or Finnish)

LIMITS
- Some maths symbols in extracted chapter text are garbled; read them from context
- Some video topics may be outside the exact course — use judgment`;

function buildSystemBlocks() {
  const blocks = [{ type: "text", text: TA_INSTRUCTIONS }];
  
  // Add video references context
  if (Object.keys(VIDEO_REFERENCES).length > 0) {
    const videoContext = formatVideoReferences(VIDEO_REFERENCES);
    blocks.push({ type: "text", text: videoContext });
  }
  
  if (COURSE_CORPUS) {
    blocks.push({
      type: "text",
      text: `<course_material>\n${COURSE_CORPUS}\n</course_material>`,
      cache_control:
        CACHE_TTL === "1h"
          ? { type: "ephemeral", ttl: "1h" }
          : { type: "ephemeral" },
    });
  }
  return blocks;
}

/**
 * Format video references for inclusion in system prompt
 */
function formatVideoReferences(refs) {
  let context = "\n<video_resources>\n";
  
  context += `## Available Video Resources\n`;
  context += `Channel: ${refs.channel.handle} (${refs.channel.url})\n\n`;
  
  // FYS.240
  if (refs.courses.FYS240) {
    context += `### FYS.240 Optics (Optiikka) - Playlists by Chapter\n`;
    const chapters = refs.courses.FYS240.chapters;
    for (const [ch, url] of Object.entries(chapters)) {
      context += `Chapter ${ch}: ${url}\n`;
    }
    context += "\n";
  }
  
  // FYS.501
  if (refs.courses.FYS501) {
    context += `### FYS.501 Laser Physics - Individual Videos\n`;
    context += `Intro: ${refs.courses.FYS501.intro.url}\n\n`;
    
    for (const [chNum, chapter] of Object.entries(refs.courses.FYS501.chapters)) {
      context += `**Chapter ${chNum}: ${chapter.title}**\n`;
      for (const [vidNum, video] of Object.entries(chapter.videos)) {
        context += `  ${vidNum}: ${video.title} - ${video.url}\n`;
      }
      context += "\n";
    }
    
    // Topic index
    context += `**Quick Topic Index:**\n`;
    for (const [topic, videoNums] of Object.entries(refs.courses.FYS501.topics)) {
      context += `  ${topic}: videos ${videoNums.join(", ")}\n`;
    }
  }
  
  context += "\n</video_resources>\n";
  return context;
}

const SYSTEM_BLOCKS = buildSystemBlocks();

const ANTHROPIC_HEADERS = {
  "x-api-key": ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  ...(CACHE_TTL === "1h" ? { "anthropic-beta": "extended-cache-ttl-2025-04-11" } : {}),
};

// ------------------------------------------------------- tiny state store ----
const seenUpdates = new Set();
const history = new Map();
const lastCall = new Map();
const HISTORY_TURNS = 6;
const MIN_INTERVAL_MS = 4000;

function remember(chatId, role, content) {
  const h = history.get(chatId) || [];
  h.push({ role, content });
  history.set(chatId, h.slice(-HISTORY_TURNS));
}

// ------------------------------------------------------------- telegram -----
async function tg(method, payload) {
  return axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 15000 });
}

async function sendMessage(chatId, text, replyTo) {
  if (LATEX_ENABLED) {
    await extractAndSendLatex(tg, chatId, text, replyTo).catch((e) => {
      console.error("extractAndSendLatex failed:", e.message);
    });
  } else {
    const chunks = [];
    let rest = text.trim();
    while (rest.length > 4000) {
      let cut = rest.lastIndexOf("\n\n", 4000);
      if (cut < 2000) cut = rest.lastIndexOf(" ", 4000);
      if (cut < 2000) cut = 4000;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    chunks.push(rest);

    for (const chunk of chunks) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: chunk,
        reply_to_message_id: replyTo,
        allow_sending_without_reply: true,
        disable_web_page_preview: true,
      }).catch((e) =>
        console.error("Telegram sendMessage failed:", e.response?.status, JSON.stringify(e.response?.data))
      );
    }
  }
}

// --------------------------------------------------------------- claude -----
async function askClaude(chatId, question) {
  const messages = [...(history.get(chatId) || []), { role: "user", content: question }];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_BLOCKS, messages },
        { headers: ANTHROPIC_HEADERS, timeout: 120000 }
      );

      const u = res.data.usage || {};
      console.log(
        `Claude ok | in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens || 0} ` +
        `cache_read=${u.cache_read_input_tokens || 0} out=${u.output_tokens}`
      );

      return res.data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch (err) {
      const status = err.response?.status;
      console.error(
        `Claude attempt ${attempt + 1} failed | status=${status} |`,
        JSON.stringify(err.response?.data || err.message)
      );
      if (status === 429 || status === 500 || status === 529 || err.code === "ECONNABORTED") {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Claude unavailable after 3 attempts");
}

// -------------------------------------------------------------- routing -----
function shouldAnswer(message) {
  const type = message.chat.type;
  const text = message.text || "";
  if (type === "private") return true;
  if (/^\//.test(text)) return true;
  if (BOT_USERNAME && text.toLowerCase().includes("@" + BOT_USERNAME)) return true;
  if (message.reply_to_message?.from?.is_bot) return true;
  return false;
}

function stripMention(text) {
  return text
    .replace(new RegExp(`@${BOT_USERNAME}`, "ig"), "")
    .replace(/^\/(ask|help|start|reset)(@\S+)?\s*/i, "")
    .trim();
}

const HELP_TEXT =
  "Hi! I'm the FYS.501 Laser Physics assistant. I know the lecture slides, " +
  "textbook Chapters 1-4, homework sheets, AND video lectures.\n\n" +
  "Ask me things like:\n" +
  "- What is the difference between a stable and unstable resonator?\n" +
  "- I'm stuck on HW3 question 2, where do I start?\n" +
  "- Explain the ABCD matrix for a thick lens\n\n" +
  "I'll give you hints, point you to relevant videos or textbook sections, " +
  "and ask guiding questions. I won't give you finished homework solutions, " +
  "but I'll check your reasoning if you show your work.\n\n" +
  "/reset clears our conversation history.";

// ------------------------------------------------------------- webhook ------
app.get("/", (_req, res) => res.send("Laser Physics bot is running"));
app.get("/healthz", (_req, res) => res.json({ 
  ok: true, 
  corpusChars: COURSE_CORPUS.length,
  videoCoursesLoaded: Object.keys(VIDEO_REFERENCES.courses || {}).length,
  latexEnabled: LATEX_ENABLED 
}));

app.post("/webhook", (req, res) => {
  if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  handleUpdate(req.body).catch((e) => console.error("handleUpdate crashed:", e.message));
});

async function handleUpdate(update) {
  const message = update?.message;
  if (!message || !message.text) return;

  if (seenUpdates.has(update.update_id)) return;
  seenUpdates.add(update.update_id);
  if (seenUpdates.size > 1000) seenUpdates.clear();

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text.trim();

  if (!shouldAnswer(message)) return;

  if (/^\/(start|help)/i.test(text)) return sendMessage(chatId, HELP_TEXT);
  if (/^\/reset/i.test(text)) {
    history.delete(chatId);
    return sendMessage(chatId, "Conversation history cleared. Ask me anything.");
  }

  const question = stripMention(text);
  if (question.length < 3) return;

  const now = Date.now();
  if (now - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
  lastCall.set(userId, now);

  console.log(`[${message.chat.type}:${chatId}] ${question.slice(0, 120)}`);

  await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const reply = await askClaude(chatId, question);
    remember(chatId, "user", question);
    remember(chatId, "assistant", reply);
    await sendMessage(chatId, reply, message.message_id);
  } catch (e) {
    await sendMessage(
      chatId,
      "Sorry, I couldn't reach my brain just now. Please try again in a moment.",
      message.message_id
    );
  }
}

// ---------------------------------------------------------------- start -----
if (!TELEGRAM_TOKEN) console.error("WARNING: TELEGRAM_TOKEN is not set");
if (!ANTHROPIC_API_KEY) console.error("WARNING: ANTHROPIC_API_KEY is not set");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const latexStatus = LATEX_ENABLED ? "ENABLED ✓" : "disabled";
  const videoStatus = Object.keys(VIDEO_REFERENCES.courses || {}).length > 0 ? "✓" : "⚠";
  console.log(
    `Bot listening on port ${PORT} | model=${MODEL} | cache=${CACHE_TTL} | ` +
    `LaTeX=${latexStatus} | Videos=${videoStatus}`
  );
});
