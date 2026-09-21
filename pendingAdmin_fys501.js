/**
 * pendingAdmin_fys501.js
 * ----------------------
 * Admin-only /pending command: lets the course instructor pull the live-generated,
 * not-yet-reviewed quiz questions out of the running bot straight into Telegram —
 * the practical way to get them off Railway's ephemeral filesystem.
 *
 *   /pending          summary + the two pending JSON files as Telegram documents
 *   /pending clear    empties both pending files (do this AFTER saving the export)
 *
 * Only Telegram IDs in ADMIN_USER_IDS may use it; everyone else is ignored silently
 * (the command is not listed in /help). Workflow after export: PENDING_QUESTIONS_fys501.md.
 */

const path = require('path');
const quiz = require('./quizGenerator_fys501');
const mvQuiz = require('./multivalueQuizGenerator_fys501');
const limiter = require('./usageLimiter');

function sectionList(bySection) {
  const parts = Object.entries(bySection)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([k, n]) => `${k}: ${n}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function summaryText(s1, s2) {
  const lines = [
    'Pending live-generated questions (not yet reviewed):',
    `- Single-select: ${s1.total}${sectionList(s1.bySection)}`,
    `- Multi-select: ${s2.total}${sectionList(s2.bySection)}`,
  ];
  if (s1.corrupt || s2.corrupt) lines.push('WARNING: a pending file was unreadable and has been kept aside on the server.');
  lines.push(
    s1.persistentDir || s2.persistentDir
      ? 'Storage: persistent directory (QUIZ_PENDING_DIR) - survives redeploys.'
      : 'Storage: repo directory - LOST on redeploy. Export now, or set QUIZ_PENDING_DIR to a Railway volume.'
  );
  return lines.join('\n');
}

/**
 * @param {object} p
 * @param {number|string} p.chatId
 * @param {number|string} p.userId
 * @param {string} p.arg                   text after "/pending"
 * @param {(chatId, text) => Promise} p.sendText
 * @param {(chatId, filePath, filename, caption) => Promise} p.sendDocument
 * @returns {Promise<boolean>} false if the caller is not an admin (nothing was sent)
 */
async function handlePendingCommand({ chatId, userId, arg, sendText, sendDocument }) {
  if (!limiter.isAdmin(userId)) return false;
  const a = String(arg || '').trim().toLowerCase();

  if (a === 'clear') {
    const n1 = quiz.clearPending();
    const n2 = mvQuiz.clearPending();
    await sendText(chatId, `Cleared the pending files: ${n1} single-select and ${n2} multi-select question(s) removed.`);
    return true;
  }
  if (a && a !== 'export') {
    await sendText(chatId, 'Usage: /pending (summary + export files) or /pending clear (empty the pending files after exporting).');
    return true;
  }

  const s1 = quiz.pendingSummary();
  const s2 = mvQuiz.pendingSummary();
  await sendText(chatId, summaryText(s1, s2));

  const files = [
    [s1, 'single-select'],
    [s2, 'multi-select'],
  ];
  let sent = 0;
  for (const [s, label] of files) {
    if (!s.total) continue;
    try {
      await sendDocument(chatId, s.path, path.basename(s.path), `${label}: ${s.total} pending question(s)`);
      sent++;
    } catch (e) {
      await sendText(chatId, `Could not send the ${label} pending file: ${e.message}`);
    }
  }
  if (sent) await sendText(chatId, 'Save the file(s) into the repo folder, run: node mergePending_fys501.js review. Send /pending clear afterwards so they are not exported twice.');
  return true;
}

module.exports = { handlePendingCommand, summaryText };
