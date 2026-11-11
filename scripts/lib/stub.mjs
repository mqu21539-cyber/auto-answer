// Core-code mode support ("核心代码模式"): the editor already contains a class
// scaffold and an empty method body. Replacing the whole editor would destroy
// the scaffold, so the answer must be spliced into the method body only.
//
// Two modes:
//   acm  — the editor is empty (or holds a previous full program); write the
//          whole file.
//   core — the editor holds scaffolding; replace only the target method body.

/** Comments that platforms use to mark the spot to fill in. */
const MARKERS = [
  /\/\/\s*write code here/i,
  /\/\/\s*your code here/i,
  /#\s*write code here/i,
  /#\s*your code here/i,
  /\/\/\s*在此编写代码/,
  /\/\/\s*在此填写代码/,
  /#\s*在此编写代码/,
  /\/\/\s*请在此处编写代码/,
  /\/\/\s*TODO/i,
  /#\s*TODO/i,
  /\/\/\s*code\s*here/i,
];

/** Languages whose method bodies are delimited by braces. */
const BRACE_LANGS = new Set([
  'java', 'cpp', 'c', 'csharp', 'javascript', 'typescript', 'go', 'rust',
  'kotlin', 'swift', 'php', 'scala', 'haskell',
]);

/** Find the first marker comment line, if any. */
function findMarkerLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (MARKERS.some((re) => re.test(lines[i]))) return i;
  }
  return -1;
}

/**
 * Scan forward from an opening brace to its matching close, skipping strings
 * and comments so braces inside literals never confuse the depth count.
 */
function findBlockEnd(code, openIdx) {
  let depth = 0;
  let i = openIdx;
  let state = 'code';

  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];

    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'bt'; i++; continue; }
      if (c === '{') { depth++; i++; continue; }
      if (c === '}') { depth--; if (depth === 0) return i; i++; continue; }
      i++;
      continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      i++; continue;
    }
    if (state === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'") state = 'code'; i++; continue; }
    if (state === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"') state = 'code'; i++; continue; }
    if (state === 'bt') { if (c === '\\') { i += 2; continue; } if (c === '`') state = 'code'; i++; continue; }
  }
  return -1;
}

/** Index of the line start that contains `offset`. */
function lineStartOf(code, offset) {
  let i = offset;
  while (i > 0 && code[i - 1] !== '\n') i--;
  return i;
}

/** Count leading spaces/tabs of the line containing `offset`. */
function indentAt(code, offset) {
  const start = lineStartOf(code, offset);
  let i = start;
  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
  return code.slice(start, i);
}

/**
 * For brace languages: locate the method body that should receive the answer.
 * Prefers the block containing the marker; falls back to the innermost block
 * whose header looks like a method signature.
 *
 * The marker sits *inside* the body, so the body is found by walking backwards
 * to the nearest `{` that is not itself inside the body — i.e. the first `{`
 * whose matching `}` comes after the marker. Scanning forward from the marker
 * would pick up braces of nested statements instead.
 *
 * @returns {{bodyStart:number, bodyEnd:number, header:string, indent:string}|null}
 */
function findBraceBody(code, lang) {
  const lines = code.split('\n');
  const markerLine = findMarkerLine(lines);

  let anchorOffset = -1;

  if (markerLine >= 0) {
    let off = 0;
    for (let i = 0; i < markerLine; i++) off += lines[i].length + 1;
    anchorOffset = off;
  }

  if (anchorOffset < 0) {
    // No marker: take the last method-looking header with a body.
    const re = /[\w>\]*&]+\s+[\w]+\s*\([^;{}]*\)\s*(?:const)?\s*\{/g;
    let m;
    let last = null;
    while ((m = re.exec(code)) !== null) last = m;
    if (!last) return null;
    anchorOffset = last.index + last[0].length - 1;
  }

  // Walk backwards from the anchor to the nearest '{' whose block encloses the
  // anchor (its matching '}' lies after it). That is the method body opener.
  let open = -1;
  for (let i = anchorOffset; i >= 0; i--) {
    if (code[i] !== '{') continue;
    // Skip braces that are inside comments.
    const before = code.slice(0, i);
    const lastBlockOpen = before.lastIndexOf('/*');
    const lastBlockClose = before.lastIndexOf('*/');
    if (lastBlockOpen > lastBlockClose) continue;
    const lineStart = lineStartOf(code, i);
    if (before.slice(lineStart).includes('//')) continue;

    const close = findBlockEnd(code, i);
    // The candidate must close after the anchor: then it encloses the marker.
    if (close > anchorOffset) { open = i; break; }
  }
  if (open < 0) return null;

  const close = findBlockEnd(code, open);
  if (close < 0) return null;

  // Header = the signature line(s) immediately before the opening brace.
  const headerStart = Math.max(0, code.lastIndexOf('\n', open) + 1);
  const header = code.slice(headerStart, open).trim();

  const braceIndent = indentAt(code, open);
  const indent = braceIndent + '    ';

  return { bodyStart: open + 1, bodyEnd: close, header, indent, braceIndent };
}

/**
 * For indentation languages (Python/Ruby): find the def whose body is empty.
 * @returns {{bodyStart:number, bodyEnd:number, header:string, indent:string}|null}
 */
function findIndentBody(code) {
  const lines = code.split('\n');
  const markerLine = findMarkerLine(lines);

  // Find the def line: the nearest preceding `def`/`class ... def` above the marker.
  let defLine = -1;
  const searchFrom = markerLine >= 0 ? markerLine : lines.length - 1;
  for (let i = searchFrom; i >= 0; i--) {
    if (/^\s*(async\s+)?def\s+\w+\s*\(/.test(lines[i])) { defLine = i; break; }
  }
  if (defLine < 0) return null;

  const defIndent = (lines[defLine].match(/^\s*/) || [''])[0];
  const indent = defIndent + '    ';

  // Body ends at the next non-blank line with indentation <= defIndent.
  let endLine = lines.length;
  for (let i = defLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const ind = (lines[i].match(/^\s*/) || [''])[0];
    if (ind.length <= defIndent.length) { endLine = i; break; }
  }

  let bodyStart = 0;
  for (let i = 0; i <= defLine; i++) bodyStart += lines[i].length + 1;

  let bodyEnd = bodyStart;
  for (let i = defLine + 1; i < endLine; i++) bodyEnd += lines[i].length + 1;

  return { bodyStart, bodyEnd, header: lines[defLine].trim(), indent };
}

/** Remove the common leading indentation from a block of code. */
function dedent(text) {
  const lines = text.split('\n');
  const widths = lines
    .filter((l) => l.trim() !== '')
    .map((l) => (l.match(/^[ \t]*/) || [''])[0].length);
  if (!widths.length) return text;
  const min = Math.min(...widths);
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(min))).join('\n');
}

/** Re-indent every non-empty line by `prefix`. */
function reindent(text, prefix) {
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : prefix + l))
    .join('\n');
}

/**
 * If the answer file itself contains a full method/class (someone pasted a
 * whole solution), pull out just the body so it can be spliced in.
 */
function extractSolutionBody(solution, lang) {
  if (BRACE_LANGS.has(lang)) {
    const lines = solution.split('\n');
    const markerLine = findMarkerLine(lines);
    if (markerLine >= 0) {
      let off = 0;
      for (let i = 0; i < markerLine; i++) off += lines[i].length + 1;
      const found = findBraceBody(solution, lang);
      if (found) return solution.slice(found.bodyStart, found.bodyEnd);
      return solution;
    }
    // A complete class/file: take the innermost method body.
    const found = findBraceBody(solution, lang);
    if (found && /\(/.test(found.header)) {
      return solution.slice(found.bodyStart, found.bodyEnd);
    }
    return solution;
  }
  return solution;
}

/**
 * Analyze an editor's current content.
 *
 * @param {string} code   current editor text
 * @param {string} lang   canonical language id
 * @returns {{mode:'acm'|'core', bodyStart?:number, bodyEnd?:number,
 *            header?:string, indent?:string, hasMarker:boolean, reason:string}}
 */
export function analyzeStub(code, lang) {
  const text = String(code ?? '');
  const lines = text.split('\n');
  const hasMarker = findMarkerLine(lines) >= 0;

  // An empty (or whitespace-only) editor is always ACM mode.
  if (text.trim() === '') {
    return { mode: 'acm', hasMarker: false, reason: 'empty-editor' };
  }

  const brace = BRACE_LANGS.has(lang);
  const found = brace ? findBraceBody(text, lang) : findIndentBody(text);

  if (!found) {
    return { mode: 'acm', hasMarker, reason: 'no-method-body-found' };
  }

  // A scaffold is recognised by a marker, or by a header that looks like a
  // function signature. A random full program (main + includes) is ACM.
  const headerLooksLikeMethod = /\([^)]*\)\s*$/.test(found.header) || /\([^)]*\)/.test(found.header);
  const isScaffold = hasMarker || (headerLooksLikeMethod && found.bodyStart > 0);

  // If the editor already holds a complete ACM program with a main(), treat it
  // as ACM so a full-file answer can replace it.
  if (/\bint\s+main\s*\(|\bdef\s+main\s*\(|func\s+main\s*\(|public\s+static\s+void\s+main\s*\(/.test(text)
      && !hasMarker) {
    return { mode: 'acm', hasMarker, reason: 'acm-main-detected' };
  }

  if (!isScaffold) {
    return { mode: 'acm', hasMarker, reason: 'not-a-scaffold' };
  }

  return {
    mode: 'core',
    bodyStart: found.bodyStart,
    bodyEnd: found.bodyEnd,
    header: found.header,
    indent: found.indent,
    braceIndent: found.braceIndent ?? '',
    hasMarker,
    reason: hasMarker ? 'marker-found' : 'signature-found',
  };
}

/**
 * Strip stray characters after the final closing brace.
 *
 * Real drafts accumulate junk: typing a key by accident leaves it after the
 * class brace, and the platform then saves it. Left alone it lands outside the
 * class body and breaks compilation, so trailing non-brace text is dropped for
 * brace languages.
 */
function stripTrailingJunk(code, lang) {
  if (!BRACE_LANGS.has(lang)) return code;
  const lastClose = code.lastIndexOf('}');
  if (lastClose < 0) return code;
  const trailing = code.slice(lastClose + 1);
  if (!trailing.trim()) return code;
  return code.slice(0, lastClose + 1);
}

/**
 * Splice `solution` into the scaffold.
 *
 * @returns {{code:string, mode:'acm'|'core', spliced:boolean, header?:string}}
 */
export function mergeSolution(stub, solution, lang) {
  const cleanedStub = stripTrailingJunk(String(stub ?? ''), lang);
  const analysis = analyzeStub(cleanedStub, lang);

  if (analysis.mode === 'acm') {
    return { code: solution, mode: 'acm', spliced: false };
  }

  const body = extractSolutionBody(solution, lang);
  const normalized = dedent(body).replace(/^\n+/, '').replace(/\s+$/, '');
  const indented = reindent(normalized, analysis.indent) + '\n';

  const before = cleanedStub.slice(0, analysis.bodyStart);
  const after = cleanedStub.slice(analysis.bodyEnd);

  // Keep a newline after the opening brace, and put the closing brace back on
  // its own line at the header's indentation level. `indented` already ends
  // with a newline, so only the indent prefix is needed here.
  const lead = before.endsWith('\n') ? '' : '\n';
  const closeIndent = analysis.braceIndent ?? '';
  const tail = after.startsWith('\n') ? '' : closeIndent;

  return {
    code: `${before}${lead}${indented}${tail}${after}`,
    mode: 'core',
    spliced: true,
    header: analysis.header,
  };
}

/** Extract the current method signature, for reporting. */
export function stubSummary(code, lang) {
  const a = analyzeStub(code, lang);
  return {
    mode: a.mode,
    hasMarker: a.hasMarker,
    header: a.header ?? null,
    reason: a.reason,
  };
}
