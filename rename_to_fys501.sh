#!/usr/bin/env bash
# rename_to_fys501.sh
#
# Renames every FYS.501 laser-bot file to carry an explicit "_fys501"
# suffix (bot.js -> bot_fys501.js, answer_key.json -> answer_key_fys501.json,
# etc.), and rewrites every require()/path reference to match. This is the
# generic-filename collision the project has already hit twice for real:
# clean_fys240.js turning up inside THIS repo, and homework_problems.json in
# the FYS.240 repo once being 100% laser content. A suffix makes a
# misplaced file obvious on sight instead of a silent footgun.
#
# WHAT THIS DOES, IN ORDER:
#   1. Sanity-checks you're at the repo root with a clean working tree.
#   2. Creates a new branch (never runs on main/master directly).
#   3. git mv's every file in the RENAMES list that actually exists (skips
#      anything missing, so it's safe to run against a partial checkout).
#   4. Rewrites every require("./oldname") / require('./oldname') and every
#      bare filename.ext reference across all tracked .js/.md/.txt files
#      (course_corpus*.txt excluded -- that's course content, not code).
#   5. Updates package.json's "main" and "scripts.start".
#   6. Runs `node --check` on every renamed .js file to catch anything the
#      text rewrite missed (a broken require shows up immediately here,
#      before you ever push).
#   7. Prints any leftover occurrences of the OLD names it couldn't
#      confidently rewrite, so you can eyeball those by hand.
#
# It deliberately does NOT touch package.json's own filename, package-lock.json,
# .gitignore, or any .pdf/.docx/.tex file — renaming those either breaks
# tooling (package.json must keep that exact name) or has no upside (the
# .tex lecture/HW sources are already unambiguously named per-chapter/per-HW).
#
# USAGE:
#   cd /path/to/Laser_physics_bot          # repo root, where package.json is
#   chmod +x rename_to_fys501.sh
#   ./rename_to_fys501.sh
#   git diff --stat                        # review WHAT changed
#   git diff                               # review the actual line-level changes
#   node --check bot_fys501.js             # already run for you in step 6, but re-check after any manual fix
#   # ... run your usual mocked-webhook test harness here ...
#   git add -A && git commit -m "Rename all files with an explicit _fys501 suffix"
#   git push -u origin rename-fys501-suffix   # then open a PR / merge as you prefer
#
# After merging, update Railway's start command if it overrides package.json
# anywhere (check the Railway dashboard's deploy settings, not just this repo).

set -euo pipefail

# ---------------------------------------------------------------- 1) checks --
if [ ! -f package.json ]; then
  echo "ERROR: no package.json here -- run this from the repo root." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree isn't clean. Commit or stash first, then re-run." >&2
  exit 1
fi

# ---------------------------------------------------------- 2) new branch ----
BRANCH="rename-fys501-suffix"
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "ERROR: branch $BRANCH already exists -- delete it or pick a new name." >&2
  exit 1
fi
git checkout -b "$BRANCH"

# --------------------------------------------------------- 3) git mv files --
rename() {
  local old="$1" new="$2"
  if [ -f "$old" ]; then
    git mv "$old" "$new"
    echo "renamed:  $old  ->  $new"
  else
    echo "skip (not found):  $old"
  fi
}

echo "--- renaming files ---"

# code / build scripts
rename bot.js                                   bot_fys501.js
rename bot_aggressive_but_crashing.js            bot_aggressive_but_crashing_fys501.js
rename bot_v1_working_but_no_lecture_links.js    bot_v1_working_but_no_lecture_links_fys501.js
rename bot_reverted_no_latex.js                  bot_reverted_no_latex_fys501.js
rename clean.js                                  clean_fys501.js
rename corpusLoader.js                           corpusLoader_fys501.js
rename lectureLinks.js                           lectureLinks_fys501.js
rename lectureClassifier.js                      lectureClassifier_fys501.js
rename quizGenerator.js                          quizGenerator_fys501.js
rename quiz_content.js                           quiz_content_fys501.js
rename hwCommands.js                             hwCommands_fys501.js
rename latex-renderer.js                         latex-renderer_fys501.js
rename terminology.js                            terminology_fys501.js
rename build_corpus.js                           build_corpus_fys501.js
rename build_corpus_v2.js                        build_corpus_fys501_v2.js
rename buildQuizBank.js                          buildQuizBank_fys501.js
rename buildHwAnswerKey.js                       buildHwAnswerKey_fys501.js
rename buildHomeworkProblems.js                  buildHomeworkProblems_fys501.js

# data
rename course_corpus.txt                         course_corpus_fys501.txt
rename course_corpus_v2.txt                       course_corpus_fys501_v2.txt
rename lecture_data.json                         lecture_data_fys501.json
rename quizBank.json                             quizBank_fys501.json
rename quizBankPending.json                      quizBankPending_fys501.json
rename terminology.json                          terminology_fys501.json
rename homework_problems.json                    homework_problems_fys501.json
rename answer_key.json                           answer_key_fys501.json
rename hwAnswerKeyPending.json                   hwAnswerKeyPending_fys501.json
rename video_references.json                     video_references_fys501.json

# Not renamed by this script, on purpose:
#   package.json, package-lock.json, .gitignore  -- tooling needs these exact names
#   *.pdf, *.docx, *.tex                          -- unambiguous already / binary, don't text-sweep these
if [ -f clean_fys240.js ]; then
  echo
  echo "NOTE: clean_fys240.js is still here. It almost certainly belongs to the" \
       "FYS.240 optics repo, not this one -- worth 'git rm clean_fys240.js' by" \
       "hand rather than renaming it into this project."
fi

# --------------------------------------------------- 4) rewrite references ---
echo
echo "--- rewriting references in tracked .js / .md / .txt files ---"

# Each pair here is a LITERAL string (no regex metacharacters get special
# treatment -- perl's \Q...\E below escapes them), so filenames with dots
# and hyphens are handled safely and can't accidentally partially-match
# each other's replacement text.
OLD_NAMES=(
  'require("./bot")'                       # unlikely, but harmless if absent
  '"./corpusLoader"'      "'./corpusLoader'"
  '"./lectureLinks"'      "'./lectureLinks'"
  '"./lectureClassifier"' "'./lectureClassifier'"
  '"./quizGenerator"'     "'./quizGenerator'"
  '"./quiz_content"'      "'./quiz_content'"
  '"./hwCommands"'        "'./hwCommands'"
  '"./clean"'             "'./clean'"
  '"./clean.js"'          "'./clean.js'"
  '"./latex-renderer"'    "'./latex-renderer'"
  '"./terminology"'       "'./terminology'"
  'bot.js'
  'course_corpus.txt'
  'course_corpus_v2.txt'
  'lecture_data.json'
  'quizBank.json'
  'quizBankPending.json'
  'terminology.json'
  'homework_problems.json'
  'answer_key.json'
  'hwAnswerKeyPending.json'
  'video_references.json'
)
NEW_NAMES=(
  'require("./bot_fys501")'
  '"./corpusLoader_fys501"'      "'./corpusLoader_fys501'"
  '"./lectureLinks_fys501"'      "'./lectureLinks_fys501'"
  '"./lectureClassifier_fys501"' "'./lectureClassifier_fys501'"
  '"./quizGenerator_fys501"'     "'./quizGenerator_fys501'"
  '"./quiz_content_fys501"'      "'./quiz_content_fys501'"
  '"./hwCommands_fys501"'        "'./hwCommands_fys501'"
  '"./clean_fys501"'             "'./clean_fys501'"
  '"./clean_fys501.js"'          "'./clean_fys501.js'"
  '"./latex-renderer_fys501"'    "'./latex-renderer_fys501'"
  '"./terminology_fys501"'       "'./terminology_fys501'"
  'bot_fys501.js'
  'course_corpus_fys501.txt'
  'course_corpus_fys501_v2.txt'
  'lecture_data_fys501.json'
  'quizBank_fys501.json'
  'quizBankPending_fys501.json'
  'terminology_fys501.json'
  'homework_problems_fys501.json'
  'answer_key_fys501.json'
  'hwAnswerKeyPending_fys501.json'
  'video_references_fys501.json'
)

# Files to sweep: tracked .js/.md/.txt, excluding the large course-corpus
# text dumps (course content, not code -- no filename references live there).
mapfile -t FILES < <(git ls-files -- '*.js' '*.md' '*.txt' | grep -v -E '^course_corpus(_fys501)?(_v2)?\.txt$')

for i in "${!OLD_NAMES[@]}"; do
  old="${OLD_NAMES[$i]}"
  new="${NEW_NAMES[$i]}"
  for f in "${FILES[@]}"; do
    [ -f "$f" ] || continue
    if grep -qF -- "$old" "$f"; then
      OLD="$old" NEW="$new" perl -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$f"
      echo "  updated reference in $f:  $old  ->  $new"
    fi
  done
done

# --------------------------------------------------- 5) package.json fields --
echo
echo "--- updating package.json ---"
perl -pi -e 's/"main":\s*"bot\.js"/"main": "bot_fys501.js"/' package.json
perl -pi -e 's/"start":\s*"node bot\.js"/"start": "node bot_fys501.js"/' package.json
grep -n '"main"\|"start"' package.json

# --------------------------------------------------- 6) syntax-check .js -----
echo
echo "--- node --check on every renamed .js file ---"
for f in "${FILES[@]}"; do
  case "$f" in
    *.js)
      if [ -f "$f" ]; then
        node --check "$f" && echo "  ok: $f" || echo "  ！SYNTAX ERROR in $f -- fix before committing" >&2
      fi
      ;;
  esac
done

# --------------------------------------------------- 7) leftover check ------
echo
echo "--- residual occurrences of OLD names (should be empty or only in .tex/.pdf/.docx) ---"
for i in "${!OLD_NAMES[@]}"; do
  old="${OLD_NAMES[$i]}"
  git grep -nF -- "$old" -- '*.js' '*.md' '*.txt' 2>/dev/null | grep -v -E '^course_corpus' || true
done

echo
echo "Done. Now:"
echo "  git diff --stat        # see what changed"
echo "  git diff               # review line-level changes"
echo "  (run your test harness)"
echo "  git add -A && git commit -m 'Rename all files with an explicit _fys501 suffix'"
