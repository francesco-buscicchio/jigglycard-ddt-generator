const test = require("node:test");
const assert = require("node:assert/strict");
const { createSyncCycle, runAlignPricesStep } = require("../services/syncCycleScheduler");

const silentLog = { log() {}, warn() {}, error() {} };

test("i passi girano in ordine e uno fallito non blocca i successivi", async () => {
  const calls = [];
  const runCycle = createSyncCycle({
    log: silentLog,
    steps: [
      { name: "prezzi", enabled: true, run: async () => calls.push("prezzi") },
      {
        name: "vemlora",
        enabled: true,
        run: async () => {
          calls.push("vemlora");
          throw new Error("HTTP 502");
        },
      },
      { name: "spento", enabled: false, disabledReason: "off", run: async () => calls.push("spento") },
      { name: "ebay", enabled: true, run: async () => calls.push("ebay") },
    ],
  });

  const outcomes = await runCycle();

  assert.deepEqual(calls, ["prezzi", "vemlora", "ebay"]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.step, outcome.status]),
    [
      ["prezzi", "ok"],
      ["vemlora", "failed"],
      ["spento", "skipped"],
      ["ebay", "ok"],
    ],
  );
  assert.equal(outcomes[1].error, "HTTP 502");
});

test("ogni passo riceve l'esito dei precedenti", async () => {
  let seen = null;
  const runCycle = createSyncCycle({
    log: silentLog,
    steps: [
      { name: "prezzi", enabled: true, run: async () => "ok" },
      { name: "spento", enabled: false, disabledReason: "off", run: async () => {} },
      { name: "report", enabled: true, run: async ({ outcomes }) => (seen = outcomes) },
    ],
  });

  await runCycle();

  assert.deepEqual(
    seen.map((outcome) => [outcome.step, outcome.status]),
    [
      ["prezzi", "ok"],
      ["spento", "skipped"],
    ],
  );
});

test("un tick durante un ciclo in corso viene saltato", async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const runCycle = createSyncCycle({
    log: silentLog,
    steps: [{ name: "lento", enabled: true, run: () => (runs += 1, blocker) }],
  });

  const first = runCycle();
  assert.equal(await runCycle(), null);
  release();
  await first;

  assert.equal(runs, 1);
  // Finito il primo, il ciclo successivo riparte.
  await runCycle();
  assert.equal(runs, 2);
});

function fakeQueue(statuses, { deduplicated = false, result = null, error = null } = {}) {
  const enqueued = [];
  let polls = 0;
  return {
    enqueued,
    enqueueTask(input) {
      enqueued.push(input);
      return { task: { id: "task-7", status: "queued" }, deduplicated };
    },
    getTask() {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return { id: "task-7", status, result, error };
    },
  };
}

test("i prezzi CardTrader passano dalla coda e si aspetta la fine del task", async () => {
  const queue = fakeQueue(["queued", "running", "completed"], { result: [{ totalItems: 3 }] });

  const outcome = await runAlignPricesStep({ queue, token: "tok", pollMs: 1, maxWaitMs: 1_000 });

  assert.equal(queue.enqueued[0].taskType, "cardtrader.align-prices");
  assert.deepEqual(queue.enqueued[0].requestEnv, { cardTraderToken: "tok" });
  assert.deepEqual(outcome, { taskId: "task-7", deduplicated: false, games: [{ totalItems: 3 }] });
});

test("un task prezzi fallito fa fallire il passo con il motivo", async () => {
  const queue = fakeQueue(["running", "failed"], { deduplicated: true, error: { message: "timeout" } });

  await assert.rejects(
    runAlignPricesStep({ queue, token: "tok", pollMs: 1, maxWaitMs: 1_000 }),
    /task-7 \(già in corso\): timeout/,
  );
});

test("oltre l'attesa massima il ciclo prosegue senza aspettare il task", async () => {
  const queue = fakeQueue(["running"]);

  await assert.rejects(
    runAlignPricesStep({ queue, token: "tok", pollMs: 1, maxWaitMs: 5 }),
    /ancora running/,
  );
});

test("un allineamento vecchio gia' concluso non viene riusato: ne parte uno nuovo", async () => {
  const enqueued = [];
  const queue = {
    enqueueTask(input) {
      enqueued.push(input);
      return input.forceNew
        ? { task: { id: "task-200", status: "queued" }, deduplicated: false }
        : { task: { id: "task-166", status: "completed" }, deduplicated: true };
    },
    getTask(id) {
      return { id, status: "completed", result: [{ totalItems: 9 }] };
    },
  };

  const outcome = await runAlignPricesStep({ queue, token: "tok", pollMs: 1, maxWaitMs: 1_000 });

  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[1].forceNew, true);
  assert.deepEqual(outcome, { taskId: "task-200", deduplicated: false, games: [{ totalItems: 9 }] });
});
