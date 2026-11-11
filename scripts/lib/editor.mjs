// Editor detection, multi-strategy injection, and read-back verification.
// All page-side logic lives in one injected bootstrap so the strategies stay
// consistent between "inspect" and "write".

const BOOTSTRAP = `
(() => {
  if (window.__AA__) return true;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  const candidates = () => {
    const out = [];
    const only = window.__AA_ONLY__ || null;   // test hook: restrict to one editor kind
    const push = (el, kind) => {
      if (only && kind !== only) return;
      if (!el || !el.isConnected || !visible(el)) return;
      if (out.some((c) => c.el === el)) return;
      out.push({ el, kind });
    };

    for (const el of document.querySelectorAll('.monaco-editor')) push(el, 'monaco');
    for (const el of document.querySelectorAll('.cm-editor')) push(el, 'codemirror6');
    for (const el of document.querySelectorAll('.CodeMirror')) push(el, 'codemirror5');
    for (const el of document.querySelectorAll('textarea')) push(el, 'textarea');
    for (const el of document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')) {
      push(el, 'contenteditable');
    }
    return out.sort((a, b) => area(b.el) - area(a.el));
  };

  const monacoModel = (root) => {
    const m = window.monaco;
    if (!m?.editor?.getModels) return null;
    const models = m.editor.getModels();
    if (!models?.length) return null;
    // Prefer the model whose editor instance lives inside this root.
    const editors = m.editor.getEditors?.() || [];
    for (const ed of editors) {
      const node = ed.getDomNode?.();
      if (node && root.contains(node)) {
        const model = ed.getModel?.();
        if (model) return model;
      }
    }
    return models[0];
  };

  // Many OJ builds ship a Monaco without exposing monaco.editor.getModels
  // (nowcoder's bundle does exactly this). The rendered lines are always in the
  // DOM though, one .view-line per line, so that is the reliable read path.
  const readViewLines = (root) => {
    const lines = [...root.querySelectorAll('.view-line')];
    if (!lines.length) return null;
    return lines.map((l) => l.innerText).join('\\n');
  };

  const cm6View = (root) => {
    const content = root.querySelector('.cm-content');
    const cmView = content?.cmView?.view || content?.parentElement?.cmView?.view;
    return cmView || null;
  };

  const cm5Instance = (root) => {
    const host = root.classList?.contains('CodeMirror') ? root : root.querySelector('.CodeMirror');
    return host?.CodeMirror || null;
  };

  // contenteditable is a block soup: Chrome wraps each line in <div> and encodes
  // indentation as &nbsp;. innerText double-counts the <br> inside an empty
  // block, so read block-by-block with textContent instead.
  const cleanCE = (s) => String(s ?? '').replace(/\\u00a0/g, ' ').replace(/\\r\\n?/g, '\\n');

  const readCE = (el) => {
    const blockish = /^(DIV|P|LI|PRE|BLOCKQUOTE)$/i;
    const hasBlocks = [...el.childNodes].some((n) => n.nodeType === 1 && blockish.test(n.nodeName));
    if (!hasBlocks) return cleanCE(el.textContent || '');

    const lines = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = cleanCE(n.textContent || '');
        if (t.trim() !== '') lines.push(t);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const onlyBr = n.childNodes.length > 0
        && [...n.childNodes].every((c) => c.nodeName === 'BR');
      if (onlyBr || n.textContent === '') { lines.push(''); continue; }
      lines.push(cleanCE(n.textContent || ''));
    }
    return lines.join('\\n');
  };

  // Deterministic writer: one block element per source line. Used as the
  // contenteditable fallback when synthetic input produces a malformed tree.
  const writeBlocks = (el, text) => {
    el.focus();
    el.innerHTML = '';
    const lines = String(text).replace(/\\r\\n?/g, '\\n').split('\\n');
    for (const line of lines) {
      const div = document.createElement('div');
      if (line === '') div.appendChild(document.createElement('br'));
      else div.textContent = line;
      el.appendChild(div);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  };

  const readOf = (entry) => {
    const { el, kind } = entry;
    try {
      if (kind === 'monaco') {
        const model = monacoModel(el);
        if (model) return model.getValue();
        // No API access (nowcoder's bundle hides monaco.editor). The rendered
        // lines are authoritative enough to read what the operator sees.
        const fromLines = readViewLines(el);
        if (fromLines !== null) return fromLines;
        return el.innerText ?? '';
      }
      if (kind === 'codemirror6') {
        const view = cm6View(el);
        return view ? view.state.doc.toString() : el.innerText;
      }
      if (kind === 'codemirror5') {
        const cm = cm5Instance(el);
        return cm ? cm.getValue() : el.innerText;
      }
      if (kind === 'textarea') return el.value;
      return readCE(el);
    } catch (e) {
      return el.innerText ?? '';
    }
  };

  const focusOf = (entry) => {
    const { el, kind } = entry;
    if (kind === 'monaco') {
      const lines = el.querySelector('.view-lines') || el;
      lines.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      lines.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    if (kind === 'codemirror6') {
      (el.querySelector('.cm-content') || el).focus();
      return;
    }
    if (kind === 'codemirror5') {
      const cm = cm5Instance(el);
      if (cm) { cm.focus(); return; }
    }
    el.focus();
  };

  const selectAll = () => {
    const sel = window.getSelection?.();
    if (sel) { sel.removeAllRanges(); }
  };

  // Strategy 1: editor's own API (most reliable, no synthetic input events).
  const writeNative = (entry, text) => {
    const { el, kind } = entry;
    if (kind === 'monaco') {
      const model = monacoModel(el);
      if (!model) return false;
      if (typeof model.setValue === 'function') { model.setValue(text); return true; }
      return false;
    }
    if (kind === 'codemirror6') {
      const view = cm6View(el);
      if (!view?.dispatch) return false;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return true;
    }
    if (kind === 'codemirror5') {
      const cm = cm5Instance(el);
      if (!cm?.setValue) return false;
      cm.setValue(text);
      return true;
    }
    return false;
  };

  // Strategy 3: native value setter + input event (React/Vue controlled inputs).
  const writeSetter = (entry, text) => {
    const { el, kind } = entry;
    if (kind === 'textarea') {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc.set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (kind === 'contenteditable') {
      try {
        return { ok: writeBlocks(el, text), kind };
      } catch (e) {
        return { ok: false, kind, error: String(e && e.message || e) };
      }
    }
    return false;
  };

  window.__AA__ = {
    list() {
      return candidates().map((c) => ({ kind: c.kind, text: readOf(c) }));
    },
    inspect() {
      const list = candidates();
      if (!list.length) return { ok: false, reason: 'no-editor-found' };
      const entry = list[0];
      return {
        ok: true,
        kind: entry.kind,
        currentText: readOf(entry),
        candidateCount: list.length,
        canNative: (() => {
          try {
            if (entry.kind === 'monaco') return !!monacoModel(entry.el);
            if (entry.kind === 'codemirror6') return !!cm6View(entry.el);
            if (entry.kind === 'codemirror5') return !!cm5Instance(entry.el);
            return false;
          } catch (e) { return false; }
        })(),
      };
    },
    prepareFocus() {
      const list = candidates();
      if (!list.length) return { ok: false, reason: 'no-editor-found' };
      const entry = list[0];
      focusOf(entry);
      selectAll();
      return { ok: true, kind: entry.kind };
    },
    writeNative(text) {
      const list = candidates();
      if (!list.length) return { ok: false, reason: 'no-editor-found' };
      const entry = list[0];
      try {
        const done = writeNative(entry, text);
        return { ok: done, kind: entry.kind };
      } catch (e) {
        return { ok: false, kind: entry.kind, error: String(e && e.message || e) };
      }
    },
    writeSetter(text) {
      const list = candidates();
      if (!list.length) return { ok: false, reason: 'no-editor-found' };
      const entry = list[0];
      try {
        const done = writeSetter(entry, text);
        return { ok: done, kind: entry.kind };
      } catch (e) {
        return { ok: false, kind: entry.kind, error: String(e && e.message || e) };
      }
    },
    read() {
      const list = candidates();
      if (!list.length) return { ok: false, reason: 'no-editor-found' };
      const entry = list[0];
      return { ok: true, kind: entry.kind, text: readOf(entry) };
    },
    clear() {
      const list = candidates();
      if (!list.length) return { ok: false, reason: 'no-editor-found' };
      const entry = list[0];
      const { el, kind } = entry;
      if (kind === 'monaco') {
        const model = monacoModel(el);
        if (model?.setValue) { model.setValue(''); return { ok: true, kind }; }
        // No API access: replacing the DOM would destroy Monaco's renderer.
        // The caller must select-all and overwrite instead.
        return { ok: true, kind, needsSelectAll: true };
      }
      if (kind === 'codemirror6') {
        const view = cm6View(el);
        if (view?.dispatch) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
          return { ok: true, kind };
        }
        return { ok: true, kind, needsSelectAll: true };
      }
      if (kind === 'codemirror5') {
        const cm = cm5Instance(el);
        if (cm?.setValue) { cm.setValue(''); return { ok: true, kind }; }
        return { ok: true, kind, needsSelectAll: true };
      }
      if (kind === 'textarea') { el.value = ''; return { ok: true, kind }; }
      el.innerHTML = '<div><br></div>';
      return { ok: true, kind };
    },
  };

  return true;
})()
`;

/**
 * Locate the execution context that holds the editor.
 *
 * OJ pages frequently host the code editor inside an iframe (`about:srcdoc` on
 * nowcoder, a separate editor frame elsewhere). Evaluating in the main frame
 * then finds nothing, so every frame is probed and the first one containing an
 * editor wins.
 *
 * @returns {Promise<{contextId:number|null, frameUrl:string, kind:string|null}>}
 */
export async function findEditorContext(cdp) {
  // Main frame first: it is the common case and costs one round trip.
  const inMain = await cdp.evaluate(`(() => {
    if (document.querySelector('.monaco-editor,.cm-editor,.CodeMirror')) return true;
    const ta = [...document.querySelectorAll('textarea')].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 60 && r.height > 40;
    });
    return ta.length > 0;
  })()`).catch(() => false);

  if (inMain) return { contextId: null, frameUrl: 'main', kind: null };

  const contexts = await cdp.contexts();
  for (const ctx of contexts) {
    if (ctx.isDefault === false) continue;
    const probe = await cdp.evaluate(`(() => {
      const monaco = document.querySelector('.monaco-editor');
      if (monaco) return 'monaco';
      if (document.querySelector('.cm-editor')) return 'codemirror6';
      if (document.querySelector('.CodeMirror')) return 'codemirror5';
      const ta = [...document.querySelectorAll('textarea')].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 60 && r.height > 40;
      });
      return ta.length ? 'textarea' : null;
    })()`, { contextId: ctx.id }).catch(() => null);

    if (probe) return { contextId: ctx.id, frameUrl: ctx.url, kind: probe };
  }

  return { contextId: null, frameUrl: 'none', kind: null };
}

/** Inject the page-side helper (idempotent), in the frame that owns the editor. */
export async function bootstrap(cdp, { contextId = null } = {}) {
  await cdp.evaluate(BOOTSTRAP, { contextId });
  const ready = await cdp.evaluate('!!window.__AA__', { contextId });
  if (!ready) throw new Error('Failed to install page helper (window.__AA__ missing)');
}

/** Normalize text for comparison: unify newlines, strip trailing whitespace per line + at end. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** Compare two texts, returning a compact diff descriptor or null when equal. */
export function diffText(expected, actual) {
  const a = normalize(expected);
  const b = normalize(actual);
  if (a === b) return null;

  const al = a.split('\n');
  const bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      return {
        reason: i >= al.length ? 'extra-lines-in-editor' : i >= bl.length ? 'missing-lines-in-editor' : 'line-mismatch',
        line: i + 1,
        expected: al[i] ?? null,
        actual: bl[i] ?? null,
        expectedLines: al.length,
        actualLines: bl.length,
        expectedChars: a.length,
        actualChars: b.length,
      };
    }
  }
  return { reason: 'unknown', expectedChars: a.length, actualChars: b.length };
}

/**
 * Select all text in the focused editor using real key events.
 *
 * Used when the editor exposes no write API: Monaco without `monaco.editor`
 * only responds to genuine input, so Ctrl+A followed by insertText is the
 * reliable way to replace its contents without touching its DOM.
 */
async function selectAllViaKeyboard(cdp) {
  const base = {
    modifiers: 2,                 // Ctrl
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll'],
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await new Promise((r) => setTimeout(r, 80));
}

/**
 * Click into the editor with real mouse events and select everything.
 *
 * Monaco only takes focus from genuine mouse input; a synthetic DOM click is
 * ignored. Clicking near the top-left of the text area puts the caret in the
 * document, and Ctrl+A then selects the whole buffer.
 */
async function focusAndSelectAll(cdp, { contextId = null } = {}) {
  const rect = await cdp.evaluate(`(() => {
    const el = document.querySelector('.monaco-editor') || document.querySelector('textarea,.cm-content,[contenteditable="true"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`, { contextId });

  if (rect && rect.w > 10 && rect.h > 10) {
    // Aim a little inside the text area: below the first line, right of the gutter.
    const x = Math.round(rect.x + Math.min(120, rect.w * 0.3));
    const y = Math.round(rect.y + Math.min(40, rect.h * 0.2));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
  }

  await selectAllViaKeyboard(cdp);
}

/**
 * Write `code` into the first visible editor using a 3-tier strategy:
 *   1. native editor API (monaco / codemirror)
 *   2. real mouse focus + Ctrl+A + CDP Input.insertText
 *   3. native value setter + dispatched input event
 * Each attempt is followed by a read-back comparison.
 */
export async function writeCode(cdp, code, { retries = 3, log = () => {} } = {}) {
  // The editor may live in a sub-frame; evaluate everything in the right one.
  const { contextId, frameUrl } = await findEditorContext(cdp);
  if (frameUrl === 'none') throw new Error('No editor found in any frame');
  if (contextId != null) log(`editor is in frame: ${frameUrl}`);

  const opts = { contextId };
  await bootstrap(cdp, opts);

  const info = await cdp.evaluate('window.__AA__.inspect()', opts);
  if (!info?.ok) throw new Error(`No editor found on page (${info?.reason ?? 'unknown'})`);

  const attempts = [];
  const strategies = [];

  if (info.canNative) strategies.push('native-api');
  strategies.push('insert-text');
  strategies.push('setter');

  for (const strategy of strategies.slice(0, retries)) {
    let attempt;
    try {
      if (strategy === 'native-api') {
        const res = await cdp.evaluate(`window.__AA__.writeNative(${JSON.stringify(code)})`, opts);
        attempt = { strategy, ok: res?.ok === true, detail: res };
      } else if (strategy === 'insert-text') {
        const cleared = await cdp.evaluate('window.__AA__.clear()', opts);
        // Order matters: the page-side focus call dispatches synthetic events
        // that collapse any selection, so it must run BEFORE the real click and
        // Ctrl+A. Doing it afterwards silently turns "replace" into "append".
        const focused = await cdp.evaluate('window.__AA__.prepareFocus()', opts);
        if (!focused?.ok) {
          attempt = { strategy, ok: false, detail: focused };
        } else {
          await focusAndSelectAll(cdp, opts);
          await cdp.send('Input.insertText', { text: code });
          attempt = { strategy, ok: true, selectAll: Boolean(cleared?.needsSelectAll) };
        }
      } else {
        const res = await cdp.evaluate(`window.__AA__.writeSetter(${JSON.stringify(code)})`, opts);
        attempt = { strategy, ok: res?.ok === true, detail: res };
      }
    } catch (err) {
      attempt = { strategy, ok: false, error: err.message };
    }

    const back = await cdp.evaluate('window.__AA__.read()', opts);
    const actual = back?.text ?? '';
    const diff = diffText(code, actual);

    if (diff === null) {
      attempts.push({ strategy: attempt.strategy, ok: true, chars: normalize(actual).length });
      log(`injected via ${strategy}`);
      return {
        ok: true,
        editor: back?.kind ?? info.kind,
        chars: normalize(actual).length,
        attempts,
        frame: frameUrl,
      };
    }

    attempts.push({ strategy: attempt.strategy, ok: false, diff, error: attempt.error });
    log(`strategy ${strategy} did not match, trying next`);
  }

  const last = attempts[attempts.length - 1];
  return { ok: false, editor: info.kind, attempts, diff: last?.diff ?? null, frame: frameUrl };
}

/** Clear the editor. */
export async function clearEditor(cdp) {
  const { contextId } = await findEditorContext(cdp);
  await bootstrap(cdp, { contextId });
  return cdp.evaluate('window.__AA__.clear()', { contextId });
}

/** Read current editor content without modifying it. */
export async function readEditor(cdp) {
  const { contextId, frameUrl } = await findEditorContext(cdp);
  if (frameUrl === 'none') return { ok: false, reason: 'no-editor-found' };
  await bootstrap(cdp, { contextId });
  const r = await cdp.evaluate('window.__AA__.read()', { contextId });
  return { ...r, frame: frameUrl };
}
