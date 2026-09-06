/**
 * LaTeX Renderer for Telegram Bot
 * Converts $$ ... $$ blocks in text to rendered equation images via CodeCogs
 */

const axios = require("axios");

const CODECOGS_BASE = "https://latex.codecogs.com/png.image";
const DEFAULT_DPI = 150;
const DEFAULT_BG = "white";

/**
 * Build CodeCogs URL for LaTeX rendering
 * @param {string} latexCode - The LaTeX equation (without $$)
 * @returns {string} - Full URL to rendered image
 */
function buildCodecogsUrl(latexCode, dpi = DEFAULT_DPI, bg = DEFAULT_BG) {
  const encoded = encodeURIComponent(latexCode);
  return `${CODECOGS_BASE}?\\dpi{${dpi}}\\bg{${bg}}${encoded}`;
}

/**
 * Verify CodeCogs URL renders successfully
 * @param {string} url - CodeCogs URL
 * @returns {Promise<boolean>} - true if renders, false otherwise
 */
async function verifyLatexUrl(url) {
  try {
    const response = await axios.head(url, { timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    console.warn(`LaTeX verification failed for: ${url.slice(0, 80)}...`);
    return false;
  }
}

/**
 * Parse text for $$ ... $$ blocks and return structured parts
 * @param {string} text - Text containing potential LaTeX blocks
 * @returns {Array<{type: 'text'|'latex', content: string}>}
 */
function parseLatexBlocks(text) {
  const parts = [];
  const blocks = text.split("$$");

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    if (i % 2 === 1) {
      // Odd index = LaTeX content (was between $$ markers)
      parts.push({ type: "latex", content: block });
    } else {
      // Even index = regular text
      parts.push({ type: "text", content: block });
    }
  }

  return parts;
}

/**
 * Send a single LaTeX equation as an image via Telegram
 * @param {Function} tg - Telegram API function (takes method, payload)
 * @param {number} chatId - Telegram chat ID
 * @param {string} latexCode - LaTeX equation
 * @param {number} replyToMessageId - Optional reply-to message ID
 * @returns {Promise<void>}
 */
async function sendLatexImage(tg, chatId, latexCode, replyToMessageId = null) {
  try {
    const imageUrl = buildCodecogsUrl(latexCode);

    // Optional: verify before sending (can be disabled for speed)
    const shouldVerify = process.env.LATEX_VERIFY_BEFORE_SEND !== "false";
    if (shouldVerify) {
      const isValid = await verifyLatexUrl(imageUrl);
      if (!isValid) {
        console.warn(`LaTeX rendering failed, sending as fallback text: ${latexCode}`);
        await tg("sendMessage", {
          chat_id: chatId,
          text: `[Equation: ${latexCode}]`,
          reply_to_message_id: replyToMessageId,
          allow_sending_without_reply: true,
        });
        return;
      }
    }

    // Send the rendered image
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: imageUrl,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
    });
  } catch (error) {
    console.error(
      `Error sending LaTeX image for "${latexCode.slice(0, 40)}...":`,
      error.message
    );
    // Fallback: send as text
    await tg("sendMessage", {
      chat_id: chatId,
      text: `[Equation: ${latexCode}]`,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
    }).catch((e) =>
      console.error("Fallback sendMessage failed:", e.message)
    );
  }
}

/**
 * Main function: Parse response for $$ blocks and send text + images
 * @param {Function} tg - Telegram API function
 * @param {number} chatId - Telegram chat ID
 * @param {string} responseText - Full response (may contain $$ blocks)
 * @param {number} replyToMessageId - Optional reply-to message ID
 * @returns {Promise<void>}
 */
async function extractAndSendLatex(tg, chatId, responseText, replyToMessageId = null) {
  const parts = parseLatexBlocks(responseText);

  for (const part of parts) {
    if (part.type === "text") {
      // Send text message
      await tg("sendMessage", {
        chat_id: chatId,
        text: part.content,
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
        disable_web_page_preview: true,
      }).catch((e) =>
        console.error("sendMessage failed:", e.response?.status, e.message)
      );
    } else if (part.type === "latex") {
      // Send LaTeX as image
      await sendLatexImage(tg, chatId, part.content, replyToMessageId);
    }
  }
}

module.exports = {
  extractAndSendLatex,
  parseLatexBlocks,
  buildCodecogsUrl,
  verifyLatexUrl,
  sendLatexImage,
};
