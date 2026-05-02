const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {
  RequestQueue,
} = require("../services/requestQueue");
const cardTraderRateLimiter = require("../services/cardTraderRateLimiter");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timeout in attesa della condizione di test.");
}

function createQueue(taskDefinitions, options = {}) {
  const queue = new RequestQueue({
    concurrency: 1,
    maxPendingTasks: 20,
    historyLimit: 50,
    taskDefinitions,
    ...options,
  });

  return queue;
}

test.beforeEach(() => {
  cardTraderRateLimiter.reset();
});

test("esegue prima il task con peso piu basso", async () => {
  const order = [];
  const queue = createQueue([
    {
      taskType: "heavy",
      endpoint: "/heavy",
      method: "POST",
      description: "Heavy",
      weight: 10,
      resources: [],
      timeoutMs: 2_000,
    },
    {
      taskType: "urgent",
      endpoint: "/urgent",
      method: "POST",
      description: "Urgent",
      weight: 1,
      resources: [],
      timeoutMs: 2_000,
    },
  ]);

  queue.registerHandler("heavy", async () => {
    order.push("heavy");
  });
  queue.registerHandler("urgent", async () => {
    order.push("urgent");
  });

  queue.enqueue({ taskType: "heavy" });
  queue.enqueue({ taskType: "urgent" });

  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["urgent", "heavy"]);
});

test("mantiene FIFO a parita di peso", async () => {
  const order = [];
  const queue = createQueue([
    {
      taskType: "a",
      endpoint: "/a",
      method: "POST",
      description: "A",
      weight: 5,
      resources: [],
      timeoutMs: 2_000,
    },
    {
      taskType: "b",
      endpoint: "/b",
      method: "POST",
      description: "B",
      weight: 5,
      resources: [],
      timeoutMs: 2_000,
    },
  ]);

  queue.registerHandler("a", async () => {
    order.push("a");
  });
  queue.registerHandler("b", async () => {
    order.push("b");
  });

  queue.enqueue({ taskType: "a" });
  queue.enqueue({ taskType: "b" });

  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["a", "b"]);
});

test("rispetta il limite massimo di task concorrenti", async () => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const taskDeferred = createDeferred();
  const queue = createQueue(
    [
      {
        taskType: "work",
        endpoint: "/work",
        method: "POST",
        description: "Work",
        weight: 5,
        resources: [],
        timeoutMs: 5_000,
      },
    ],
    { concurrency: 2 },
  );

  queue.registerHandler("work", async () => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await taskDeferred.promise;
    active -= 1;
  });

  queue.enqueue({ taskType: "work" });
  queue.enqueue({ taskType: "work" });
  queue.enqueue({ taskType: "work" });

  await waitFor(() => started === 2);
  assert.equal(maxActive, 2);

  taskDeferred.resolve();
  await waitFor(() => started === 3);
});

test("un task rate-limited su CardTrader non blocca un task non CardTrader", async () => {
  cardTraderRateLimiter.blockedUntil = Date.now() + 250;

  let cardStarted = false;
  let localStarted = false;
  const localDeferred = createDeferred();

  const queue = createQueue(
    [
      {
        taskType: "card",
        endpoint: "/card",
        method: "POST",
        description: "Card",
        weight: 1,
        resources: ["cardtrader"],
        timeoutMs: 5_000,
      },
      {
        taskType: "local",
        endpoint: "/local",
        method: "POST",
        description: "Local",
        weight: 5,
        resources: [],
        timeoutMs: 5_000,
      },
    ],
    { concurrency: 2 },
  );

  queue.registerHandler("card", async () => {
    cardStarted = true;
  });
  queue.registerHandler("local", async () => {
    localStarted = true;
    await localDeferred.promise;
  });

  queue.enqueue({ taskType: "card" });
  queue.enqueue({ taskType: "local" });

  await waitFor(() => localStarted === true);
  assert.equal(cardStarted, false);

  localDeferred.resolve();
  await waitFor(() => queue.listTasks({ statuses: ["completed"] }).length === 2, {
    timeoutMs: 3_000,
  });
});

test("il lock CardTrader lascia partire altri task senza quella risorsa", async () => {
  let cardStarted = 0;
  let localStarted = false;
  const firstCardDeferred = createDeferred();
  const localDeferred = createDeferred();

  const queue = createQueue(
    [
      {
        taskType: "card",
        endpoint: "/card",
        method: "POST",
        description: "Card",
        weight: 1,
        resources: ["cardtrader"],
        timeoutMs: 5_000,
      },
      {
        taskType: "local",
        endpoint: "/local",
        method: "POST",
        description: "Local",
        weight: 2,
        resources: [],
        timeoutMs: 5_000,
      },
    ],
    { concurrency: 2 },
  );

  queue.registerHandler("card", async () => {
    cardStarted += 1;
    if (cardStarted === 1) {
      await firstCardDeferred.promise;
    }
  });
  queue.registerHandler("local", async () => {
    localStarted = true;
    await localDeferred.promise;
  });

  const first = queue.enqueue({ taskType: "card" });
  const second = queue.enqueue({ taskType: "card" });
  queue.enqueue({ taskType: "local" });

  await waitFor(() => localStarted === true);
  assert.equal(cardStarted, 1);

  const secondTask = queue.getTask(second.task.id);
  assert.equal(secondTask.status, "waiting_resource");

  localDeferred.resolve();
  firstCardDeferred.resolve();

  await waitFor(() => cardStarted === 2);
  const firstTask = queue.getTask(first.task.id);
  assert.equal(firstTask.status, "completed");
});

test("retry e backoff controllato completano il task al secondo tentativo", async () => {
  let attempts = 0;
  const queue = createQueue([
    {
      taskType: "retryable",
      endpoint: "/retryable",
      method: "POST",
      description: "Retryable",
      weight: 3,
      resources: [],
      timeoutMs: 5_000,
      maxRetries: 1,
    },
  ]);

  queue.registerHandler("retryable", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("boom");
    }
    return { ok: true };
  });

  const { task } = queue.enqueue({ taskType: "retryable" });
  await waitFor(() => {
    const latestTask = queue.getTask(task.id);
    return latestTask?.status === "completed";
  }, {
    timeoutMs: 4_000,
  });

  const completedTask = queue.getTask(task.id);
  assert.equal(completedTask.retryCount, 1);
  assert.deepEqual(completedTask.result, { ok: true });
});

test("deduplica due enqueue con la stessa idempotency key", async () => {
  const deferred = createDeferred();
  const queue = createQueue([
    {
      taskType: "dedupe",
      endpoint: "/dedupe",
      method: "POST",
      description: "Dedupe",
      weight: 1,
      resources: [],
      timeoutMs: 5_000,
    },
  ]);

  queue.registerHandler("dedupe", async () => {
    await deferred.promise;
  });

  const first = queue.enqueue({
    taskType: "dedupe",
    idempotencyKey: "same-key",
  });
  const second = queue.enqueue({
    taskType: "dedupe",
    idempotencyKey: "same-key",
  });

  assert.equal(second.deduplicated, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(queue.listTasks({ limit: 10 }).length, 1);

  deferred.resolve();
  await waitFor(() => queue.getTask(first.task.id)?.status === "completed");
});

test("la documentazione endpoint/pesi esiste e contiene la tabella", async () => {
  const documentationPath = path.join(
    __dirname,
    "..",
    "docs",
    "endpoint-weights.md",
  );
  const fileContent = await fs.readFile(documentationPath, "utf8");

  assert.match(fileContent, /Endpoint Weights And Queue Contracts/);
  assert.match(fileContent, /\| Endpoint \| Metodo \| Descrizione \| Task type \|/);
  assert.match(fileContent, /\/api\/cardtrader\/run\/align-prices/);
  assert.match(fileContent, /\/api\/tasks\/:taskId\/result/);
});
