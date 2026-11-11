// Switch the page's language selector to a target language.
//
// This is deliberately separate from injection: the editor often resets when
// the language changes, so the caller must switch first, wait, then write.

import { normalizeLang } from './lang.mjs';
import { sleep } from './cdp.mjs';

/**
 * Find and select the option matching `targetLang`.
 * @returns {Promise<{ok:boolean, switched?:boolean, before?:string, after?:string, reason?:string, options?:string[]}>}
 */
export async function switchLanguage(cdp, targetLang) {
  const want = normalizeLang(targetLang);
  if (!want) return { ok: false, reason: 'unrecognized-target', target: targetLang };

  const result = await cdp.evaluate(`(() => {
    const norm = (s) => String(s || '').trim();
    const visible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 8;
    };

    // Locate the language <select> the same way extraction does.
    const LANG = /python|java|c\\+\\+|cpp|javascript|js|typescript|golang|go\\b|c#|rust|php|ruby|kotlin|swift|scala|haskell|lua|perl|\\br\\b|sql/i;
    const selects = [...document.querySelectorAll('select')].filter(visible);
    let sel = null;
    for (const s of selects) {
      if ([...s.options].some((o) => LANG.test(o.text))) { sel = s; break; }
    }
    if (!sel) return { ok: false, reason: 'no-language-select' };

    const options = [...sel.options].map((o) => o.text.trim());
    return { ok: true, current: sel.options[sel.selectedIndex]?.text.trim() || null, options };
  })()`);

  if (!result?.ok) return { ok: false, reason: result?.reason ?? 'unknown' };

  // Resolve which option index corresponds to the target, using the same
  // normalizer as the caller (must run in Node, not in the page).
  const idx = result.options.findIndex((o) => normalizeLang(o) === want);
  if (idx < 0) {
    return {
      ok: false,
      reason: 'option-not-available',
      want,
      current: result.current,
      options: result.options,
    };
  }

  const current = normalizeLang(result.current);
  if (current === want) {
    return { ok: true, switched: false, before: result.current, after: result.current };
  }

  const applied = await cdp.evaluate(`(() => {
    const visible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 8;
    };
    const LANG = /python|java|c\\+\\+|cpp|javascript|js|typescript|golang|go\\b|c#|rust|php|ruby|kotlin|swift|scala|haskell|lua|perl|\\br\\b|sql/i;
    const selects = [...document.querySelectorAll('select')].filter(visible);
    let sel = null;
    for (const s of selects) {
      if ([...s.options].some((o) => LANG.test(o.text))) { sel = s; break; }
    }
    if (!sel) return { ok: false, reason: 'select-disappeared' };
    sel.selectedIndex = ${idx};
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, now: sel.options[sel.selectedIndex]?.text.trim() || null };
  })()`);

  if (!applied?.ok) return { ok: false, reason: applied?.reason ?? 'apply-failed' };

  // Most OJs rebuild the editor when the language changes.
  await sleep(700);

  const after = await cdp.evaluate(`(() => {
    const visible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 8;
    };
    const LANG = /python|java|c\\+\\+|cpp|javascript|js|typescript|golang|go\\b|c#|rust|php|ruby|kotlin|swift|scala|haskell|lua|perl|\\br\\b|sql/i;
    const selects = [...document.querySelectorAll('select')].filter(visible);
    for (const s of selects) {
      if ([...s.options].some((o) => LANG.test(o.text))) {
        return s.options[s.selectedIndex]?.text.trim() || null;
      }
    }
    return null;
  })()`);

  return {
    ok: normalizeLang(after) === want,
    switched: true,
    before: result.current,
    after,
    expected: want,
  };
}
