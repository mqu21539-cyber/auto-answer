// Notification copy. Kept in one place so the wording can be changed without
// touching the pipeline.
//
// Defaults are intentionally blank: the toast is only a presence ping, and a
// Windows toast renders an empty body fine. Set a string here to show text.

export const MESSAGES = {
  /** Shown when a new question is detected in watch mode. */
  detected: () => '',

  /** Shown after the payload is on the clipboard. */
  ready: () => '',

  /** Shown when a copy fails. */
  failed: () => '',
};

export const TITLES = {
  main: '',
};
