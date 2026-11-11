// No-site mode: `watch --hotkey` with no URL must open a VISIBLE window so the
// operator can navigate to a question themselves, and must still arm the hotkey.
//
// A headless run cannot verify visibility by looking at the screen, so this
// checks the two things that actually determine it:
//   1. state.json records headless:false for the instance watch started
//   2. the browser exposes a page target and the hotkey listener is alive

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';

import { readState, stopChrome, APP_DIR } from './lib/chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const TRACKER = path.join(APP_DIR, 'tracker-nosite.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(APP_DIR, { recursive: true });
  await rm(TRACKER, { force: true });
  await stopChrome().catch(() => {});

  // No --url: exactly what the desktop launcher does when no site is configured.
  const child = spawn(process.execPath, [
    AA, 'watch', '--hotkey', 'J+K', '--clip-delay', '3',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TRACKER_FILE: TRACKER },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  // Wait for the browser to come up and the listener to arm.
  let state = null;
  for (let i = 0; i < 30; i++) {
    await wait(700);
    state = await readState();
    if (state?.port) break;
  }

  await wait(2500);

  // A visible instance must expose a real page target.
  let pageCount = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/json/list`);
    const list = await res.json();
    pageCount = list.filter((t) => t.type === 'page').length;
  } catch { /* reported below */ }

  const listenerArmed = /listening for J\+K/i.test(err);
  // The wording changed when attach-to-existing-browser was added; accept the
  // current phrasing so the test tracks behaviour, not a frozen string.
  const noUrlNote = /whichever tab is in front|no URL given/i.test(err);

  child.kill();
  await wait(600);
  await stopChrome().catch(() => {});

  return {
    ok: state?.headless === false && pageCount >= 1 && listenerArmed && noUrlNote,
    headless: state?.headless ?? null,
    port: state?.port ?? null,
    pageTargets: pageCount,
    hotkeyArmed: listenerArmed,
    loggedNoUrlHint: noUrlNote,
    stderrTail: err.split('\n').slice(-6).join('\n'),
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
