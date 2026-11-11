// Chrome lifecycle: locate the binary, launch headless with a private profile,
// reuse a live instance, and persist state across CLI invocations.
// Zero dependencies.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { join } from 'node:path';
import os from 'node:os';

import { cdpJson, sleep } from './cdp.mjs';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const APP_DIR = path.join(LOCAL, 'dsh-auto-answer');
export const STATE_FILE = path.join(APP_DIR, 'state.json');
export const PROFILE_DIR = process.env.AA_PROFILE || path.join(APP_DIR, 'chrome-profile');

/** The user's everyday Chrome profile, with all their logins. */
export const DAILY_PROFILE_DIR = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
/** The user's everyday Edge profile. */
export const DAILY_EDGE_PROFILE_DIR = path.join(LOCAL, 'Microsoft', 'Edge', 'User Data');

export const DEFAULT_PORT = Number(process.env.AA_PORT || 9333);

/** Ports commonly used for debugging, probed when looking for a browser to join. */
export const ATTACH_PORTS = [9222, 9223, 9333, 9444];

/**
 * Supported browsers, in preference order. Both speak CDP, so the automation
 * layer does not care which one is running — only the binary and the profile
 * directory differ.
 */
export const BROWSERS = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    binary: 'chrome.exe',
    candidates: [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    dailyProfile: DAILY_PROFILE_DIR,
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    binary: 'msedge.exe',
    candidates: [
      process.env.EDGE_PATH,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    dailyProfile: DAILY_EDGE_PROFILE_DIR,
  },
].map((b) => ({ ...b, candidates: b.candidates.filter(Boolean) }));

/** Every installed browser, in preference order. */
export function findBrowsers() {
  const found = [];
  for (const b of BROWSERS) {
    const p = b.candidates.find((c) => existsSync(c));
    if (p) found.push({ ...b, path: p });
  }
  return found;
}

/**
 * Pick a browser. `AA_BROWSER=chrome|edge` forces one; otherwise the first
 * installed candidate wins (Chrome, then Edge).
 */
export function findBrowser(preferred = process.env.AA_BROWSER) {
  const all = findBrowsers();
  if (!all.length) {
    throw new Error(
      'Neither Chrome nor Edge was found. Set CHROME_PATH or EDGE_PATH.\nTried:\n'
      + BROWSERS.flatMap((b) => b.candidates).join('\n'),
    );
  }
  if (preferred) {
    const want = all.find((b) => b.id === preferred.toLowerCase());
    if (!want) throw new Error(`AA_BROWSER=${preferred} but it is not installed`);
    return want;
  }
  return all[0];
}

export function findChrome() {
  return findBrowser().path;
}

/**
 * Find a browser we can attach to without launching anything.
 * @returns {Promise<{port:number, version:object}|null>}
 */
export async function findAttachable({ ports = ATTACH_PORTS } = {}) {
  for (const p of ports) {
    try {
      const version = await cdpJson(p, '/json/version', { timeoutMs: 800 });
      return { port: p, version };
    } catch {
      // Not listening; try the next one.
    }
  }
  return null;
}

/**
 * Launch a browser with the user's DAILY profile so every existing login is there.
 *
 * Chrome and Edge both refuse `--remote-debugging-port` on a profile that is
 * already open, so the caller must have closed it first; that failure is
 * reported clearly rather than retried in a loop.
 */
export async function launchDailyProfile({ port = 9222, browserId = null } = {}) {
  const browser = findBrowser(browserId ?? process.env.AA_BROWSER);
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${browser.dailyProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const version = await cdpJson(port, '/json/version', { timeoutMs: 800 });
      const state = {
        pid: child.pid,
        port,
        profileDir: browser.dailyProfile,
        chromePath: browser.path,
        browserId: browser.id,
        browserLabel: browser.label,
        headless: false,
        mode: 'daily',
        startedAt: new Date().toISOString(),
      };
      await writeState(state);
      return { ...state, version, reused: false };
    } catch {
      await sleep(200);
    }
  }

  throw new Error(
    `${browser.label} did not expose CDP on the daily profile. `
    + 'Close every browser window first — the debug port is refused when the '
    + 'profile is already in use.',
  );
}

export async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(state) {
  await mkdir(APP_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export async function clearState() {
  await rm(STATE_FILE, { force: true });
}

/** True when a CDP HTTP endpoint answers on this port. */
export async function isPortAlive(port) {
  try {
    await cdpJson(port, '/json/version', { timeoutMs: 1200 });
    return true;
  } catch {
    return false;
  }
}

/** Find a free TCP port, preferring `preferred`. */
export async function pickPort(preferred = DEFAULT_PORT) {
  if (await isFree(preferred)) return preferred;
  for (let p = preferred + 1; p < preferred + 200; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`No free port found near ${preferred}`);
}

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function chromeArgs({ port, headless }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A killed instance leaves the profile marked as crashed, and Chrome then
    // shows a "Restore pages?" bubble that covers the window. The automation
    // profile is disposable, so suppress the bubble at every level.
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--mute-audio',
    '--window-size=1440,900',
    '--window-position=80,60',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');
  return args;
}

/**
 * Clear the "crashed" marker Chrome persists in the profile.
 *
 * Chrome records `exit_type` in Preferences and treats anything other than
 * "Normal" as a crash on next start. Deleting the session files plus resetting
 * the flag prevents the restore bubble from covering the window.
 */
async function clearCrashState(profileDir) {
  const prefFile = join(profileDir, 'Default', 'Preferences');
  try {
    const raw = await readFile(prefFile, 'utf8');
    const prefs = JSON.parse(raw);
    let changed = false;
    if (prefs?.profile?.exit_type && prefs.profile.exit_type !== 'Normal') {
      prefs.profile.exit_type = 'Normal';
      changed = true;
    }
    if (prefs?.profile?.exited_cleanly === false) {
      prefs.profile.exited_cleanly = true;
      changed = true;
    }
    if (changed) await writeFile(prefFile, JSON.stringify(prefs), 'utf8');
  } catch { /* no preferences yet */ }

  for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try { await rm(join(profileDir, 'Default', f), { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Start Chrome (or reuse the running instance recorded in state.json).
 * Returns { port, pid, reused, chromePath }.
 *
 * A running instance is only reused when its visibility matches what the caller
 * asked for. Reusing a headless instance for a `--show` request would leave the
 * operator with no window to navigate in, which is exactly the bug that makes
 * "just press J+K" unusable.
 */
export async function ensureChrome({ headless = true, port = null, forceNew = false } = {}) {
  const state = await readState();

  if (!forceNew && state?.port && (await isPortAlive(state.port))) {
    const sameMode = state.headless === undefined ? headless : state.headless === headless;
    if (sameMode) {
      return { port: state.port, pid: state.pid, reused: true, chromePath: state.chromePath, headless };
    }
    // Mode differs: shut the old instance down before starting a new one.
    try { process.kill(state.pid); } catch { /* already gone */ }
    await sleep(600);
    await clearState();
  }

  const browser = findBrowser();
  const chromePath = browser.path;
  const usePort = port ?? (await pickPort(DEFAULT_PORT));

  await mkdir(PROFILE_DIR, { recursive: true });
  // A previous headless run that was killed leaves the profile flagged as
  // crashed; clearing that is what keeps the restore bubble off the screen.
  await clearCrashState(PROFILE_DIR);

  const child = spawn(chromePath, chromeArgs({ port: usePort, headless }), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isPortAlive(usePort)) {
      const next = {
        pid: child.pid,
        port: usePort,
        profileDir: PROFILE_DIR,
        chromePath,
        browserId: browser.id,
        browserLabel: browser.label,
        headless,
        startedAt: new Date().toISOString(),
      };
      await writeState(next);
      return { ...next, reused: false };
    }
    await sleep(150);
  }

  throw new Error(
    `${browser.label} did not expose CDP on port ${usePort} within 20s (binary: ${chromePath})`,
  );
}

/**
 * Pick the page target the operator is actually looking at.
 *
 * A browser started by `watch` has several tabs: the initial `about:blank`,
 * plus whatever the operator opened. Attaching to `pages[0]` would land on the
 * blank tab and every extraction would fail, so the target is chosen by:
 *
 *   1. exact URL match, when a URL was requested
 *   2. otherwise the most recently focused real page (http/https/file)
 *   3. otherwise the first non-blank page
 */
function pickPage(pages, url = null) {
  if (url) {
    const exact = pages.find((t) => t.url === url);
    if (exact) return exact;
  }

  const real = pages.filter((t) => /^(https?|file):/.test(t.url));
  if (real.length) {
    // `lastActiveTime` is set by Chrome and is the best "what is on screen" hint.
    return real.sort((a, b) => (b.lastActiveTime ?? 0) - (a.lastActiveTime ?? 0))[0];
  }

  const nonBlank = pages.filter((t) => t.url !== 'about:blank');
  return nonBlank[0] ?? pages[0];
}

/** Attach to the page the operator is viewing, navigating it if a URL is given. */
export async function attachPage({ port, url = null, timeoutMs = 30000, targetId = null }) {
  const list = await cdpJson(port, '/json/list');
  const pages = list.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('No page target available in the browser');

  let target = targetId ? pages.find((t) => t.id === targetId) : null;
  if (!target) target = pickPage(pages, url);

  const { CDP } = await import('./cdp.mjs');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Bring the chosen tab to the front so the operator sees the same page the
  // automation is reading.
  await cdp.send('Page.bringToFront').catch(() => {});

  if (url && target.url !== url) {
    const loaded = new Promise((resolve) => {
      const off = cdp.on('Page.loadEventFired', () => { off(); resolve(); });
    });
    await cdp.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(timeoutMs)]).then(() => undefined);
    await cdp.waitFor('document.readyState === "complete"', { timeoutMs, label: 'document ready' });
  }

  const state = await readState();
  if (state) await writeState({ ...state, targetId: target.id, url: url ?? target.url });
  return { cdp, targetId: target.id, targetUrl: target.url, pageCount: pages.length };
}

/** Kill the recorded Chrome instance and forget it. */
export async function stopChrome() {
  const state = await readState();
  if (!state?.pid) {
    await clearState();
    return { stopped: false, reason: 'no recorded instance' };
  }
  try {
    process.kill(state.pid);
  } catch (err) {
    // Already gone; still clear the state file.
  }
  await sleep(400);
  await clearState();
  return { stopped: true, pid: state.pid };
}
