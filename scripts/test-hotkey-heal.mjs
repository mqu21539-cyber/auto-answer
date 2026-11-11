// Hotkey listener self-healing: the listener is a separate process and can die
// on its own. It must be replaced automatically, and if it cannot be kept alive
// the caller must be told instead of being left with a silent zombie.

import { startHotkey } from './lib/hotkey.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function testRestart() {
  const messages = [];
  let deadCalled = false;

  const hk = startHotkey('CTRL+ALT+J', () => {}, {
    restartDelayMs: 1500,
    maxRestarts: 3,
    log: (m) => messages.push(m),
    onDead: () => { deadCalled = true; },
  });

  await wait(3000);
  const firstPid = hk.child?.pid ?? null;
  if (!firstPid) {
    hk.stop();
    return { ok: false, error: 'listener never started', messages };
  }

  // Simulate the listener dying on its own (antivirus, Windows update, crash).
  try { process.kill(firstPid); } catch { /* already gone */ }

  await wait(4000);

  const secondPid = hk.child?.pid ?? null;
  const restarts = hk.restarts();
  const replaced = Boolean(secondPid) && secondPid !== firstPid;
  const stillAlive = hk.child?.exitCode === null;

  hk.stop();
  await wait(800);

  return {
    ok: replaced && restarts === 1 && stillAlive && !deadCalled,
    firstPid,
    secondPid,
    replaced,
    restarts,
    stillAlive,
    deadCalled,
    messages,
  };
}

async function testGiveUp() {
  const messages = [];
  let deadReason = null;

  // maxRestarts: 0 means the very first death is fatal.
  const hk = startHotkey('CTRL+ALT+J', () => {}, {
    restartDelayMs: 800,
    maxRestarts: 0,
    log: (m) => messages.push(m),
    onDead: (reason) => { deadReason = reason; },
  });

  await wait(3000);
  const pid = hk.child?.pid ?? null;
  if (!pid) {
    hk.stop();
    return { ok: false, error: 'listener never started', messages };
  }

  try { process.kill(pid); } catch { /* already gone */ }
  await wait(2500);

  hk.stop();
  await wait(500);

  return {
    ok: Boolean(deadReason) && hk.restarts() === 1,
    pid,
    deadReason,
    restarts: hk.restarts(),
    messages,
  };
}

async function testStopDoesNotRestart() {
  const messages = [];
  const hk = startHotkey('CTRL+ALT+J', () => {}, {
    restartDelayMs: 1000,
    maxRestarts: 3,
    log: (m) => messages.push(m),
  });

  await wait(2500);
  const pid = hk.child?.pid ?? null;
  hk.stop();               // deliberate stop
  await wait(2500);        // longer than restartDelayMs

  const restarts = hk.restarts();
  return {
    ok: restarts === 0 && !messages.some((m) => /restarting/.test(m)),
    pid,
    restarts,
    messages,
  };
}

async function main() {
  const restart = await testRestart();
  const giveUp = await testGiveUp();
  const deliberate = await testStopDoesNotRestart();

  const ok = restart.ok && giveUp.ok && deliberate.ok;

  console.log(JSON.stringify({
    ok,
    restart,
    giveUp,
    deliberateStop: deliberate,
  }, null, 2));

  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exitCode = 1;
});