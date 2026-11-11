// Language identity: normalize whatever the page calls a language into one
// canonical id, map it to file extensions, and pick a syntax-highlight mode.
//
// OJ pages are wildly inconsistent — "C++", "cpp", "C＋＋", "GNU C++17",
// "Python3", "PyPy 3", "Java 8", "Java (OpenJDK 17)". All of those must
// collapse to one id before anything downstream can trust them.

/** Canonical language ids. Order matters: first match wins. */
const RULES = [
  // C++ before C, otherwise "C++" would match the C rule.
  { id: 'cpp', re: /c\+\+|cpp|cxx|g\+\+|c＋＋/i },
  { id: 'csharp', re: /c#|csharp|c\s*sharp|dotnet|\.net/i },
  // JavaScript/TypeScript must precede Java, otherwise "JavaScript" -> java.
  { id: 'typescript', re: /typescript|\bts\b/i },
  { id: 'javascript', re: /javascript|\bjs\b|ecmascript|node/i },
  { id: 'java', re: /java|openjdk|jdk/i },
  { id: 'c', re: /^(c|gcc|clang|ansi\s*c|c99|c11|c17|gnu\s*c\d*)$/i },
  { id: 'python', re: /python|\bpy\b|pypy|cpython/i },
  { id: 'go', re: /golang|^go$|go\s*\d/i },
  { id: 'rust', re: /rust|cargo/i },
  { id: 'kotlin', re: /kotlin/i },
  { id: 'swift', re: /swift/i },
  { id: 'php', re: /php/i },
  { id: 'ruby', re: /ruby|\brb\b/i },
  { id: 'scala', re: /scala/i },
  { id: 'haskell', re: /haskell/i },
  { id: 'lua', re: /lua/i },
  { id: 'perl', re: /perl/i },
  { id: 'r', re: /^r$|\br\s*lang\b/i },
  { id: 'sql', re: /sql/i },
];

/** Canonical id -> file extensions, most common first. */
export const EXTENSIONS = {
  cpp: ['.cpp', '.cc', '.cxx', '.c++'],
  c: ['.c'],
  csharp: ['.cs'],
  python: ['.py'],
  java: ['.java'],
  javascript: ['.js', '.mjs'],
  typescript: ['.ts'],
  go: ['.go'],
  rust: ['.rs'],
  kotlin: ['.kt'],
  swift: ['.swift'],
  php: ['.php'],
  ruby: ['.rb'],
  scala: ['.scala'],
  haskell: ['.hs'],
  lua: ['.lua'],
  perl: ['.pl'],
  r: ['.r', '.R'],
  sql: ['.sql'],
};

/** Monaco / CodeMirror language mode names. */
export const MONACO_MODE = {
  cpp: 'cpp', c: 'c', csharp: 'csharp', python: 'python', java: 'java',
  javascript: 'javascript', typescript: 'typescript', go: 'go', rust: 'rust',
  kotlin: 'kotlin', swift: 'swift', php: 'php', ruby: 'ruby', scala: 'scala',
  haskell: 'haskell', lua: 'lua', perl: 'perl', r: 'r', sql: 'sql',
};

/** Comment syntax per language, used by the template generator. */
export const COMMENT = {
  cpp: '//', c: '//', csharp: '//', java: '//', javascript: '//',
  typescript: '//', go: '//', rust: '//', kotlin: '//', swift: '//',
  php: '//', scala: '//', csharp2: '//',
  python: '#', ruby: '#', perl: '#', r: '#',
  haskell: '--', lua: '--', sql: '--',
};

/**
 * Normalize a page-supplied language label to a canonical id.
 * @param {string|null} label e.g. "C++17 (GCC 9)", "Python3", "Java 8"
 * @returns {string|null}
 */
export function normalizeLang(label) {
  if (!label) return null;
  const raw = String(label).trim();
  if (!raw) return null;

  // Strip version/compiler noise so "GNU C++17" becomes "GNU C++".
  // NOTE: keep the trailing word boundary so "Node.js" survives as "Node.js"
  // while "Java 8" still loses its version.
  const cleaned = raw
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(gnu|openjdk|gcc|clang|pypy|cpython|dotnet)\b/gi, ' ')
    .replace(/(\d+\.)+\d+/g, ' ')
    .replace(/\s+\d+\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const rule of RULES) {
    if (rule.re.test(raw) || rule.re.test(cleaned)) return rule.id;
  }
  return null;
}

/** Best-guess language from a filename, for `answer --file solution.cpp`. */
export function langFromFile(filePath) {
  const lower = String(filePath).toLowerCase();
  const entries = Object.entries(EXTENSIONS);
  // Longest extension first so .cxx beats .c and .ts beats .t.
  const flat = [];
  for (const [id, exts] of entries) for (const ext of exts) flat.push([ext, id]);
  flat.sort((a, b) => b[0].length - a[0].length);
  for (const [ext, id] of flat) {
    if (lower.endsWith(ext.toLowerCase())) return id;
  }
  return null;
}

/**
 * Resolve the effective language for an answer.
 * Precedence: explicit --lang > file extension > page selector > default.
 */
export function resolveLang({ explicit, file, pageLang, fallback = 'python' }) {
  const fromExplicit = normalizeLang(explicit);
  if (fromExplicit) return { lang: fromExplicit, source: 'explicit' };

  const fromFile = langFromFile(file);
  if (fromFile) return { lang: fromFile, source: 'file-extension' };

  const fromPage = normalizeLang(pageLang);
  if (fromPage) return { lang: fromPage, source: 'page-selector' };

  return { lang: normalizeLang(fallback) ?? 'python', source: 'default' };
}
