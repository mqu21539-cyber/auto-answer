// Minimal Chrome DevTools Protocol client over Node's native WebSocket.
// Zero dependencies. Node >= 22 (native WebSocket) required.
//
// Usage:
//   const cdp = await CDP.connect(wsUrl);
//   const { result } = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
//   cdp.on('Page.loadEventFired', () => {});
//   cdp.close();

export class CDP {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;
  /** frameId -> { id, frameId, url, isDefault } */
  #contexts = new Map();

  constructor(ws) {
    this.#ws = ws;
  }

  /** Connect to a page-level or browser-level CDP WebSocket URL. */
  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms: ${wsUrl}`)),
        timeoutMs,
      );
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connect failed: ${wsUrl}`));
      }, { once: true });
    });
    const cdp = new CDP(ws);
    ws.addEventListener('message', (ev) => cdp.#onMessage(ev.data));
    ws.addEventListener('close', () => { cdp.#closed = true; cdp.#rejectAll(new Error('CDP socket closed')); });
    return cdp;
  }
  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id != null) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        const detail = msg.error.data ? ` :: ${msg.error.data}` : '';
        pending.reject(new Error(`${msg.error.message}${detail}`));
      } else {
        pending.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.method) {
      // Context bookkeeping happens before listeners so `contexts()` is correct
      // even when nothing else subscribes.
      if (msg.method === 'Runtime.executionContextCreated') this.#trackContext(msg.params ?? {});
      else if (msg.method === 'Runtime.executionContextDestroyed') this.#dropContext(msg.params ?? {});
      else if (msg.method === 'Runtime.executionContextsCleared') this.#contexts.clear();

      const list = this.#handlers.get(msg.method);
      if (!list) return;
      for (const fn of list) {
        try { fn(msg.params ?? {}); } catch { /* listener errors must not kill the socket */ }
      }
    }
  }

  /** Track execution contexts as they appear, so sub-frames can be evaluated. */
  #trackContext(params) {
    const ctx = params.context;
    if (!ctx || !ctx.auxData?.frameId) return;
    this.#contexts.set(ctx.auxData.frameId, {
      id: ctx.id,
      frameId: ctx.auxData.frameId,
      url: ctx.origin ?? '',
      isDefault: ctx.auxData.isDefault === true,
      name: ctx.name ?? '',
    });
  }

  #dropContext(params) {
    for (const [frameId, c] of this.#contexts) {
      if (c.id === params.executionContextId) this.#contexts.delete(frameId);
    }
  }

  #rejectAll(err) {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  /** Send a CDP command and await its result. */
  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP socket is closed'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method, fn) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(fn);
    return () => this.#handlers.get(method)?.delete(fn);
  }

  /**
   * Evaluate an expression in the page and return its value.
   * Throws if the page threw, so callers never silently get `undefined`.
   *
   * @param {string} expression
   * @param {object} [opts]
   * @param {number} [opts.contextId] execution context to run in (a sub-frame).
   *   Omitted means the main frame.
   */
  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000, contextId = null } = {}) {
    const params = {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    };
    if (contextId != null) params.contextId = contextId;

    const res = await this.send('Runtime.evaluate', params);
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description
        || res.exceptionDetails.text
        || 'unknown page exception';
      throw new Error(`Page exception: ${desc}`);
    }
    return res.result?.value;
  }

  /**
   * Every execution context currently alive, one per frame.
   * Collected by enabling Runtime and waiting for the initial context events.
   *
   * @returns {Promise<Array<{id:number, frameId:string, url:string, isDefault:boolean}>>}
   */
  async contexts({ timeoutMs = 1500 } = {}) {
    if (!this.#contexts.size) {
      const seen = new Promise((resolve) => {
        const off = this.on('Runtime.executionContextCreated', () => { off(); resolve(); });
        setTimeout(() => { off(); resolve(); }, timeoutMs);
      });
      await this.send('Runtime.enable').catch(() => {});
      await seen;
    }
    return [...this.#contexts.values()];
  }

  /** Wait until `expression` is truthy in the page. Resolves with its value. */
  async waitFor(expression, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(`(() => { try { return (${expression}); } catch (e) { return false; } })()`);
        if (value) return value;
      } catch (err) { lastErr = err; }
      await sleep(intervalMs);
    }
    const suffix = lastErr ? ` (last error: ${lastErr.message})` : '';
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
  }

  close() {
    this.#closed = true;
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON from a CDP HTTP endpoint, tolerating a not-yet-ready browser. */
export async function cdpJson(port, pathname, { timeoutMs = 3000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${pathname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
