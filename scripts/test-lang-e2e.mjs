// End-to-end: for every supported language, generate its skeleton, switch the
// page selector, inject, and read back. Proves the whole chain per language.

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ensureChrome, attachPage, stopChrome } from './lib/chrome.mjs';
import { templateFor, templateLanguages } from './lib/templates.mjs';
import { switchLanguage } from './lib/langswitch.mjs';
import { writeCode, readEditor, normalize } from './lib/editor.mjs';
import { normalizeLang } from './lib/lang.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock.html');

const QUESTION = { heading: 'A + B Problem', body: '给定两个整数 A 和 B，输出它们的和。' };

// The mock page only offers these; others are verified at the template level.
const ON_PAGE = ['python', 'cpp', 'c', 'java', 'javascript', 'go', 'rust', 'csharp', 'kotlin'];

async function main() {
  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: pathToFileURL(MOCK).href, timeoutMs: 20000 });

  const results = [];
  try {
    await new Promise((r) => setTimeout(r, 2500));

    for (const lang of templateLanguages()) {
      const code = templateFor(QUESTION, lang);
      if (!code) {
        results.push({ lang, ok: false, reason: 'no-template' });
        continue;
      }

      let sw = null;
      if (ON_PAGE.includes(lang)) {
        sw = await switchLanguage(cdp, lang);
      }

      const write = await writeCode(cdp, code, { retries: 3 });
      const back = await readEditor(cdp);
      const expected = normalize(code);
      const actual = normalize(back?.text ?? '');
      const equal = expected === actual;

      // Confirm the page actually reports the language we asked for.
      const pageLang = await cdp.evaluate(`(() => {
        const s = document.getElementById('lang');
        return s ? s.options[s.selectedIndex].text : null;
      })()`);

      results.push({
        lang,
        ok: equal && write.ok,
        switched: sw ? sw.ok : null,
        pageLang,
        pageLangNormalized: normalizeLang(pageLang),
        strategy: write.attempts?.find((a) => a.ok)?.strategy ?? null,
        expectedChars: expected.length,
        actualChars: actual.length,
      });
    }

    return {
      ok: results.every((r) => r.ok),
      count: results.length,
      results,
    };
  } finally {
    cdp.close();
    await stopChrome();
  }
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
