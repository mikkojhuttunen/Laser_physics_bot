/**
 * FYS.501 Laser Physics — Telegram teaching-assistant bot
 *
 * Key differences from the crashing version:
 *   1. Course material is sent as CACHED TEXT in the system prompt, not as 11 PDFs
 *      re-uploaded on every single message.
 *   2. Telegram is acknowledged (HTTP 200) IMMEDIATELY, before Claude is called.
 *      This is what stopped the webhook-retry storm that was killing the container.
 *   3. Duplicate updates, long replies, rate limits and API errors are all handled.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------- config ----
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";        // optional, see README
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CACHE_TTL = process.env.CACHE_TTL || "1h";                // "1h" or "5m"
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "900", 10);
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ------------------------------------------------------- course material ----
// Loaded ONCE at startup. Regenerate with `node build_corpus.js` if the PDFs change.
const CORPUS_PATH = path.join(__dirname, "course_corpus.txt");
let COURSE_CORPUS = "";
try {
  COURSE_CORPUS = fs.readFileSync(CORPUS_PATH, "utf8");
  console.log(
    `Loaded course corpus: ${COURSE_CORPUS.length.toLocaleString()} chars ` +
    `(~${Math.round(COURSE_CORPUS.length / 3.7).toLocaleString()} tokens)`
  );
} catch (e) {
  console.error(`FATAL: could not read ${CORPUS_PATH} — ${e.message}`);
  console.error("The bot will still start but will have no course knowledge.");
}

const TA_INSTRUCTIONS = `You are the teaching assistant bot for FYS.501 Laser Physics, answering in Telegram.

WHAT YOU KNOW
Course material: lecture slides, textbook Chapters 1–4, homework assignment sheets. Ground answers in this material and cite which chapter/section. You do NOT have homework solutions.

HOW TO ANSWER — ABSOLUTE RULES
1. **LENGTH**: ONE OR TWO SHORT SENTENCES/PARAGRAPH ONLY. Never use section headers, bullets, tables, or sub-points. No "Step 1, Step 2". No "Key insight:". Just talk to them like a person.

2. **HOMEWORK**: Give hints, not answers. Name the relevant equation or concept, point to the section, ask ONE guiding question. Example: "That uses the lensmaker's equation from Chapter 3.2. What happens when you set d→0?" Don't explain the whole path.

3. **CONCEPTUAL**: Answer directly and briefly. Full but concise. If someone asks "what is stimulated emission?", answer it in 2 sentences.

4. **MATH NOTATION** — CRITICAL:
   - Use UNICODE SYMBOLS ONLY: α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω
   - Use superscript ¹²³⁴ for exponents, subscript ₁₂₃₄ for indices
   - Write fractions as: a/b or use ÷
   - Write as inline text: "q = hc(1/λₚ - 1/λ₀)" NOT "q = hc\\left(\\frac{1}{\\lambda_p}..."
   - NO dollar signs $...$ anywhere, NO backslashes, NO braces {}
   - Acceptable for complex expressions: "N₂ > (g₂/g₁)N₁" or "(ω - ω₀)/Δω"

5. **STUDENT ATTEMPTS**: If they show work, check it quickly, point at one specific error if there is one. Don't rewrite the whole thing.

6. **REDIRECT**: If it's outside course scope, say "That's beyond FYS.501, ask Mikko" (don't lecture).

7. **LANGUAGE**: Respond in the language they use (English or Finnish).

TONE: Encouraging, conversational, brief. These are hard topics; students asking are doing the right thing.`;

function buildSystemBlocks() {
  const blocks = [{ type: "text", text: TA_INSTRUCTIONS }];
  if (COURSE_CORPUS) {
    blocks.push({
      // The big, unchanging block goes LAST and carries the cache breakpoint,
      // so it is billed at the cheap cache-read rate on every subsequent call.
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
const SYSTEM_BLOCKS = buildSystemBlocks();

const ANTHROPIC_HEADERS = {
  "x-api-key": ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  ...(CACHE_TTL === "1h" ? { "anthropic-beta": "extended-cache-ttl-2025-04-11" } : {}),
};

// ------------------------------------------------------- tiny state store ----
const seenUpdates = new Set();           // de-duplicate Telegram retries
const history = new Map();               // chatId -> [{role, content}, ...]
const lastCall = new Map();              // userId -> timestamp (rate limit)
const HISTORY_TURNS = 6;                 // 3 exchanges
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
  // Telegram hard-caps messages at 4096 characters.
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
      // Retry only on transient failures.
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
  if (type === "private") return true;                                  // DMs: always
  if (/^\//.test(text)) return true;                                    // commands
  if (BOT_USERNAME && text.toLowerCase().includes("@" + BOT_USERNAME)) return true;
  if (message.reply_to_message?.from?.is_bot) return true;              // replying to us
  return false;                                                          // otherwise stay quiet
}

function stripMention(text) {
  return text
    .replace(new RegExp(`@${BOT_USERNAME}`, "ig"), "")
    .replace(/^\/(ask|help|start|reset)(@\S+)?\s*/i, "")
    .trim();
}

const HELP_TEXT =
  "Hi! I'm the FYS.501 Laser Physics assistant. I know the lecture slides, " +
  "textbook Chapters 1-4 and the six homework sheets.\n\n" +
  "Ask me things like:\n" +
  "- What is the difference between a stable and unstable resonator?\n" +
  "- I'm stuck on HW3 question 2, where do I start?\n" +
  "- Explain the ABCD matrix for a thick lens\n\n" +
  "I'll give you hints and point you to the right section, but I won't hand you " +
  "finished homework solutions. Show me your attempt and I'll check your reasoning.\n\n" +
  "/reset clears our conversation history.";

// ------------------------------------------------------------- webhook ------
app.get("/", (_req, res) => res.send("Laser Physics bot is running"));
app.get("/healthz", (_req, res) => res.json({ ok: true, corpusChars: COURSE_CORPUS.length }));

app.post("/webhook", (req, res) => {
  // 1) Acknowledge Telegram FIRST. Everything below runs after the response.
  if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  // 2) Handle the update asynchronously.
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
app.listen(PORT, () => console.log(`Bot listening on port ${PORT} | model=${MODEL} | cache=${CACHE_TTL}`));
  console.log(
    `Loaded course corpus: ${COURSE_CORPUS.length.toLocaleString()} chars ` +
    `(~${Math.round(COURSE_CORPUS.length / 3.7).toLocaleString()} tokens)`
  );
} catch (e) {
  console.error(`FATAL: could not read ${CORPUS_PATH} — ${e.message}`);
  console.error("The bot will still start but will have no course knowledge.");
}

const TA_INSTRUCTIONS = `You are the teaching assistant bot for FYS.501 Laser Physics, answering students in a Telegram group.

WHAT YOU KNOW
The course material below is the full text of the lecture slides, textbook Chapters 1-4, and the six homework assignment sheets. Ground your answers in it and say which chapter or slide section a result comes from so students can look it up. You do NOT have the homework solutions, and you must never claim to.

HOW TO HELP
- Homework questions: guide, do not solve. Name the relevant concept, point to the section of the material, restate what is being asked, and suggest the first step or the governing equation. Then hand it back with a question: "What do you get when you multiply those two matrices?" / "What happens to the stability condition if L > 2R?"
- If a student asks outright for the full worked answer, redirect warmly: "I can walk you through it, but the working needs to be yours. Let's start with..."
- If a student shows their own attempt, that changes things: check their reasoning, point at the specific line where it goes wrong, and explain why.
- Conceptual questions (not graded homework): answer them properly and fully. Being stingy here helps nobody.
- Be encouraging. These are hard topics and students asking questions are doing the right thing.

FORMAT
- Plain text for Telegram. No markdown headers, no bold, no LaTeX delimiters. Write equations in readable inline form: "1/f = (n-1)(1/R1 - 1/R2)".
- 2-3 short paragraphs maximum. Brevity matters more than completeness here; students can ask a follow-up.
- Answer in the language the student writes in (English or Finnish).

LIMITS
- If something is outside the course scope, say so briefly and point them to the lecturer.
- Some maths symbols in the extracted chapter text are garbled by PDF extraction. Read them from context and never invent a formula you cannot find. If you are unsure, say so and tell the student which page to check.`;

function buildSystemBlocks() {
  const blocks = [{ type: "text", text: TA_INSTRUCTIONS }];
  if (COURSE_CORPUS) {
    blocks.push({
      // The big, unchanging block goes LAST and carries the cache breakpoint,
      // so it is billed at the cheap cache-read rate on every subsequent call.
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
const SYSTEM_BLOCKS = buildSystemBlocks();

const ANTHROPIC_HEADERS = {
  "x-api-key": ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  ...(CACHE_TTL === "1h" ? { "anthropic-beta": "extended-cache-ttl-2025-04-11" } : {}),
};

// ------------------------------------------------------- tiny state store ----
const seenUpdates = new Set();           // de-duplicate Telegram retries
const history = new Map();               // chatId -> [{role, content}, ...]
const lastCall = new Map();              // userId -> timestamp (rate limit)
const HISTORY_TURNS = 6;                 // 3 exchanges
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
  // Telegram hard-caps messages at 4096 characters.
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
      // Retry only on transient failures.
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
  if (type === "private") return true;                                  // DMs: always
  if (/^\//.test(text)) return true;                                    // commands
  if (BOT_USERNAME && text.toLowerCase().includes("@" + BOT_USERNAME)) return true;
  if (message.reply_to_message?.from?.is_bot) return true;              // replying to us
  return false;                                                          // otherwise stay quiet
}

function stripMention(text) {
  return text
    .replace(new RegExp(`@${BOT_USERNAME}`, "ig"), "")
    .replace(/^\/(ask|help|start|reset)(@\S+)?\s*/i, "")
    .trim();
}

const HELP_TEXT =
  "Hi! I'm the FYS.501 Laser Physics assistant. I know the lecture slides, " +
  "textbook Chapters 1-4 and the six homework sheets.\n\n" +
  "Ask me things like:\n" +
  "- What is the difference between a stable and unstable resonator?\n" +
  "- I'm stuck on HW3 question 2, where do I start?\n" +
  "- Explain the ABCD matrix for a thick lens\n\n" +
  "I'll give you hints and point you to the right section, but I won't hand you " +
  "finished homework solutions. Show me your attempt and I'll check your reasoning.\n\n" +
  "/reset clears our conversation history.";

// ------------------------------------------------------------- webhook ------
app.get("/", (_req, res) => res.send("Laser Physics bot is running"));
app.get("/healthz", (_req, res) => res.json({ ok: true, corpusChars: COURSE_CORPUS.length }));

app.post("/webhook", (req, res) => {
  // 1) Acknowledge Telegram FIRST. Everything below runs after the response.
  if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  // 2) Handle the update asynchronously.
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
app.listen(PORT, () => console.log(`Bot listening on port ${PORT} | model=${MODEL} | cache=${CACHE_TTL}`));
