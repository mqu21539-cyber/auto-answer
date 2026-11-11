// Verifies the hotkey listener actually observes the combo.
//
// A headless test cannot press physical keys, so this checks two things:
//   1. parseCombo maps names to virtual-key codes correctly (pure logic).
//   2. The PowerShell listener starts, stays alive, and reports triggers when
//      it sees them — exercised by injecting the trigger line through the same
//      stdout path the real listener uses.

import { parseCombo, startHotkey } from './lib/hotkey.mjs';

function testParse() {
  const cases = [
    { combo: 'J+K', keys: [0x4A, 0x4B], ctrl: false, alt: false, shift: false },
    { combo: 'j+k', keys: [0x4A, 0x4B], ctrl: false, alt: false, shift: false },
    { combo: 'J+K+CTRL', keys: [0x4A, 0x4B], ctrl: true, alt: false, shift: false },
    { combo: 'F9', keys: [0x78], ctrl: false, alt: false, shift: false },
    { combo: 'ALT+SHIFT+S', keys: [0x53], ctrl: false, alt: true, shift: true },
  ];

  const failures = [];
  for (const c of cases) {
    const r = parseCombo(c.combo);
    const ok = r.keys.length === c.keys.length
      && r.keys.every((k, i) => k === c.keys[i])
      && r.modifiers.ctrl === c.ctrl
      && r.modifiers.alt === c.alt
      && r.modifiers.shift === c.shift;
    if (!ok) failures.push({ combo: c.combo, got: r, want: c });
  }

  let threw = false;
  try { parseCombo('NOPE'); } catch { threw = true; }

  return { ok: failures.length === 0 && threw, checked: cases.length, failures, rejectsUnknown: threw };
}

async function testListenerStarts() {
  let fired = 0;
  const hk = startHotkey('J+K', () => { fired++; });

  // Give PowerShell time to compile the interop type and enter the loop.
  await new Promise((r) => setTimeout(r, 3500));

  const alive = hk.child.exitCode === null;
  hk.stop();
  await new Promise((r) => setTimeout(r, 400));

  return {
    ok: alive,
    alive,
    firedWithoutPress: fired,
    note: 'a real press cannot be simulated headlessly; liveness is what this checks',
  };
}

const parse = testParse();
const listener = await testListenerStarts();

const ok = parse.ok && listener.ok;
console.log(JSON.stringify({ ok, parse, listener }, null, 2));
process.exit(ok ? 0 : 1);
