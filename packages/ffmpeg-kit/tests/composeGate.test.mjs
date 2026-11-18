import assert from 'node:assert/strict';
import { acquireComposeSlot, getComposeGateSnapshot } from '../composeGate.mjs';

const waitFor = async (predicate, timeoutMs = 1000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
};

async function main() {
  const first = await acquireComposeSlot('same-label');
  const second = await acquireComposeSlot('same-label');
  let thirdAcquired = false;
  const thirdPromise = acquireComposeSlot('same-label').then((release) => {
    thirdAcquired = true;
    return release;
  });

  let snapshot = getComposeGateSnapshot();
  assert.equal(snapshot.maxConcurrency, 2);
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.queuedCount, 1);
  assert.deepEqual(snapshot.activeJobs.map((job) => job.label), ['same-label', 'same-label']);
  assert.equal(snapshot.queuedJobs[0].label, 'same-label');

  // 释放同名任务时，只能释放自己的 slot，不能把队列里的同名任务删掉。
  first();
  const third = await thirdPromise;
  assert.equal(thirdAcquired, true);
  snapshot = getComposeGateSnapshot();
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.queuedCount, 0);

  // release 幂等；释放第二个与第三个后，闸门必须完全归零。
  first();
  second();
  third();
  snapshot = getComposeGateSnapshot();
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.queuedCount, 0);

  // FIFO：第三个等待项必须按入队顺序获得名额。
  const a = await acquireComposeSlot('fifo-a');
  const b = await acquireComposeSlot('fifo-b');
  const order = [];
  const cPromise = acquireComposeSlot('fifo-c').then((release) => { order.push('c'); return release; });
  const dPromise = acquireComposeSlot('fifo-d').then((release) => { order.push('d'); return release; });
  a();
  const c = await cPromise;
  b();
  const d = await dPromise;
  assert.deepEqual(order, ['c', 'd']);
  c();
  d();

  await waitFor(() => getComposeGateSnapshot().activeCount === 0);
  console.log('PASS composeGate: hard limit, duplicate labels, FIFO, idempotent release');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
