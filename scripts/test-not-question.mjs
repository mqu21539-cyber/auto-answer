// Non-question pages must never notify.
//
// Loads a mock "question list" page (no problem statement, just a list and a
// search box), runs watch, mutates it repeatedly, and asserts:
//   - zero toasts
//   - zero queued entries
//   - the page is reported as not-a-question

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR } from './lib/chrome.mjs';
import { clearQueue, listQueue } from './lib/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const TOAST_LOG = path.join(APP_DIR, 'toast-notq.jsonl');
const TRACKER = path.join(APP_DIR, 'tracker-notq.json');
const NOTQ_PAGE = path.join(APP_DIR, 'not-question.html');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A page that looks like a problem list: has a search textarea, but no statement.
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>题库</title></head>
<body>
  <h1>题库</h1>
  <div class="content">
    <p>全部题目</p>
    <p>1. 两数之和 简单 通过率 45%</p>
    <p>2. 反转链表 简单 通过率 38%</p>
    <p>3. 二叉树的最大深度 中等 通过率 29%</p>
    <p>搜索  筛选  排序方式</p>
  </div>
  <textarea placeholder="搜索题目"></textarea>
</body></html>`;

async function toasts() {
  try {
    const raw = await readFile(TOAST_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  await mkdir(APP_DIR, { recursive: true });
  await writeFile(NOTQ_PAGE, PAGE, 'utf8');
  await clearQueue();
  await rm(TOAST_LOG, { force: true });
  await rm(TRACKER, { force: true });

  const child = spawn(process.execPath, [
    AA, 'watch', '--queue', '--url', pathToFileURL(NOTQ_PAGE).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AA_TOAST_LOG: TOAST_LOG,
      AA_TRACKER_FILE: TRACKER,
    },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  await wait(6000);

  // Churn the list page: this is what a real SPA does on hover/scroll/refresh.
  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: null, timeoutMs: 8000 });
  for (let i = 0; i < 5; i++) {
    await cdp.evaluate(`(() => {
      const p = document.querySelectorAll('.content p');
      if (p[0]) p[0].textContent = '全部题目 (' + ${i} + ' 道)';
      return true;
    })()`);
    await wait(700);
  }
  cdp.close();
  await wait(2000);

  const toastCount = await toasts();
  const queue = await listQueue();

  child.kill();
  await wait(500);
  await stopChrome().catch(() => {});

  const events = out.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const notAQ = events.filter((e) => e.event === 'not-a-question');
  const detected = events.filter((e) => e.event === 'question-detected');

  return {
    ok: toastCount === 0 && queue.length === 0 && notAQ.length > 0 && detected.length === 0,
    toasts: toastCount,
    queued: queue.length,
    notAQuestionEvents: notAQ.length,
    detectedEvents: detected.length,
    firstNotAQuestion: notAQ[0] ?? null,
    stderrTail: err.split('\n').slice(-4).join('\n'),
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
