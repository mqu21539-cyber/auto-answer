// Probe: report which signals the page can read about this browser.
//
// This is a DIAGNOSTIC, not a stealth layer. It exists so a site owner can
// verify their own bot-detection logic actually fires. It never modifies a
// single value — it only reports what the page already sees.

const PROBE = `
(() => {
  const nav = navigator;
  const ua = nav.userAgent || '';

  const webgl = (() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      };
    } catch (e) { return null; }
  })();

  const plugins = [];
  try {
    for (const p of nav.plugins || []) plugins.push(p.name);
  } catch (e) {}

  return {
    url: location.href,
    title: document.title,
    userAgent: ua,
    headlessHints: {
      uaContainsHeadlessChrome: /HeadlessChrome/i.test(ua),
      hasChromeObject: typeof window.chrome === 'object' && window.chrome !== null,
      pluginsEmpty: plugins.length === 0,
      languagesEmpty: !(nav.languages && nav.languages.length),
    },
    webdriver: nav.webdriver === true,
    languages: nav.languages ? [...nav.languages] : [],
    platform: nav.platform,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    plugins,
    visibility: {
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      devicePixelRatio: window.devicePixelRatio,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    },
    webgl,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
})()
`;

/**
 * Collect the page-visible fingerprint of the current browser.
 * @returns {Promise<object>} report with a `summary` block of booleans
 */
export async function probe(cdp) {
  const raw = await cdp.evaluate(PROBE);
  const summary = {
    webdriverFlagSet: raw.webdriver === true,
    uaAdvertisesHeadless: raw.headlessHints.uaContainsHeadlessChrome,
    pluginsListEmpty: raw.headlessHints.pluginsEmpty,
    noChromeObject: !raw.headlessHints.hasChromeObject,
    reportsHidden: raw.visibility.hidden === true,
    reportsNoFocus: raw.visibility.hasFocus === false,
    webglRendererPresent: Boolean(raw.webgl?.unmaskedRenderer || raw.webgl?.renderer),
    windowSizeIsHeadlessDefault: raw.screen.outerWidth === 0 || raw.screen.outerHeight === 0,
  };
  summary.likelyDetectableAsAutomation = Object.entries(summary)
    .some(([k, v]) => k !== 'webglRendererPresent' && k !== 'windowSizeIsHeadlessDefault' && v === true);

  return { ...raw, summary };
}
