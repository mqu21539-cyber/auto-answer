// Language matrix test: verifies normalization, template generation for every
// supported language, and that the page's selector is switched before writing.

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ensureChrome, attachPage, stopChrome } from './lib/chrome.mjs';
import { normalizeLang, EXTENSIONS, resolveLang } from './lib/lang.mjs';
import { templateFor, templateLanguages } from './lib/templates.mjs';
import { switchLanguage } from './lib/langswitch.mjs';
import { extractQuestion } from './lib/extract.mjs';
import { writeCode, readEditor, normalize } from './lib/editor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock.html');

// Every label an OJ might show, mapped to the id we expect.
const CASES = [
  ['Python 3', 'python'], ['Python3', 'python'], ['PyPy 3', 'python'], ['CPython 3.11', 'python'],
  ['C++', 'cpp'], ['C++17 (GCC 9.2)', 'cpp'], ['GNU C++17', 'cpp'], ['cpp', 'cpp'], ['C＋＋', 'cpp'],
  ['C', 'c'], ['C (gcc 9)', 'c'], ['GNU C11', 'c'],
  ['Java', 'java'], ['Java (OpenJDK 17)', 'java'], ['Java 8', 'java'], ['OpenJDK 11', 'java'],
  ['JavaScript (Node.js)', 'javascript'], ['JavaScript', 'javascript'], ['Node.js', 'javascript'], ['JS', 'javascript'],
  ['TypeScript', 'typescript'],
  ['C# (.NET 6)', 'csharp'], ['C Sharp', 'csharp'],
  ['Go 1.20', 'go'], ['Golang', 'go'],
  ['Rust 1.70', 'rust'], ['Kotlin 1.8', 'kotlin'], ['Swift 5', 'swift'],
  ['PHP 8', 'php'], ['Ruby 3', 'ruby'], ['Scala 3', 'scala'],
  ['Haskell', 'haskell'], ['Lua', 'lua'], ['Perl', 'perl'], ['R', 'r'], ['SQL', 'sql'],
];

const TEMPLATE_CASES = {
  aplusb: { heading: 'A + B Problem', body: '给定两个整数 A 和 B，输出它们的和。' },
  sort: { heading: '排序', body: '给定 n 个整数，按升序输出。' },
  fib: { heading: 'Fibonacci', body: '求第 n 个斐波那契数。' },
};

function runNormalization() {
  const failures = [];
  for (const [label, want] of CASES) {
    const got = normalizeLang(label);
    if (got !== want) failures.push({ label, want, got });
  }
  // Unrecognized input must be null, not a wrong guess.
  for (const junk of ['Brainfuck', '', 'UnknownLang', 'COBOL']) {
    if (normalizeLang(junk) !== null) failures.push({ label: junk, want: null, got: normalizeLang(junk) });
  }
  return { ok: failures.length === 0, checked: CASES.length, failures };
}

function runTemplates() {
  const langs = templateLanguages();
  const missing = [];
  const shapes = ['aplusb', 'sort', 'fib'];

  for (const lang of langs) {
    for (const shape of shapes) {
      const code = templateFor(TEMPLATE_CASES[shape], lang);
      if (!code || code.trim().length < 20) {
        missing.push({ lang, shape });
        continue;
      }
      // A skeleton must be non-empty and mention stdin or a read call.
      if (!/stdin|System\.in|readLine|Console\.In|fmt\.Fscan|io::stdin|scanf|cin|require\('fs'\)/i.test(code)) {
        missing.push({ lang, shape, reason: 'no-stdin-read' });
      }
    }
  }

  // Unknown language falls back to python rather than throwing.
  const fallback = templateFor(TEMPLATE_CASES.aplusb, 'brainfuck');
  if (!fallback) missing.push({ lang: 'brainfuck', shape: 'aplusb', reason: 'no-fallback' });

  // Unknown shape returns null, so the caller skips instead of writing junk.
  const noShape = templateFor({ heading: '???', body: '???' }, 'python');
  if (noShape !== null) missing.push({ shape: 'unknown', reason: 'should-be-null' });

  return { ok: missing.length === 0, languages: langs, shapes, failures: missing };
}

function runResolution() {
  const cases = [
    [{ explicit: 'C++', file: 'a.py', pageLang: 'Java' }, 'cpp', 'explicit'],
    [{ explicit: null, file: 'sol.cpp', pageLang: 'Python3' }, 'cpp', 'file-extension'],
    [{ explicit: null, file: 'sol.txt', pageLang: 'Java 8' }, 'java', 'page-selector'],
    [{ explicit: null, file: null, pageLang: null }, 'python', 'default'],
    [{ explicit: 'Java', file: null, pageLang: 'C++17 (GCC 9.2)' }, 'java', 'explicit'],
  ];
  const failures = [];
  for (const [input, wantLang, wantSource] of cases) {
    const r = resolveLang(input);
    if (r.lang !== wantLang || r.source !== wantSource) {
      failures.push({ input, wantLang, wantSource, got: r });
    }
  }
  return { ok: failures.length === 0, checked: cases.length, failures };
}

async function runPageSwitch() {
  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: pathToFileURL(MOCK).href, timeoutMs: 20000 });

  try {
    await new Promise((r) => setTimeout(r, 2500));

    const q0 = await extractQuestion(cdp);
    const results = [];

    for (const target of ['cpp', 'java', 'go', 'python']) {
      const sw = await switchLanguage(cdp, target);
      const q = await extractQuestion(cdp);
      const after = normalizeLang(q.lang);
      results.push({
        target,
        ok: sw.ok && after === target,
        switchReport: { ok: sw.ok, before: sw.before, after: sw.after, reason: sw.reason },
        pageLangNow: q.lang,
      });
    }

    // Write code after a switch and confirm the editor still round-trips.
    const code = 'int main() { return 0; }\n';
    const write = await writeCode(cdp, code, { retries: 3 });
    const back = await readEditor(cdp);
    const roundTrip = normalize(back?.text ?? '') === normalize(code);

    return {
      ok: results.every((r) => r.ok) && roundTrip,
      detectedLang: q0.lang,
      langOptions: q0.langOptions,
      switches: results,
      roundTripAfterSwitch: roundTrip,
      writeOk: write.ok,
      strategy: write.attempts?.find((a) => a.ok)?.strategy ?? null,
    };
  } finally {
    cdp.close();
    await stopChrome();
  }
}

async function main() {
  const norm = runNormalization();
  const tpl = runTemplates();
  const res = runResolution();
  const page = await runPageSwitch();

  const ok = norm.ok && tpl.ok && res.ok && page.ok;
  return {
    ok,
    normalization: norm,
    templates: { ok: tpl.ok, languages: tpl.languages, failures: tpl.failures },
    resolution: res,
    pageSwitch: page,
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
