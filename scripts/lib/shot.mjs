// Screenshot capture: the universal fallback for pages whose DOM cannot be read.
//
// DOM extraction fails on a lot of real pages: the editor lives in a
// cross-origin frame, the statement is rendered to a canvas, the site is a
// screenshot-only viewer, or the layout is simply unlike anything the
// heuristics know. In all of those cases a picture of the page still carries
// the question, and a vision-capable agent can read it.
//
// So capture is treated as a first-class path, not an error branch.

import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

import { APP_DIR } from './chrome.mjs';

export const SHOT_DIR = path.join(APP_DIR, 'shots');

/** Full-page metrics, used to decide how tall the capture must be. */
export async function pageMetrics(cdp, { contextId = null } = {}) {
  return cdp.evaluate(`(() => ({
    scrollHeight: Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0,
    ),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    title: document.title,
    url: location.href,
  }))()`, { contextId });
}

/**
 * Capture the page.
 *
 * @param {object} cdp
 * @param {object} [opts]
 * @param {boolean} [opts.fullPage] capture the whole document, not just the view
 * @param {string}  [opts.name] file stem; defaults to a timestamp
 * @returns {Promise<{ok:boolean, file:string, bytes:number, width?:number, height?:number, fullPage:boolean}>}
 */
export async function capture(cdp, { fullPage = true, name = null } = {}) {
  await mkdir(SHOT_DIR, { recursive: true });

  const params = { format: 'png', captureBeyondViewport: fullPage };
  if (fullPage) {
    const m = await pageMetrics(cdp).catch(() => null);
    if (m?.scrollHeight) {
      // Cap the height: some pages report absurd scrollHeight (infinite feeds).
      params.clip = {
        x: 0,
        y: 0,
        width: Math.max(m.viewportWidth, 320),
        height: Math.min(m.scrollHeight, 8000),
        scale: 1,
      };
    }
  }

  const res = await cdp.send('Page.captureScreenshot', params);
  const buf = Buffer.from(res.data, 'base64');
  const stem = name ?? `page-${Date.now()}`;
  const file = path.join(SHOT_DIR, `${stem}.png`);
  await writeFile(file, buf);

  return { ok: true, file, bytes: buf.length, fullPage };
}

/**
 * Watch a file for changes and call `onTrigger` each time it is written.
 *
 * Gives any external tool (AutoHotkey, a macro key, a shortcut) a way to ask
 * for a capture without depending on the built-in keyboard listener. Polling is
 * used rather than fs.watch because editors and scripts touch files in ways that
 * fs.watch reports inconsistently on Windows.
 *
 * @returns {{stop:()=>void}}
 */
export function watchTriggerFile(file, onTrigger, { intervalMs = 250 } = {}) {
  let last = 0;
  let stopped = false;

  // Seed with the current mtime so a pre-existing file does not fire at once.
  try {
    last = statSync(file).mtimeMs;
  } catch { /* not created yet */ }

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const m = statSync(file).mtimeMs;
      if (m > last) {
        last = m;
        try { onTrigger({ at: Date.now() }); } catch { /* keep polling */ }
      }
    } catch { /* file missing; ignore */ }
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Capture and also return whatever text the DOM could offer.
 *
 * The text is best-effort: it is a hint for the reader, never a substitute for
 * looking at the image.
 */
export async function grabPage(cdp, { fullPage = true, name = null } = {}) {
  const shot = await capture(cdp, { fullPage, name });

  const text = await cdp.evaluate(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.innerText || '').trim() : '';
    };
    const body = document.body ? (document.body.innerText || '') : '';
    return {
      url: location.href,
      title: document.title,
      heading: pick('h1') || pick('.problem-title,.question-title,.title') || document.title,
      text: body.slice(0, 20000),
      textLength: body.length,
    };
  })()`).catch(() => null);

  return { ...shot, dom: text };
}
