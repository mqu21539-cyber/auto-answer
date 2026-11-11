// Clipboard retry: a failed write must be retried, not silently dropped.
//
// The failure is produced by actually opening the Windows clipboard in another
// process and holding it, so this exercises the real CLIPBRD_E_CANT_OPEN path
// rather than a stubbed one.
//
// Ordering matters: the lock must be confirmed BEFORE the trigger, otherwise the
// first copy can legitimately succeed and the test proves nothing.
//
// The lock is not equally effective on every machine — some Windows builds and
// clipboard stacks let a write through anyway. The test therefore probes that
// premise first and reports `skipped` rather than a false failure when the
// environment cannot force contention.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { APP_DIR } from './lib/chrome.mjs';
import { readClipboard, copyToClipboard, preserveClipboard } from './lib/clipboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const TRIGGER = path.join(APP_DIR, 'clipretry-trigger.txt');
const TOAST_LOG = path.join(APP_DIR, 'toast-clipretry.jsonl');

const CODE = 'public class Solution {\n    public int f(int n) { return n; }\n}\n';
const HOLD_MS = 5000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const parse = (t) => t.split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

/** Hold the clipboard open like a clipboard manager or screenshot tool does. */
const HOLD_CLIPBOARD = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CL {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
}
"@
if ([CL]::OpenClipboard([IntPtr]::Zero)) {
  [Console]::Out.WriteLine("HELD")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${HOLD_MS}
  [CL]::CloseClipboard() | Out-Null
  [Console]::Out.WriteLine("RELEASED")
  [Console]::Out.Flush()
} else {
  [Console]::Out.WriteLine("OPEN-FAILED")
  [Console]::Out.Flush()
}
`;

/**
 * Verify this machine can actually be made to reject a clipboard write.
 *
 * If it cannot, every assertion below would be vacuous: the copy would succeed
 * on the first attempt no matter what, and the test would report a failure that
 * says nothing about the code.
 */
async function lockBlocksWrites() {
  const holder = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', HOLD_CLIPBOARD.replace(String(HOLD_MS), '3000')],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let seen = '';
  holder.stdout.setEncoding('utf8');
  holder.stdout.on('data', (d) => { seen += d; });

  for (let i = 0; i < 40; i += 1) {
    if (/HELD/.test(seen)) break;
    if (/OPEN-FAILED/.test(seen)) {
      try { holder.kill(); } catch { /* gone */ }
      return false;
    }
    await wait(250);
  }

  if (!/HELD/.test(seen)) {
    try { holder.kill(); } catch { /* gone */ }
    return false;
  }

  const probe = await copyToClipboard('LOCK-PROBE');
  try { holder.kill(); } catch { /* gone */ }
  await wait(800);

  // If the write went through while another process had it open, the lock is
  // advisory on this machine and contention cannot be simulated.
  return probe.ok !== true;
}

async function main() {
  const restoreClipboard = await preserveClipboard();

  await mkdir(APP_DIR, { recursive: true });
  await rm(TOAST_LOG, { force: true });
  await rm(TRIGGER, { force: true });

  // Determine the premise before doing anything expensive.
  const canForce = await lockBlocksWrites();
  if (!canForce) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'this machine lets clipboard writes through even while the clipboard is held; contention cannot be simulated here',
      note: 'the retry path itself is still covered by test-auto / test-silent error handling',
    }, null, 2));
    // The lock probe above wrote to the clipboard; put the operator's data back
    // before leaving, even on the skip path.
    await restoreClipboard();
    process.exitCode = 0;
    return;
  }

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: CODE } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, [
    AA, 'watch', '--desktop', '--auto', '--no-toast',
    '--trigger-file', TRIGGER,
    '--api-base', `http://127.0.0.1:${port}/v1`,
    '--api-key', 'stub', '--model', 'stub',
    '--clip-delay', '0',
    '--answer-timeout', '60',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  await wait(3000);

  // 1. Take the clipboard and WAIT until the holder confirms it is held.
  const holder = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', HOLD_CLIPBOARD],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let held = '';
  holder.stdout.setEncoding('utf8');
  holder.stdout.on('data', (d) => { held += d; });

  let acquired = false;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    if (/HELD/.test(held)) { acquired = true; break; }
    if (/OPEN-FAILED/.test(held)) break;
  }

  if (!acquired) {
    child.kill(); try { holder.kill(); } catch { /* gone */ }
    console.log(JSON.stringify({ ok: false, error: 'could not lock the clipboard', held }, null, 2));
    process.exitCode = 1;
    return;
  }

  // 2. Only now trigger, so the first copy attempt is guaranteed to fail.
  await writeFile(TRIGGER, `t ${Date.now()}\n`, 'utf8');

  let copied = null;
  for (let i = 0; i < 120; i++) {
    await wait(500);
    copied = parse(out).find((e) => e.event === 'clipboard-copied');
    if (copied) break;
  }

  const retries = parse(out).filter((e) => e.event === 'clipboard-retry');
  const failed = parse(out).filter((e) => e.event === 'clipboard-failed');

  // 3. Let the holder release before reading, or the read itself fails.
  for (let i = 0; i < 40; i++) {
    if (/RELEASED/.test(held)) break;
    await wait(250);
  }
  await wait(500);

  const clip = await readClipboard();

  child.kill();
  try { holder.kill(); } catch { /* gone */ }
  await wait(500);
  server.close();

  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
  const ok = retries.length >= 1
    && failed.length === 0
    && copied?.ok === true
    && copied.attempts >= 2
    && norm(clip) === norm(CODE);

  console.log(JSON.stringify({
    ok,
    clipboardWasHeld: acquired,
    retryEvents: retries.map((r) => ({ attempt: r.attempt, error: (r.error ?? '').slice(0, 70), nextInMs: r.nextInMs })),
    gaveUp: failed.length,
    copied: copied ?? null,
    clipboardMatches: norm(clip) === norm(CODE),
    clipboardChars: clip?.length ?? 0,
    stderrTail: err.split('\n').slice(-8).join('\n'),
  }, null, 2));

  await restoreClipboard();

  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exitCode = 1;
});