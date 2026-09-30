import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/monitor.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { startMonitor, checkMonitoredSessions } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const sent = [];
  const errors = [];
  return {
    sent, errors,
    options: {
      sessionIds: ['a', 'b'], isActive: () => true,
      states: {}, quotaAllowed: true, pending: new Set(), onStop: () => {},
      getStatus: async () => ({ turn_id: 'turn-1', status: 'completed' }),
      trigger: async id => { sent.push(id); },
      onError: error => errors.push(error), ...overrides,
    },
  };
}

test('stopping during quota lookup prevents sending and rescheduling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quota = deferred();
  let checks = 0;
  const { sent, options } = fixture();
  const stop = startMonitor(async isActive => {
    checks++;
    await quota.promise;
    await checkMonitoredSessions({ ...options, isActive });
    return 30_000;
  }, () => true);
  stop();
  quota.resolve();
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(checks, 1);
  assert.deepEqual(sent, []);
});

test('stop during status lookup prevents a queued message', async () => {
  const status = deferred();
  let active = true;
  const { options, sent } = fixture({ isActive: () => active, getStatus: () => status.promise });
  const check = checkMonitoredSessions(options);
  active = false;
  status.resolve({ turn_id: 'turn-1', status: 'completed' });
  await check;
  assert.deepEqual(sent, []);
  assert.equal(options.pending.size, 0);
});

test('overlapping checks send once and remember in-flight success after stop', async () => {
  const delivery = deferred();
  let active = true;
  let sends = 0;
  const { options } = fixture({
    isActive: () => active,
    trigger: async () => { sends++; await delivery.promise; },
  });
  const first = checkMonitoredSessions(options);
  await flush();
  active = false;
  // A replacement effect targets the same session while the old send is pending.
  await checkMonitoredSessions({ ...options, sessionIds: ['a'], isActive: () => true });
  assert.equal(sends, 1);
  delivery.resolve();
  await first;
  assert.equal(options.states.a.lastSentTurn, 'turn-1');
  assert.equal(options.states.b, undefined);
  active = true;
  await checkMonitoredSessions({ ...options, sessionIds: ['a'] });
  assert.equal(sends, 1);
});

test('failed sends release the lock and can retry', async () => {
  const { options, errors } = fixture({ sessionIds: ['a'], trigger: async () => { throw Error('CLI failed'); } });
  await checkMonitoredSessions(options);
  assert.equal(errors.length, 1);
  assert.equal(options.pending.size, 0);
  assert.equal(options.states.a, undefined);
  let sends = 0;
  options.trigger = async () => { sends++; };
  await checkMonitoredSessions(options);
  assert.equal(sends, 1);
});

test('active loops poll until stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const stop = startMonitor(async () => { checks++; return 30_000; }, () => true);
  await flush();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(checks, 2);
  stop();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(checks, 2);
});

const turn = (id, status, limited = false) => ({ turn_id: id, status, is_usage_limited: limited });

test('first available quota sends once regardless of prior turn status', async () => {
  for (const status of ['completed', 'inProgress', 'failed', 'interrupted']) {
    const { options, sent } = fixture({ sessionIds: ['a'], quotaAllowed: false, getStatus: async () => turn('old', status) });
    await checkMonitoredSessions(options);
    assert.equal(sent.length, 0);
    options.quotaAllowed = true;
    await checkMonitoredSessions(options);
    assert.equal(sent.length, 1);
    await checkMonitoredSessions(options);
    assert.equal(sent.length, 1);
  }
});

test('running and normally completed new turns stop even without quota', async () => {
  for (const status of ['inProgress', 'completed']) {
    const stopped = [];
    const { options, sent } = fixture({ sessionIds: ['a'], onStop: id => stopped.push(id) });
    await checkMonitoredSessions(options);
    options.getStatus = async () => turn('new', status);
    options.quotaAllowed = false;
    await checkMonitoredSessions(options);
    options.quotaAllowed = true;
    await checkMonitoredSessions(options);
    assert.equal(sent.length, 1);
    assert.deepEqual(stopped, ['a']);
    assert.equal(options.states.a.phase, 'stopped');
  }
});

test('quota interruption waits for recovery, resends once and keeps checking', async () => {
  const { options, sent } = fixture({ sessionIds: ['a'] });
  await checkMonitoredSessions(options);
  options.getStatus = async () => turn('limited-1', 'failed', true);
  options.quotaAllowed = false;
  await checkMonitoredSessions(options);
  assert.equal(sent.length, 1);
  assert.equal(options.states.a.phase, 'waiting_quota');
  options.quotaAllowed = true;
  await checkMonitoredSessions(options);
  await checkMonitoredSessions(options);
  assert.equal(sent.length, 2);
  options.getStatus = async () => turn('limited-2', 'interrupted', true);
  await checkMonitoredSessions(options);
  assert.equal(sent.length, 3);
  options.getStatus = async () => turn('success', 'completed');
  await checkMonitoredSessions(options);
  assert.equal(options.states.a.phase, 'stopped');
});

test('ordinary failure and manual interruption stop without resending', async () => {
  for (const status of ['failed', 'interrupted']) {
    const { options, sent } = fixture({ sessionIds: ['a'] });
    await checkMonitoredSessions(options);
    options.getStatus = async () => turn('new', status);
    await checkMonitoredSessions(options);
    assert.equal(sent.length, 1);
    assert.equal(options.states.a.phase, 'stopped');
  }
});

test('old completed turn, missing status, and unknown status do not resend or stop', async () => {
  const { options, sent } = fixture({ sessionIds: ['a'] });
  await checkMonitoredSessions(options);
  for (const result of [turn('turn-1', 'completed'), null, turn('new', 'unknown')]) {
    options.getStatus = async () => result;
    await checkMonitoredSessions(options);
    assert.equal(sent.length, 1);
    assert.equal(options.states.a.phase, 'awaiting_result');
  }
});

test('multi-session monitoring stops each session independently', async () => {
  const stopped = [];
  const { options, sent } = fixture({ onStop: id => stopped.push(id) });
  await checkMonitoredSessions(options);
  options.getStatus = async id => turn('new', id === 'a' ? 'inProgress' : 'failed', id === 'b');
  options.quotaAllowed = false;
  await checkMonitoredSessions(options);
  assert.deepEqual(stopped, ['a']);
  assert.equal(options.states.b.phase, 'waiting_quota');
  options.quotaAllowed = true;
  await checkMonitoredSessions(options);
  assert.deepEqual(sent, ['a', 'b', 'b']);
});

test('fresh monitoring run sends again without inheriting previous stop state', async () => {
  const { options, sent } = fixture({ sessionIds: ['a'] });
  await checkMonitoredSessions(options);
  options.getStatus = async () => turn('new', 'completed');
  await checkMonitoredSessions(options);
  await checkMonitoredSessions({ ...options, states: {} });
  assert.equal(sent.length, 2);
});

test('database read errors do not authorize sending', async () => {
  const { options, errors, sent } = fixture({ sessionIds: ['a'], getStatus: async () => { throw Error('database unavailable'); } });
  await checkMonitoredSessions(options);
  assert.equal(errors.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(options.states.a, undefined);
});
