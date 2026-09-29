import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/monitor.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { startMonitor, triggerIdleSessions } = await import(
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
      lastTriggered: {}, pending: new Set(),
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
    await triggerIdleSessions({ ...options, isActive });
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
  const check = triggerIdleSessions(options);
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
  const first = triggerIdleSessions(options);
  await flush();
  active = false;
  // A replacement effect targets the same session while the old send is pending.
  await triggerIdleSessions({ ...options, sessionIds: ['a'], isActive: () => true });
  assert.equal(sends, 1);
  delivery.resolve();
  await first;
  assert.equal(options.lastTriggered.a, 'turn-1');
  assert.equal(options.lastTriggered.b, undefined);
  active = true;
  await triggerIdleSessions({ ...options, sessionIds: ['a'] });
  assert.equal(sends, 1);
});

test('running turns are skipped; completed, failed and interrupted turns deduplicate', async () => {
  const { options, sent } = fixture({ sessionIds: ['a'] });
  for (const [index, status] of ['inProgress', 'completed', 'failed', 'interrupted'].entries()) {
    options.getStatus = async () => ({ turn_id: String(index), status });
    await triggerIdleSessions(options);
    await triggerIdleSessions(options);
  }
  assert.deepEqual(sent, ['a', 'a', 'a']);
});

test('failed sends release the lock and can retry', async () => {
  const { options, errors } = fixture({ sessionIds: ['a'], trigger: async () => { throw Error('CLI failed'); } });
  await triggerIdleSessions(options);
  assert.equal(errors.length, 1);
  assert.equal(options.pending.size, 0);
  assert.equal(options.lastTriggered.a, undefined);
  let sends = 0;
  options.trigger = async () => { sends++; };
  await triggerIdleSessions(options);
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
