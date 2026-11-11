// Watch mode: detect question changes in-page and drive injection.
//
// Detection uses a MutationObserver on the document plus URL polling, with a
// `selfWriting` guard so our own injection never re-triggers the pipeline.

const WATCH_INSTALL = `
(() => {
  if (window.__AAWATCH__) return true;

  const state = { selfWriting: false, lastSig: null, timer: null };

  const emit = (payload) => {
    try {
      if (typeof window.__aaEmit === 'function') window.__aaEmit(JSON.stringify(payload));
    } catch (e) { /* binding not installed yet */ }
  };

  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '');

  const snapshotKey = () => {
    const heading = textOf(document.querySelector('h1') || document.querySelector('.problem-title'));
    // Editor content: only used to detect a reset, not for the signature.
    const body = textOf(document.querySelector('article,main,.problem,.question,.content,body'));
    return (heading + '|' + body.slice(0, 600) + '|' + body.length).slice(0, 1200);
  };

  const fire = (reason) => {
    if (state.selfWriting) return;
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.selfWriting) return;
      emit({ type: 'question-changed', reason, url: location.href, key: snapshotKey() });
    }, 500);
  };

  const observer = new MutationObserver(() => fire('mutation'));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: false,
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      fire('url');
    }
  }, 700);

  window.__AAWATCH__ = {
    mute() { state.selfWriting = true; },
    unmute() { state.selfWriting = false; },
    poke() { fire('manual'); },
    status() { return { selfWriting: state.selfWriting }; },
  };

  // Prime the pipeline for whatever question is already on screen.
  setTimeout(() => fire('initial'), 800);
  return true;
})()
`;

/**
 * Install the in-page watcher and route its events to `onChange`.
 * @returns {Promise<() => void>} uninstall function
 */
export async function installWatcher(cdp, onChange, { log = () => {} } = {}) {
  await cdp.send('Runtime.addBinding', { name: '__aaEmit' }).catch(() => {
    // Binding may already exist from a previous run; that is fine.
  });

  const off = cdp.on('Runtime.bindingCalled', (params) => {
    if (params.name !== '__aaEmit') return;
    let payload;
    try { payload = JSON.parse(params.payload); } catch { return; }
    onChange(payload);
  });

  await cdp.evaluate(WATCH_INSTALL);
  log('watcher installed');

  return async () => {
    off();
    await cdp.evaluate('window.__AAWATCH__ && (window.__AAWATCH__.mute = () => {})').catch(() => {});
  };
}

/** Suppress watcher events while we are writing into the editor. */
export async function mute(cdp) {
  await cdp.evaluate('window.__AAWATCH__ && window.__AAWATCH__.mute()').catch(() => {});
}

/** Resume watcher events after writing. */
export async function unmute(cdp) {
  await cdp.evaluate('window.__AAWATCH__ && window.__AAWATCH__.unmute()').catch(() => {});
}
