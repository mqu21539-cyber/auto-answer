#!/usr/bin/env node
// auto-answer — drive a hidden Chrome, read the question, inject code, verify.
//
// Zero dependencies. Node >= 22 (native WebSocket + fetch).
//
// High-level flow:  prepare  ->  (agent writes solution.py)  ->  answer --file
// Watch flow:       watch --solver agent        (auto-detect question changes)

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  ensureChrome, attachPage, stopChrome, readState, APP_DIR, PROFILE_DIR, findChrome,
  findAttachable, launchDailyProfile, DAILY_PROFILE_DIR, ATTACH_PORTS, findBrowsers,
} from './lib/chrome.mjs';
import { writeCode, readEditor, clearEditor, normalize, diffText } from './lib/editor.mjs';
import { extractQuestion, diagnose, signature } from './lib/extract.mjs';
import { installWatcher, mute, unmute } from './lib/watch.mjs';
import { cdpJson } from './lib/cdp.mjs';
import { probe } from './lib/probe.mjs';
import { copyToClipboard, clearClipboard, toast, beep } from './lib/clipboard.mjs';
import { MESSAGES, TITLES } from './lib/messages.mjs';
import { normalizeLang, resolveLang, langFromFile, EXTENSIONS } from './lib/lang.mjs';
import { switchLanguage } from './lib/langswitch.mjs';
import { templateFor } from './lib/templates.mjs';
import { mergeSolution, stubSummary } from './lib/stub.mjs';
import {
  enqueue, listQueue, newestPending, markAnswered, clearQueue, QUEUE_DIR,
  loadTrackerState, saveTrackerState,
} from './lib/queue.mjs';
import { QuestionTracker, compareQuestions } from './lib/identity.mjs';
import { classifyPage } from './lib/classify.mjs';
import { startHotkey } from './lib/hotkey.mjs';
import { grabPage, capture, SHOT_DIR } from './lib/shot.mjs';
import { captureScreen } from './lib/screen.mjs';
import { solveWithVision, solveAndVerify, loadSolverConfig, guessLanguage } from './lib/vision-solver.mjs';

const DEFAULT_NAV_TIMEOUT = Number(process.env.AA_NAV_TIMEOUT || 30000);

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Event streams (watch) emit one JSON object per line so a reader can parse
// them incrementally; one-shot commands stay pretty-printed for humans.
let JSONL = false;

// Writing to a closed stdout throws EPIPE, and an unhandled 'error' event on the
// stream kills the process. A detached watcher outlives whatever started it —
// the terminal closes, the capture window goes away — and at that point a
// logging call must not be able to take the whole thing down.
let stdoutGone = false;
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') { stdoutGone = true; return; }
  throw err;
});

const print = (obj) => {
  if (stdoutGone) return;
  const body = JSONL ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
  try {
    process.stdout.write(body + '\n');
  } catch (err) {
    if (err && err.code === 'EPIPE') { stdoutGone = true; return; }
    throw err;
  }
};

let stderrGone = false;
process.stderr.on('error', (err) => {
  if (err && err.code === 'EPIPE') { stderrGone = true; return; }
  throw err;
});

const log = (msg) => {
  if (stderrGone) return;
  try {
    process.stderr.write(`[aa] ${msg}\n`);
  } catch (err) {
    if (err && err.code === 'EPIPE') { stderrGone = true; return; }
    throw err;
  }
};

function fail(message, extra = {}) {
  print({ ok: false, error: message, ...extra });
  process.exit(1);
}

// ------------------------------------------------------------------ commands

async function cmdStart(args) {
  const headless = !args.show;
  const info = await ensureChrome({
    headless,
    port: args.port ? Number(args.port) : null,
  });
  print({
    ok: true,
    port: info.port,
    pid: info.pid,
    headless: info.headless ?? headless,
    reused: info.reused,
    profileDir: PROFILE_DIR,
    chromePath: info.chromePath ?? findChrome(),
  });
}

async function cmdStatus() {
  const state = await readState();
  if (!state) {
    print({ ok: true, running: false });
    return;
  }
  let alive = false;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/json/version`);
    alive = res.ok;
  } catch { alive = false; }
  print({ ok: true, running: alive, ...state });
}

async function cmdStop() {
  const res = await stopChrome();
  print({ ok: true, ...res });
}

/**
 * Kill leftover hotkey-listener processes.
 *
 * Only needed for listeners spawned by builds that did not watch their parent.
 * The current listener exits by itself when the watcher disappears, so this is a
 * one-off cleanup for anything older still lying around.
 *
 * DANGER: the match is textual, and any shell whose command line mentions the
 * P/Invoke symbol matches too — including the very shell that called this. Both
 * the current process and its parent shell are excluded by PID, and the pattern
 * is the listener's own class name rather than the Win32 API name that other
 * tooling is likely to mention.
 */
async function killHotkeyListeners() {
  try {
    const { execFileSync } = await import('node:child_process');
    const exclusions = [process.pid, process.ppid].filter(Boolean).join(',');
    const script = `$skip = @(${exclusions})`
      + `; Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"`
      + ` | Where-Object { $_.CommandLine -like '*class AAKeyState*' -and $_.ProcessId -ne $PID -and $skip -notcontains $_.ProcessId }`
      + ` | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch { /* best effort */ }
}

/**
 * Stop every running watcher.
 *
 * A hidden watcher has no console to close, so this is the only way to stop it.
 * Sweeps the process table rather than relying on the PID file, since a stray
 * from a crashed run would keep answering the hotkey.
 */
async function cmdStopWatch() {
  const lockFile = path.join(APP_DIR, 'watch.pid');

  let before = [];
  try {
    const { execFileSync } = await import('node:child_process');
    const list = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*aa.mjs*watch*' -and $_.CommandLine -notlike '*stop-watch*' } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: 'utf8', timeout: 15000 });
    before = list.split('\n').map((s) => Number(s.trim())).filter(Boolean);
  } catch { /* query failed; fall back to the pid file */ }

  if (before.length) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*aa.mjs*watch*' -and $_.CommandLine -notlike '*stop-watch*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
      ], { stdio: 'ignore', timeout: 15000 });
    } catch { /* best effort */ }
  }

  await rm(lockFile, { force: true });

  // The key-polling children outlive their parent; take them down too, or each
  // stop leaves an 80 MB process behind.
  await killHotkeyListeners();

  print({
    ok: true,
    stopped: before,
    count: before.length,
    ...(before.length ? {} : { note: 'no watcher was running' }),
  });
}

async function cmdLogin(args) {
  const url = args._[0] || args.url;
  if (!url) fail('login requires a URL: aa.mjs login <url>');

  log('starting Chrome with a visible window; log in manually, then press Enter here');
  const info = await ensureChrome({ headless: false, forceNew: true });
  const { cdp } = await attachPage({ port: info.port, url, timeoutMs: DEFAULT_NAV_TIMEOUT });

  await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('\n[aa] press Enter once you are logged in... ', () => { rl.close(); resolve(); });
  });

  // Confirm the session survived before closing the window.
  const check = await extractQuestion(cdp).catch(() => null);
  await cdp.evaluate('window.close()').catch(() => {});
  cdp.close();
  await stopChrome();

  print({
    ok: true,
    saved: true,
    profileDir: PROFILE_DIR,
    loggedOutHint: check?.loggedOutHint ?? null,
    next: 'aa.mjs prepare --url <same-url>',
  });
}

async function withPage(args, fn) {
  const url = args.url ?? args._[0] ?? null;
  // Same resolution as `watch`: join a running browser when there is one,
  // otherwise start the private profile. This keeps `prepare` / `answer` /
  // `clip` working against whichever browser the operator actually uses.
  const browser = await resolveBrowser(args);
  const { cdp, targetId, targetUrl } = await attachPage({
    port: browser.port,
    url,
    timeoutMs: DEFAULT_NAV_TIMEOUT,
  });
  try {
    return await fn(cdp, { info: browser, targetId, targetUrl });
  } finally {
    cdp.close();
  }
}

async function cmdPrepare(args) {
  await withPage(args, async (cdp) => {
    const q = await extractQuestion(cdp);
    const d = diagnose(q);
    const editor = await readEditor(cdp).catch(() => null);
    print({
      ok: d.ok,
      ...(d.ok ? {} : { reason: d.reason, hint: d.hint }),
      question: {
        sig: q.sig,
        url: q.url,
        title: q.title,
        heading: q.heading,
        bodyLength: q.bodyLength,
        body: q.body,
        samples: q.samples,
        lang: q.lang,
        editorKind: q.editorKind,
        iframes: q.iframes,
      },
      editorContent: editor?.text ?? null,
      editorChars: normalize(editor?.text ?? '').length,
    });
    if (!d.ok) process.exitCode = 2;
  });
}

async function cmdRead(args) {
  await withPage(args, async (cdp) => {
    const q = await extractQuestion(cdp);
    const editor = await readEditor(cdp).catch(() => null);
    print({
      ok: true,
      question: { sig: q.sig, heading: q.heading, bodyLength: q.bodyLength, lang: q.lang, editorKind: q.editorKind },
      editorContent: editor?.text ?? null,
      editorChars: normalize(editor?.text ?? '').length,
    });
  });
}

async function cmdProbe(args) {
  await withPage(args, async (cdp) => {
    const report = await probe(cdp);
    print({ ok: true, ...report });
  });
}

/** Read the editor's current content, tolerating a page with no editor yet. */
async function currentEditorText(cdp) {
  const r = await readEditor(cdp).catch(() => null);
  return r?.text ?? '';
}

/**
 * Build the text to actually write.
 *
 * In core-code mode the editor holds a scaffold (class + method with an empty
 * body). Writing the whole file would destroy it, so the answer is spliced into
 * the method body instead. In ACM mode the answer replaces the editor.
 */
function buildPayload(stubText, answer, lang) {
  const merged = mergeSolution(stubText, answer, lang);
  return {
    code: merged.code,
    mode: merged.mode,
    spliced: merged.spliced,
    header: merged.header ?? null,
  };
}

async function cmdAnswer(args) {
  const file = args.file ?? args._[0];
  if (!file) fail('answer requires --file <path>');
  if (!existsSync(file)) fail(`file not found: ${file}`);

  const code = await readFile(file, 'utf8');

  await withPage(args, async (cdp) => {
    const q = await extractQuestion(cdp).catch(() => null);
    const d = q ? diagnose(q) : { ok: false, reason: 'extract-failed' };
    if (!d.ok && d.reason === 'logged-out') {
      print({ ok: false, reason: d.reason, hint: d.hint, url: q?.url });
      process.exitCode = 2;
      return;
    }

    // Language precedence: what the page says the question is written in comes
    // first. --lang and the file extension are fallbacks for pages with no
    // selector, and a mismatch is reported rather than silently ignored.
    const detectedLang = normalizeLang(q?.lang);
    const resolved = detectedLang
      ? { lang: detectedLang, source: 'page-selector' }
      : resolveLang({
        explicit: args.lang,
        file,
        pageLang: null,
        fallback: process.env.AA_DEFAULT_LANG || 'python',
      });

    const fileLang = langFromFile(file);
    const langMismatch = Boolean(
      detectedLang && fileLang && fileLang !== detectedLang && !args.force,
    );
    if (langMismatch) {
      log(
        `warning: ${path.basename(file)} is ${fileLang} but the question is ${detectedLang}`
        + ' (pass --force to write anyway)',
      );
    }

    // If the page exposes a language selector and it is on a different
    // language, switch it before writing: the editor usually resets on switch.
    let langSwitch = null;
    if (resolved.lang && q?.langOptions?.length) {
      langSwitch = await switchLanguage(cdp, resolved.lang);
      if (langSwitch.ok && langSwitch.switched) {
        log(`language switched: ${langSwitch.before} -> ${langSwitch.after}`);
        // Re-extract: the editor may be a different instance after the switch.
        await extractQuestion(cdp).catch(() => {});
      } else if (!langSwitch.ok && langSwitch.reason === 'option-not-available') {
        log(`page has no ${resolved.lang} option; writing anyway`);
      }
    }

    await mute(cdp).catch(() => {});

    // Read the scaffold AFTER any language switch: switching rebuilds the
    // editor and restores the platform's stub, which is what must be merged into.
    const stubText = args['no-merge'] ? '' : await currentEditorText(cdp);
    const payload = buildPayload(stubText, code, resolved.lang);
    if (payload.mode === 'core') {
      log(`core-code mode: splicing into ${payload.header ?? 'method body'}`);
    }

    const result = await writeCode(cdp, payload.code, { retries: Number(args.retries || 3), log });
    await unmute(cdp).catch(() => {});

    let shot = null;
    if (args.shot) {
      shot = await screenshot(cdp, args.shot);
    }

    print({
      ok: result.ok && !langMismatch,
      editor: result.editor,
      chars: result.chars ?? null,
      attempts: result.attempts,
      diff: result.diff ?? null,
      mode: payload.mode,
      spliced: payload.spliced,
      methodHeader: payload.header,
      lang: resolved.lang,
      langSource: resolved.source,
      pageLang: q?.lang ?? null,
      fileLang,
      langMismatch,
      langSwitch,
      question: q ? { sig: q.sig, heading: q.heading } : null,
      screenshot: shot,
    });
    if (!result.ok) process.exitCode = 3;
    else if (langMismatch) process.exitCode = 5;
  });
}

async function cmdFill(args) {
  const text = args._[0];
  if (!text) fail('fill requires text as the first positional argument');
  await withPage(args, async (cdp) => {
    const result = await writeCode(cdp, text, { retries: 1, log });
    print({ ok: result.ok, editor: result.editor, chars: result.chars ?? null });
    if (!result.ok) process.exitCode = 3;
  });
}

async function cmdClick(args) {
  const target = args._[0];
  if (!target) fail('click requires a selector or visible text');
  await withPage(args, async (cdp) => {
    const expr = `(() => {
      const sel = ${JSON.stringify(target)};
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el) {
        const want = sel.trim();
        el = [...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')]
          .find((n) => (n.innerText || n.value || '').trim() === want)
          || [...document.querySelectorAll('button,a,[role="button"]')]
            .find((n) => (n.innerText || '').includes(want));
      }
      if (!el) return { ok: false, reason: 'not-found' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, text: (el.innerText || el.value || '').trim().slice(0, 80) };
    })()`;
    const res = await cdp.evaluate(expr);
    print(res);
    if (!res?.ok) process.exitCode = 3;
  });
}

async function screenshot(cdp, outPath) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.resolve(outPath === true ? path.join(APP_DIR, `shot-${Date.now()}.png`) : outPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(res.data, 'base64'));
  return target;
}

async function cmdShot(args) {
  await withPage(args, async (cdp) => {
    const file = await screenshot(cdp, args.out ?? path.join(APP_DIR, `shot-${Date.now()}.png`));
    print({ ok: true, file });
  });
}

/**
 * Universal read: whatever the page is, return something the caller can act on.
 *
 * Order of preference:
 *   1. structured question (heading + statement + samples + editor)
 *   2. DOM text plus a screenshot
 *   3. screenshot alone
 */
async function cmdGrab(args) {
  await withPage(args, async (cdp) => {
    const q = await extractQuestion(cdp).catch(() => null);
    const cls = q ? classifyPage(q) : null;
    const editor = await readEditor(cdp).catch(() => null);

    const grabbed = await grabPage(cdp, {
      fullPage: args.viewport ? false : true,
      name: `grab-${Date.now()}`,
    }).catch((err) => ({ ok: false, error: err.message }));

    print({
      ok: true,
      url: q?.url ?? null,
      title: q?.title ?? null,
      recognized: cls?.isQuestion ?? false,
      score: cls?.score ?? null,
      signals: cls?.signals ?? [],
      question: q ? {
        sig: q.sig,
        heading: q.heading,
        lang: q.lang,
        langOptions: q.langOptions,
        editorKind: q.editorKind,
        bodyLength: q.bodyLength,
        body: q.body,
        samples: q.samples,
        samplePairs: q.samplePairs,
      } : null,
      editorContent: editor?.text ?? null,
      editorFrame: editor?.frame ?? null,
      screenshot: grabbed.file ?? null,
      screenshotBytes: grabbed.bytes ?? null,
      domText: grabbed.dom?.text?.slice(0, 20000) ?? null,
      domTextLength: grabbed.dom?.textLength ?? 0,
    });
  });
}

async function cmdClip(args) {
  const file = args.file ?? args._[0];
  if (!file) fail('clip requires --file <path>');
  if (!existsSync(file)) fail(`file not found: ${file}`);

  const code = await readFile(file, 'utf8');
  const delay = args.delay === undefined ? 0 : Number(args.delay);

  // One toast per run, not one per stage.
  if (delay > 0) {
    log(`waiting ${delay}s...`);
    await new Promise((r) => setTimeout(r, delay * 1000));
  }

  const res = await copyToClipboard(code);
  if (!res.ok) fail(`clipboard write failed: ${res.error}`);

  if (args.toast !== false) {
    await toast(TITLES.main, MESSAGES.ready());
  }
  beep();

  print({
    ok: true,
    copied: res.chars,
    lang: langFromFile(file),
    file: path.resolve(file),
  });
}

async function cmdPending(args) {
  const all = await listQueue();
  const pending = all.filter((q) => !q.answered);

  if (args.all) {
    print({ ok: true, count: all.length, questions: all.map(summarize) });
    return;
  }

  if (!pending.length) {
    print({ ok: true, count: 0, question: null, hint: 'run: aa.mjs watch --queue' });
    return;
  }

  // Newest first; the full body is included because the caller needs to solve it.
  const q = pending[0];
  print({
    ok: true,
    count: pending.length,
    sig: q.sig,
    url: q.url,
    heading: q.heading,
    lang: q.lang,
    langOptions: q.langOptions,
    editorKind: q.editorKind,
    bodyLength: q.bodyLength,
    body: q.body,
    samples: q.samples,
    samplePairs: q.samplePairs,
    detectedAt: q.detectedAt,
    queueDir: QUEUE_DIR,
  });
}

function summarize(q) {
  return {
    sig: q.sig,
    heading: q.heading,
    lang: q.lang,
    answered: q.answered,
    detectedAt: q.detectedAt,
    bodyLength: q.bodyLength,
  };
}

async function cmdQueue(args) {
  if (args.clear) {
    await clearQueue();
    print({ ok: true, cleared: true });
    return;
  }
  const all = await listQueue();
  print({
    ok: true,
    count: all.length,
    pending: all.filter((q) => !q.answered).length,
    questions: all.map(summarize),
  });
}

/**
 * Push an answer to the clipboard, merging it into the page's scaffold when the
 * question is in core-code mode.
 *
 * The page is read first (to get the scaffold and confirm the language), but is
 * never written to — the answer only goes to the clipboard.
 */
async function cmdSolve(args) {
  const file = args.file ?? args._[0];

  let sig = args.sig ?? null;
  let question = null;

  if (!sig) {
    question = await newestPending();
    if (!question) fail('no pending question; run "aa.mjs watch --queue" first, or pass --sig');
    sig = question.sig;
  } else if (!file) {
    // Look the signature up so the language can be resolved.
    const all = await listQueue();
    question = all.find((q) => q.sig === sig) ?? null;
  }

  let answer = null;
  if (file) {
    if (!existsSync(file)) fail(`file not found: ${file}`);
    answer = await readFile(file, 'utf8');
  } else if (typeof args.text === 'string') {
    answer = args.text;
  } else {
    fail('solve requires --file <path> or --text "<code>"');
  }

  // Resolve the language: page > queue record > file extension > default.
  const detected = normalizeLang(question?.lang ?? null);
  const resolved = detected
    ? { lang: detected, source: 'question' }
    : resolveLang({
      explicit: args.lang,
      file: file ?? null,
      pageLang: null,
      fallback: process.env.AA_DEFAULT_LANG || 'python',
    });

  // Merge into the scaffold when the editor holds one, so pasting produces
  // compilable code rather than a bare method body.
  let payload = { code: answer, mode: 'acm', spliced: false, header: null };
  let scaffoldFound = false;
  try {
    const info = await ensureChrome({ headless: true });
    const { cdp } = await attachPage({ port: info.port, url: null, timeoutMs: 8000 });
    try {
      const stubText = await currentEditorText(cdp);
      if (stubText.trim()) {
        scaffoldFound = true;
        payload = buildPayload(stubText, answer, resolved.lang);
      }
    } finally {
      cdp.close();
    }
  } catch {
    // No browser running: fall back to the raw answer. Pasting a bare body is
    // still useful when the editor is ACM mode.
  }

  const res = await copyToClipboard(payload.code);
  if (!res.ok) fail(`clipboard write failed: ${res.error}`);

  if (question) await markAnswered(sig);

  if (args.toast !== false) await toast(TITLES.main, MESSAGES.ready());
  beep();

  print({
    ok: true,
    sig,
    lang: resolved.lang,
    langSource: resolved.source,
    mode: payload.mode,
    spliced: payload.spliced,
    methodHeader: payload.header,
    scaffoldFound,
    chars: res.chars,
  });
}

/**
 * Resolve a browser to work against, without assuming we launched it.
 *
 * Order:
 *   1. --port / AA_PORT, if that port already answers
 *   2. any known debugging port that already answers (an existing Chrome)
 *   3. --daily: launch the user's everyday profile (all logins present)
 *   4. otherwise: launch the private automation profile
 *
 * Returns { port, mode, reused, headless }.
 */
async function resolveBrowser(args) {
  const explicitPort = args.port ? Number(args.port) : (process.env.AA_PORT ? Number(process.env.AA_PORT) : null);

  if (explicitPort) {
    try {
      await cdpJson(explicitPort, '/json/version', { timeoutMs: 800 });
      return { port: explicitPort, mode: 'attached', reused: true, headless: null };
    } catch {
      // Fall through: the caller may still want us to start on that port.
    }
  }

  if (args.attach !== false) {
    const found = await findAttachable({ ports: explicitPort ? [explicitPort] : ATTACH_PORTS });
    if (found) {
      log(`attached to the browser already running on port ${found.port}`);
      return { port: found.port, mode: 'attached', reused: true, headless: null };
    }
  }

  if (args.daily) {
    const info = await launchDailyProfile({ port: explicitPort ?? 9222 });
    log(`started Chrome with your everyday profile on port ${info.port}`);
    return { port: info.port, mode: 'daily', reused: false, headless: false };
  }

  // A window is required whenever the operator must open the page themselves:
  // no target URL means there is nothing to navigate to, and a headless browser
  // would be unreachable.
  const needWindow = Boolean(args.show) || !(args.url ?? args._[0]);
  const info = await ensureChrome({ headless: !needWindow, port: explicitPort });
  return {
    port: info.port,
    mode: 'private',
    reused: info.reused,
    headless: info.headless ?? !needWindow,
  };
}

async function cmdAttach(args) {
  const found = await findAttachable({ ports: args.port ? [Number(args.port)] : ATTACH_PORTS });
  if (!found) {
    print({
      ok: false,
      reason: 'no-browser-with-debug-port',
      hint: 'Start Chrome/Edge with --remote-debugging-port=9222, or run: aa.mjs watch --daily',
      probedPorts: args.port ? [Number(args.port)] : ATTACH_PORTS,
    });
    process.exitCode = 2;
    return;
  }

  const { cdp, targetUrl, pageCount } = await attachPage({ port: found.port, timeoutMs: 10000 });
  const q = await extractQuestion(cdp).catch(() => null);
  const cls = q ? classifyPage(q) : null;
  cdp.close();

  // The CDP handshake reports the browser name, so we can say which one it is.
  const ua = found.version['User-Agent'] ?? '';
  const browserName = /Edg\//.test(ua) ? 'Microsoft Edge'
    : /Chrome\//.test(ua) ? 'Google Chrome'
      : (found.version.Browser ?? 'unknown');

  print({
    ok: true,
    port: found.port,
    browser: browserName,
    version: found.version.Browser,
    pageCount,
    currentPage: targetUrl,
    question: q ? {
      heading: q.heading,
      lang: q.lang,
      editorKind: q.editorKind,
      bodyLength: q.bodyLength,
      samples: q.samples?.length ?? 0,
      isQuestion: cls?.isQuestion ?? null,
      score: cls?.score ?? null,
    } : null,
  });
}

async function cmdBrowsers() {
  const installed = findBrowsers();
  const attachable = await findAttachable();
  const state = await readState();

  print({
    ok: true,
    installed: installed.map((b) => ({ id: b.id, label: b.label, path: b.path })),
    preferred: installed[0]?.id ?? null,
    forcedBy: process.env.AA_BROWSER ?? null,
    attachable: attachable ? { port: attachable.port, browser: attachable.version.Browser } : null,
    running: state ? { port: state.port, mode: state.mode ?? 'private', browser: state.browserLabel ?? null } : null,
  });
}

/**
 * Desktop capture watch: no browser, no CDP, no debug port.
 *
 * Press the hotkey -> the screen is captured -> notification #1 -> the answerer
 * (agent or the operator) reads the picture and writes `answers/<sig>.<ext>` ->
 * that file lands on the clipboard -> notification #2.
 *
 * This is the most portable mode: it works with any browser, any viewer, any
 * application, and never opens a window of its own.
 */
/**
 * Ensure only one watcher is listening at a time.
 *
 * Every watcher reacts to the same hotkey, so leaving an old one alive means one
 * keypress fires two notifications — and if the stale copy predates `--no-toast`,
 * the user sees popups they explicitly turned off. Starting a watcher therefore
 * replaces any previous one instead of competing with it.
 */
async function claimSingleInstance() {
  const lockFile = path.join(APP_DIR, 'watch.pid');

  // The PID file only knows about the last clean start. Strays survive a killed
  // terminal, a crashed run, or an older build — and every stray answers the
  // same hotkey, which is exactly how one keypress ends up firing several
  // notifications. Sweep the process table rather than trust the lock file.
  try {
    const { execFileSync } = await import('node:child_process');
    const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" `
      + `| Where-Object { $_.CommandLine -like '*aa.mjs*watch*' -and $_.CommandLine -notlike '*stop-watch*' -and $_.ProcessId -ne ${process.pid} } `
      + `| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch { /* best effort; the lock file below still applies */ }

  // Listeners orphaned by a previous instance would keep polling the keyboard
  // alongside the one we are about to start. At this point this process has not
  // spawned its own yet, so every match belongs to an older watcher.
  await killHotkeyListeners();

  await mkdir(APP_DIR, { recursive: true });
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');

  const release = async () => {
    try {
      const cur = JSON.parse(await readFile(lockFile, 'utf8'));
      if (cur?.pid === process.pid) await rm(lockFile, { force: true });
    } catch { /* nothing to release */ }
  };
  process.on('exit', () => { release().catch(() => {}); });
  return release;
}

async function cmdWatchDesktop(args, { clipDelay = 3, hotkeyCombo = 'CTRL+ALT+J' } = {}) {
  JSONL = true;
  await claimSingleInstance();

  const answersDir = path.join(APP_DIR, 'answers');
  await mkdir(answersDir, { recursive: true });

  const answerTimeoutMs = Number(args['answer-timeout'] || 600) * 1000;

  // Silent mode: no toast and no beep. The operator watches the clipboard
  // instead of the screen, so every popup is noise.
  const silent = Boolean(args['no-toast'] || args.silent);
  const ping = async (msg) => {
    if (silent) return;
    await toast(TITLES.main, msg);
    beep();
  };

  // Auto-solve deadline: the model must answer inside this window, otherwise the
  // request is abandoned rather than left hanging.
  const deadlineSec = args.deadline === undefined ? null : Number(args.deadline);

  // Preflight: starting a silent watcher without a key would fail invisibly on
  // the first keypress — in silent mode there is no toast to say so. Refuse at
  // startup instead, where the console still shows the reason.
  if (args.auto) {
    const pre = await loadSolverConfig({
      model: args.model,
      baseUrl: args['api-base'],
      apiKey: args['api-key'],
    });
    if (!pre.apiKey) {
      fail('auto mode needs an API key: run "aa.mjs setup --api-key <key>" (or pass --api-key)', {
        configFile: (await import('./lib/vision-solver.mjs')).SOLVER_CONFIG,
      });
    }
    log(`auto solver ready: ${pre.model} @ ${pre.baseUrl}`);
  }

  let handled = 0;
  let seq = 0;

  // Generation guard. Every press bumps this; a request carries the value it
  // was created with. Anything whose generation is stale — a slow model call,
  // a pending clipboard retry — must not touch the clipboard afterwards.
  // Without this, retrying a failed copy could drop the PREVIOUS question's
  // answer onto the clipboard after the operator already moved on, and they
  // would paste the wrong solution.
  let generation = 0;
  const isStale = (entry) => entry.gen !== generation;

  /** sig -> { sig, gen, file, at, copied, claimed, failures, nextAt } */
  const pending = new Map();

  // Clipboard retries: the Windows clipboard is a single-owner resource, so a
  // write fails with CLIPBRD_E_CANT_OPEN while another program holds it. That
  // is transient, so retry on a backoff instead of dropping the answer.
  const CLIP_MAX_ATTEMPTS = 10;
  const clipBackoffMs = (n) => (n <= 3 ? 1000 * 2 ** (n - 1) : 30000);

  /**
   * Capture the screen and register a pending answer slot.
   *
   * Each press gets its OWN identity. A screenshot carries no question text at
   * this layer, so the previous version — which fed an empty heading/body into
   * the fuzzy matcher — made every capture look like the same question and the
   * notification cap swallowed all but the first.
   */
  const captureOnce = async () => {
    seq += 1;
    generation += 1;
    const myGen = generation;
    const sigLocal = `d${Date.now().toString(16)}x${seq}`;

    // A new press means "this is the question I am looking at now". Anything
    // still queued from an earlier press is obsolete: drop it before it can
    // overwrite the clipboard later. Its answer file, if any, stays on disk.
    for (const older of [...pending.values()]) {
      if (older.gen === myGen) continue;
      pending.delete(older.sig);
      print({ event: 'superseded', sig: older.sig, by: sigLocal });
      log(`superseded ${older.sig} (a newer capture replaced it)`);
    }

    try {
      const shot = await captureScreen({ foreground: Boolean(args.foreground) });
      if (!shot.ok) {
        print({ event: 'capture-failed', error: shot.error });
        return;
      }

      // Empty the clipboard before solving.
      //
      // The answer arrives 10-25s later, and the natural mistake is to press
      // Ctrl+V too early — which pastes the PREVIOUS answer (or whatever was
      // copied before) and looks like the tool produced wrong code. An empty
      // clipboard makes an early paste do nothing, which is an honest signal
      // that the answer is not ready yet.
      if (!args['keep-clipboard']) {
        const cleared = await clearClipboard();
        print({ event: 'clipboard-cleared', ok: cleared.ok, error: cleared.error ?? null, sig: sigLocal });
      }

      pending.set(sigLocal, {
        sig: sigLocal,
        gen: myGen,
        file: shot.file,
        at: Date.now(),
        copied: false,
        claimed: false,
        failures: 0,
        nextAt: 0,
      });

      print({
        event: 'vision-request',
        sig: sigLocal,
        gen: myGen,
        source: 'desktop',
        screenshot: shot.file,
        width: shot.width,
        height: shot.height,
        notify: !silent,
        notifyCount: silent ? 0 : 1,
        hint: `write the answer to ${path.join(answersDir, `${sigLocal}.java`)} (or .py/.cpp)`,
      });

      // Silence is a feature here: the operator watches the clipboard, not the
      // screen, so a popup per press would just be in the way.
      await ping(MESSAGES.detected());

      // Auto-solve: hand the screenshot to the vision model and drop the result
      // where the poller will find it. This is what removes the manual step.
      if (args.auto) {
        solveInBackground(sigLocal, shot.file, myGen);
      }
    } catch (err) {
      log(`capture error: ${err.message}`);
    }
  };

  /**
   * Run the vision solver for one capture and write the answer file.
   *
   * Deliberately not awaited: a slow model must not block the next keypress.
   */
  const solveInBackground = (sigLocal, imagePath, myGen) => {
    (async () => {
      const started = Date.now();
      const cfg = await loadSolverConfig({
        model: args.model,
        baseUrl: args['api-base'],
        apiKey: args['api-key'],
      });

      // Enforce the deadline at the transport level so a stalled connection
      // cannot hold the slot past the window the operator was promised. The
      // budget covers ALL retry attempts together, not each one.
      if (deadlineSec) {
        cfg.timeoutMs = Math.min(Number(cfg.timeoutMs) || 120000, deadlineSec * 1000);
        cfg.budgetMs = deadlineSec * 1000;
      }

      const r = await solveAndVerify({
        imagePath,
        config: cfg,
        extra: args.lang ? `请用 ${args.lang} 作答。` : '',
        maxSolveAttempts: args['verify-attempts'] === undefined ? 3 : Number(args['verify-attempts']),
        onRetry: (info) => {
          print({
            event: 'solve-retry',
            sig: sigLocal,
            attempt: info.attempt,
            error: (info.error ?? '').slice(0, 120),
            waitMs: info.waitMs,
          });
          log(`gateway busy (${(info.error ?? '?').slice(0, 60)}); retry #${info.attempt} in ${info.waitMs}ms`);
        },
        onVerify: (info) => {
          print({
            event: 'verify-result',
            sig: sigLocal,
            attempt: info.attempt,
            lang: info.lang,
            ok: info.result.ok,
            samples: (info.result.results ?? []).length,
            reason: info.result.reason ?? null,
          });
          if (!info.result.ok) {
            for (const bad of (info.result.results ?? []).filter((x) => !x.ok).slice(0, 2)) {
              log(`sample ${bad.index} mismatch: expected ${JSON.stringify(bad.expected)} got ${JSON.stringify(bad.actual)}`);
            }
          }
        },
        onSolveRetry: (info) => {
          print({ event: 'answer-retry', sig: sigLocal, attempt: info.attempt });
          log(`answer failed verification; asking again (${info.attempt})`);
        },
      });

      if (!r.ok) {
        print({
          event: 'solve-failed',
          sig: sigLocal,
          error: r.error,
          ms: r.ms,
          attempts: r.attempts ?? 1,
        });
        pending.delete(sigLocal);
        return;
      }

      // A checkable answer that failed its samples is not delivered at all.
      // The clipboard stays empty, which is the honest signal that this
      // question could not be answered — better than pasting plausible code
      // that the judge will reject.
      if (r.checkable && !r.verified) {
        print({
          event: 'answer-rejected',
          sig: sigLocal,
          reason: r.verifyReason,
          solveAttempts: r.solveAttempts ?? null,
          sampleResults: (r.verifyResults ?? []).map((x) => ({
            index: x.index, ok: x.ok, expected: x.expected, actual: x.actual,
          })),
        });
        log(`rejected: ${r.verifyReason} — nothing was put on the clipboard`);
        pending.delete(sigLocal);
        return;
      }

      const lang = args.lang ?? guessLanguage(r.code);
      const ext = (EXTENSIONS[lang] && EXTENSIONS[lang][0]) || '.java';
      const out = path.join(answersDir, `${sigLocal}${ext}`);

      // Write even when superseded: the file costs nothing and is the only
      // backup if the operator decides they want that question after all.
      await writeFile(out, r.code, 'utf8');

      const stale = myGen !== generation;
      print({
        event: 'solve-ready',
        sig: sigLocal,
        gen: myGen,
        stale,
        model: r.model,
        lang,
        chars: r.code.length,
        verified: r.verified === true,
        verifyReason: r.verifyReason ?? null,
        solveAttempts: r.solveAttempts ?? null,
        file: out,
        ms: r.ms ?? Date.now() - started,
        usage: r.usage ?? null,
      });

      if (stale) {
        pending.delete(sigLocal);
        log(`answer for ${sigLocal} kept on disk but not delivered (newer capture won)`);
      }
    })().catch((err) => {
      print({ event: 'solve-failed', sig: sigLocal, error: err.message });
      pending.delete(sigLocal);
    });
  };

  /**
   * Watch the answer folder without blocking the hotkey.
   *
   * The capture path must stay responsive: blocking here is what made later
   * J+K presses report "still busy" while the first one waited for its answer.
   */
  const pollAnswers = async () => {
    for (const entry of [...pending.values()]) {
      // Claim before the first await: copying takes ~1s (PowerShell), and the
      // poller can tick again during that time. Without the claim the same
      // answer is copied twice, producing duplicate notifications.
      if (entry.copied || entry.claimed) continue;

      // A newer press happened while this one was in flight. Dropping it here
      // is what keeps a stale answer off the clipboard.
      if (isStale(entry)) {
        pending.delete(entry.sig);
        print({ event: 'superseded', sig: entry.sig });
        log(`dropped ${entry.sig}: superseded by a newer capture`);
        continue;
      }

      // Still inside the backoff window after a failed clipboard write.
      if (Date.now() < (entry.nextAt ?? 0)) continue;

      let file = null;
      for (const ext of ['.java', '.py', '.cpp', '.js', '.go', '.cs', '.txt']) {
        const p = path.join(answersDir, `${entry.sig}${ext}`);
        if (existsSync(p)) { file = p; break; }
      }

      if (file) {
        entry.claimed = true;
        try {
          const code = await readFile(file, 'utf8');
          if (clipDelay > 0) await new Promise((r) => setTimeout(r, clipDelay * 1000));

          // Re-check after the delay: the operator may have pressed again
          // while we were waiting, and the clipboard must not be touched then.
          if (isStale(entry)) {
            entry.claimed = false;
            pending.delete(entry.sig);
            print({ event: 'superseded', sig: entry.sig });
            continue;
          }

          const res = await copyToClipboard(code);

          if (!res.ok) {
            // Do NOT dequeue on failure: keep the entry and try again. The
            // Windows clipboard is single-owner, so this is usually transient.
            entry.claimed = false;
            entry.failures = (entry.failures ?? 0) + 1;
            const wait = clipBackoffMs(entry.failures);

            if (entry.failures >= CLIP_MAX_ATTEMPTS) {
              entry.copied = true;
              pending.delete(entry.sig);
              print({
                event: 'clipboard-failed',
                sig: entry.sig,
                attempts: entry.failures,
                error: res.error ?? null,
                answerFile: file,
                recover: `node aa.mjs clip --file "${file}"`,
              });
              log(`gave up on ${entry.sig} after ${entry.failures} attempts: ${res.error ?? 'unknown'}`);
              log(`the code is still on disk: ${file}`);
              log(`recover with: node aa.mjs clip --file "${file}"`);
            } else {
              entry.nextAt = Date.now() + wait;
              print({
                event: 'clipboard-retry',
                sig: entry.sig,
                attempt: entry.failures,
                error: res.error ?? null,
                nextInMs: wait,
              });
              log(`clipboard busy (${res.error ?? 'unknown'}); retry #${entry.failures} in ${wait}ms`);
            }
            continue;
          }

          entry.copied = true;
          pending.delete(entry.sig);

          print({
            event: 'clipboard-copied',
            sig: entry.sig,
            ok: true,
            chars: res.chars ?? null,
            answerFile: file,
            attempts: (entry.failures ?? 0) + 1,
          });

          await ping(MESSAGES.ready());
          handled += 1;
          if (handled >= (args.max ? Number(args.max) : Infinity)) {
            log('reached --max, stopping');
            process.exit(0);
          }
        } catch (err) {
          // Release the claim so a later tick can retry the copy.
          entry.claimed = false;
          log(`copy error: ${err.message}`);
        }
        continue;
      }

      if (Date.now() - entry.at > answerTimeoutMs) {
        pending.delete(entry.sig);
        print({ event: 'vision-timeout', sig: entry.sig });
      }
    }
  };

  const poller = setInterval(() => {
    pollAnswers().catch((e) => log(`poller error: ${e.message}`));
  }, 1000);

  let stopTrigger = null;

  if (args['trigger-file']) {
    const { watchTriggerFile } = await import('./lib/screen.mjs');
    stopTrigger = watchTriggerFile(String(args['trigger-file']), () => {
      print({ event: 'hotkey', combo: 'file-trigger' });
      captureOnce();
    }).stop;
    log(`desktop capture armed — write to ${args['trigger-file']} to capture`);
  } else {
    const hk = startHotkey(hotkeyCombo, () => {
      captureOnce();
    }, {
      log,
      // If the listener cannot be kept alive, stop rather than keep a process
      // that looks healthy but answers nothing. The log records why.
      onDead: (reason) => {
        print({ event: 'hotkey-dead', reason });
        clearInterval(poller);
        log('stopping: a watcher whose hotkey is dead would fail silently');
        process.exit(4);
      },
    });
    stopTrigger = hk.stop;
    log(`desktop capture armed — press ${hotkeyCombo} to capture the screen`);
  }

  const shutdown = () => {
    log('shutting down');
    clearInterval(poller);
    if (stopTrigger) stopTrigger();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

/**
 * Save solver credentials so `--auto` can run without flags.
 *
 * The key goes to a file under %LOCALAPPDATA% rather than onto every command
 * line, where it would end up in shell history.
 */
async function cmdSetup(args) {
  const { SOLVER_CONFIG } = await import('./lib/vision-solver.mjs');
  const cfg = {
    baseUrl: args['api-base'] ?? 'https://api.openai.com/v1',
    apiKey: args['api-key'] ?? null,
    model: args.model ?? 'gpt-4o',
    timeoutMs: 120000,
    maxTokens: 4096,
    temperature: 0.1,
  };

  if (!cfg.apiKey) fail('setup requires --api-key <key>');

  // Validate the model against the gateway before saving. A wrong id is the
  // most common mistake and only surfaces later as a 404 in the middle of a
  // capture, where it is much harder to diagnose.
  let available = null;
  let modelOk = null;
  try {
    const res = await fetch(`${String(cfg.baseUrl).replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = await res.json();
      available = (json.data ?? []).map((m) => m.id);
      modelOk = available.includes(cfg.model);
    }
  } catch { /* offline, or the endpoint has no /models — skip validation */ }

  if (modelOk === false) {
    print({
      ok: false,
      error: `model "${cfg.model}" is not available on this endpoint`,
      availableModels: available,
      hint: 'pick one of availableModels and run setup again',
    });
    process.exitCode = 2;
    return;
  }

  await mkdir(APP_DIR, { recursive: true });
  await writeFile(SOLVER_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');

  print({
    ok: true,
    saved: SOLVER_CONFIG,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    modelVerified: modelOk,
    availableModels: available,
    keyLength: String(cfg.apiKey).length,
    next: 'node aa.mjs watch --desktop --auto',
  });
}

async function cmdSolvers() {
  const { loadSolverConfig, SOLVER_CONFIG } = await import('./lib/vision-solver.mjs');
  const cfg = await loadSolverConfig();
  print({
    ok: true,
    configFile: SOLVER_CONFIG,
    configured: Boolean(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    keyPresent: Boolean(cfg.apiKey),
    keyLength: cfg.apiKey ? String(cfg.apiKey).length : 0,
  });
}

async function cmdWatch(args) {
  JSONL = true;
  const dryRun = Boolean(args['dry-run']);
  const solver = args.solver ?? 'agent';
  const max = args.max ? Number(args.max) : Infinity;
  const answersDir = path.join(APP_DIR, 'answers');
  await mkdir(answersDir, { recursive: true });

  // --clip: detect a question, notify, wait, copy the answer to the clipboard
  // so the operator pastes it by hand.
  let clipMode = Boolean(args.clip);
  // In hotkey mode the default gap is 3s: press J+K, get the "recognised" toast,
  // then three seconds later the "answer is on the clipboard" toast.
  const clipDelayDefault = args.hotkey !== undefined || process.env.AA_HOTKEY ? 3 : 5;
  const clipDelay = args['clip-delay'] === undefined
    ? clipDelayDefault
    : Number(args['clip-delay']);

  // --queue: detect and persist the question, then stop. No answer needed here;
  // the agent solves it later and `aa.mjs solve` pushes the result to the
  // clipboard. This is the mode for "just tell me the question, I'll answer it".
  const queueMode = Boolean(args.queue);

  // --vision: recognise by screenshot only. The DOM is never trusted for the
  // statement, which makes the flow work on any site, including ones where the
  // editor lives in a frame or the statement is drawn to a canvas.
  const visionMode = Boolean(args.vision);

  // --desktop: capture the screen itself. No browser is started and no debug
  // port is needed, so it works with whatever the operator already has open —
  // Chrome, Edge, a PDF, an image, anything.
  if (args.desktop) {
    const combo = args.hotkey === undefined
      ? (process.env.AA_HOTKEY || 'CTRL+ALT+J')
      : (args.hotkey === true ? 'CTRL+ALT+J' : String(args.hotkey));
    return cmdWatchDesktop(args, { clipDelay, hotkeyCombo: combo });
  }

  const url = args.url ?? args._[0] ?? null;

  // Prefer a browser that is already running: the operator's own Chrome, with
  // their logins and their tabs. Only start one when nothing is attachable.
  const browser = await resolveBrowser(args);
  const { cdp, targetUrl } = await attachPage({ port: browser.port, url, timeoutMs: DEFAULT_NAV_TIMEOUT });

  log(`watching on port ${browser.port} (${browser.mode}${dryRun ? ', dry-run' : ''}), solver=${solver}`);
  if (clipDelay > 0 && clipMode) log(`clipboard mode: ${clipDelay}s after each detected answer`);
  if (dryRun) log('switch questions now; each detection prints one JSON line');
  if (!url) log(`reading whichever tab is in front (now: ${targetUrl ?? 'about:blank'})`);

  // Hotkey gating: with `--hotkey J+K` (the default in the desktop launcher),
  // detection only runs when the operator presses the combo. Automatic DOM
  // watching is disabled in that mode, so ordinary browsing never triggers it.
  const hotkeyCombo = args.hotkey === undefined
    ? (process.env.AA_HOTKEY || null)
    : (args.hotkey === true ? 'CTRL+ALT+J' : String(args.hotkey));

  // In hotkey mode, "detect and hand me the answer" is the whole point, so
  // clipboard delivery is on unless the caller explicitly chose otherwise.
  // Vision mode runs its own copy step, so it is excluded here.
  if (hotkeyCombo && !clipMode && !queueMode && !dryRun && !visionMode) {
    clipMode = true;
  }

  const seen = new Map();      // sig -> timestamp of last SUCCESSFUL handling
  const DEDUPE_MS = 10 * 60 * 1000;

  // Identity tracking decides "same question or a new one", and enforces the
  // notification cap: at most `maxNotify` toasts per question, spaced at least
  // one minute apart.
  //
  // Counts are persisted so restarting watch does not hand every question a
  // fresh quota — that would break "at most 2 per question" across restarts.
  const maxNotify = args['max-notify'] === undefined ? 2 : Number(args['max-notify']);
  const renotifyDelay = Number(args['renotify-delay'] || 60000);
  const savedTracker = args['reset-notify'] ? null : await loadTrackerState();
  const tracker = QuestionTracker.fromJSON(savedTracker, {
    maxNotifications: maxNotify,
    minReNotifyMs: renotifyDelay,
  });
  if (savedTracker) log(`restored ${tracker.history.length} known question(s)`);

  // Persist after every decision, cheaply and without blocking the pipeline.
  let savePending = false;
  const persistTracker = () => {
    if (savePending) return;
    savePending = true;
    setTimeout(() => {
      savePending = false;
      saveTrackerState(tracker.toJSON()).catch(() => {});
    }, 300);
  };

  let handled = 0;
  let consecutiveFailures = 0;
  let busy = false;

  /**
   * Process one question. Split out from `handle` so a retry can re-run the
   * answer half without re-announcing the question (which would fire a second
   * toast and break "one detection, one notification").
   *
   * @param {object} q        extracted question
   * @param {number} since    answer files must be newer than this
   * @param {boolean} announce whether this is a fresh detection
   * @returns {Promise<{retry?:string, done?:boolean}>}
   */
  const processQuestion = async (q, since, announce) => {
    const d = diagnose(q);

    // Is this page a coding question the heuristics recognise?
    const page = classifyPage(q);

    // Vision mode: always capture, never depend on the DOM.
    //
    // Pressing J+K means "look at my screen". Screenshot recognition is immune
    // to editor frames, canvas-rendered statements, and layouts the heuristics
    // have never seen, so in this mode the picture IS the input.
    if (announce && visionMode) {
      let shot = null;
      let bytes = 0;
      try {
        const grabbed = await grabPage(cdp, { fullPage: true, name: `vision-${q.sig}` });
        shot = grabbed.file;
        bytes = grabbed.bytes ?? 0;
      } catch (err) {
        log(`screenshot failed: ${err.message}`);
      }

      const verdict = tracker.observe(q);
      persistTracker();

      // The question is persisted so the answerer can pick it up with `pending`.
      await enqueue(q);

      print({
        event: 'vision-request',
        sig: q.sig,
        url: q.url,
        title: q.title,
        heading: q.heading,
        lang: q.lang,
        editorKind: q.editorKind,
        screenshot: shot,
        screenshotBytes: bytes,
        text: q.body ? q.body.slice(0, 20000) : null,
        notify: verdict.notify,
        notifyCount: verdict.count,
      });

      if (verdict.notify) {
        await toast(TITLES.main, MESSAGES.detected());
        beep();
      }

      // Wait for the answer, then land it on the clipboard and ping again.
      const answerFile = await waitForAnswerFile(
        answersDir, q.sig, Number(args['answer-timeout'] || 600), null, Date.now() - 1000,
      );

      if (!answerFile) {
        print({ event: 'vision-timeout', sig: q.sig, hint: 'no answer file written in time' });
        return { retry: q.sig };
      }

      const code = await readFile(answerFile, 'utf8');
      const res = await copyToClipboard(code);
      print({
        event: 'clipboard-copied',
        sig: q.sig,
        ok: res.ok,
        chars: res.chars ?? null,
        answerFile,
      });

      if (res.ok) {
        await toast(TITLES.main, MESSAGES.ready());
        beep();
        seen.set(q.sig, Date.now());
        handled++;
        return { done: true };
      }
      return { retry: q.sig };
    }

    if (announce && !page.isQuestion) {
      // Automatic watching must stay silent on ordinary pages: the DOM observer
      // fires on every list page, profile and dialog, and notifying there is
      // noise. Only an explicit hotkey press earns a look.
      if (!hotkeyCombo) {
        print({
          event: 'not-a-question',
          sig: q.sig,
          url: q.url,
          heading: q.heading,
          editorKind: q.editorKind,
          bodyLength: q.bodyLength,
          reason: page.reason,
          score: page.score,
          signals: page.signals,
        });
        return { done: true };
      }

      // Hotkey pressed: the operator asked us to look, so capture the page
      // instead of giving up. "Not recognised" is not "not a question" — the
      // editor may be in a cross-origin frame, the statement may be a canvas or
      // an image, or the layout may be unlike anything the heuristics know. A
      // picture still carries the question, and the reader can use it.
      let shot = null;
      let domText = null;
      try {
        const grabbed = await grabPage(cdp, { fullPage: true, name: `fallback-${q.sig}` });
        shot = grabbed.file;
        domText = grabbed.dom?.text ?? null;
      } catch (err) {
        log(`screenshot fallback failed: ${err.message}`);
      }

      // Still notify: the operator pressed the key and expects a response.
      const verdict = tracker.observe(q);
      persistTracker();

      print({
        event: 'page-captured',
        sig: q.sig,
        url: q.url,
        heading: q.heading,
        editorKind: q.editorKind,
        bodyLength: q.bodyLength,
        reason: page.reason,
        score: page.score,
        signals: page.signals,
        notify: verdict.notify,
        notifyCount: verdict.count,
        screenshot: shot,
        text: domText ? domText.slice(0, 20000) : null,
      });

      if (verdict.notify) {
        await toast(TITLES.main, MESSAGES.detected());
        beep();
      }
      return { done: true };
    }

    // Decide identity before doing anything: is this the question we already
    // know, or a genuinely new one? A cosmetic re-render must not be treated as
    // a switch, and no question may notify more than `maxNotify` times.
    const verdict = announce ? tracker.observe(q) : null;
    if (verdict) persistTracker();

    if (announce) {
      print({
        event: 'question-detected',
        reason: verdict.isNew ? 'new-question' : 'same-question',
        sig: q.sig,
        isNew: verdict.isNew,
        notify: verdict.notify,
        notifyCount: verdict.count,
        notifyReasons: verdict.reasons,
        pageScore: page.score,
        url: q.url,
        heading: q.heading,
        lang: q.lang,
        editorKind: q.editorKind,
        bodyLength: q.bodyLength,
        langOptions: q.langOptions,
        ok: d.ok,
        ...(d.ok ? {} : { reasonDetail: d.reason, hint: d.hint }),
        body: q.body,
        samples: q.samples,
        samplePairs: q.samplePairs,
      });
    }

    if (!d.ok || dryRun) return { done: true };
    if (handled >= max) {
      log(`reached --max ${max}, stopping`);
      cdp.close();
      process.exit(0);
    }

    // Notify only when the tracker allows it: first sighting, or a re-sighting
    // at least a minute later, capped at `maxNotify` per question. A re-render
    // of the current question therefore stays silent.
    //
    // In hotkey mode the two notifications mean different things:
    //   #1 — the question was recognised (fires immediately on J+K)
    //   #2 — the answer is on the clipboard (fires after the copy)
    const twoPhase = Boolean(hotkeyCombo);
    const firstToastAllowed = Boolean((clipMode || queueMode) && announce && verdict?.notify);

    if (firstToastAllowed) {
      await toast(TITLES.main, MESSAGES.detected());
      beep();
    }

    // Always persist the question, in every mode. The agent needs to read it
    // afterwards via `pending` to write the answer — a hotkey detection that is
    // not queued is unreachable, which breaks the whole loop.
    if (announce) {
      await enqueue(q);
      print({
        event: 'queued',
        sig: q.sig,
        heading: q.heading,
        lang: q.lang,
        editorKind: q.editorKind,
        bodyLength: q.bodyLength,
        samples: q.samples?.length ?? 0,
        file: path.join(QUEUE_DIR, `${q.sig}.json`),
      });
    }

    // Queue mode ends here: the question is already persisted above, and the
    // agent will solve it later via `pending` / `solve`.
    if (queueMode) {
      seen.set(q.sig, Date.now());
      handled++;
      return { done: true };
    }

    // The language detected on the question wins, always: whatever the page
    // says the problem is written in is what the pasted answer must be in.
    // --lang is only a fallback for pages with no language selector at all.
    const detectedLang = normalizeLang(q.lang);
    const resolved = detectedLang
      ? { lang: detectedLang, source: 'page-selector' }
      : resolveLang({
        explicit: args.lang,
        file: null,
        pageLang: null,
        fallback: process.env.AA_DEFAULT_LANG || 'python',
      });

    let code = null;
    let answerFile = null;

    if (solver === 'agent') {
      // Wait for answers/<sig>.<ext>; the detected language's extension is
      // tried first so a .java never loses to a stale .py from an earlier run.
      const found = await waitForAnswerFile(
        answersDir, q.sig, Number(args['answer-timeout'] || 180), resolved.lang, since,
      );
      if (!found) {
        log(`no answer file for sig ${q.sig} within timeout; will retry`);
        return { retry: q.sig };
      }

      // The answer's language must match the language detected on the page.
      // Copying Python into a page that selected Java is never what anyone wants.
      const answerLang = langFromFile(found);
      if (answerLang && resolved.lang && answerLang !== resolved.lang) {
        log(
          `answer file is ${answerLang} but the question is ${resolved.lang}; `
          + `rename it to ${q.sig}${EXTENSIONS[resolved.lang]?.[0] ?? ''} — will retry`,
        );
        print({
          event: 'language-mismatch',
          sig: q.sig,
          expected: resolved.lang,
          found: answerLang,
          file: found,
        });
        return { retry: q.sig };
      }

      answerFile = found;
      code = await readFile(found, 'utf8');
    } else if (solver === 'template') {
      code = templateFor(q, resolved.lang);
      if (!code) { log('no template matched; skipping'); return { done: true }; }
    } else {
      code = await runSolverCommand(solver, q);
      if (!code) { log('solver returned no code; skipping'); return { done: true }; }
    }

    // ---- clipboard mode: wait, copy. The first toast already fired above.
    if (clipMode) {
      print({
        event: 'clipboard-pending',
        sig: q.sig,
        delaySec: clipDelay,
        lang: resolved.lang,
        langSource: resolved.source,
        retry: !announce,
      });

      await new Promise((r) => setTimeout(r, clipDelay * 1000));

      const res = await copyToClipboard(code);
      print({
        event: 'clipboard-copied',
        sig: q.sig,
        ok: res.ok,
        chars: res.chars ?? null,
        lang: resolved.lang,
        langSource: resolved.source,
        answerFile,
        error: res.error ?? null,
      });

      if (!res.ok) return { retry: q.sig };
      seen.set(q.sig, Date.now());
      handled++;

      // Second notification: the answer is now on the clipboard. This is the
      // operator's cue to press Ctrl+V, so it must follow the copy, not the
      // detection.
      if (twoPhase && firstToastAllowed) {
        await toast(TITLES.main, MESSAGES.ready());
        beep();
      }

      return { done: true };
    }

    // Switch the page's language selector before writing: the editor often
    // resets on switch, so it must happen before injection, not after.
    let langSwitch = null;
    if (q.langOptions?.length && resolved.lang) {
      langSwitch = await switchLanguage(cdp, resolved.lang);
      if (langSwitch.ok && langSwitch.switched) {
        log(`language switched: ${langSwitch.before} -> ${langSwitch.after}`);
      }
    }

    await mute(cdp).catch(() => {});
    // Same scaffold handling as `answer`: read the stub after any language
    // switch, then splice or replace depending on the mode.
    const stubText = args['no-merge'] ? '' : await currentEditorText(cdp);
    const payload = buildPayload(stubText, code, resolved.lang);
    const result = await writeCode(cdp, payload.code, { retries: Number(args.retries || 3), log });
    await unmute(cdp).catch(() => {});

    print({
      event: 'injected',
      sig: q.sig,
      ok: result.ok,
      editor: result.editor,
      chars: result.chars ?? null,
      mode: payload.mode,
      spliced: payload.spliced,
      methodHeader: payload.header,
      lang: resolved.lang,
      langSource: resolved.source,
      langSwitch,
      answerFile,
      diff: result.diff ?? null,
    });

    if (!result.ok) return { retry: q.sig };

    seen.set(q.sig, Date.now());
    handled++;

    if (args['auto-submit']) {
      const submit = await cdp.evaluate(`(() => {
        const want = /提交|submit/i;
        const el = [...document.querySelectorAll('button,input[type=submit],a')]
          .find((n) => want.test((n.innerText || n.value || '').trim()));
        if (!el) return { ok: false, reason: 'submit-not-found' };
        el.click();
        return { ok: true };
      })()`);
      print({ event: 'submit', ...submit });
    }
    return { done: true };
  };

  const retryQueue = new Map();   // sig -> timer

  function scheduleRetry(sig) {
    if (retryQueue.has(sig)) return;
    const delay = Number(args['retry-delay'] || 3000);
    log(`will retry sig ${sig} in ${delay}ms`);
    const timer = setTimeout(async () => {
      retryQueue.delete(sig);
      if (busy) { scheduleRetry(sig); return; }
      busy = true;
      try {
        const q = await extractQuestion(cdp);
        // Keep the original detection cutoff: the answer file the operator is
        // fixing was written after the question appeared, not after the retry.
        const outcome = await processQuestion(q, 0, false);
        if (outcome.retry) scheduleRetry(outcome.retry);
        else consecutiveFailures = 0;
      } catch (err) {
        log(`retry error: ${err.message}`);
      } finally {
        busy = false;
      }
    }, delay);
    retryQueue.set(sig, timer);
    if (retryQueue.size > 20) {
      const [oldest] = retryQueue.keys();
      clearTimeout(retryQueue.get(oldest));
      retryQueue.delete(oldest);
    }
  }

  const handle = async (payload) => {
    if (busy) {
      log(`event ignored (busy): ${payload?.reason ?? 'unknown'}`);
      return;
    }
    busy = true;
    let outcome = null;
    const fromHotkey = payload?.reason === 'hotkey';
    try {
      const q = await extractQuestion(cdp);

      // Dedupe on *successful handling*, not on detection: a rejected answer
      // (wrong language, timeout) must not lock the question for 10 minutes,
      // otherwise fixing the file has no effect until the window expires.
      //
      // A hotkey press is an explicit request, so it bypasses the dedupe window:
      // pressing J+K on the same question must still re-run the flow.
      if (!fromHotkey && seen.has(q.sig) && Date.now() - seen.get(q.sig) < DEDUPE_MS) {
        busy = false;
        return;
      }

      // Answer files must be newer than this detection, otherwise a leftover
      // file from a previous run would be injected for the same signature.
      outcome = await processQuestion(q, Date.now(), true);
    } catch (err) {
      log(`handler error: ${err.message}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 2) { cdp.close(); process.exit(3); }
    } finally {
      busy = false;
      if (outcome?.retry) {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          log('two consecutive failures; stopping watch');
          cdp.close();
          process.exit(3);
        }
        scheduleRetry(outcome.retry);
      }
    }
  };

  let hotkey = null;
  let triggerWatcher = null;

  if (hotkeyCombo) {
    // Hotkey mode: no DOM observer at all. Detection happens exactly when the
    // operator asks for it, so browsing the site never triggers a notification.
    hotkey = startHotkey(hotkeyCombo, () => {
      print({ event: 'hotkey', combo: hotkeyCombo });
      handle({ type: 'hotkey', reason: 'hotkey' });
    });
    log(`listening for ${hotkeyCombo} — press it to detect the current question`);
  } else if (args['trigger-file']) {
    // External trigger: any tool (AutoHotkey, a Stream Deck, a shortcut) can
    // ask for a capture by writing to a file. Also makes the flow testable
    // without a physical keypress.
    const { watchTriggerFile } = await import('./lib/shot.mjs');
    triggerWatcher = watchTriggerFile(String(args['trigger-file']), () => {
      print({ event: 'hotkey', combo: 'file-trigger' });
      handle({ type: 'hotkey', reason: 'hotkey' });
    });
    log(`watching trigger file ${args['trigger-file']} — write to it to detect`);
  } else {
    await installWatcher(cdp, (p) => { handle(p); }, { log });
    log('watching DOM changes (pass --hotkey J+K to detect on demand instead)');
  }

  // Keep the process alive until Ctrl+C or a stop condition.
  const shutdown = async () => {
    log('shutting down watch');
    if (hotkey) hotkey.stop();
    if (triggerWatcher) triggerWatcher.stop();
    cdp.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

/**
 * Wait for an answer file written *after* `since`.
 *
 * Stale files from an earlier run must never be picked up: the same question
 * keeps the same signature, so `answers/<sig>.py` left over from yesterday
 * would otherwise be injected for today's question. Files older than `since`
 * are ignored until the operator rewrites them.
 */
async function waitForAnswerFile(dir, sig, timeoutSec, lang = null, since = 0) {
  // Prefer the extension for the question's language, then everything else so a
  // mismatch can be detected and reported instead of silently timing out.
  const preferred = lang && EXTENSIONS[lang] ? EXTENSIONS[lang] : [];
  const all = Object.values(EXTENSIONS).flat();
  const exts = [...new Set([...preferred, ...all, '.txt'])];

  const { statSync } = await import('node:fs');
  const deadline = Date.now() + timeoutSec * 1000;
  let staleSeen = null;

  while (Date.now() < deadline) {
    for (const ext of exts) {
      const p = path.join(dir, sig + ext);
      if (!existsSync(p)) continue;
      const mtime = statSync(p).mtimeMs;
      // 1s tolerance for filesystem timestamp granularity.
      if (mtime + 1000 < since) { staleSeen = p; continue; }
      return p;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (staleSeen) {
    log(`ignored stale answer file ${path.basename(staleSeen)} (older than this detection)`);
  }
  return null;
}

async function runSolverCommand(cmd, q) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.trim() || null));
    child.on('error', () => resolve(null));
    child.stdin.write(JSON.stringify(q));
    child.stdin.end();
  });
}

async function cmdSelftest(args) {
  const { runSelftest } = await import('./selftest.mjs');
  const res = await runSelftest({ keep: Boolean(args.keep) });
  print(res);
  if (!res.ok) process.exitCode = 4;
}

// ---------------------------------------------------------------------- main

const COMMANDS = {
  start: cmdStart,
  status: cmdStatus,
  stop: cmdStop,
  'stop-watch': cmdStopWatch,
  login: cmdLogin,
  prepare: cmdPrepare,
  read: cmdRead,
  probe: cmdProbe,
  answer: cmdAnswer,
  clip: cmdClip,
  solve: cmdSolve,
  pending: cmdPending,
  queue: cmdQueue,
  fill: cmdFill,
  click: cmdClick,
  shot: cmdShot,
  grab: cmdGrab,
  watch: cmdWatch,
  attach: cmdAttach,
  browsers: cmdBrowsers,
  setup: cmdSetup,
  solvers: cmdSolvers,
  selftest: cmdSelftest,
};

const USAGE = `auto-answer — hidden Chrome question automation

Usage: node aa.mjs <command> [options]

Commands:
  start                 launch (or reuse) headless Chrome
  status                show instance state
  stop                  close the Chrome instance
  stop-watch            stop every running watcher (hidden or not)
  login <url>           open a visible window, you log in, cookies persist
  prepare [--url <u>]   start + navigate + extract the current question
  read                  re-read question and editor content
  probe                 report which bot-detection signals the page can see
  answer --file <p>     inject a solution and verify by read-back
  clip --file <p>       copy a solution to the clipboard (paste it yourself)
  solve --file <p>      merge into the page scaffold and copy to clipboard
  pending               show the newest detected, unanswered question
  queue [--clear]       list (or clear) the detected-question queue
  fill <text>           inject raw text (no verification loop)
  click <sel|text>      click a button by selector or visible text
  shot [--out <p>]      screenshot the page
  grab                  read anything: question, DOM text, and a screenshot
  setup                 save vision-model credentials for --auto
  solvers               show the current solver configuration
  watch                 auto-detect question changes and inject
  attach                report which browser/tab is reachable, and what is on it
  selftest              verify injection against the bundled mock page

Options:
  --show                run with a visible window (default: headless)
  --daily               use your everyday Chrome profile (all logins present)
  --no-attach           do not reuse a browser that is already running
  --port <n>            CDP port (default 9333, auto-falls back)
  --lang <name>         fallback language when the page has no selector
  --force               answer: write even if the file language differs
  --no-merge            answer/watch: replace the whole editor (ACM mode)
  --retries <n>         injection strategy retries (default 3)
  --shot <path>         capture a screenshot after answer
  --run                 (reserved) click the page's run/test button
  --submit              click the page's submit button
  --hotkey <combo>      watch: detect only when this combo is pressed (default CTRL+ALT+J)
  --vision              watch: recognise by screenshot only (any site, any layout)
  --trigger-file <p>    watch: trigger a capture when this file is written
  --desktop             watch: capture the screen; no browser, no debug port
  --auto                watch --desktop: solve the screenshot with a vision model
  --no-toast            watch --desktop: no notifications at all (silent)
  --keep-clipboard      watch --desktop: do not clear the clipboard at capture
  --verify-attempts <n> auto: re-solve when the samples fail (default 3)
  --deadline <s>        auto: abandon the solve after this many seconds
  --model <name>        auto: model id (default from solver.json)
  --api-key <key>       auto: API key (prefer solver.json or AA_API_KEY)
  --api-base <url>      auto: OpenAI-compatible base URL
  --dry-run             watch: detect only, never inject
  --queue               watch: save detected questions for pending/solve
  --clip                watch: notify, wait, then copy the answer to the clipboard
  --clip-delay <s>      watch --clip: seconds between notification and copy (default 5)
  --solver <mode>       watch: agent | template | "<command>"
  --max <n>             watch: stop after n injected answers
  --auto-submit         watch: submit after a verified injection
  --answer-timeout <s>  watch: wait this long for answers/<sig>.<ext> (default 180)
  --retry-delay <ms>    watch: retry a failed question after this delay (default 3000)
  --max-notify <n>      watch: max notifications per question (default 2)
  --renotify-delay <ms> watch: minimum gap between notifications (default 60000)
  --reset-notify        watch: forget saved notification counts and start over
  --keep                selftest: leave the browser open
`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    // Help goes to stdout: writing it to stderr makes PowerShell surface it as
    // a NativeCommandError, which looks like a failure when it is not.
    process.stdout.write(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  const cmd = argv[0];
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stdout.write(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(1);
  }
  try {
    await fn(parseArgs(argv.slice(1)));
  } catch (err) {
    print({ ok: false, error: err.message });
    process.exit(1);
  }
}

main();
