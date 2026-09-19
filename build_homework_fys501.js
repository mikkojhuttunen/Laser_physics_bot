/**
 * Regenerate homework_problems_fys501.json for the FYS.501 Laser Physics bot,
 * directly from the HW#_FYS501_ModelSolutions.tex sources — the same
 * approach build_corpus.js uses for the lecture material, applied to the
 * homework problem statements instead.
 *
 * Each HW file wraps every problem statement in a single-argument
 * \Exercise{...} macro, in order, right after \HWset{<n>}. This script:
 *   1. Reads \HWset{<n>} to get the homework number.
 *   2. Finds every top-level \Exercise{...} block (balanced braces).
 *   3. Runs each block's raw LaTeX through clean_fys240.js's cleanTex(),
 *      the same LaTeX->Unicode pipeline used for the lecture corpus.
 *   4. Strips the trailing "(N points)" / "(N~points)" annotation, since
 *      the bot's own /HWn overview builder re-adds point context itself
 *      only when needed, and it's not useful inside a quoted "verbatim
 *      problem text" block sent to Claude.
 *   5. Numbers problems 1..N in the order they appear in the file.
 *
 * IMPORTANT: only the \Exercise{...} problem STATEMENTS are extracted —
 * everything inside \solution{...} (worked answers) is never touched, so
 * no solution text can leak into a student-facing hint.
 *
 * Run locally whenever a HW#_FYS501_ModelSolutions.tex source changes:
 *
 *   node build_homework_fys501.js <tex_dir>
 *
 * Then commit the new homework_problems_fys501.json and redeploy the laser bot.
 */

const fs = require('fs');
const path = require('path');
const clean = require('./clean_fys240.js');

const HW_FILENAME_RE = /^HW(\d+)_FYS501_ModelSolutions\.tex$/;

// Some exercises use literal escaped braces as math delimiters, e.g.
// \left\{ ... \right. (a visible left brace paired with an INVISIBLE right
// delimiter — valid LaTeX, but it means the raw text has a real "\{" with
// no matching "\}"). matchBrace() just counts bare { and } characters, so
// it must never see those literal, escaped ones while it's hunting for the
// \Exercise{...} block's real closing brace. Stash "\{"/"\}" as same-slot
// placeholders first (so indices found via matchBrace stay valid against
// this same neutralized copy), extract the block from the neutralized
// copy, then restore the placeholders before handing the block to
// cleanTex() (which does its own, identical stashing internally).
function neutralizeLiteralBraces(text) {
  return text.replace(/\\\{/g, '\u0002').replace(/\\\}/g, '\u0003');
}
function restoreLiteralBraces(text) {
  return text.replace(/\u0002/g, '\\{').replace(/\u0003/g, '\\}');
}

function findExerciseBlocks(raw) {
  const neutral = neutralizeLiteralBraces(raw);
  const blocks = [];
  const re = /\\Exercise\{/g;
  let m;
  while ((m = re.exec(neutral)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = clean.matchBrace(neutral, openIdx);
    if (closeIdx === -1) {
      console.warn(`  WARNING: unmatched \\Exercise{ at offset ${m.index} — skipped`);
      continue;
    }
    blocks.push(restoreLiteralBraces(neutral.slice(openIdx + 1, closeIdx)));
    re.lastIndex = closeIdx + 1; // resume scanning after this block
  }
  return blocks;
}

function main() {
  const texDir = process.argv[2] || '.';
  const files = fs.readdirSync(texDir).filter((f) => HW_FILENAME_RE.test(f));

  if (!files.length) {
    console.error(`No HW#_FYS501_ModelSolutions.tex files found in ${texDir}`);
    process.exit(1);
  }

  const result = {};
  const stats = [];

  for (const file of files.sort()) {
    const hwNum = file.match(HW_FILENAME_RE)[1];
    const raw = fs.readFileSync(path.join(texDir, file), 'utf8');

    const hwSetMatch = raw.match(/\\HWset\{(\d+)\}/);
    if (hwSetMatch && hwSetMatch[1] !== hwNum) {
      console.warn(`  WARNING: ${file} filename says HW${hwNum} but \\HWset{${hwSetMatch[1]}} inside — using filename`);
    }

    const blocks = findExerciseBlocks(raw);
    if (!blocks.length) {
      console.warn(`  WARNING: no \\Exercise{...} blocks found in ${file}`);
      continue;
    }

    result[hwNum] = {};
    blocks.forEach((block, i) => {
      const problemNum = String(i + 1);
      // Dirac notation: \ket{X} / \bra{X} aren't in clean_fys240.js's macro
      // table (it was built against FYS.240's lecture slides, which don't
      // use braket notation) — resolve them to |X⟩ / ⟨X| before the generic
      // cleaner runs, or it silently drops the ket/bra markers and keeps
      // only X.
      let pre = clean.unwrapMacro(block, 'ket', { transform: (inner) => `|${inner}⟩` });
      pre = clean.unwrapMacro(pre, 'bra', { transform: (inner) => `⟨${inner}|` });

      let cleaned = clean.cleanTex(pre);
      // TeX's "~" (non-breaking space) isn't handled by clean_fys240.js
      // either (same reason) — it's common in this homework source
      // ("5.0~m^{-1}", "(5~points)") and should just read as a space.
      cleaned = cleaned.replace(/~/g, ' ').replace(/ {2,}/g, ' ');
      // Strip a trailing point-value annotation, e.g. "(5 points)".
      cleaned = cleaned.replace(/\s*\(\s*\d+\s*points?\s*\)\s*$/i, '').trim();
      result[hwNum][problemNum] = `${hwNum}.${problemNum}.\n${cleaned}`;
    });

    stats.push({ file, hwNum, count: blocks.length });
  }

  const outPath = path.join(process.cwd(), 'homework_problems_fys501.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log('File'.padEnd(45) + 'HW#'.padEnd(6) + 'Problems');
  for (const s of stats) console.log(s.file.padEnd(45) + s.hwNum.padEnd(6) + s.count);
  const total = stats.reduce((n, s) => n + s.count, 0);
  console.log(`\nWrote homework_problems_fys501.json — ${total} problems across ${stats.length} homeworks`);
}

main();
