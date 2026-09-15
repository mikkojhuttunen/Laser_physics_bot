/**
 * corpusLoader.js
 * -----------------
 * Chapter- and section-tagged access into course_corpus.txt.
 *
 * The corpus is a single flat text file (built by build_corpus.js) that
 * concatenates the lecture slides and the four textbook chapters, wrapped in
 * `===== BEGIN ... =====` / `===== END ... =====` markers. Section headings
 * inside it appear in TWO different numbering conventions, because the two
 * source documents disagree with each other:
 *
 *   - Textbook chapters use plain ASCII digits, e.g. "3.4 Eigenmodes of an
 *     Optical Resonator".
 *   - Lecture slides use Unicode "Mathematical Sans-Serif/Double-Struck"
 *     digit glyphs produced by the PDF text extraction, e.g. "𝟛.𝟜 Stability
 *     Condition".
 *
 * Rather than re-tagging the corpus at build time (option A in the setup
 * guide), this loader takes the "fallback" approach: it recognises headings
 * in *either* numbering convention directly via regex character classes, and
 * exposes a `getCorpusSection(chapter, section)` that works against the
 * existing course_corpus.txt unmodified. If build_corpus.js is ever updated
 * to emit explicit `### 2.3 ... ###` delimiters, this loader can be
 * simplified, but nothing else needs to change (same exported function
 * signatures).
 *
 * SECTION_INDEX below is the canonical list of chapters/sections used
 * throughout the quiz feature (quizBank.json, buildQuizBank.js). It resolves
 * the slide-vs-textbook numbering disagreement in section 3.4/3.5 by
 * following the textbook's own internal order (3.4 Eigenmodes, 3.5
 * Stability), since that's what quizBank.json was already built against.
 */

const fs = require('fs');
const path = require('path');

const CORPUS_PATH = path.join(__dirname, 'course_corpus.txt');

// terminology.json is built offline by terminology.js (harvested from the
// \CDAlert/\Alert-marked lecture .tex sources) and committed alongside the
// corpus. It backs the /define command in bot.js.
const TERMINOLOGY_PATH = path.join(__dirname, 'terminology.json');

// Default cap on how much text getCorpusSection() returns, to keep LLM
// prompts (and eyeballing during buildQuizBank.js runs) reasonably sized.
const DEFAULT_MAX_CHARS = 9000;
const DEFAULT_MAX_CHARS_CHAPTER = 14000; // when no section is given

// ---------- canonical chapter/section index ----------

const SECTION_INDEX = {
  1: {
    title: 'Introductory Concepts',
    sections: {
      '1.1': 'Spontaneous and Stimulated Emission, Absorption',
      '1.2': 'The Laser Idea',
      '1.3': 'Pumping Schemes',
      '1.4': 'Properties of Laser Beams',
    },
  },
  2: {
    title: 'Semiclassical Theory of Light-Matter Interaction',
    sections: {
      '2.1': 'Time-dependent Perturbation Theory',
      '2.2': 'The Einstein A and B Coefficients',
      '2.3': "Fermi's Golden Rule",
      '2.4': 'Cross-Section and Line Broadening',
      '2.5': 'Line-broadening Mechanisms',
      '2.6': 'Saturation and Gain',
    },
  },
  3: {
    title: 'Passive Optical Resonators',
    sections: {
      '3.1': 'Matrix Formulation of Paraxial Optics',
      '3.2': 'Fabry-Perot Interferometer',
      '3.3': 'Optical Resonators',
      '3.4': 'Eigenmodes of an Optical Resonator',
      '3.5': 'Stability Condition',
      '3.6': 'Photon Lifetime and Cavity Q-factor',
    },
  },
  4: {
    title: 'Continuous Wave (CW) Behaviour of a Laser',
    sections: {
      '4.1': 'Rate Equations Model and Laser Parameters',
      '4.2': 'CW Behaviour',
      '4.3': 'Reasons for Multimode Oscillation',
      '4.4': 'Single-Mode Selection',
    },
  },
};

// ---------- digit-class helpers (ASCII <-> Unicode math digit) ----------

const MATH_DIGIT = { 0: '𝟘', 1: '𝟙', 2: '𝟚', 3: '𝟛', 4: '𝟜', 5: '𝟝', 6: '𝟞', 7: '𝟟', 8: '𝟠', 9: '𝟡' };
const MATH_DIGIT_TO_ASCII = Object.fromEntries(Object.entries(MATH_DIGIT).map(([a, b]) => [b, a]));

// Regex character class matching either the ASCII digit `d` or its Unicode
// math-digit twin, e.g. digitClass(3) -> "[3𝟛]"
function digitClass(d) {
  return `[${d}${MATH_DIGIT[d]}]`;
}

// Matches one or more digits in either convention, e.g. "34" or "𝟛𝟜" or "3𝟜"
const ANY_DIGITS = '[0-9𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡]+';

// Converts a heading's captured number (possibly mixed/Unicode) to a plain
// ASCII "3.4" / "1.4.2" style string for comparison.
//
// NOTE: uses [...raw] (code-point iteration), not raw.split(''), because
// the Unicode math digits are astral characters (surrogate pairs) and
// split('') would break each one into two meaningless UTF-16 halves.
function normalizeHeadingNumber(raw) {
  return [...raw]
    .map((ch) => MATH_DIGIT_TO_ASCII[ch] || ch)
    .join('');
}

// Any heading line, in either numbering convention: "3.4 Eigenmodes ..." or
// "𝟛.𝟜 Stability Condition" or a deeper "1.4.2.1 Spatial Coherence".
//
// NOTE: the `u` flag is required here. The Unicode math-digit glyphs (e.g.
// 𝟛) live outside the Basic Multilingual Plane and are represented in JS
// strings as surrogate pairs. Without `u`, a character class like [3𝟛]
// matches raw UTF-16 code units (splitting the surrogate pair into two
// unrelated, useless entries) instead of the intended code point. With `u`,
// character classes correctly treat each astral glyph as a single unit.
const HEADING_RE = new RegExp(`(?:^|\\n)(${ANY_DIGITS}(?:\\.${ANY_DIGITS})+)[ \\t]+([^\\n]+)`, 'gu');

// ---------- corpus loading (cached) ----------

let _corpusText = null;
let _corpusMtimeMs = null;

function loadCorpus({ forceReload = false } = {}) {
  if (_corpusText !== null && !forceReload) return _corpusText;
  let stat;
  try {
    stat = fs.statSync(CORPUS_PATH);
    _corpusText = fs.readFileSync(CORPUS_PATH, 'utf8');
    _corpusMtimeMs = stat.mtimeMs;
  } catch (e) {
    _corpusText = null;
    _corpusMtimeMs = null;
    throw new Error(`corpusLoader: could not read ${CORPUS_PATH}: ${e.message}`);
  }
  return _corpusText;
}

function corpusLooksHealthy() {
  try {
    const text = loadCorpus();
    return typeof text === 'string' && text.length > 1000;
  } catch (e) {
    return false;
  }
}

// ---------- block extraction ----------

function chapterBlockMarkers(chapter) {
  // e.g. chapter=3 -> BEGIN TEXTBOOK CHAPTER 3 ... END TEXTBOOK CHAPTER 3
  const cd = digitClass(chapter);
  return new RegExp(
    `===== BEGIN TEXTBOOK CHAPTER ${cd}[^\\n]*=====\\n([\\s\\S]*?)===== END TEXTBOOK CHAPTER ${cd}[^\\n]*=====`,
    'mu'
  );
}

function getTextbookChapterBlock(chapter, corpusText) {
  const m = corpusText.match(chapterBlockMarkers(chapter));
  return m ? m[1] : '';
}

let _slidesBlockCache = null;

function getSlidesBlock(corpusText) {
  if (_slidesBlockCache !== null) return _slidesBlockCache;
  const m = corpusText.match(
    /===== BEGIN LECTURE SLIDES[^\n]*=====\n([\s\S]*?)===== END LECTURE SLIDES[^\n]*=====/mu
  );
  _slidesBlockCache = m ? m[1] : '';
  return _slidesBlockCache;
}

// NOTE: we deliberately do NOT try to bound a chapter's slide content by
// searching for its bare top-level heading (e.g. "𝟚. Semiclassical Theory
// ..."). The slide deck repeats a mini table-of-contents (all 4 chapter
// titles, one per line) at the start of the deck and again at the start of
// each chapter, so the very first occurrence of a chapter's bare heading is
// immediately followed by the *next* chapter's bare heading on the next
// line, producing an empty/near-empty slice. Instead, for slides we always
// go straight to section-level headings ("2.3 Fermi's Golden Rule" /
// "𝟚.𝟛 Fermi's Golden Rule"), which are unambiguous (a "2.3" heading can only
// belong to chapter 2). Whole-chapter slide excerpts are built by
// concatenating each of the chapter's known sections (see
// getChapterCombinedBlock below).

// ---------- section-level slicing within a chapter's combined text ----------

function extractSection(scopeText, chapter, section) {
  const wanted = `${chapter}.${section.split('.')[1]}`; // normalize to "3.4" form
  const headings = [...scopeText.matchAll(HEADING_RE)].map((m) => ({
    index: m.index,
    lineStart: m.index + m[0].indexOf(m[1]),
    number: normalizeHeadingNumber(m[1]),
    contentStart: m.index + m[0].length,
  }));

  if (!headings.length) return null;

  const matchesWanted = (num) => num === wanted || num.startsWith(`${wanted}.`);

  const chunks = [];
  for (let i = 0; i < headings.length; i++) {
    if (!matchesWanted(headings[i].number)) continue;
    const start = headings[i].contentStart;
    const end = i + 1 < headings.length ? headings[i + 1].index : scopeText.length;
    const chunk = scopeText.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }

  if (!chunks.length) return null;

  // De-duplicate identical consecutive chunks (running-header artifacts).
  const deduped = chunks.filter((c, i) => c !== chunks[i - 1]);
  return deduped.join('\n\n');
}

// ---------- balanced multi-part truncation ----------

// Truncates a list of text parts to fit within `maxChars` total, splitting
// the budget so no single part can starve the others out entirely (which is
// what a naive join-then-slice(0, maxChars) does when the first part alone
// exceeds maxChars). Parts that fit within an equal share keep their full
// text; the leftover budget from those is redistributed to the parts that
// still need it, so a short part never wastes budget and a long part never
// hogs it beyond what the others actually need.
function truncateBalanced(parts, maxChars) {
  const nonEmpty = parts.filter(Boolean);
  if (nonEmpty.length === 0) return '';
  if (nonEmpty.length === 1) {
    const p = nonEmpty[0];
    return p.length > maxChars ? p.slice(0, maxChars) + '\n\n[...excerpt truncated...]' : p;
  }

  const SEP = '\n\n';
  let budget = maxChars - SEP.length * (nonEmpty.length - 1);
  const shares = new Array(nonEmpty.length).fill(0);
  const active = nonEmpty.map((_, i) => i);

  while (active.length > 0) {
    const per = Math.floor(budget / active.length);
    const satisfied = active.filter((i) => nonEmpty[i].length <= per);
    if (satisfied.length === 0) {
      // No remaining part fits within an equal share of what's left —
      // split the rest evenly among them.
      active.forEach((i) => { shares[i] = per; });
      break;
    }
    satisfied.forEach((i) => {
      shares[i] = nonEmpty[i].length;
      budget -= nonEmpty[i].length;
    });
    satisfied.forEach((i) => active.splice(active.indexOf(i), 1));
  }

  return nonEmpty
    .map((p, i) => (p.length <= shares[i] ? p : p.slice(0, shares[i]) + '\n\n[...truncated...]'))
    .join(SEP);
}

// ---------- glossary (terminology.json) ----------

let _glossary = null;

function loadGlossary({ forceReload = false } = {}) {
  if (_glossary !== null && !forceReload) return _glossary;
  try {
    const raw = fs.readFileSync(TERMINOLOGY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    _glossary = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`corpusLoader: could not read/parse ${TERMINOLOGY_PATH}: ${e.message}`);
    _glossary = [];
  }
  return _glossary;
}

function glossaryLooksHealthy() {
  const g = loadGlossary();
  return Array.isArray(g) && g.length > 50;
}

function normalizeTerm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Looks up a student-typed term against the glossary. Ranks exact
// normalized matches first, then prefix/substring matches either
// direction (so "population inversion" matches a query of just
// "inversion", and "gain" matches an entry titled "gain saturation").
function findGlossaryTerms(query, limit = 3) {
  const glossary = loadGlossary();
  const q = normalizeTerm(query);
  if (!q || !glossary.length) return [];

  const exact = [];
  const starts = [];
  const includes = [];

  for (const entry of glossary) {
    const termNorm = normalizeTerm(entry.term);
    if (!termNorm) continue;
    if (termNorm === q) {
      exact.push(entry);
    } else if (termNorm.startsWith(q) || q.startsWith(termNorm)) {
      starts.push(entry);
    } else if (termNorm.includes(q) || q.includes(termNorm)) {
      includes.push(entry);
    }
  }

  return [...exact, ...starts, ...includes].slice(0, limit);
}

// ---------- public API ----------

/**
 * Returns a text excerpt for a chapter (optionally narrowed to one section),
 * combining the textbook chapter prose and the matching lecture-slide
 * bullets. Throws only if the corpus file itself can't be read or the
 * chapter number is invalid — a missing/unmatched section falls back
 * gracefully to the whole chapter excerpt (with a console warning) rather
 * than throwing, since the two source documents don't always number
 * sub-sections identically.
 *
 * When the combined excerpt exceeds the char cap, each source (textbook /
 * slides) is truncated independently via a balanced budget split
 * (truncateBalanced) rather than concatenating first and slicing from the
 * front — otherwise a long textbook section could consume the entire cap
 * before the lecture-slide portion is ever appended.
 *
 * @param {number|string} chapter - 1-4
 * @param {string} [section] - e.g. "2.3"; omit for the whole chapter
 * @param {object} [opts]
 * @param {number} [opts.maxChars] - truncate the returned excerpt
 * @returns {string}
 */
function getCorpusSection(chapter, section, opts = {}) {
  const chapterNum = parseInt(chapter, 10);
  if (!SECTION_INDEX[chapterNum]) {
    throw new Error(`corpusLoader: unknown chapter "${chapter}" (expected 1-4)`);
  }
  if (section && !SECTION_INDEX[chapterNum].sections[section]) {
    throw new Error(`corpusLoader: unknown section "${section}" for chapter ${chapterNum}`);
  }

  const corpusText = loadCorpus(); // throws if unreadable

  const textbookBlock = getTextbookChapterBlock(chapterNum, corpusText);
  const slidesFull = getSlidesBlock(corpusText);

  if (!textbookBlock && !slidesFull) {
    throw new Error(
      `corpusLoader: could not locate chapter ${chapterNum} content in course_corpus.txt ` +
      `(corpus may be stale or malformed — try re-running build_corpus.js)`
    );
  }

  if (!section) {
    // Whole chapter: textbook prose (bounded by BEGIN/END markers) plus every
    // known section's slide content, concatenated in section order. Each
    // source gets a fair share of the char budget (see truncateBalanced)
    // rather than the textbook block silently eating the whole cap.
    const slideParts = listSections(chapterNum)
      .map((sec) => extractSection(slidesFull, chapterNum, sec))
      .filter(Boolean);
    const maxChars = opts.maxChars || DEFAULT_MAX_CHARS_CHAPTER;
    return truncateBalanced([textbookBlock, ...slideParts], maxChars);
  }

  const fromTextbook = textbookBlock ? extractSection(textbookBlock, chapterNum, section) : null;
  const fromSlides = slidesFull ? extractSection(slidesFull, chapterNum, section) : null;
  const parts = [fromTextbook, fromSlides].filter(Boolean);
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;

  if (parts.length) {
    return truncateBalanced(parts, maxChars);
  }

  console.warn(
    `corpusLoader: no heading match for section ${chapterNum}.${section.split('.')[1]} ` +
    `— falling back to the whole chapter ${chapterNum} excerpt`
  );
  const slideParts = listSections(chapterNum)
    .map((sec) => extractSection(slidesFull, chapterNum, sec))
    .filter(Boolean);
  return truncateBalanced([textbookBlock, ...slideParts], maxChars);
}

function listChapters() {
  return Object.keys(SECTION_INDEX).map(Number).sort((a, b) => a - b);
}

function listSections(chapter) {
  const entry = SECTION_INDEX[parseInt(chapter, 10)];
  if (!entry) return [];
  return Object.keys(entry.sections);
}

function getChapterTitle(chapter) {
  return SECTION_INDEX[parseInt(chapter, 10)]?.title || null;
}

function getSectionTitle(chapter, section) {
  return SECTION_INDEX[parseInt(chapter, 10)]?.sections?.[section] || null;
}

function isValidSection(chapter, section) {
  return Boolean(SECTION_INDEX[parseInt(chapter, 10)]?.sections?.[section]);
}

module.exports = {
  getCorpusSection,
  listChapters,
  listSections,
  getChapterTitle,
  getSectionTitle,
  isValidSection,
  corpusLooksHealthy,
  SECTION_INDEX,
  // glossary / /define command
  glossaryLooksHealthy,
  findGlossaryTerms,
  // exposed mainly for tests / buildQuizBank.js diagnostics
  _loadCorpus: loadCorpus,
  _loadGlossary: loadGlossary,
};
