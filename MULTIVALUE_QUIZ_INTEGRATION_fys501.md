# Multivalue ("select all that apply") Quiz Add-On — FYS.501

Ported from the FYS.240 Optics bot (`FYS240_Optics_TGbot`: `multivalueQuizGenerator_fys240.js`,
`MULTIVALUE_QUIZ_INTEGRATION.md`, and the wiring in `bot_fys240.js`). Same architecture:
isolated module, own bank, own session state, own callback namespace. The existing
single-select `/quiz` flow (`quizGenerator_fys501.js`, `quizBank_fys501.json`) is **not modified**.

## Files

| File | Role |
|---|---|
| `multivalueQuizGenerator_fys501.js` | Generator + session + grading logic |
| `multivalueQuizBank_fys501.json` | Curated bank. Ships **empty** (`{}`) — see "Bank" below |
| `multivalueQuizBankPending_fys501.json` | Created at runtime: live-generated questions awaiting review (never served from here) |

Bank schema: `{ "<chapter>": { "<chapter.section>": [ { id, stem, options[4-8], correctIndices[≥2, <all], explanation } ] } }`

## Changes in `bot_fys501.js`

1. `require("./multivalueQuizGenerator_fys501")`.
2. `askWhichChapterMv()` — chapter picker with its own `mvquizchapter:N` callback prefix, so a tap can never start the single-select quiz.
3. `/mvquiz [chapter N | N.M] [count]` command (also `/mvquiz@BotName …`), same 4 s per-user throttle as other commands.
4. Free-text trigger (`multiquiz`, `multi-select quiz`, `select all`) — **must be checked before `quizGenerator.isQuizRequest()`**. The optics doc says the two regexes don't overlap; they do for `multi-select quiz`, `multi quiz` and `multi-quiz` (each contains a standalone word "quiz"). Order in the handler is what keeps them apart.
5. `handleCallbackQuery()`: `mv:` (toggle/submit) and `mvquizchapter:` branches.
6. `/healthz`: `multivalueQuizBankLooksHealthy` (reports `false` until the bank has at least one curated question; `ok` is unaffected).
7. `/help` text lists `/mvquiz`.
8. **`/topics`** is now an alias of `/lectures` — same regex branch, same handler, same output (`/topics@BotName` works too).

## Behaviour

- Buttons show only the letter (`A`–`H`, `✅` when toggled), two per row, plus a `✅ Submit answer` row; option text is in the message body.
- Grading is in code: `score = max(0, c/k − w/(n−k))` per question (exact set = 1, ticking everything = 0). Total shown to 2 decimals with %, e.g. `1.67/3.00 (56%)`.
- Bank-first → live Haiku generation for any shortfall (scoped to the section excerpt) → appended to the pending file and logged as `MVQUIZ_PENDING_QUESTION {json}` lines (durable on Railway without a volume).
- Generated and banked questions are structurally validated before being served (4–8 options, in-range unique indices, ≥2 correct, ≥1 wrong).

## Deviations from the FYS.240 original

HTML-escaping of all question text (laser questions contain `<`, `>`, `&`); per-session id in `callback_data` (`mv:<sid>:<q>:t:<i>`) so stale keyboards can't act on a newer quiz; question index advances before any `await` (double-tap on Submit can't double-count); edits use the tapped message's own `message_id`; sliding 20-min session TTL; **English only** (no EN/FI layer — laser's corpus loader and single-select quiz have none).

## Bank

The optics bank was **not** copied (course-content discipline). All four chapters are now drafted from the lecture notes and textbook: **88 questions** (Ch 1: 16, Ch 2: 27, Ch 3: 26, Ch 4: 19; 4–6 per section), each with `"reviewed": true` (reviewed by the course instructor on 2026-09-19 against `mv_review_ch1-2.md` and `mv_review_ch3-4.md`; ✅ marks the correct options, with explanation and source). New questions curated from the pending file should be added with `"reviewed": false` until checked. Every section holds at least 4 questions; sections 2.2, 2.3, 2.4, 3.2, 3.5 and 4.3 hold 5 and section 4.2 holds 6, so the default 5-question section quiz is fully served from the bank there (the other sections hold 4 and need one generated question to fill a default quiz). Curate further questions from `MVQUIZ_PENDING_QUESTION` log lines / `multivalueQuizBankPending_fys501.json` under `chapter → section`.

Section keys follow `corpusLoader_fys501.js` (3.4 = Eigenmodes, 3.5 = Stability), the same convention as `quizBank_fys501.json`. Where a section holds fewer unseen questions than requested, the remainder is topped up by live generation (needs the corpus fix below); otherwise only the banked questions are served.

## Known prerequisite: corpus file

Live generation calls `corpusLoader.getCorpusSection()`, which reads `course_corpus_fys501.txt`. At the time of this port, that committed file contains only the homework sheets (~23 KB) and the loader throws *"could not locate chapter N content"* — so live generation (here **and** in the single-select fallback) can't work until the loader/bot point at a corpus containing chapter content (e.g. `course_corpus_fys501_v2.txt`, ~334 KB). Verified in a scratch copy: with the v2 file in place, all four chapters resolve and live generation works.
