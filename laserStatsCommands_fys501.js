'use strict';
/**
 * laserStatsCommands_fys501.js
 * -----------------------------
 * Telegram-facing wrapper for the laser-quiz stats (bot_fys501.js only calls this).
 *
 *   /laserstats            (ADMIN_USER_IDS only, silently ignored for everyone else)
 *        /laserstats               briefing: usage, weekly trend, hardest questions, learning curve
 *        /laserstats export        send laser_quiz_log.jsonl as a document (needs QUIZ_DATA_DIR)
 *
 * Reads the same log file laserQuiz.js writes to (path.join(dataDir, 'laser_quiz_log.jsonl')),
 * gated the same way (LASER_QUIZ_LOG on + QUIZ_SALT set). No separate opt-out here: this is the
 * same data laserQuiz.js already logs for weekly XP / the leaderboard, and /optout already covers
 * it via laserQuiz.js's own logic — see LASER_QUIZ_WIRING.md.
 */

const fs = require('fs');
const path = require('path');
const stats = require('./laserStats_fys501');
const limiter = require('./usageLimiter');

function readLogText(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'laser_quiz_log.jsonl'), 'utf8');
  } catch (e) {
    return '';
  }
}

/**
 * @param {object} p
 * @param {number|string} p.userId
 * @param {string} p.arg                    text after "/laserstats"
 * @param {string} p.dataDir                laserQuiz.config.dataDir from bot_fys501.js
 * @param {(chatId, text) => Promise} p.sendText
 * @param {(chatId, filePath, filename, caption) => Promise} p.sendDocument
 * @param {number|string} p.chatId
 * @returns {Promise<boolean>} false if the caller is not an admin (nothing was sent)
 */
async function handleLaserStatsCommand({ chatId, userId, arg, dataDir, sendText, sendDocument }) {
  if (!limiter.isAdmin(userId)) return false;

  const logPath = path.join(dataDir, 'laser_quiz_log.jsonl');
  const words = String(arg || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (words[0] === 'export') {
    if (!fs.existsSync(logPath)) {
      await sendText(chatId, 'No log file yet at ' + logPath + '. Make sure QUIZ_DATA_DIR points at a mounted Railway volume, LASER_QUIZ_LOG is not disabled, and QUIZ_SALT is set.');
      return true;
    }
    try {
      await sendDocument(chatId, logPath, 'laser_quiz_log.jsonl', 'Laser quiz events. Analyse with: node laserStats_fys501.js laser_quiz_log.jsonl');
    } catch (e) {
      await sendText(chatId, `Could not send the log file: ${e.message}`);
    }
    return true;
  }

  const text = readLogText(dataDir);
  if (!text.trim()) {
    await sendText(chatId, 'No laser quiz events recorded yet. This needs QUIZ_SALT set and QUIZ_DATA_DIR pointed at a mounted Railway volume (see LASER_QUIZ_WIRING.md), and at least one completed round.');
    return true;
  }
  const events = stats.parseEvents(text);
  const report = stats.analyse(events);
  await sendText(chatId, stats.formatTelegram(report));
  return true;
}

module.exports = { handleLaserStatsCommand };
