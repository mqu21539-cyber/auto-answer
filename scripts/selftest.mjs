// Self-test: prove the injection pipeline works against the bundled mock page.
//
// Runs three rounds, one per editor kind (textarea / contenteditable / monaco),
// each: inject -> read back -> compare. Also captures a screenshot per round.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR } from './lib/chrome.mjs';
import { writeCode, readEditor, normalize } from './lib/editor.mjs';
import { extractQuestion } from './lib/extract.mjs';
import { probe } from './lib/probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock.html');

const SAMPLE_CODE = `import sys

def solve(a: int, b: int) -> int:
    return a + b

def main() -> None:
    data = sys.stdin.read().split()
    if not data:
        return
    a, b = int(data[0]), int(data[1])
    print(solve(a, b))

if __name__ == "__main__":
    main()
`;

async function screenshot(cdp, outPath) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, Buffer.from(res.data, 'base64'));
  return outPath;
}

/** Restrict the page helper to one editor kind (test hook). */
async function scopeTo(cdp, kind) {
  return cdp.evaluate(`(() => {
    window.__AA_ONLY__ = ${JSON.stringify(kind)};
    return true;
  })()`);
}

export async function runSelftest({ keep = false } = {}) {
  const results = [];
  const shots = [];
  await mkdir(APP_DIR, { recursive: true });

  const info = await ensureChrome({ headless: true });
  const url = pathToFileURL(MOCK).href;
  const { cdp } = await attachPage({ port: info.port, url, timeoutMs: 20000 });

  try {
    // Give Monaco a moment to load from CDN; if it never does, we just skip it.
    await new Promise((r) => setTimeout(r, 2500));

    const hasMonaco = await cdp.evaluate('!!document.querySelector(".monaco-editor")');
    const kinds = ['textarea', 'contenteditable'];
    if (hasMonaco) kinds.push('monaco');

    for (const kind of kinds) {
      const scoped = await scopeTo(cdp, kind);
      if (!scoped) {
        results.push({ kind, ok: false, reason: 'editor-not-present' });
        continue;
      }

      const write = await writeCode(cdp, SAMPLE_CODE, { retries: 3 });
      const back = await readEditor(cdp);
      const expected = normalize(SAMPLE_CODE);
      const actual = normalize(back?.text ?? '');
      const equal = expected === actual;

      const shot = await screenshot(cdp, path.join(APP_DIR, `selftest-${kind}.png`));
      shots.push(shot);

      results.push({
        kind,
        ok: equal && write.ok,
        writeOk: write.ok,
        strategy: write.attempts?.find((a) => a.ok)?.strategy ?? null,
        expectedChars: expected.length,
        actualChars: actual.length,
        attempts: write.attempts,
      });
    }

    const q = await extractQuestion(cdp).catch((e) => ({ error: e.message }));
    const p = await probe(cdp).catch(() => null);

    const ok = results.length >= 2 && results.every((r) => r.ok);

    if (!keep) {
      cdp.close();
      await stopChrome();
    } else {
      cdp.close();
    }

    return {
      ok,
      mockPage: url,
      editorsTested: kinds,
      monacoAvailable: hasMonaco,
      results,
      screenshots: shots,
      extraction: { heading: q?.heading, bodyLength: q?.bodyLength, editorKind: q?.editorKind, samples: q?.samples?.length ?? 0 },
      probeSummary: p?.summary ?? null,
      browserStillRunning: keep,
    };
  } catch (err) {
    cdp.close();
    if (!keep) await stopChrome().catch(() => {});
    return { ok: false, error: err.message, results, screenshots: shots };
  }
}
