const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {
  RequestQueue,
} = require("../services/requestQueue");
const {
  listTaskDefinitions,
  validateTaskDefinitions,
} = require("../config/taskDefinitions");
const {
  generateEndpointWeightsDoc,
} = require("../scripts/generateEndpointWeightsDoc");
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

function taskDefinition(overrides = {}) {
  const taskType = overrides.taskType || "test.task";
  return {
    taskType,
    endpoint: overrides.endpoint || `/${taskType}`,
    method: "POST",
    description: overrides.description || `Task ${taskType}`,
    weight: 5,
    resources: ["local"],
    concurrencyGroup: "default",
    timeoutMs: 2_000,
    maxRetries: 0,
    idempotency: { required: false, strategy: "none" },
    operationalNotes: "Definizione task usata dai test.",
    ...overrides,
  };
}

function createQueue(taskDefinitions, options = {}) {
  const resourceLimits = {
    local: { capacity: 100 },
    ...(options.resourceLimits ?? {}),
  };
  const queue = new RequestQueue({
    concurrency: 1,
    maxPendingTasks: 20,
    historyLimit: 50,
    ...options,
    resourceLimits,
    taskDefinitions,
  });

  return queue;
}

test.beforeEach(() => {
  cardTraderRateLimiter.reset();
});

test("esegue prima il task con peso piu basso", async () => {
  const order = [];
  const queue = createQueue([
    taskDefinition({
      taskType: "heavy",
      endpoint: "/heavy",
      description: "Heavy",
      weight: 10,
    }),
    taskDefinition({
      taskType: "urgent",
      endpoint: "/urgent",
      description: "Urgent",
      weight: 1,
    }),
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
    taskDefinition({
      taskType: "a",
      endpoint: "/a",
      description: "A",
      weight: 5,
    }),
    taskDefinition({
      taskType: "b",
      endpoint: "/b",
      description: "B",
      weight: 5,
    }),
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
      taskDefinition({
        taskType: "work",
        endpoint: "/work",
        description: "Work",
        weight: 5,
        timeoutMs: 5_000,
      }),
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
      taskDefinition({
        taskType: "card",
        endpoint: "/card",
        description: "Card",
        weight: 1,
        resources: ["cardtrader"],
        concurrencyGroup: "cardtrader-test",
        rateLimitGroup: "cardtrader",
        timeoutMs: 5_000,
      }),
      taskDefinition({
        taskType: "local",
        endpoint: "/local",
        description: "Local",
        weight: 5,
        timeoutMs: 5_000,
      }),
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
      taskDefinition({
        taskType: "card",
        endpoint: "/card",
        description: "Card",
        weight: 1,
        resources: ["cardtrader"],
        concurrencyGroup: "cardtrader-test",
        rateLimitGroup: "cardtrader",
        timeoutMs: 5_000,
      }),
      taskDefinition({
        taskType: "local",
        endpoint: "/local",
        description: "Local",
        weight: 2,
        timeoutMs: 5_000,
      }),
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
    taskDefinition({
      taskType: "retryable",
      endpoint: "/retryable",
      description: "Retryable",
      weight: 3,
      timeoutMs: 5_000,
      maxRetries: 1,
    }),
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
    taskDefinition({
      taskType: "dedupe",
      endpoint: "/dedupe",
      description: "Dedupe",
      weight: 1,
      timeoutMs: 5_000,
    }),
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

test("rifiuta taskType sconosciuti prima di accodare", () => {
  const queue = createQueue([
    taskDefinition({
      taskType: "known",
      endpoint: "/known",
    }),
  ]);
  queue.registerHandler("known", async () => ({ ok: true }));

  assert.throws(
    () => queue.enqueue({ taskType: "unknown" }),
    /Task type non supportato: unknown/,
  );
});

test("peso, risorse, concorrenza, timeout e retry arrivano dal registry", () => {
  const queue = createQueue([
    taskDefinition({
      taskType: "catalogued",
      endpoint: "/catalogued",
      weight: 2,
      resources: ["local", "database"],
      concurrencyGroup: "catalogued-group",
      timeoutMs: 7_000,
      maxRetries: 4,
      retryBackoff: { strategy: "linear", baseDelayMs: 200, maxDelayMs: 1_000 },
      idempotency: {
        required: false,
        strategy: "client-key",
        keySource: "header:Idempotency-Key",
      },
    }),
  ]);
  queue.registerHandler("catalogued", async () => ({ ok: true }));

  const { task } = queue.enqueue({
    taskType: "catalogued",
    weight: 99,
    timeoutMs: 1,
    maxRetries: 99,
    resources: ["client-controlled"],
    concurrencyGroup: "client-controlled",
  });

  assert.equal(task.weight, 2);
  assert.deepEqual(task.resources, ["local", "database"]);
  assert.equal(task.concurrencyGroup, "catalogued-group");
  assert.equal(task.timeoutMs, 7_000);
  assert.equal(task.maxRetries, 4);
  assert.deepEqual(task.retryBackoff, {
    strategy: "linear",
    baseDelayMs: 200,
    maxDelayMs: 1_000,
  });
  assert.deepEqual(task.idempotency, {
    required: false,
    strategy: "client-key",
    keySource: "header:Idempotency-Key",
  });
});

test("il registry ufficiale e valido e i task CardTrader dichiarano le policy richieste", () => {
  const definitions = listTaskDefinitions();
  assert.deepEqual(validateTaskDefinitions(definitions), []);

  const cardTraderDefinitions = definitions.filter((definition) =>
    definition.resources.includes("cardtrader"),
  );

  assert.ok(cardTraderDefinitions.length > 0);
  for (const definition of cardTraderDefinitions) {
    assert.equal(definition.rateLimitGroup, "cardtrader");
    assert.match(definition.concurrencyGroup, /^cardtrader/);
    assert.equal(definition.idempotency.required, true);
  }
});

test("gli endpoint Express che accodano task usano taskType registrati", async () => {
  const registryTaskTypes = new Set(
    listTaskDefinitions().map((definition) => definition.taskType),
  );
  const cardTraderRoute = await fs.readFile(
    path.join(__dirname, "..", "routes", "cardtrader.js"),
    "utf8",
  );
  const excelRoute = await fs.readFile(
    path.join(__dirname, "..", "routes", "excel.js"),
    "utf8",
  );

  assert.match(cardTraderRoute, /getCardTraderTaskDefinition/);
  assert.match(cardTraderRoute, /taskType: definition\.taskType/);
  assert.match(excelRoute, /getTaskDefinition\(taskType\)/);
  assert.ok(registryTaskTypes.has("excel.convert-to-pdf"));
});

test("la documentazione endpoint/pesi e coerente con il registry", async () => {
  const documentationPath = path.join(
    __dirname,
    "..",
    "docs",
    "endpoint-weights.md",
  );
  const fileContent = await fs.readFile(documentationPath, "utf8");

  assert.equal(fileContent, generateEndpointWeightsDoc());
  assert.match(fileContent, /\| Task type \| Endpoint \| Metodo HTTP \|/);
  assert.match(fileContent, /cardtrader\.align-prices/);
  assert.match(fileContent, /\/api\/tasks\/:taskId\/result/);
});
