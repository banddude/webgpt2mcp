import assert from 'node:assert/strict';
import test from 'node:test';

import { createQueueManager } from '../src/server/queue.js';

// Mike (2026-09-17): the boolean browser lock became an awaitable FIFO mutex so a second
// browser-control caller queues instead of being refused ("I can't take over the browser
// right now because another ChatGPT Web task is using it").

test('three concurrent control acquires resolve in arrival order and release passes control on', async () => {
    const queueManager = createQueueManager({}, {});
    const granted = [];

    const first = await queueManager.acquireControlLock('first');
    assert.equal(queueManager.isControlLocked(), true);
    assert.equal(queueManager.getStatus().browserControlReason, 'first');

    // Two more line up while the first holds the browser; neither may be granted early.
    const second = queueManager.acquireControlLock('second').then((release) => { granted.push('second'); return release; });
    const third = queueManager.acquireControlLock('third').then((release) => { granted.push('third'); return release; });
    await Promise.resolve();
    assert.deepEqual(granted, []);
    assert.equal(queueManager.getStatus().browserControlQueued, 2);
    assert.deepEqual(queueManager.getDetailedStatus(), { processing: ['first'], waiting: ['second', 'third'] });

    first(); // releasing hands the browser straight to the next waiter
    const releaseSecond = await second;
    assert.deepEqual(granted, ['second']);
    assert.equal(queueManager.getStatus().browserControlReason, 'second');

    releaseSecond();
    const releaseThird = await third;
    assert.deepEqual(granted, ['second', 'third']);

    releaseThird();
    assert.equal(queueManager.isControlLocked(), false);
    assert.equal(queueManager.getStatus().browserControlLocked, false);
    assert.equal(queueManager.getStatus().browserControlQueued, 0);
});

test('the control wait cap gives up with its queue position instead of hanging forever', async () => {
    // The cap used to be a straight refusal; now the caller waits, and only past the cap
    // does it give up so the route can answer 409 with queue_position/waited_ms.
    const queueManager = createQueueManager({}, {});
    const release = await queueManager.acquireControlLock('holder');
    const queued = queueManager.acquireControlLock('queued', { waitMs: 20 });
    const stillQueued = queueManager.acquireControlLock('behind', { waitMs: 5000 });

    await assert.rejects(queued, (error) => {
        assert.equal(error.code, 'BROWSER_CONTROL_WAIT_TIMEOUT');
        assert.equal(error.queuePosition, 1);
        assert.ok(error.waitedMs >= 15, `waitedMs ${error.waitedMs} must reflect the 20ms cap`);
        return true;
    });

    // The timed-out waiter leaves no residue: the one behind it still gets control.
    release();
    const releaseBehind = await stillQueued;
    assert.equal(queueManager.getStatus().browserControlReason, 'behind');
    releaseBehind();
    assert.equal(queueManager.isControlLocked(), false);
});

test('a queued stop jumps ahead of unrelated queued dispatches but never preempts the holder', async () => {
    const queueManager = createQueueManager({}, {});
    const granted = [];
    const holder = await queueManager.acquireControlLock('chatgpt-dispatch');

    const dispatch2 = queueManager.acquireControlLock('chatgpt-dispatch').then((release) => { granted.push('dispatch2'); return release; });
    const stop = queueManager.acquireControlLock('chatgpt-stop').then((release) => { granted.push('stop'); return release; });
    await Promise.resolve();

    holder(); // the holder finishes on its own; the stop only jumps the wait line
    const releaseStop = await stop;
    assert.deepEqual(granted, ['stop']);
    releaseStop();
    const releaseDispatch2 = await dispatch2;
    assert.deepEqual(granted, ['stop', 'dispatch2']);
    releaseDispatch2();
    assert.equal(queueManager.isControlLocked(), false);
});

test('a client that hangs up while queued leaves the line without taking the browser', async () => {
    const queueManager = createQueueManager({}, {});
    const release = await queueManager.acquireControlLock('holder');
    const controller = new AbortController();
    const queued = queueManager.acquireControlLock('chatgpt-dispatch', { signal: controller.signal });

    controller.abort();
    await assert.rejects(queued, (error) => error.code === 'BROWSER_CONTROL_WAIT_ABORTED');
    assert.equal(queueManager.getStatus().browserControlQueued, 0);

    release(); // no phantom waiter: the lock is simply free
    assert.equal(queueManager.isControlLocked(), false);

    // An abort that arrives after a grant is a no-op: the holder keeps the browser.
    const holderController = new AbortController();
    const granted = await queueManager.acquireControlLock('in-flight', { signal: holderController.signal });
    holderController.abort();
    assert.equal(queueManager.isControlLocked(), true);
    granted();
    assert.equal(queueManager.isControlLocked(), false);
});
