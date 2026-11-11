// Verifies the two guarantees:
//
//   1. The pasted answer's language always equals the language detected on the
//      question — a mismatched answer file is refused, not silently copied.
//   2. One detection produces exactly one notification, never two.
//
// Notification count is measured with AA_TOAST_LOG, which the real toast()
// honours, so production behaviour is what gets tested.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';

import { attachPage, stopChrome, APP_DIR } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';
import { normalizeLang } from './lib/lang.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock.html');
const AA = path.join(HERE, 'aa.mjs');
const ANSWERS = path.join(APP_DIR, 'answers');
const TOAST_LOG = path.join(APP_DIR, 'toast-log.jsonl');
const TRACKER_LOG = path.join(APP_DIR, 'tracker-test.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const parseEvents = (text) => text.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return { raw: line }; }
});

const PY = 'print(1 + 2)\n';
const JAVA = 'public class Main { public static void main(String[] a) { System.out.println(3); } }\n';

async function readToastLog() {
  try {
    const raw = await readFile(TOAST_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

let restoreClipboard = async () => {};

async function main() {
  restoreClipboard = await preserveClipboard();

  await mkdir(ANSWERS, { recursive: true });
  await rm(TOAST_LOG, { force: true });
  // A leftover tracker would mark this question as already notified, making the
  // one-toast assertion fail for the wrong reason.
  await rm(TRACKER_LOG, { force: true });

  // Clear leftover answer files so the test starts from a clean slate, but keep a
  // copy: these are the operator's real answers, and wiping them outright once
  // destroyed an answer that was still needed.
  const { readdirSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
  const answersBackup = new Map();
  for (const f of readdirSync(ANSWERS)) {
    const p = path.join(ANSWERS, f);
    try {
      answersBackup.set(f, readFileSync(p));
      rmSync(p, { force: true });
    } catch { /* directory entry or unreadable; leave it alone */ }
  }

  const child = spawn(process.execPath, [
    AA, 'watch', '--clip', '--clip-delay', '2', '--url', pathToFileURL(MOCK).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG, AA_TRACKER_FILE: TRACKER_LOG },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const cleanup = async () => {
    child.kill();
    await wait(400);
    await stopChrome().catch(() => {});

    // Put the operator's answer files back, minus anything the test created.
    for (const [f, buf] of answersBackup) {
      const p = path.join(ANSWERS, f);
      try { writeFileSync(p, buf); } catch { /* best effort */ }
    }
  };

  // Wait for the first detection.
  let first = null;
  for (let i = 0; i < 40; i++) {
    await wait(500);
    first = parseEvents(stdout).find((e) => e.event === 'question-detected');
    if (first?.sig) break;
  }
  if (!first) {
    await cleanup();
    return { ok: false, error: 'no detection', stderr };
  }

  const detectedLang = normalizeLang(first.lang);

  // --- Case 1: an answer in the wrong language must be refused.
  const wrongExt = detectedLang === 'java' ? '.py' : '.java';
  const wrongCode = detectedLang === 'java' ? PY : JAVA;
  await writeFile(path.join(ANSWERS, `${first.sig}${wrongExt}`), wrongCode, 'utf8');

  let mismatch = null;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    mismatch = parseEvents(stdout).find((e) => e.event === 'language-mismatch');
    if (mismatch) break;
  }
  const copiedBefore = parseEvents(stdout).filter((e) => e.event === 'clipboard-copied').length;

  // --- Case 2: the correct language is copied.
  // Remove the wrong file first: while it exists, the retry keeps rejecting it.
  await rm(path.join(ANSWERS, `${first.sig}${wrongExt}`), { force: true });
  const rightExt = detectedLang === 'java' ? '.java' : '.py';
  const rightCode = detectedLang === 'java' ? JAVA : PY;
  await writeFile(path.join(ANSWERS, `${first.sig}${rightExt}`), rightCode, 'utf8');

  let copied = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    copied = parseEvents(stdout).find((e) => e.event === 'clipboard-copied');
    if (copied) break;
  }
  const clip = await readClipboard();

  // --- Notification accounting.
  const toasts = await readToastLog();
  const all = parseEvents(stdout);
  const detections = all.filter((e) => e.event === 'question-detected');
  const pending = all.filter((e) => e.event === 'clipboard-pending');
  const copies = all.filter((e) => e.event === 'clipboard-copied');

  await cleanup();

  const oneToastPerDetection = toasts.length === detections.length && pending.length === detections.length;

  return {
    ok: Boolean(mismatch)
        && copied?.ok === true
        && clip === rightCode
        && copied.lang === detectedLang
        && oneToastPerDetection,
    detectedLang,
    detectedLangRaw: first.lang,
    mismatchRefused: Boolean(mismatch),
    mismatchEvent: mismatch,
    copiedBeforeMismatch: copiedBefore,
    copiedAfterFix: copied?.ok ?? false,
    copiedLang: copied?.lang ?? null,
    clipboardMatchesExpected: clip === rightCode,
    detectionCount: detections.length,
    pendingCount: pending.length,
    copyCount: copies.length,
    toastCount: toasts.length,
    toasts,
    oneToastPerDetection,
    stderrTail: stderr.split('\n').slice(-8).join('\n'),
  };
}

main().then(async (r) => {
  await restoreClipboard();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch(async (e) => {
  await restoreClipboard();
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
