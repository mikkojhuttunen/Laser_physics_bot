/**
 * Regenerate course_corpus.txt from the original PDFs.
 * Run this LOCALLY (not on Railway) whenever the course material changes:
 *
 *   npm install pdf-parse
 *   node build_corpus.js ./pdfs
 *
 * Then commit the new course_corpus.txt AND homework_problems.json and redeploy.
 *
 * IMPORTANT: do not put HW*_solutions.pdf in the folder. The bot should not
 * have the worked solutions.
 *
 * HOMEWORK FILES: any PDF with "hw" in its filename is scanned for "Homework <N>"
 * headers and split into one section per number found — this works whether you
 * have six separate FYS_501_Laser_HW<N>.pdf files OR one combined PDF containing
 * all homeworks (e.g. FYS_501_LaserPhysics_allHWs_2026.pdf), so you don't need to
 * keep the file layout in sync with this script.
 *
 * HOMEWORK NUMBERING: each top-level problem must start its own line with
 * exactly "<N>.<n>" (e.g. "1.1", "1.2", "2.1" ...), where <N> matches the
 * "Homework <N>" section it's under. This script splits on that pattern and
 * writes homework_problems.json — { "1": { "1": "<full text of problem 1.1>",
 * "2": "..." }, "2": {...} } — which bot.js uses to look up an exact problem's
 * text for /HW<N>.<n> instead of asking Claude to search the whole corpus.
 */

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

// Order the material sensibly; anything not listed is appended alphabetically.
const PREFERRED_ORDER = [
  "Laser_Physics_Slides.pdf",
  "Chapter_1.pdf",
  "Chapter_2.pdf",
  "Chapter_3.pdf",
  "Chapter_4.pdf",
  "FYS_501_LaserPhysics_allHWs_2026.pdf",
];

// PowerPoint animation layers make the same phrase appear 5-10 times in a row.
function collapseRepeats(line) {
  const re = /(\S.{7,}?)(?:\s*\1)+/g;
  let prev = null;
  let out = line;
  while (prev !== out) {
    prev = out;
    out = out.replace(re, "$1");
  }
  return out;
}

function clean(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => collapseRepeats(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --------------------------------------------------- homework section split -
// A PDF that mentions "hw" in its filename may contain one or several
// homeworks. Split its cleaned text into sections by finding every occurrence
// of "Homework <N>" (the standard header line, e.g. "...Exercises and
// Homework 3") and slicing from each occurrence to the next. Sections sharing
// the same number are concatenated rather than overwritten (defensive, in
// case a homework spans a stray extra "Homework N" mention).
function splitIntoHomeworkSections(body) {
  const headerRe = /Homework\s+(\d+)\b/gi;
  const matches = [...body.matchAll(headerRe)];
  if (matches.length === 0) return [];

  const merged = {};
  for (let i = 0; i < matches.length; i++) {
    const hwNum = matches[i][1];
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const text = body.slice(start, end).trim();
    merged[hwNum] = merged[hwNum] ? `${merged[hwNum]}\n\n${text}` : text;
  }
  return Object.keys(merged)
    .sort((a, b) => Number(a) - Number(b))
    .map((hwNum) => ({ hwNum, text: merged[hwNum] }));
}

// New HW sheets number every top-level problem "<hw>.<problem>", e.g. "1.1",
// "1.2", "2.1" — one number per problem, unique within its homework.
// This splits a homework section's text into { "1": "full text of 1.1", ... }
// by looking for lines that START with "<hwNum>.<n>" (whole line, own paragraph).
// A line like "1.10" won't be mistaken for "1.1" because of the trailing \b.
function parseHomeworkProblems(hwNum, body) {
  const headerRe = new RegExp(`^${hwNum}\\.(\\d+)\\b`);
  const lines = body.split("\n");
  const problems = {};
  let current = null;
  let buffer = [];

  for (const line of lines) {
    const m = line.trim().match(headerRe);
    if (m) {
      if (current) problems[current] = buffer.join("\n").trim();
      current = m[1];
      buffer = [line];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) problems[current] = buffer.join("\n").trim();
  return problems;
}

async function main() {
  const dir = process.argv[2] || "./pdfs";
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));

  const rejected = files.filter((f) => /solution/i.test(f));
  if (rejected.length) {
    console.error(`REFUSING to include solution files: ${rejected.join(", ")}`);
    console.error("Remove them from the folder and rerun.");
    process.exit(1);
  }

  const ordered = [
    ...PREFERRED_ORDER.filter((f) => files.includes(f)),
    ...files.filter((f) => !PREFERRED_ORDER.includes(f)).sort(),
  ];

  const parts = [
    "COURSE MATERIAL CORPUS — FYS.501 Laser Physics",
    "Text extracted from the official course PDFs. Homework solutions are excluded.",
    "Some mathematical symbols are garbled by PDF text extraction; read them from context.",
  ];

  const homeworkProblems = {}; // { "1": { "1": "text...", "2": "text..." }, "2": {...} }

  for (const f of ordered) {
    const data = await pdfParse(fs.readFileSync(path.join(dir, f)));
    const body = clean(data.text);

    if (/hw/i.test(f)) {
      const sections = splitIntoHomeworkSections(body);
      if (sections.length === 0) {
        console.warn(
          `WARNING: "${f}" looks like a homework file (filename contains "hw") but no "Homework <N>" ` +
          `header was found in its text — including it as generic material instead.`
        );
        parts.push(`\n\n===== BEGIN ${f} (${data.numpages} pages) =====\n\n${body}\n\n===== END ${f} =====`);
        console.log(`${f.padEnd(34)} ${String(data.numpages).padStart(4)} pages  ${body.length.toLocaleString()} chars`);
        continue;
      }
      for (const { hwNum, text: sectionBody } of sections) {
        const problems = parseHomeworkProblems(hwNum, sectionBody);
        const found = Object.keys(problems).length;
        homeworkProblems[hwNum] = problems;
        parts.push(
          `\n\n===== BEGIN HOMEWORK ${hwNum} — assignment sheet (questions only, no solutions)  [file: ${f}] =====\n\n${sectionBody}\n\n===== END HOMEWORK ${hwNum} — assignment sheet (questions only, no solutions) =====`
        );
        console.log(
          `  Homework ${hwNum} (from ${f})`.padEnd(34) +
            ` ${sectionBody.length.toLocaleString()} chars` +
            `  (parsed ${found} problem${found === 1 ? "" : "s"}: ${Object.keys(problems).sort((a, b) => Number(a) - Number(b)).map((n) => `${hwNum}.${n}`).join(", ") || "NONE — check numbering!"})`
        );
      }
    } else {
      parts.push(`\n\n===== BEGIN ${f} (${data.numpages} pages) =====\n\n${body}\n\n===== END ${f} =====`);
      console.log(`${f.padEnd(34)} ${String(data.numpages).padStart(4)} pages  ${body.length.toLocaleString()} chars`);
    }
  }

  const corpus = parts.join("\n");
  fs.writeFileSync("course_corpus.txt", corpus, "utf8");
  console.log(
    `\nWrote course_corpus.txt — ${corpus.length.toLocaleString()} chars ` +
    `(~${Math.round(corpus.length / 3.7).toLocaleString()} tokens)`
  );
  if (corpus.length / 3.7 > 150000) {
    console.warn("WARNING: corpus is large. Consider splitting by topic.");
  }

  fs.writeFileSync("homework_problems.json", JSON.stringify(homeworkProblems, null, 2), "utf8");
  const totalProblems = Object.values(homeworkProblems).reduce((n, hw) => n + Object.keys(hw).length, 0);
  console.log(`Wrote homework_problems.json — ${totalProblems} problems across ${Object.keys(homeworkProblems).length} homeworks`);
  for (const [hwNum, problems] of Object.entries(homeworkProblems)) {
    if (Object.keys(problems).length === 0) {
      console.warn(
        `WARNING: found 0 numbered problems in Homework ${hwNum}. Check that each problem's PDF text ` +
        `starts its own line with exactly "${hwNum}.<n>" (e.g. "${hwNum}.1").`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
