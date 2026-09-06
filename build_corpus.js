/**
 * Regenerate course_corpus.txt from the original PDFs.
 * Run this LOCALLY (not on Railway) whenever the course material changes:
 *
 *   npm install pdf-parse
 *   node build_corpus.js ./pdfs
 *
 * Then commit the new course_corpus.txt and redeploy.
 *
 * IMPORTANT: do not put HW*_solutions.pdf in the folder. The bot should not
 * have the worked solutions.
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
  "FYS_501_Laser_HW1.pdf",
  "FYS_501_Laser_HW2.pdf",
  "FYS_501_Laser_HW3.pdf",
  "FYS_501_Laser_HW4.pdf",
  "FYS_501_Laser_HW5.pdf",
  "FYS_501_Laser_HW6.pdf",
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

  for (const f of ordered) {
    const data = await pdfParse(fs.readFileSync(path.join(dir, f)));
    const body = clean(data.text);
    parts.push(`\n\n===== BEGIN ${f} (${data.numpages} pages) =====\n\n${body}\n\n===== END ${f} =====`);
    console.log(`${f.padEnd(34)} ${String(data.numpages).padStart(4)} pages  ${body.length.toLocaleString()} chars`);
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
