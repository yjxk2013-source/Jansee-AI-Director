import assert from 'node:assert/strict';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';
import { getAdminMonitor, getAdminRenderQueue } from '../../admin.mjs';

async function main() {
  const releaseA = await acquireComposeSlot('image_film_monitor_test_a');
  const releaseB = await acquireComposeSlot('video_dub_monitor_test_b');
  let releaseC;
  const queuedC = acquireComposeSlot('speechcut:monitor_test_c').then((release) => {
    releaseC = release;
  });

  try {
    const queue = getAdminRenderQueue();
    assert.equal(queue.maxConcurrency, 2);
    assert.equal(queue.activeSlotCount, 2);
    assert.equal(queue.pendingQueueCount, 1);
    assert.equal(queue.runningTasks.length, 2);
    assert.equal(queue.queuedTasks.length, 1);

    const monitor = getAdminMonitor();
    assert.equal(monitor.queueBacklog, 1);
    assert.equal(monitor.disk, monitor.storage.disk);
    assert.equal(monitor.disk.status, 'ok');
    assert.ok(monitor.disk.total);
    assert.ok(monitor.disk.used);
    assert.ok(monitor.disk.free);
    assert.notEqual(monitor.disk.total, '512 GB');
    assert.notEqual(monitor.disk.free, '384 GB');

    releaseA();
    await queuedC;
    assert.equal(getAdminRenderQueue().activeSlotCount, 2);
    assert.equal(getAdminRenderQueue().pendingQueueCount, 0);
  } finally {
    releaseA();
    releaseB();
    if (releaseC) releaseC();
  }

  assert.equal(getAdminRenderQueue().activeSlotCount, 0);
  assert.equal(getAdminRenderQueue().pendingQueueCount, 0);
  console.log('PASS admin monitor: real disk fields + live 2-slot gate + FIFO queue metrics');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
