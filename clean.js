/**
 * clean.js — turns a raw lecture .tex file into clean, flowing plain text
 * with Unicode math, suitable for an LLM-facing course corpus.
 */

// ---------- balanced-brace helpers ----------

// Given a string and the index of an opening '{', return the index of the
// matching closing '}' (handles nesting). Returns -1 if unmatched.
function matchBrace(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Repeatedly unwraps \name[optional]{content} -> content (or -> '' if drop=true),
// for a given macro name, until no more occurrences remain. Handles nested braces.
function unwrapMacro(text, name, { drop = false, transform = null } = {}) {
  const re = new RegExp(`\\\\${name}(\\[[^\\]\\n]*\\])?\\{`, '');
  let out = text;
  let guard = 0;
  while (guard++ < 20000) {
    const m = out.match(re);
    if (!m) break;
    const openIdx = m.index + m[0].length - 1; // index of the '{'
    const closeIdx = matchBrace(out, openIdx);
    if (closeIdx === -1) {
      // unmatched brace — bail out to avoid infinite loop, strip the macro token only
      out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
      continue;
    }
    const inner = out.slice(openIdx + 1, closeIdx);
    const optArg = m[1] ? m[1].slice(1, -1) : null;
    const replacement = drop ? '' : (transform ? transform(inner, optArg) : inner);
    out = out.slice(0, m.index) + replacement + out.slice(closeIdx + 1);
  }
  return out;
}

// Removes a whole environment \begin{name}...\end{name} (non-nested version;
// fine for tikzpicture/minipage which don't nest in these files).
// Drops \xdef\name{...}, \gdef\name{...}, \def\name{...}, \edef\name{...}
// constructs entirely (TeX variable/macro (re)definitions used for layout
// bookkeeping — figure offsets, \loc anchors, \sectiontitle plumbing — none
// of which carry corpus-worthy content).
function dropDefinitions(text) {
  const re = /\\(?:xdef|gdef|edef|def)\\[A-Za-z]+\{/;
  let out = text;
  let guard = 0;
  while (guard++ < 20000) {
    const m = out.match(re);
    if (!m) break;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchBrace(out, openIdx);
    if (closeIdx === -1) {
      out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
      continue;
    }
    out = out.slice(0, m.index) + out.slice(closeIdx + 1);
  }
  return out;
}

// Un-escapes literal characters TeX requires backslashed, and strips the
// \( \) inline-math shorthand delimiters (content inside is handled by the
// math converters elsewhere in the pipeline).
function unescapeChars(text) {
  return text
    .replace(/\\\(/g, '')
    .replace(/\\\)/g, '')
    .replace(/\\%/g, '%')
    .replace(/\\&/g, '&')
    .replace(/\\_/g, '_')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    // Escaped literal set-notation braces \{ \} are REAL content, not a
    // macro delimiter — but converting them straight to "{"/"}" this early
    // would throw off every balanced-brace scan (matchBrace) done later for
    // actual macro unwrapping. Stash them as brace-shaped placeholder glyphs
    // instead; they read fine left as-is in the final text.
    .replace(/\\\{/g, '❴')
    .replace(/\\\}/g, '❵')
    // \- is TeX's discretionary-hyphen hint (manual hyphenation point) —
    // no text value, just drop it.
    .replace(/\\-/g, '');
}

// Unwraps a two-argument macro \name{arg1}{arg2}, keeping only arg 1 or 2
// (e.g. \texorpdfstring{tex}{plain} keeps arg 2; \raisebox{offset}{text}
// keeps arg 2). Falls back to keeping the single arg found if only one
// brace group follows (defensive; shouldn't normally happen).
function unwrapTwoArgMacro(text, name, keep = 2) {
  const re = new RegExp(`\\\\${name}\\{`);
  let out = text;
  let guard = 0;
  while (guard++ < 5000) {
    const m = out.match(re);
    if (!m) break;
    const open1 = m.index + m[0].length - 1;
    const close1 = matchBrace(out, open1);
    if (close1 === -1) { out = out.slice(0, m.index) + out.slice(m.index + m[0].length); continue; }
    const inner1 = out.slice(open1 + 1, close1);
    const afterFirst = out.slice(close1 + 1);
    if (!/^\{/.test(afterFirst)) {
      out = out.slice(0, m.index) + (keep === 1 ? inner1 : '') + out.slice(close1 + 1);
      continue;
    }
    const open2 = close1 + 1;
    const close2 = matchBrace(out, open2);
    const inner2 = out.slice(open2 + 1, close2);
    out = out.slice(0, m.index) + (keep === 1 ? inner1 : inner2) + out.slice(close2 + 1);
  }
  return out;
}

function removeEnvironment(text, name) {
  const re = new RegExp(`\\\\begin\\{${name}\\}[\\s\\S]*?\\\\end\\{${name}\\}`, 'g');
  return text.replace(re, '');
}

function unwrapEnvironment(text, name) {
  const reBegin = new RegExp(`\\\\begin\\{${name}\\}(\\[[^\\]\\n]*\\])?`, 'g');
  const reEnd = new RegExp(`\\\\end\\{${name}\\}`, 'g');
  return text.replace(reBegin, '').replace(reEnd, '');
}

// ---------- symbol maps ----------

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SUB_MAP = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ',
  i: 'ᵢ', j: 'ⱼ', u: 'ᵤ', v: 'ᵥ', r: 'ᵣ',
};

// Non-Greek word-macros with a plain symbol/space replacement. Merged with
// GREEK into one dictionary and applied in a single regex pass (see
// SYMBOL_MACROS below) so a longer macro name (e.g. "simeq") is always
// matched whole — never truncated by a shorter one (e.g. "sim") sharing its
// prefix, which a sequence of separate .replace(/\\sim/) calls would risk.
const OPERATOR_WORDS = {
  equal: '=', minus: '-', plus: '+', hbar: 'ℏ',
  Rightarrow: '⇒', Leftrightarrow: '⇔', rightarrow: '→', leftarrow: '←', to: '→',
  geq: '≥', leq: '≤', ge: '≥', le: '≤', neq: '≠', ne: '≠',
  approx: '≈', simeq: '≃', sim: '∼', propto: '∝',
  infty: '∞', partial: '∂', nabla: '∇',
  int: '∫', sum: '∑', prod: '∏', equiv: '≡',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓',
  langle: '⟨', rangle: '⟩',
  ldots: '…', dots: '…', cdots: '…', vdots: '⋮', ddots: '⋱',
  forall: '∀', exists: '∃', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩',
  emptyset: '∅', perp: '⊥', parallel: '∥', angle: '∠', circ: '∘', degree: '°',
  ll: '≪', gg: '≫', top: '⊤', bot: '⊥', wedge: '∧', vee: '∨', neg: '¬',
  quad: ' ', qquad: '  ',
  cong: '≅', iff: '⇔', circ: '∘',
  // course-specific short custom macros (bracket delimiters, big sum/int)
  lP: '(', rP: ')', LP: '(', RP: ')', lB: '[', rB: ']', LB: '[', RB: ']',
  nsum: '∑', nint: '∫', ell: 'ℓ',
  // function names — keep as plain words, just drop the backslash
  sin: 'sin', cos: 'cos', tan: 'tan', ln: 'ln', log: 'log', lim: 'lim',
  det: 'det', exp: 'exp', arg: 'arg',
};

const SUP_MAP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ',
  m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

function toSub(s) {
  return [...s].map((c) => SUB_MAP[c] ?? `_${c}`).join('');
}
function toSup(s) {
  return [...s].map((c) => SUP_MAP[c] ?? `^${c}`).join('');
}

// ---------- main pipeline ----------

function stripComments(text) {
  // Remove unescaped % to end of line (keep \%). Escaping parity matters:
  // "\%" is a literal percent, but "\\%" is a line-break macro (\\) followed
  // by a REAL comment-starting %, since the two backslashes pair off. A
  // naive "is the immediately preceding char a backslash?" check gets this
  // wrong, so count the run of backslashes already emitted and only treat
  // '%' as escaped when that run is odd.
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%') {
          let bs = 0;
          for (let j = out.length - 1; j >= 0 && out[j] === '\\'; j--) bs++;
          if (bs % 2 === 0) break;
        }
        out += line[i];
      }
      return out;
    })
    .join('\n');
}

// Drop whole-macro-with-arg constructs we never want in the output at all.
function dropStructuralMacros(text) {
  let out = text;
  for (const name of [
    'xdef', 'label', 'includegraphics', 'vspace', 'hspace', 'part', 'section',
    'frametitle', 'framesubtitle', 'caption',
  ]) {
    out = unwrapMacro(out, name, { drop: true });
  }
  // bare macros with no braces
  out = out.replace(/\\(TOCrefs|TOCcourse|endofslide|endofsection|noindent|centering|clearpage|newpage)\b/g, '');
  // \begin{frame}[...] / \end{frame} -> sentinels (resolved later by
  // splitFrames, once frame content is fully cleaned, so near-empty frames
  // — e.g. a mini table-of-contents whose \hyperlink targets are undefined
  // outside this file — can be dropped instead of leaving stray bullets).
  out = out.replace(/\\begin\{frame\}(\[[^\]]*\])?/g, FRAME_START);
  out = out.replace(/\\end\{frame\}/g, FRAME_END);
  return out;
}

const FRAME_START = '\u0001FRAME_START\u0001';
const FRAME_END = '\u0001FRAME_END\u0001';

// Splits cleaned text on frame sentinels and drops frames whose content
// carries no real information (only bullet glyphs / whitespace left after
// cleaning — typically a mini-TOC frame referencing titles defined outside
// this file). Non-frame text (rare) passes through untouched.
function splitFrames(text) {
  const parts = text.split(FRAME_START);
  const out = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const endIdx = parts[i].indexOf(FRAME_END);
    const content = endIdx === -1 ? parts[i] : parts[i].slice(0, endIdx);
    const rest = endIdx === -1 ? '' : parts[i].slice(endIdx + FRAME_END.length);
    const stripped = content.replace(/[•\s#]/g, '');
    if (stripped.length >= 6) out.push(content);
    out.push(rest);
  }
  return out.join('\n\n');
}

function removeFigures(text) {
  let out = removeEnvironment(text, 'tikzpicture');
  // stray figure-placement lines that sometimes sit outside tikzpicture
  out = out.replace(/^.*\\node\s*\([^)]*\).*$/gm, '');
  return out;
}

// Resolves the inner content of a _{...} / ^{...} group: first collapses any
// Greek letters and nested subscripts inside it, then either renders it as
// true Unicode sub/superscript characters (if short and simple, e.g. "21" or
// "sp") or falls back to a plain-text "_(...)"/"^(...)" grouping (if it's a
// multi-symbol expression like "-t/τ_sp", which has no clean glyph form).
function resolveScript(raw, isSup) {
  let inner = raw.replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ?? OPERATOR_WORDS[name] ?? m);
  inner = inner.replace(/_\{([^{}]*)\}/g, (_, g) => toSub(g));
  inner = inner.replace(/_([0-9a-zA-Z])/g, (_, g) => toSub(g));
  const map = isSup ? SUP_MAP : SUB_MAP;
  const simple = inner.length > 0 && inner.length <= 6 && [...inner].every((c) => map[c] !== undefined);
  if (simple) return [...inner].map((c) => map[c]).join('');
  return (isSup ? '^(' : '_(') + inner + ')';
}

// Matches a balanced {...} allowing exactly one extra level of nesting
// inside (sufficient for these slides' _{...}/^{...} usage).
const ONE_LEVEL_BRACE = '\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}';

function convertMathMacros(text) {
  let out = text;

  // \frac{a}{b} / \Frac{a}{b} -> (a)/(b), innermost-first, looped for nesting
  const fracRe = /\\[Ff]rac\{([^{}]*)\}\{([^{}]*)\}/;
  let guard = 0;
  while (fracRe.test(out) && guard++ < 2000) {
    out = out.replace(fracRe, '($1)/($2)');
  }

  out = out.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
  out = out.replace(/\\sqrt/g, '√');

  // \text{...} and \mathrm{...} -> plain inner text; drop styling wrappers
  // (bold/calligraphic/dot-accent) but keep their content
  out = unwrapMacro(out, 'text');
  out = unwrapMacro(out, 'mathrm');
  out = unwrapMacro(out, 'mathbf', { transform: (inner) => inner });
  out = unwrapMacro(out, 'mathcal', { transform: (inner) => inner });
  out = unwrapMacro(out, 'textbf', { transform: (inner) => inner });
  out = unwrapMacro(out, 'hat', { transform: (inner) => inner });
  out = unwrapMacro(out, 'dot', { transform: (inner) => inner });
  out = unwrapMacro(out, 'vec', { transform: (inner) => inner + '⃗' });
  out = unwrapMacro(out, 'bar', { transform: (inner) => inner + '̄' });

  // subscripts / superscripts: _{xyz} / _x  and ^{xyz} / ^x (superscript
  // first, since it may contain a nested subscript that resolveScript
  // handles internally)
  out = out.replace(new RegExp('\\^' + ONE_LEVEL_BRACE, 'g'), (_, g) => resolveScript(g, true));
  out = out.replace(new RegExp('_' + ONE_LEVEL_BRACE, 'g'), (_, g) => resolveScript(g, false));
  out = out.replace(/\^([0-9a-zA-Z])/g, (_, g) => (SUP_MAP[g] ?? `^${g}`));
  out = out.replace(/_([0-9a-zA-Z])/g, (_, g) => (SUB_MAP[g] ?? `_${g}`));

  // Greek letters + operator/spacing word-macros, in ONE pass so the regex
  // always grabs the macro's full name (no partial-prefix collisions).
  out = out.replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ?? OPERATOR_WORDS[name] ?? m);

  // sizing/delimiter macros: \Bigg| \big( \Big) \left( \right] etc ->
  // keep the delimiter char if any, drop the sizing/name token itself
  out = out.replace(
    /\\(?:BIGGL|BIGGR|Biggl|Biggr|BIGG|Bigg|biggl|biggr|bigg|BIGL|BIGR|Bigl|Bigr|BIG|Big|big|left|right)\s*([|()[\]{}.]?)/g,
    (_, d) => (d && d !== '.' ? d : '')
  );

  // punctuation spacing macros -> single space
  out = out.replace(/\\[,;:!]/g, ' ');

  return out;
}

function convertHighlightMacros(text, { mark = false } = {}) {
  const wrap = mark ? (inner) => TERM_OPEN + inner + TERM_CLOSE : (inner) => inner;
  let out = unwrapMacro(text, 'CDAlert', { transform: wrap });
  out = unwrapMacro(out, 'Alert', { transform: wrap });
  out = unwrapMacro(out, 'culine'); // underline styling only, not a term highlight
  return out;
}

// Sentinel characters (Private-Use-Area-ish, unlikely to appear in physics
// text) marking the span of a \CDAlert/\Alert-highlighted term, so it can
// be recovered by the terminology harvester AFTER the term's own content
// has passed through the same math/Greek/etc. cleanup as everything else.
const TERM_OPEN = '\u2668';
const TERM_CLOSE = '\u2669';
function stripTermMarkers(text) {
  return text.replace(/[\u2668\u2669]/g, '').replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n +/g, '\n');
}

function convertMisc(text) {
  let out = text;
  // \texorpdfstring{tex-form}{plain-form} -> keep plain form (2nd arg)
  out = unwrapTwoArgMacro(out, 'texorpdfstring', 2);
  // \raisebox{offset}{content} -> keep content (2nd arg), drop the offset
  out = unwrapTwoArgMacro(out, 'raisebox', 2);

  // \hyperlink{id}{text} -> text  (drop the id, keep the visible text)
  out = out.replace(/\\hyperlink\{[^{}]*\}\{/g, '\\_KEEP_{');
  out = unwrapMacro(out, '_KEEP_');

  // \implies{content} -> "⇒ content" (custom callout macro in these slides)
  out = unwrapMacro(out, 'implies', { transform: (inner) => `⇒ ${inner}` });

  // \subsection{Title} -> markdown-ish mini heading
  out = unwrapMacro(out, 'subsection', { transform: (inner) => `\n\n## ${inner}\n` });

  // \appear{content} -> content (progressive-reveal wrapper, just unwrap)
  out = unwrapMacro(out, 'appear');

  // minipage: \begin{minipage}[opt]{width} ... \end{minipage} -> keep content,
  // drop the width argument (must strip the {width} braces before the
  // generic begin/end regex, or "8.2cm" leaks into the text).
  out = out.replace(/\\begin\{minipage\}(\[[^\]]*\])?\{[^{}]*\}/g, '');
  out = out.replace(/\\end\{minipage\}/g, '');

  return out;
}

function convertLists(text) {
  let out = text;
  out = out.replace(/\\begin\{itemize\}(\[[^\]]*\])?/g, '');
  out = out.replace(/\\end\{itemize\}/g, '');
  out = out.replace(/\\begin\{enumerate\}(\[[^\]]*\])?/g, '');
  out = out.replace(/\\end\{enumerate\}/g, '');
  // \item<overlay>[label] or \item[] or bare \item
  out = out.replace(/\\item(?:<[^>]*>)?(\[[^\]]*\])?/g, '\n• ');
  return out;
}

const MATRIX_OPEN = { pmatrix: '(', bmatrix: '[', vmatrix: '|', Vmatrix: '‖', Bmatrix: '{', matrix: '' };
const MATRIX_CLOSE = { pmatrix: ')', bmatrix: ']', vmatrix: '|', Vmatrix: '‖', Bmatrix: '}', matrix: '' };

function convertMathEnvAndDelimiters(text) {
  let out = text;

  // matrix-like environments -> bracketed, single-line text. Row (\\) and
  // column (&) separators inside a matrix are flattened to "; " and " "
  // rather than left to fall through to the generic \\ -> newline rule
  // below. The generic rule matters because .tex sources typically write
  // matrix rows on their own physical line, e.g.:
  //   A & B \\
  //   C & D
  // The trailing "\\" becomes a newline AND the source's own line break
  // right after it is still there, producing a blank line in the middle of
  // a matrix (and the sentence around it). Downstream code (terminology.js
  // splitBlocks) treats any blank line as a paragraph boundary, so it was
  // silently slicing matrices — and their surrounding context — in half.
  // Handling matrix content here, before the generic \\ rule runs, avoids
  // that entirely.
  for (const name of Object.keys(MATRIX_OPEN)) {
    const envRe = new RegExp(`\\\\begin\\{${name}\\}([\\s\\S]*?)\\\\end\\{${name}\\}`, 'g');
    out = out.replace(envRe, (_, inner) => {
      const rows = inner
        .split(/\\\\/)
        .map((row) => row.replace(/&/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return ` ${MATRIX_OPEN[name]}${rows.join('; ')}${MATRIX_CLOSE[name]} `;
    });
  }

  // Display-math wrappers become newlines (not deleted outright), so an
  // equation never glues onto the end of the preceding sentence with no
  // separator (e.g. "...of form" + "N_2(t)=..." -> "of formN_2(t)=...").
  out = out.replace(/\\begin\{(equation\*?|align\*?|aligned|gather\*?|eqnarray\*?|cases)\}/g, '\n');
  out = out.replace(/\\end\{(equation\*?|align\*?|aligned|gather\*?|eqnarray\*?|cases)\}/g, '\n');
  out = out.replace(/\\begin\{array\}(\{[^{}]*\})?/g, '\n');
  out = out.replace(/\\end\{array\}/g, '\n');
  out = out.replace(/\\\[/g, '\n').replace(/\\\]/g, '\n');
  out = out.replace(/\$\$/g, '\n');
  out = out.replace(/\$/g, '');
  out = out.replace(/&/g, ' ');
  out = out.replace(/\\\\/g, '\n');

  return out;
}

// Safety net: strip ANY remaining \begin{word}/\end{word} tokens (with an
// optional trailing [..] and/or {..} argument, e.g. itemize's
// [leftmargin=...] or array's column spec) whole. Must run AFTER
// convertLists() (which needs to see literal "\begin{itemize}[...]" itself
// to handle it properly) but BEFORE catchAll(), which would otherwise
// misread a bare "\begin{foo}" as a generic \macro{arg} and leave the
// stray word "foo" in the output.
function stripStrayEnvironments(text) {
  return text.replace(/\\(?:begin|end)\{[^{}]*\}(\[[^\]]*\])?(\{[^{}]*\})?/g, ' ');
}

// Final catch-all: unwrap or strip any leftover LaTeX we didn't explicitly
// handle, so nothing raw leaks into the corpus.
function catchAll(text) {
  let out = text;
  let guard = 0;
  // generic \Name[opt]{...} -> inner content
  const genericRe = /\\[A-Za-z]+(\[[^\]\n]*\])?\{/;
  while (genericRe.test(out) && guard++ < 5000) {
    const m = out.match(genericRe);
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchBrace(out, openIdx);
    if (closeIdx === -1) { out = out.slice(0, m.index) + out.slice(m.index + m[0].length); continue; }
    const inner = out.slice(openIdx + 1, closeIdx);
    out = out.slice(0, m.index) + inner + out.slice(closeIdx + 1);
  }
  // bare macros with no args left (e.g. \relax, leftover custom tokens)
  out = out.replace(/\\[A-Za-z]+/g, '');
  // stray braces / dollar signs / tex leftovers
  out = out.replace(/[{}$]/g, '');
  return out;
}

function whitespaceCleanup(text) {
  // NOTE: deliberately line-based (not a single \s+ regex) — \s matches
  // \n too, so a naive `/^\s+|\s+$/gm` greedily eats multi-line
  // whitespace-only spans and silently deletes the very newlines we
  // inserted around display equations.
  let out = text.replace(/[ \t]+/g, ' ');
  out = out.split('\n').map((l) => l.trim()).join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.replace(/^\n+|\n+$/g, '').trim();
}

// Full pipeline: raw .tex source -> clean plain text
function cleanTex(raw, { mark = false } = {}) {
  let t = stripComments(raw);
  t = dropDefinitions(t);
  t = unescapeChars(t);
  t = dropStructuralMacros(t);
  t = removeFigures(t);
  t = convertMisc(t);
  t = convertHighlightMacros(t, { mark });
  t = convertMathMacros(t);
  t = convertMathEnvAndDelimiters(t);
  t = convertLists(t);
  t = stripStrayEnvironments(t);
  t = catchAll(t);
  t = splitFrames(t);
  t = whitespaceCleanup(t);
  return t;
}

// Same pipeline, but \CDAlert/\Alert spans are wrapped in sentinel markers
// (TERM_OPEN/TERM_CLOSE) instead of being silently flattened — used by the
// terminology harvester. stripTermMarkers() on the result recovers exactly
// what cleanTex(raw) would have produced.
function cleanTexMarked(raw) {
  return cleanTex(raw, { mark: true });
}

module.exports = {
  matchBrace, unwrapMacro, unwrapTwoArgMacro, removeEnvironment, unwrapEnvironment,
  stripComments, dropDefinitions, unescapeChars, dropStructuralMacros,
  removeFigures, convertMathMacros, convertHighlightMacros, convertMisc,
  convertLists, convertMathEnvAndDelimiters, stripStrayEnvironments, catchAll, splitFrames,
  whitespaceCleanup, cleanTex, cleanTexMarked, stripTermMarkers,
  TERM_OPEN, TERM_CLOSE, GREEK, OPERATOR_WORDS, resolveScript,
};
