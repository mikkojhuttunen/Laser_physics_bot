/**
 * FYS.501 Laser Physics — Telegram teaching-assistant bot
 *
 * Key differences from the crashing version:
 *   1. Course material is sent as CACHED TEXT in the system prompt, not as 11 PDFs
 *      re-uploaded on every single message.
 *   2. Telegram is acknowledged (HTTP 200) IMMEDIATELY, before Claude is called.
 *      This is what stopped the webhook-retry storm that was killing the container.
 *   3. Duplicate updates, long replies, rate limits and API errors are all handled.
 *
 * HOMEWORK-HELPER COMMANDS (added):
 *   /HW3          — overview: lists the problems in Homework 3
 *   /HW3.2        — hint on Homework 3, problem 2 (equation/section pointer + guiding question)
 *   /HW_hint3.2   — minimal nudge: one guiding question, nothing else
 *   photo message — quick "right track / wrong track" read on a work-in-progress photo;
 *                   caption it with a problem reference (e.g. "/HW3.2") for best results.
 *   None of these reveal solutions — same no-solutions rule as the rest of the bot.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const quizGenerator = require("./quizGenerator_fys501");
const corpusLoader = require("./corpusLoader_fys501");
const lectureLinks = require("./lectureLinks_fys501");

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
const CORPUS_PATH = path.join(__dirname, "course_corpus_fys501.txt");
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

// Exact per-problem text, keyed "<hw>" -> "<problem>" -> text, e.g. HOMEWORK_PROBLEMS["1"]["2"].
// Built by build_corpus.js from problems numbered "<hw>.<n>" in the HW PDFs.
// Optional: if missing/empty, /HW commands fall back to letting Claude search the full corpus.
const HW_PROBLEMS_PATH = path.join(__dirname, "homework_problems_fys501.json");
let HOMEWORK_PROBLEMS = {};
try {
  HOMEWORK_PROBLEMS = JSON.parse(fs.readFileSync(HW_PROBLEMS_PATH, "utf8"));
  const total = Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0);
  console.log(`Loaded homework_problems_fys501.json: ${total} problems across ${Object.keys(HOMEWORK_PROBLEMS).length} homeworks`);
} catch (e) {
  console.log(`No homework_problems_fys501.json found (${e.code || e.message}) — /HW commands will fall back to full-corpus search.`);
}

// Lecture video links, keyed by week (lecture_data-2.json). Loaded once at
// startup, same pattern as the corpus and homework problems above.
lectureLinks.loadLectureData();


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

WHEN TO SUGGEST VIDEOS
If a student asks a conceptual or homework question that's covered in a lecture video, weave in the relevant one:
- Check the <video_lectures> list below for a title matching the topic
- Write it as a Markdown link with the video title as the clickable label, e.g.:
  "That's covered in [Laser Physics 3.2 — Cavity Modes](https://youtube.com/watch?v=abc123)."
- ALWAYS use this exact [Title](URL) format — never write the raw URL on its own, after a colon, or after a dash
- Don't force a link where none genuinely fits; one relevant link is usually enough

TONE: Encouraging, conversational, brief. These are hard topics; students asking are doing the right thing.`;

/**
 * Format the lecture video database for inclusion in the system prompt, so
 * Claude can weave a relevant [Title](URL) link into an ordinary conceptual
 * answer — same pattern as the FYS.240 bot's formatVideoDatabase(). This is
 * separate from lectureLinks.js's own STAGE1_TRIGGER path, which still
 * handles explicit "any video on X?" / "/lectures" requests deterministically
 * without involving Claude.
 */
function formatVideoDatabase() {
  const weeks = lectureLinks.getAllWeeks();
  if (!weeks.length) return "";
  let context = "\n<video_lectures>\n";
  context += "## FYS.501 Laser Physics - Lecture Videos\n\n";
  weeks.forEach((week) => {
    week.lectures.forEach((lec) => {
      context += `Week ${week.week} (${week.topic}): ${lec.title} - ${lec.url}\n`;
    });
  });
  context += "\n</video_lectures>\n";
  return context;
}

function buildSystemBlocks() {
  const blocks = [{ type: "text", text: TA_INSTRUCTIONS }];

  const videoContext = formatVideoDatabase();
  if (videoContext) {
    blocks.push({ type: "text", text: videoContext });
  }

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

// Converts one run of Unicode Mathematical Alphanumeric characters for a
// given style. Digits have no dedicated "italic" codepoints in Unicode, so
// italic digits are left as plain ASCII; lowercase italic "h" has no
// codepoint of its own either (Unicode reserves that slot), so it maps to
// the pre-existing PLANCK CONSTANT compatibility character (ℎ, U+210E)
// instead, which is the standard workaround.
function toMathUnicode(inner, style) {
  let out = "";
  for (const ch of inner) {
    const code = ch.codePointAt(0);
    if (style === "bold") {
      if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d400 + (code - 0x41));      // A-Z
      else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d41a + (code - 0x61)); // a-z
      else if (code >= 0x30 && code <= 0x39) out += String.fromCodePoint(0x1d7ce + (code - 0x30)); // 0-9
      else out += ch;
    } else if (style === "italic") {
      if (ch === "h") out += "\u210e";                                                             // italic h exception
      else if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d434 + (code - 0x41));  // A-Z
      else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d44e + (code - 0x61));  // a-z
      else out += ch;                                                                               // no italic digits exist
    } else { // "bolditalic"
      if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d468 + (code - 0x41));      // A-Z
      else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d482 + (code - 0x61)); // a-z
      else if (code >= 0x30 && code <= 0x39) out += String.fromCodePoint(0x1d7ce + (code - 0x30)); // 0-9 (reuses bold digits)
      else out += ch;
    }
  }
  return out;
}

// Converts Claude's Markdown emphasis into real Unicode styled characters,
// since Telegram is sent parse_mode "HTML" here and asterisks otherwise show
// up literally to students. Claude reaches for both "*single*" (italic) and
// "**double**" (bold) inconsistently for emphasizing symbols/variable names
// (e.g. *N_i*, **A**, **B**), so both are handled, plus "***triple***" for
// completeness. Order matters: match longest marker first, since by the time
// we get to the single-* pass, all ** and *** runs have already been
// replaced with plain Unicode characters (no asterisks left to confuse it).
function markdownEmphasisToUnicode(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, inner) => toMathUnicode(inner, "bolditalic"));
  text = text.replace(/\*\*(.+?)\*\*/g, (_, inner) => toMathUnicode(inner, "bold"));
  text = text.replace(/\*(.+?)\*/g, (_, inner) => toMathUnicode(inner, "italic"));
  return text;
}

// Escapes text for safe use inside a Telegram HTML parse_mode message.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Converts any "[label](url)" Markdown links in Claude's text into real
// Telegram HTML <a> tags, and HTML-escapes everything else in the chunk so
// it's safe to send with parse_mode: "HTML". Links are pulled out into
// placeholders BEFORE escaping so neither the label nor the URL get their
// &/</> characters mangled, then the <a> tags are spliced back in after.
// NOTE: Claude is never given lecture video URLs in this bot (that's kept
// deterministic via lectureLinks.js/lectureClassifier.js on purpose), so
// this is a safety net for any incidental link Claude's text ends up with
// (e.g. quoting something from the corpus) rather than a video-suggestion
// feature — it just means such a link renders as clickable text instead of
// literal brackets, same fix as the FYS.240 bot.
function convertLinksAndEscape(text) {
  const links = [];
  const withPlaceholders = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => {
      links.push({ label, url });
      return `\u0000${links.length - 1}\u0000`;
    }
  );
  let escaped = escapeHtml(withPlaceholders);
  links.forEach((link, i) => {
    const anchor = `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`;
    escaped = escaped.replace(`\u0000${i}\u0000`, anchor);
  });
  return escaped;
}

async function sendMessage(chatId, text, replyTo, parseMode) {
  // Callers that already built final HTML themselves (lectureLinks output,
  // etc.) pass parseMode: "HTML" explicitly and are sent as-is below. Any
  // other call is raw text (Claude's replies, plain status strings) that
  // may contain a Markdown "[label](url)" link — convert + escape it and
  // force parse_mode "HTML" so a link renders as clickable text rather than
  // literal brackets. Harmless no-op for text with no links or HTML chars.
  if (!parseMode) {
    text = markdownEmphasisToUnicode(text);
    text = convertLinksAndEscape(text);
    parseMode = "HTML";
  }

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
      parse_mode: parseMode,
      reply_to_message_id: replyTo,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    }).catch((e) =>
      console.error("Telegram sendMessage failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  }
}

// ---------------------------------------------------- quiz bot adapter -----
// quizGenerator.js expects a small node-telegram-bot-api-shaped `bot`
// object (sendMessage/editMessageText/answerCallbackQuery). This bot_fys501.js
// talks to Telegram directly via axios (tg()) rather than that library, so
// this adapter bridges the two without adding a new dependency.
const quizBot = {
  async sendMessage(chatId, text, opts = {}) {
    return tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
    }).catch((e) =>
      console.error("Telegram sendMessage (quiz) failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  },
  async editMessageText(text, opts = {}) {
    return tg("editMessageText", {
      chat_id: opts.chat_id,
      message_id: opts.message_id,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
    }).catch((e) =>
      console.error("Telegram editMessageText (quiz) failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  },
  async answerCallbackQuery(callbackQueryId, opts = {}) {
    return tg("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: opts.text,
    }).catch((e) =>
      console.error("Telegram answerCallbackQuery failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  },
};

// Called by quizGenerator.startQuiz() when the student didn't name a
// chapter/section (e.g. just typed "quiz me"). Presents an inline-keyboard
// chapter picker; the actual quiz is kicked off from the "quizchapter:N"
// callback handled in handleCallbackQuery() below. Returning null here tells
// startQuiz() to stop — there's nothing more for it to do until the student
// taps a button.
async function askWhichChapter(bot, chatId) {
  await bot.sendMessage(chatId, "Which chapter would you like to be quizzed on?", {
    reply_markup: {
      inline_keyboard: corpusLoader.listChapters().map((ch) => ([
        { text: `Chapter ${ch} — ${corpusLoader.getChapterTitle(ch)}`, callback_data: `quizchapter:${ch}` },
      ])),
    },
  });
  return null;
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

// ----------------------------------------------------------- claude vision --
// Separate from askClaude(): image checks are one-off (not multi-turn history),
// use a fixed low token budget, and never get logged/stored as chat history.
const VISION_MODEL = process.env.VISION_MODEL || MODEL;
const VISION_MAX_TOKENS = 300;

async function askClaudeVision(imageBase64, mediaType, directive) {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: directive },
      ],
    },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: VISION_MODEL, max_tokens: VISION_MAX_TOKENS, system: SYSTEM_BLOCKS, messages },
        { headers: ANTHROPIC_HEADERS, timeout: 120000 }
      );
      return res.data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch (err) {
      const status = err.response?.status;
      console.error(
        `Claude vision attempt ${attempt + 1} failed | status=${status} |`,
        JSON.stringify(err.response?.data || err.message)
      );
      if (status === 429 || status === 500 || status === 529 || err.code === "ECONNABORTED") {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Claude vision unavailable after 3 attempts");
}

// ------------------------------------------------------ telegram file fetch -
async function fetchTelegramPhotoAsBase64(fileId) {
  const fileRes = await tg("getFile", { file_id: fileId });
  const filePath = fileRes.data.result.file_path; // e.g. "photos/file_123.jpg"
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const binRes = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 20000 });
  const ext = (filePath.split(".").pop() || "jpg").toLowerCase();
  const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { base64: Buffer.from(binRes.data).toString("base64"), mediaType };
}

// -------------------------------------------------------------- routing -----
function shouldAnswer(message) {
  const type = message.chat.type;
  const text = message.text || message.caption || "";
  if (type === "private") return true;                                  // DMs: always
  if (message.photo) return true;                                       // photos: always answer, same as DMs/commands
  if (/^\//.test(text)) return true;                                    // commands
  if (BOT_USERNAME && text.toLowerCase().includes("@" + BOT_USERNAME)) return true;
  if (message.reply_to_message?.from?.is_bot) return true;              // replying to us
  return false;                                                          // otherwise stay quiet
}

// --------------------------------------------------------- HW commands ------
// Matches:  /HW3          (overview of Homework 3)
//           /HW3.2        (hint on Homework 3, problem 2)
//           /HW_hint3.2   (minimal one-line nudge on Homework 3, problem 2)
const HW_COMMAND_RE = /^\/HW(_hint)?(\d+)(?:\.(\d+))?(@\S+)?\b/i;

function buildHwOverviewDirective(hwNum) {
  return (
    `[HOMEWORK OVERVIEW REQUEST]\n` +
    `The student wants an overview of Homework ${hwNum}. Find "HOMEWORK ${hwNum}" in the course ` +
    `material and list each top-level numbered problem with a one-line topic description only ` +
    `(no sub-parts, no hints, no solutions, no point values needed). Keep the whole reply short — ` +
    `one line per problem. End with: "Ask /HW${hwNum}.<problem number> for a hint on a specific one."`
  );
}

// Free, deterministic version — used when homework_problems_fys501.json has this homework,
// so it costs no API call and can't hallucinate a problem list.
function buildHwOverviewFromStructuredData(hwNum) {
  const problems = HOMEWORK_PROBLEMS[hwNum];
  const nums = Object.keys(problems).sort((a, b) => Number(a) - Number(b));
  const lines = nums.map((n) => {
    const firstLine = problems[n]
      .split("\n")[0]
      .trim()
      .replace(new RegExp(`^${hwNum}\\.${n}\\b\\.?\\s*`), "") // strip the leading "hw.n" header itself
      .replace(/\s*\(\d+\s*points?\)\s*$/i, "");
    return `${hwNum}.${n} — ${firstLine}`;
  });
  return (
    `Homework ${hwNum}:\n` +
    lines.join("\n") +
    `\n\nAsk /HW${hwNum}.<problem number> for a hint on a specific one.`
  );
}

function buildHwHintDirective(hwNum, problemNum) {
  const exactText = HOMEWORK_PROBLEMS[hwNum]?.[problemNum];
  const problemBlock = exactText
    ? `Here is the exact text of problem ${hwNum}.${problemNum}, verbatim from the assignment sheet:\n"""\n${exactText}\n"""\n`
    : `Find problem ${hwNum}.${problemNum} in Homework ${hwNum} in the course material below. ` +
      `If you can't find it, say so plainly instead of guessing.\n`;
  return (
    `[HOMEWORK HINT REQUEST]\n` +
    `The student is asking for help with Homework ${hwNum}, problem ${problemNum}. ${problemBlock}` +
    `Give ONE hint per your standing homework rules: name the relevant equation or concept, point ` +
    `to where it's covered, and ask one guiding question. Do not solve the problem or give the final answer.`
  );
}

function buildHwMinimalHintDirective(hwNum, problemNum) {
  const exactText = HOMEWORK_PROBLEMS[hwNum]?.[problemNum];
  const problemBlock = exactText
    ? `Here is the exact text of problem ${hwNum}.${problemNum}, verbatim from the assignment sheet:\n"""\n${exactText}\n"""\n`
    : `Find problem ${hwNum}.${problemNum} in Homework ${hwNum} in the course material below. ` +
      `If you can't find it, say so plainly instead of guessing.\n`;
  return (
    `[HOMEWORK MINIMAL HINT REQUEST]\n` +
    `The student wants just a nudge for Homework ${hwNum}, problem ${problemNum} — no explanation. ${problemBlock}` +
    `Reply with ONE short guiding question only (a single sentence), optionally naming one equation ` +
    `or concept. No further explanation, no solution.`
  );
}

function buildPhotoCheckDirective(caption) {
  return (
    `[HOMEWORK PHOTO CHECK — QUICK DIRECTION READ ONLY]\n` +
    `The student sent a photo of their in-progress work` +
    (caption ? ` with this caption: "${caption}"` : " with no caption — infer the problem from what's visible") +
    `. Give ONLY a quick preliminary read, 2-3 sentences total: ` +
    `(1) one line saying whether the overall approach looks like it's heading in the right direction ` +
    `or has a likely wrong turn, and (2) if something looks off, name the ONE most likely issue and ` +
    `point to the relevant concept/section — do NOT solve it, do NOT write out corrected math, do NOT ` +
    `give the final answer. If the photo is unreadable or you can't tell what problem it's for, say so ` +
    `and ask them to retake it or add a caption with the problem number (e.g. "/HW3.2").`
  );
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
  "- Explain the ABCD matrix for a thick lens\n\n" +
  "Homework commands:\n" +
  "- /HW3 — list the problems in Homework 3\n" +
  "- /HW3.2 — get a hint on Homework 3, problem 2\n" +
  "- /HW_hint3.2 — just a one-line nudge, no explanation\n" +
  "- Send a photo of your work-in-progress (caption it with the problem, e.g. \"/HW3.2\") " +
  "and I'll give a quick read on whether you're headed the right way.\n\n" +
  "Quizzes:\n" +
  "- \"quiz me\" — I'll ask which chapter\n" +
  "- \"quiz me on chapter 2\" or \"quiz me on section 2.3\" — multiple choice, tap an answer to grade it\n" +
  "- add a number for how many questions, e.g. \"quiz me on chapter 2, 10 questions\"\n\n" +
  "Lecture videos:\n" +
  "- /lectures — full listing, week by week\n" +
  "- \"is there a video on gain saturation?\" or \"recording for week 3?\" — I'll find the right one(s)\n\n" +
  "I'll give you hints and point you to the right section, but I won't hand you " +
  "finished homework solutions.\n\n" +
  "/reset clears our conversation history.";

// ------------------------------------------------------------- webhook ------
app.get("/", (_req, res) => res.send("Laser Physics bot is running"));
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    corpusChars: COURSE_CORPUS.length,
    corpusLooksHealthy: corpusLoader.corpusLooksHealthy(),
    homeworkProblemsLoaded: Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0),
    quizBankLooksHealthy: quizGenerator.quizBankLooksHealthy(),
    lectureDataLooksHealthy: lectureLinks.lectureDataLooksHealthy(),
  })
);

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
  if (!update || update.update_id === undefined) return;

  if (seenUpdates.has(update.update_id)) return;
  seenUpdates.add(update.update_id);
  if (seenUpdates.size > 1000) seenUpdates.clear();

  // Quiz answer taps and chapter-picker taps arrive as callback_query
  // updates, not message updates — handle those separately, before we ever
  // look for update.message (which callback_query updates don't have).
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query);
  }

  const message = update.message;
  if (!message || (!message.text && !message.photo)) return;

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  if (!shouldAnswer(message)) return;

  // ---- photo submission: quick direction check, handled before anything else
  if (message.photo && message.photo.length) {
    if (!shouldAnswer(message)) return;

    const now0 = Date.now();
    if (now0 - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
    lastCall.set(userId, now0);

    const caption = (message.caption || "").trim();
    console.log(`[${message.chat.type}:${chatId}] photo submitted, caption="${caption.slice(0, 80)}"`);

    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

    try {
      // Largest resolution is the last entry in Telegram's photo size array.
      const best = message.photo[message.photo.length - 1];
      const { base64, mediaType } = await fetchTelegramPhotoAsBase64(best.file_id);
      const directive = buildPhotoCheckDirective(caption);
      const reply = await askClaudeVision(base64, mediaType, directive);
      await sendMessage(chatId, reply, message.message_id);
    } catch (e) {
      console.error("Photo check failed:", e.message);
      await sendMessage(
        chatId,
        "Sorry, I couldn't read that photo just now. Please try again, ideally with good lighting and " +
          "a caption naming the problem (e.g. \"/HW3.2\").",
        message.message_id
      );
    }
    return;
  }

  if (/^\/(start|help)/i.test(text)) return sendMessage(chatId, HELP_TEXT);
  if (/^\/reset/i.test(text)) {
    history.delete(chatId);
    return sendMessage(chatId, "Conversation history cleared. Ask me anything.");
  }
  if (/^\/lectures/i.test(text)) {
    return sendMessage(chatId, lectureLinks.formatFullListing(), message.message_id, "HTML");
  }

  // ---- /HW3, /HW3.2, /HW_hint3.2
  const hwMatch = text.match(HW_COMMAND_RE);
  if (hwMatch) {
    const isMinimalHint = !!hwMatch[1];
    const hwNum = hwMatch[2];
    const problemNum = hwMatch[3];

    const now1 = Date.now();
    if (now1 - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
    lastCall.set(userId, now1);

    console.log(`[${message.chat.type}:${chatId}] HW command: ${text.slice(0, 60)}`);

    // Overview with no problem number: answer for free/instantly if we have
    // structured data for this homework, no need to call Claude at all.
    if (!problemNum && HOMEWORK_PROBLEMS[hwNum] && Object.keys(HOMEWORK_PROBLEMS[hwNum]).length) {
      await sendMessage(chatId, buildHwOverviewFromStructuredData(hwNum), message.message_id);
      return;
    }

    const directive = !problemNum
      ? buildHwOverviewDirective(hwNum)
      : isMinimalHint
      ? buildHwMinimalHintDirective(hwNum, problemNum)
      : buildHwHintDirective(hwNum, problemNum);

    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

    try {
      const reply = await askClaude(chatId, directive);
      remember(chatId, "user", text);
      remember(chatId, "assistant", reply);
      await sendMessage(chatId, reply, message.message_id);
    } catch (e) {
      await sendMessage(
        chatId,
        "Sorry, I couldn't reach my brain just now. Please try again in a moment.",
        message.message_id
      );
    }
    return;
  }

  const question = stripMention(text);
  if (question.length < 3) return;

  const now = Date.now();
  if (now - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
  lastCall.set(userId, now);

  console.log(`[${message.chat.type}:${chatId}] ${question.slice(0, 120)}`);

  // ---- "quiz me" / "quiz me on chapter 2" / "quiz me on section 2.3" ----
  if (quizGenerator.isQuizRequest(question)) {
    return quizGenerator
      .startQuiz(quizBot, chatId, question, askWhichChapter)
      .catch((e) => console.error("quizGenerator.startQuiz crashed:", e.message));
  }

  // ---- "any lecture video about X?" / "where's the recording for week 3?"
  if (lectureLinks.STAGE1_TRIGGER.test(question)) {
    try {
      const reply = await lectureLinks.handleLectureQuery(question);
      await sendMessage(chatId, reply, message.message_id, "HTML");
    } catch (e) {
      console.error("lectureLinks.handleLectureQuery crashed:", e.message);
      await sendMessage(chatId, "Sorry, I couldn't look up lecture videos just now.", message.message_id);
    }
    return;
  }

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

// callback_query updates: answer-option taps ("quiz:...") from
// quizGenerator's inline keyboards, and chapter-picker taps
// ("quizchapter:N") from askWhichChapter() above.
async function handleCallbackQuery(cq) {
  const data = cq.data || "";

  if (data.startsWith("quiz:")) {
    return quizGenerator
      .handleQuizAnswer(quizBot, cq)
      .catch((e) => console.error("quizGenerator.handleQuizAnswer crashed:", e.message));
  }

  if (data.startsWith("quizchapter:")) {
    const chapter = data.split(":")[1];
    const chatId = cq.message?.chat?.id;
    await quizBot.answerCallbackQuery(cq.id);
    if (!chatId) return;
    return quizGenerator
      .startQuiz(quizBot, chatId, `quiz me on chapter ${chapter}`, askWhichChapter)
      .catch((e) => console.error("quizGenerator.startQuiz (chapter pick) crashed:", e.message));
  }

  // Unknown callback data — acknowledge anyway so Telegram stops showing a
  // loading spinner on the button.
  await quizBot.answerCallbackQuery(cq.id).catch(() => {});
}

// ---------------------------------------------------------------- start -----
if (!TELEGRAM_TOKEN) console.error("WARNING: TELEGRAM_TOKEN is not set");
if (!ANTHROPIC_API_KEY) console.error("WARNING: ANTHROPIC_API_KEY is not set");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT} | model=${MODEL} | cache=${CACHE_TTL}`));
