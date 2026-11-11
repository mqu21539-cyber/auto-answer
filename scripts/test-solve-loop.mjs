// End-to-end: the full loop the user asked for.
//
//   watch --queue  ->  pending  ->  solve --file  ->  clipboard holds compilable code
//
// Verified on the core-code mock page, where `solve` must merge the answer into
// the page's scaffold rather than copying a bare method body.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR, readState } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';
import { clearQueue, listQueue } from './lib/queue.mjs';
import { normalize } from './lib/editor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock-core.html');
const AA = path.join(HERE, 'aa.mjs');
const ANSWERS = path.join(APP_DIR, 'answers');

const JAVA_ANSWER = `ListNode dummy = new ListNode(-1);
ListNode cur = dummy;
while (pHead1 != null && pHead2 != null) {
    if (pHead1.val <= pHead2.val) {
        cur.next = pHead1;
        pHead1 = pHead1.next;
    } else {
        cur.next = pHead2;
        pHead2 = pHead2.next;
    }
    cur = cur.next;
}
cur.next = (pHead1 != null) ? pHead1 : pHead2;
return dummy.next;`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const parseEvents = (t) => t.split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return { raw: l }; }
});

function runAA(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AA, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

let restoreClipboard = async () => {};

async function main() {
  restoreClipboard = await preserveClipboard();

  await clearQueue();
  await mkdir(ANSWERS, { recursive: true });

  // 1) Start watch --queue in the background; it owns the browser.
  const watcher = spawn(process.execPath, [
    AA, 'watch', '--queue', '--url', pathToFileURL(MOCK).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AA_TRACKER_FILE: path.join(APP_DIR, 'tracker-solve.json') } });

  let wout = '';
  let werr = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stderr.setEncoding('utf8');
  watcher.stdout.on('data', (d) => { wout += d; });
  watcher.stderr.on('data', (d) => { werr += d; });

  // Wait for the question to land in the queue. Polling the queue itself is
  // more reliable than parsing the child's stdout, which may be buffered.
  let queued = null;
  for (let i = 0; i < 40; i++) {
    await wait(500);
    const items = await listQueue();
    if (items.length) { queued = items[0]; break; }
  }
  if (!queued) {
    watcher.kill();
    await stopChrome().catch(() => {});
    return { ok: false, error: 'no queued question', stdout: wout.slice(0, 600), stderr: werr.slice(0, 600) };
  }

  // 2) pending must report the question with its full body and language.
  const pendingRes = await runAA(['pending']);
  let pending = null;
  try { pending = JSON.parse(pendingRes.out); } catch { /* reported below */ }

  // 3) Write the answer, then solve.
  const answerPath = path.join(ANSWERS, 'solve-test.java');
  await writeFile(answerPath, JAVA_ANSWER, 'utf8');
  const solveRes = await runAA(['solve', '--file', answerPath]);
  let solved = null;
  try { solved = JSON.parse(solveRes.out); } catch { /* reported below */ }

  const clip = await readClipboard();

  // 4) The clipboard must hold a compilable file, not a bare body.
  const clipOk = Boolean(clip)
    && clip.includes('public class Solution')
    && clip.includes('public ListNode Merge (ListNode pHead1, ListNode pHead2)')
    && clip.includes('ListNode dummy = new ListNode(-1)')
    && !clip.includes('write code here');

  const balance = (s) => {
    let d = 0;
    for (const ch of s || '') { if (ch === '{') d++; if (ch === '}') d--; }
    return d;
  };

  // 5) pending must now report nothing (the sig is marked answered).
  const afterRes = await runAA(['pending']);
  let after = null;
  try { after = JSON.parse(afterRes.out); } catch { /* reported below */ }

  watcher.kill();
  await wait(500);
  await stopChrome().catch(() => {});

  return {
    ok: Boolean(queued) && Boolean(pending?.body) && solved?.ok === true && clipOk
        && after?.count === 0,
    queued: { sig: queued.sig, lang: queued.lang, heading: queued.heading },
    pending: pending ? {
      sig: pending.sig,
      lang: pending.lang,
      heading: pending.heading,
      bodyChars: pending.body?.length ?? 0,
      hasSamples: (pending.samples?.length ?? 0) > 0,
    } : { error: pendingRes.out.slice(0, 300) },
    solve: solved ? {
      ok: solved.ok,
      mode: solved.mode,
      spliced: solved.spliced,
      methodHeader: solved.methodHeader,
      scaffoldFound: solved.scaffoldFound,
      lang: solved.lang,
      chars: solved.chars,
    } : { error: solveRes.out.slice(0, 300) },
    clipboard: {
      ok: clipOk,
      chars: clip?.length ?? 0,
      hasClass: Boolean(clip?.includes('public class Solution')),
      hasBody: Boolean(clip?.includes('ListNode dummy')),
      markerGone: !clip?.includes('write code here'),
      braceBalance: balance(clip),
    },
    pendingAfterSolve: after ? { count: after.count } : null,
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
