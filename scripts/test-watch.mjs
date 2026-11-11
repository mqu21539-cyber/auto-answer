// End-to-end test of `watch --clip` against the mock page.
//
// The child watcher owns the browser lifecycle; this harness only drives the
// page and inspects the clipboard, so there is no second attach racing it.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR, readState } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';
import { extractQuestion } from './lib/extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock.html');
const AA = path.join(HERE, 'aa.mjs');

const ANSWER = `import sys\n\ndef solve(a, b):\n    return a + b\n\nprint(solve(1, 2))\n`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const parseEvents = (text) => text.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return { raw: line }; }
});

let restoreClipboard = async () => {};

async function main() {
  restoreClipboard = await preserveClipboard();

  await mkdir(path.join(APP_DIR, 'answers'), { recursive: true });

  // Start the watcher first: it launches Chrome, navigates, and installs the
  // observer. Starting Chrome here instead would race the child's own launch.
  const child = spawn(process.execPath, [AA, 'watch', '--clip', '--clip-delay', '2', '--url',
    pathToFileURL(MOCK).href], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AA_TRACKER_FILE: path.join(APP_DIR, 'tracker-watch.json') } });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  // Wait for the watcher to come up and report the initial question.
  let q0 = null;
  for (let i = 0; i < 40; i++) {
    await wait(500);
    const ev = parseEvents(stdout).find((e) => e.event === 'question-detected');
    if (ev?.sig) { q0 = ev; break; }
  }
  if (!q0) {
    child.kill();
    await stopChrome();
    return { ok: false, error: 'no initial detection', stdout: stdout.slice(0, 800), stderr };
  }

  // The watcher is waiting for answers/<sig>.py — write it, expect a copy.
  await writeFile(path.join(APP_DIR, 'answers', `${q0.sig}.py`), ANSWER, 'utf8');

  let firstCopy = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    const ev = parseEvents(stdout).find((e) => e.event === 'clipboard-copied');
    if (ev) { firstCopy = ev; break; }
  }
  const clipAfterFirst = await readClipboard();

  // Attach (read-only) to switch questions and prove the mutation path.
  const state = await readState();
  const { cdp } = await attachPage({ port: state.port, url: null, timeoutMs: 10000 });
  await cdp.evaluate('document.getElementById("btnNext").click()');
  await wait(1500);
  const q1 = await extractQuestion(cdp);

  await writeFile(path.join(APP_DIR, 'answers', `${q1.sig}.py`), ANSWER, 'utf8');

  let secondCopy = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    const all = parseEvents(stdout).filter((e) => e.event === 'clipboard-copied');
    if (all.length >= 2) { secondCopy = all[1]; break; }
  }

  const clip = await readClipboard();
  const detections = parseEvents(stdout).filter((e) => e.event === 'question-detected');

  cdp.close();
  child.kill();
  await wait(500);
  await stopChrome().catch(() => {});

  return {
    ok: Boolean(firstCopy?.ok) && Boolean(secondCopy?.ok)
        && detections.length >= 2
        && q1.sig !== q0.sig
        && clip === ANSWER,
    detectionCount: detections.length,
    copyCount: parseEvents(stdout).filter((e) => e.event === 'clipboard-copied').length,
    firstSig: q0.sig,
    secondSig: q1.sig,
    questionChanged: q1.sig !== q0.sig,
    firstCopy,
    secondCopy,
    clipboardMatchesAnswer: clip === ANSWER,
    clipboardChars: clip?.length ?? null,
    answerChars: ANSWER.length,
    stderrTail: stderr.split('\n').slice(-6).join('\n'),
  };
}

main().then(async (r) => {
  await restoreClipboard();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch(async (e) => {
  await restoreClipboard();
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
