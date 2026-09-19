'use strict';
/**
 * usageLimiter.js - per-student daily LLM credits + shared daily spend backstop.
 *
 * Railway variables (all optional):
 *   STUDENT_LLM_DAILY_USAGE   credits per student per day               (default 10)
 *   DAILY_BACKSTOP_EUR        shared estimated spend cap per day, 0=off (default 5)
 *   USD_TO_EUR                conversion used for the estimate          (default 0.9)
 *   LLM_WEIGHT_CHAT           credit cost of a chat/Q&A answer          (default 1)
 *   LLM_WEIGHT_PHOTO          credit cost of a homework photo check     (default 1)
 *   LLM_WEIGHT_QUIZ           credit cost of a live quiz-question top-up (default 1)
 *   LLM_WEIGHT_CHECKHW        credit cost of a /checkhw submission      (default 3)
 *   ADMIN_USER_IDS            comma-separated Telegram IDs exempt from limits
 *   PRICING_JSON              optional price override (USD per million tokens),
 *                             e.g. {"sonnet":{"in":3,"out":15},"haiku":{"in":1,"out":5}}
 *   LIMIT_TIMEZONE            day boundary timezone (default Europe/Helsinki)
 *
 * State is in memory: counters reset on every redeploy/restart, so treat this as a
 * soft guard. The monthly spend limit in the Anthropic Console is the hard stop.
 */

// ---------- config helpers (read on every call, so changes are picked up) ----------
function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function cfg() {
  return {
    dailyLimit: num('STUDENT_LLM_DAILY_USAGE', 10),
    backstopEUR: num('DAILY_BACKSTOP_EUR', 5),
    usdToEur: num('USD_TO_EUR', 0.9),
    weights: {
      chat: num('LLM_WEIGHT_CHAT', 1),
      photo: num('LLM_WEIGHT_PHOTO', 1),
      quiz: num('LLM_WEIGHT_QUIZ', 1),
      checkhw: num('LLM_WEIGHT_CHECKHW', 3),
    },
  };
}

function isAdmin(userId) {
  const ids = (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(userId));
}

function dayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.LIMIT_TIMEZONE || 'Europe/Helsinki',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // YYYY-MM-DD
}

// ---------- pricing (USD per million tokens; verify against current price list) ----------
const DEFAULT_PRICES = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
};

function priceFor(model) {
  let table = DEFAULT_PRICES;
  if (process.env.PRICING_JSON) {
    try {
      table = { ...DEFAULT_PRICES, ...JSON.parse(process.env.PRICING_JSON) };
    } catch {
      console.error('[limiter] PRICING_JSON is invalid JSON, using defaults');
    }
  }
  const m = String(model || '').toLowerCase();
  for (const key of Object.keys(table)) {
    if (m.includes(key)) return table[key];
  }
  return table.sonnet; // unknown model: assume Sonnet-level pricing (conservative)
}

function costUSD(model, usage) {
  if (!usage) return 0;
  const p = priceFor(model);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (
    (input * p.in + output * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1e6
  );
}

// ---------- state ----------
let state = { day: dayKey(), users: new Map(), spendUSD: 0, backstopLogged: false };

function rollover() {
  const d = dayKey();
  if (d !== state.day) {
    console.log(
      `[limiter] new day ${d}; yesterday: ${state.users.size} users, ~EUR ${(
        state.spendUSD * cfg().usdToEur
      ).toFixed(2)}`
    );
    state = { day: d, users: new Map(), spendUSD: 0, backstopLogged: false };
  }
}

function spendEUR() {
  return state.spendUSD * cfg().usdToEur;
}

function backstopReached() {
  const { backstopEUR } = cfg();
  return backstopEUR > 0 && spendEUR() >= backstopEUR;
}

// ---------- public API ----------

/**
 * Reserve credits BEFORE making the LLM call.
 * Returns { ok:true, cost, used, remaining, limit } or { ok:false, reason:'user_limit'|'backstop' }.
 */
function reserve(userId, kind = 'chat') {
  rollover();
  const c = cfg();
  const key = String(userId);

  if (isAdmin(key)) return { ok: true, admin: true, cost: 0, used: 0, remaining: Infinity, limit: Infinity };

  if (backstopReached()) return { ok: false, reason: 'backstop' };

  const cost = c.weights[kind] ?? 1;
  const used = state.users.get(key) || 0;
  if (used + cost > c.dailyLimit) {
    return { ok: false, reason: 'user_limit', used, limit: c.dailyLimit };
  }
  state.users.set(key, used + cost);
  return { ok: true, cost, used: used + cost, remaining: c.dailyLimit - used - cost, limit: c.dailyLimit };
}

/** True while the shared daily backstop is active (optional LLM calls should be skipped). */
function isPaused() {
  rollover();
  return backstopReached();
}

/** Give credits back if the LLM call failed. */
function refund(userId, cost) {
  rollover();
  const key = String(userId);
  if (!cost || !state.users.has(key)) return;
  state.users.set(key, Math.max(0, state.users.get(key) - cost));
}

/** Add the cost of one API response to today's spend estimate (all models, all calls). */
function recordUsage(model, usage) {
  rollover();
  state.spendUSD += costUSD(model, usage);
  if (backstopReached() && !state.backstopLogged) {
    state.backstopLogged = true;
    console.warn(
      `[limiter] BACKSTOP REACHED: ~EUR ${spendEUR().toFixed(2)} >= ${cfg().backstopEUR}. LLM calls paused until midnight.`
    );
  }
}

/** Drop-in replacement for client.messages.create(params) that records spend automatically. */
async function trackedCreate(client, params) {
  const res = await client.messages.create(params);
  try {
    recordUsage(res.model || params.model, res.usage);
  } catch (e) {
    console.error('[limiter] failed to record usage:', e.message);
  }
  return res;
}

/** Status for a user (/usage command) and for /healthz. */
function userStatus(userId) {
  rollover();
  const c = cfg();
  if (isAdmin(userId)) return { admin: true, used: 0, limit: Infinity };
  return { used: state.users.get(String(userId)) || 0, limit: c.dailyLimit };
}

function status() {
  rollover();
  const c = cfg();
  return {
    day: state.day,
    activeUsers: state.users.size,
    estSpendEUR: Number(spendEUR().toFixed(3)),
    backstopEUR: c.backstopEUR,
    backstopReached: backstopReached(),
    studentDailyLimit: c.dailyLimit,
  };
}

module.exports = { reserve, refund, recordUsage, trackedCreate, userStatus, status, isAdmin, isPaused };
