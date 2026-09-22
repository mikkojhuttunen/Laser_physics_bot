# Laser types quiz: wiring guide

## Files

| File | Purpose |
|---|---|
| `laserQuiz.js` | The module: question engine, grading, XP store, session flow, rendering |
| `laser_types.json` | Laser data bank (source of truth for every question) |
| `laser_quiz_names.js` | Hidden XP level ladder and the anonymous alias pool (both editable) |
| `test_laserQuiz.js` | `node test_laserQuiz.js`: data checks, scoring, ISO weeks, alias balance, full fake-Telegram quiz run |

Copy the first three next to `bot.js`. No new npm dependencies.

## bot.js wiring

```js
const { createLaserQuiz } = require('./laserQuiz');

// isCourseMember = your existing getChatMember-based access check (optional)
const laserQuiz = createLaserQuiz(bot, { isAllowed: (userId) => isCourseMember(userId) });

// Stage 0: before any LLM routing
bot.on('message', async (msg) => {
  if (laserQuiz.handleCommand(msg)) return;   // handles /lasers
  // ... existing routing
});

bot.on('callback_query', (q) => {
  if (laserQuiz.handleCallback(q)) return;    // handles callback_data starting with "lq:"
  // ... existing callback handling
});

// In your SIGTERM/shutdown handler (Railway sends SIGTERM on redeploy):
laserQuiz.shutdown();                          // flushes XP to disk
```

If `bot.js` already has one `callback_query` and one `message` handler, add the two `if` lines at the top of each.
The module never calls the LLM, so it does not touch `STUDENT_LLM_DAILY_USAGE` or the EUR backstop.
Also add `/lasers` to your `setMyCommands` list.

## Railway variables

| Variable | Default | Meaning |
|---|---|---|
| `WEEKLY_XP_ENABLED` | off | Collect weekly XP. Turns on the weekly goal bar, the hidden level ladder and the header XP counter. Requires `QUIZ_SALT`. |
| `LEADERBOARD_VISIBLE` | off | Show the anonymous weekly top 10 after each quiz. Needs `WEEKLY_XP_ENABLED`; otherwise it is ignored with a startup warning. |
| `WEEKLY_XP_TARGET` | 300 | Weekly XP goal shown as a progress bar. |
| `LASER_QUIZ_DAILY_XP_CAP` | 300 | Max XP counted per day (anti-farming). `0` = no cap. |
| `QUIZ_SALT` | none | Secret for hashing Telegram IDs. Generate once (`openssl rand -hex 32`) and never change it, or everyone gets a new identity. |
| `QUIZ_DATA_DIR` | `./data` | Set to your Railway volume mount path (e.g. `/data`), otherwise XP is lost on each deploy. |
| `QUIZ_TZ` | `Europe/Helsinki` | Time zone for day and week boundaries (weeks reset Monday 00:00 local). |
| `LASER_QUIZ_SESSION_TTL_MIN` | 30 | Idle session timeout. |
| `LASER_QUIZ_LOG` | on | Append an anonymized per-step answer log (`laser_quiz_log.jsonl`) for finding hard topics. Needs `QUIZ_SALT`. |
| `LASER_QUIZ_REQUIRE_REVIEW` | off | Only serve lasers with `"reviewed": true` in `laser_types.json`. |

Flag behaviour:

| `WEEKLY_XP_ENABLED` | `LEADERBOARD_VISIBLE` | Students see |
|---|---|---|
| off | any | XP for the current session only. Nothing is stored. |
| on | off | Weekly XP, goal bar, hidden level. Data is still collected, so the board can be switched on later. |
| on | on | All of the above plus the top 10. |

## What is stored

- `laser_xp.json`: per user an HMAC of the Telegram ID (never the raw ID), an alias, the current ISO week, weekly XP and today's XP. Weekly XP resets lazily on the first activity of a new week.
- `laser_quiz_log.jsonl`: `{ts, u (hashed), laser, step, pts, perfect}` per answered question.
- Students only ever see alias plus XP. The level ladder is never sent in full; the next level shows as `???`.

## Names

- Alias pool: 20 women and 20 men, disjoint from the ladder. Aliases are assigned to keep the class balanced: the next new student gets a name from whichever gender has been assigned fewer, so classes of up to 40 are exactly 50/50. Beyond 40 students, names get a numeral (`Ada Lovelace II`).
- Ladder: 15 levels, 7 women and 8 men (an odd number of levels cannot split evenly). Level bands are 50 XP wide from 0 to 350, so a first round already unlocks a level or two, and 100 XP wide from 400 up to the top level at 1000.

## Upper-state lifetime step

Each laser can carry a `lifetime: { bucket }` field, where `bucket` is one of the five order-of-magnitude labels in the top-level `lifetimeBuckets` array (ns → µs → 100s of µs → ms → 10s of ms). If present, a single-choice "what is the approximate upper-state lifetime?" step is inserted right after the level-scheme step, with 3 other buckets drawn as distractors. The explanation note (`notes.lifetime`) is where the "why it matters" payload lives — e.g. tying Ti:Sapph's ~3.2 µs lifetime to why it can't be flashlamp-pumped, or Nd:YAG's ~230 µs to why Q-switching works.

Lasers where a single clean lifetime number doesn't really exist (currently the two gas lasers, HeNe and CO₂) simply omit the `lifetime` field, and the step is skipped — the same pattern already used for `pumpWavelength` on electrically pumped lasers.

## Lasers without a level scheme

`level` is nullable. A gain medium whose physics doesn't map onto the 3-level/quasi-3-level/4-level framework at all can omit `level` (or set it to `null`) and the "level scheme" step is skipped entirely, the same way `pumpWavelength` is skipped for gas lasers.

The diode laser entry takes a different approach: rather than skipping the question, `levelSchemes` has a 4th option, `"N/A – semiconductor (no discrete atomic levels)"`, and diode's `level` points at it. That 4th option is also a legitimate wrong answer for every other laser's level-scheme question — a useful "trick" distractor that reminds students the atomic framework has limits.

## Before students see it

1. Every laser has `"reviewed": false`. Check each number and note in `laser_types.json`, then set it to `true` (and optionally set `LASER_QUIZ_REQUIRE_REVIEW=true`).
2. Startup validation throws with a list of problems if a laser is malformed (missing note, too few distractors, unknown pump key, lifetime bucket not in `lifetimeBuckets`, and so on).
3. Adding a laser: append an object to `lasers` following an existing entry. You need at least 4 lasers, because the "which transition" distractors come from other lasers.
4. This patch adds four new lasers, all `"reviewed": false`: **Ruby** (fills the one real gap in the level-scheme coverage — it's the only pure 3-level laser in the set), **Er:YAG** (2940 nm, self-terminating transition — its level-scheme step is skipped entirely; see "Freeform nuance questions" below), **Thulium/Tm:YAG** (~2010 nm, eye-safe, cross-relaxation), and **Diode** (the electrically-pumped semiconductor that pumps most of the other lasers in this set — no pump-wavelength step, and its own level-scheme answer is "N/A").

## Freeform nuance questions

A laser can carry an `extraQuestions` array for a laser-specific wrinkle that doesn't fit any of the standard fields above. Each entry supplies its own `id`, `title` (shown in place of the usual `STEP_TITLES` lookup), `q`, `multi`, `options` (`{t, ok}` pairs, 2–6 of them), and `note`. These are inserted right after the lifetime step.

Er:YAG uses this instead of the level-scheme question: its 2940 nm transition is self-terminating (the lower laser level outlives the upper one, the opposite of the usual 3-level/4-level assumption), which a 3-option multiple-choice doesn't represent well. Its `level` field is `null` (skipping the level-scheme step, the same nullable pattern the diode entry introduced) and `extraQuestions` carries a dedicated multi-select question — "which of the following are true about this transition?" — instead. That's a template for any future laser whose physics doesn't fit the standard fields cleanly.

## Tuning notes

- A perfect 8-question round is worth 80 XP plus streak bonuses (+5 per perfect answer from the third in a row, carried across lasers within a session), so up to about 110 XP. The top level (1000 XP) therefore needs roughly 10 perfect rounds in a week; retune `WEEKLY_XP_TARGET` and the ladder in `laser_quiz_names.js` once you see real usage.
- Callback data format: `lq:s`, `lq:t:<step>:<option>`, `lq:c:<step>`, `lq:n:<step>`, `lq:l`, `lq:x` (all under 64 bytes). Buttons carrying an old step number are ignored, so stale messages cannot double-count XP.
