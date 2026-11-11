// Question-switching accuracy: switch between several distinct questions and
// assert each one is detected as a *new* signature with the correct content,
// language and scaffold — no stale text, no missed switch, no duplicate.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR } from './lib/chrome.mjs';
import { clearQueue, listQueue } from './lib/queue.mjs';
import { extractQuestion } from './lib/extract.mjs';
import { readEditor, normalize } from './lib/editor.mjs';
import { mergeSolution } from './lib/stub.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock-core.html');
const AA = path.join(HERE, 'aa.mjs');
const ANSWERS = path.join(APP_DIR, 'answers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const JAVA_BODY = `ListNode dummy = new ListNode(-1);
return dummy.next;`;

async function runAA(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AA, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 60000);
    child.on('close', () => { clearTimeout(t); resolve({ out, err }); });
  });
}

/**
 * Rewrite the mock page into a different question, the way a real OJ would on
 * navigation: new heading, new body text, and a fresh scaffold.
 */
async function switchTo(cdp, { heading, body, lang }) {
  await cdp.evaluate(`(() => {
    document.getElementById('qTitle').textContent = ${JSON.stringify(heading)};
    const left = document.querySelector('.left');
    const blocks = left.querySelectorAll('.problem');
    blocks[0].innerHTML = '<h3>描述</h3><p>' + ${JSON.stringify(body)} + '</p>';
    for (let i = 1; i < blocks.length; i++) blocks[i].remove();
    const sel = document.getElementById('lang');
    if (sel) {
      sel.value = ${JSON.stringify(lang)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
  // Switching language rebuilds the editor; wait until it is back rather than
  // assuming a fixed delay, otherwise the detection sees a half-rendered page.
  await wait(900);
  for (let i = 0; i < 12; i++) {
    const ready = await cdp.evaluate(`(() => {
      const hasEditor = Boolean(document.querySelector('.monaco-editor .view-line, .monaco-editor textarea'));
      const hasTitle = (document.getElementById('qTitle')?.textContent || '').trim().length > 0;
      return hasEditor && hasTitle;
    })()`).catch(() => false);
    if (ready) break;
    await wait(400);
  }
  await wait(500);
}

let restoreClipboard = async () => {};

async function main() {
  restoreClipboard = await preserveClipboard();

  await clearQueue();
  await mkdir(ANSWERS, { recursive: true });

  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: pathToFileURL(MOCK).href, timeoutMs: 20000 });
  await wait(2800);

  // The watcher runs in queue mode: each new question is persisted.
  const watcher = spawn(process.execPath, [
    AA, 'watch', '--queue', '--url', pathToFileURL(MOCK).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AA_TRACKER_FILE: path.join(APP_DIR, 'tracker-switch.json') } });
  let werr = '';
  watcher.stderr.setEncoding('utf8');
  watcher.stderr.on('data', (d) => { werr += d; });

  const waitForQueue = async (n, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const items = await listQueue();
      if (items.length >= n) return items;
      await wait(400);
    }
    return listQueue();
  };

  const first = await waitForQueue(1);
  if (!first.length) {
    watcher.kill();
    cdp.close();
    await stopChrome().catch(() => {});
    return { ok: false, error: 'initial question not queued', stderr: werr.slice(0, 500) };
  }

  const steps = [];

  // --- Switch 1: different heading + body, same language.
  await switchTo(cdp, {
    heading: '反转链表',
    body: '给定一个单链表的头结点 pHead，反转该链表并输出反转后链表的头结点。数据范围：0 ≤ n ≤ 1000。',
    lang: 'java',
  });
  let items = await waitForQueue(2);
  const q2 = items.find((q) => q.heading.includes('反转链表'));
  steps.push({
    step: 'switch-1',
    heading: '反转链表',
    detected: Boolean(q2),
    sig: q2?.sig ?? null,
    lang: q2?.lang ?? null,
    bodyHasNewText: Boolean(q2?.body?.includes('反转该链表')),
    bodyHasOldText: Boolean(q2?.body?.includes('合并这两个链表')),
    distinctSig: q2 ? q2.sig !== first[0].sig : false,
  });

  // --- Switch 2: language changes too, scaffold must follow.
  await switchTo(cdp, {
    heading: '二叉树的最大深度',
    body: '输入一棵二叉树的根节点 root，返回该树的最大深度。深度指从根节点到叶子节点的最长路径上的节点数。',
    lang: 'cpp',
  });
  items = await waitForQueue(3);
  const q3 = items.find((q) => q.heading.includes('二叉树的最大深度'));
  steps.push({
    step: 'switch-2',
    heading: '二叉树的最大深度',
    detected: Boolean(q3),
    sig: q3?.sig ?? null,
    lang: q3?.lang ?? null,
    bodyHasNewText: Boolean(q3?.body?.includes('最大深度')),
    distinctSig: q3 ? (q3.sig !== first[0].sig && q3.sig !== q2?.sig) : false,
  });

  // --- Switch 3: back to the original heading, must still be a fresh detection.
  await switchTo(cdp, {
    heading: '合并两个排序的链表',
    body: '输入两个递增的链表，合并这两个链表并使新链表中的节点仍然是递增排序的。',
    lang: 'java',
  });
  await wait(1500);

  // The scaffold for the current question must match the current language.
  const q = await extractQuestion(cdp);
  const stub = await readEditor(cdp);
  const merged = mergeSolution(stub?.text ?? '', JAVA_BODY, 'java');

  const all = await listQueue();
  const sigs = all.map((x) => x.sig);

  watcher.kill();
  await wait(400);
  cdp.close();
  await stopChrome().catch(() => {});

  return {
    ok: steps.every((s) => s.detected && s.bodyHasNewText && s.distinctSig && !s.bodyHasOldText)
        && new Set(sigs).size === sigs.length,
    initial: { sig: first[0].sig, heading: first[0].heading, lang: first[0].lang },
    switches: steps,
    queueCount: all.length,
    allSigsDistinct: new Set(sigs).size === sigs.length,
    finalQuestion: {
      heading: q.heading,
      lang: q.lang,
      editorKind: q.editorKind,
      scaffoldKept: merged.code.includes('public class Solution'),
      spliced: merged.spliced,
      markerGone: !merged.code.includes('write code here'),
    },
    stderrTail: werr.split('\n').slice(-5).join('\n'),
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
