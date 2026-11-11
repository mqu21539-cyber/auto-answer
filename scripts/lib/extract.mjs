// Question extraction: pull the problem statement, samples, language selector
// and editor kind out of an arbitrary OJ page, without a site-specific adapter.
//
// Heuristics only — it never throws on a "weird" page, it degrades to nulls so
// the caller can decide whether to fall back to manual mode.

const EXTRACT = `
(() => {
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  const score = (el) => {
    const t = txt(el);
    if (t.length < 40) return 0;
    let s = Math.min(t.length, 4000) / 1000;
    if (/输入|输出|样例|示例|输入格式|输出格式|说明|限制|Sample|Input|Output/i.test(t)) s += 3;
    if (/时间限制|内存限制|题目描述|problem|description/i.test(t)) s += 2;
    const cls = (el.className || '') + ' ' + (el.id || '');
    if (/problem|question|subject|title|desc|content|statement|main/i.test(cls)) s += 2;
    if (/nav|menu|header|footer|sidebar|comment|toolbar|editor|code/i.test(cls)) s -= 4;
    return s;
  };

  const blocks = [...document.querySelectorAll('article,section,main,div,td')]
    .filter(visible)
    .map((el) => ({ el, s: score(el) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  // Walk up from the best block while the parent's text is still problem-shaped.
  let best = blocks[0]?.el || null;
  if (best) {
    let node = best;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      const parent = node.parentElement;
      const pt = txt(parent);
      if (pt.length > 30000) break;
      if (score(parent) >= score(node) - 0.5 && /输入|输出|样例|示例|Sample/i.test(pt)) {
        node = parent;
      } else break;
    }
    best = node;
  }

  const heading = txt(
    document.querySelector('h1') ||
    document.querySelector('.problem-title,.question-title,.title') ||
    document.title
  ).split('\\n')[0].slice(0, 200);

  const body = best ? txt(best) : '';

  // Sample I/O: look for labelled code blocks near "样例/示例/Sample/Input/Output".
  // The label is the nearest preceding text; use the *last* label line so a
  // block right after "样例输入：" is classified as input, not by an earlier word.
  const samples = [];
  const preBlocks = [...document.querySelectorAll('pre,code')].filter(visible);
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  for (let i = 0; i < preBlocks.length; i++) {
    const block = preBlocks[i];
    const content = textOf(block);
    if (!content || content.length > 20000) continue;

    // Walk backwards collecting text, stopping at the previous code block.
    const parts = [];
    let n = block;
    for (let k = 0; k < 4 && n; k++) {
      const prev = n.previousElementSibling;
      if (!prev) break;
      if (/^(PRE|CODE)$/i.test(prev.tagName)) break;
      const t = textOf(prev);
      if (t) parts.unshift(t);
      n = prev;
    }

    // The label is the last line of the collected context.
    const ctx = parts.join('\\n');
    const lines = ctx.split('\\n').map((s) => s.trim()).filter(Boolean);
    const label = (lines[lines.length - 1] || '').slice(-80);

    let kind = null;
    if (/输出|output/i.test(label)) kind = 'output';
    else if (/输入|input/i.test(label)) kind = 'input';
    else if (/样例|示例|sample|example/i.test(label)) kind = 'sample';
    if (kind) samples.push({ kind, label, content });
  }

  // Pair them up: input[i] followed by output[i].
  const pairs = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].kind === 'input' && samples[i + 1]?.kind === 'output') {
      pairs.push({ input: samples[i].content, output: samples[i + 1].content });
      i++;
    }
  }

  // Language selector: a <select> whose options look like languages, or a
  // button/span with a language name. We also record every candidate option so
  // the caller can switch languages, not just read the current one.
  const LANG = /python|java|c\\+\\+|cpp|javascript|js|typescript|golang|go\\b|c#|rust|php|ruby|kotlin|swift|scala|haskell|lua|perl|\\br\\b|sql/i;
  let lang = null;
  let langOptions = [];
  let langSelectIndex = -1;

  const selects = [...document.querySelectorAll('select')].filter(visible);
  for (let si = 0; si < selects.length; si++) {
    const sel = selects[si];
    const opts = [...sel.options].map((o) => o.text.trim());
    if (opts.some((o) => LANG.test(o))) {
      lang = sel.options[sel.selectedIndex]?.text.trim() || null;
      langOptions = opts;
      langSelectIndex = si;
      break;
    }
  }

  if (!lang) {
    // Fallback: a short visible label that names a language.
    // The length cap plus the exclusion list matter: without them a code line
    // like "import java.util.*;" matches /java/ and becomes the language.
    const CODE_LIKE = /[;{}()=<>\\/*]|\\bimport\\b|\\bpackage\\b|\\bclass\\b|\\bpublic\\b|\\breturn\\b|^#include/i;
    const nodes = [...document.querySelectorAll('button,span,div[role="button"]')].filter(visible);
    for (const el of nodes.slice(0, 400)) {
      const t = txt(el);
      if (!t || t.length > 16) continue;
      if (CODE_LIKE.test(t)) continue;
      if (LANG.test(t)) { lang = t; break; }
    }
  }

  const editorKind = (() => {
    if (document.querySelector('.monaco-editor')) return 'monaco';
    if (document.querySelector('.cm-editor')) return 'codemirror6';
    if (document.querySelector('.CodeMirror')) return 'codemirror5';
    const ta = [...document.querySelectorAll('textarea')].filter(visible);
    if (ta.length) return 'textarea';
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    if (ce.length) return 'contenteditable';
    return null;
  })();

  const frames = document.querySelectorAll('iframe').length;

  return {
    url: location.href,
    title: document.title,
    heading,
    body,
    bodyLength: body.length,
    samples,
    samplePairs: pairs,
    lang,
    langOptions,
    langSelectIndex,
    editorKind,
    iframes: frames,
    loggedOutHint: /登录|登陆|sign in|log in|login/i.test(heading + ' ' + document.title),
  };
})()
`;

export async function extractQuestion(cdp) {
  const data = await cdp.evaluate(EXTRACT);
  if (!data) throw new Error('Question extraction returned nothing');
  return { ...data, sig: signature(data) };
}

/** Stable signature for a question, used to dedupe watch events. */
export function signature(q) {
  const key = `${q.heading ?? ''}|${(q.body ?? '').slice(0, 400)}|${q.bodyLength ?? 0}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Detect "not actually a question page" states. */
export function diagnose(q) {
  if (q.loggedOutHint) {
    return { ok: false, reason: 'logged-out', hint: 'Session expired. Run: aa.mjs login <url>' };
  }
  if (!q.editorKind) {
    return { ok: false, reason: 'no-editor', hint: 'No answer box found. Page layout may have changed.' };
  }
  if (!q.body || q.bodyLength < 30) {
    return { ok: false, reason: 'empty-statement', hint: 'Problem statement looks empty; question may still be loading.' };
  }
  return { ok: true };
}
