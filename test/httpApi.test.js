// Integration test HTTP (VN-19): contratti delle API task su un server reale,
// usando il task inerte system.echo. Nessuna dipendenza esterna richiesta.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");
const requestQueue = require("../services/requestQueue");

let server;
let baseUrl;

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timeout in attesa della condizione di test.");
}

async function api(method, apiPath, { body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { status: response.status, json };
}

async function submitEcho({ payload = {}, headers = {} } = {}) {
  return api("POST", "/api/tasks", {
    body: { taskType: "system.echo", payload },
    headers,
  });
}

async function pollUntilStatus(taskId, expectedStatuses, options = {}) {
  const statusSet = new Set(
    Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses],
  );
  let lastTask = null;

  await waitFor(async () => {
    const { status, json } = await api("GET", `/api/tasks/${taskId}`);
    if (status !== 200) return false;
    lastTask = json.task;
    return statusSet.has(lastTask.status);
  }, options);

  return lastTask;
}

test.before(async () => {
  requestQueue.startScheduler();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  requestQueue.stopScheduler();
  await new Promise((resolve) => server.close(resolve));
});

test.afterEach(() => {
  delete process.env.INTERNAL_API_KEY;
});

test("le API rifiutano richieste senza API key quando l'auth e configurata", async () => {
  process.env.INTERNAL_API_KEY = "chiave-di-test";

  const senzaChiave = await api("GET", "/api/tasks");
  assert.equal(senzaChiave.status, 401);

  const chiaveSbagliata = await api("GET", "/api/tasks", {
    headers: { "x-api-key": "chiave-errata" },
  });
  assert.equal(chiaveSbagliata.status, 401);

  const conHeader = await api("GET", "/api/tasks", {
    headers: { "x-api-key": "chiave-di-test" },
  });
  assert.equal(conHeader.status, 200);

  const conBearer = await api("GET", "/api/tasks", {
    headers: { Authorization: "Bearer chiave-di-test" },
  });
  assert.equal(conBearer.status, 200);
});

test("la validazione del payload rifiuta task type sconosciuti o non creabili", async () => {
  const sconosciuto = await api("POST", "/api/tasks", {
    body: { taskType: "non.esiste" },
  });
  assert.equal(sconosciuto.status, 404);

  const nonCreabile = await api("POST", "/api/tasks", {
    body: { taskType: "excel.convert-to-pdf" },
  });
  assert.equal(nonCreabile.status, 400);

  const azioneSconosciuta = await api(
    "POST",
    "/api/cardtrader/run/azione-sconosciuta",
  );
  assert.equal(azioneSconosciuta.status, 404);
  assert.ok(Array.isArray(azioneSconosciuta.json.availableActions));

  const headerMancanti = await api("POST", "/api/tasks", {
    body: { taskType: "shopify.fetch-shop" },
  });
  assert.equal(headerMancanti.status, 400);
  assert.ok(headerMancanti.json.missingHeaders.length > 0);
});

test("submit async: 202 immediato, polling fino a completed, risultato via /result", async () => {
  const submit = await submitEcho({ payload: { marker: "vn-19" } });
  assert.equal(submit.status, 202);
  assert.equal(submit.json.ok, true);
  assert.equal(submit.json.deduplicated, false);
  assert.ok(submit.json.task.id);
  assert.equal(submit.json.links.self, `/api/tasks/${submit.json.task.id}`);

  await pollUntilStatus(submit.json.task.id, "completed");

  const result = await api("GET", `/api/tasks/${submit.json.task.id}/result`);
  assert.equal(result.status, 200);
  assert.equal(result.json.result.echo.marker, "vn-19");
});

test("il result di un task non completato risponde 409", async () => {
  const submit = await submitEcho({ payload: { delayMs: 2_000 } });
  assert.equal(submit.status, 202);

  const prematuro = await api("GET", `/api/tasks/${submit.json.task.id}/result`);
  assert.equal(prematuro.status, 409);

  await api("POST", `/api/tasks/${submit.json.task.id}/cancel`);
  await pollUntilStatus(submit.json.task.id, "cancelled");
});

test("due submit con la stessa Idempotency-Key non creano due task attivi", async () => {
  const primo = await submitEcho({
    payload: { delayMs: 1_500 },
    headers: { "Idempotency-Key": "chiave-idempotente-1" },
  });
  assert.equal(primo.status, 202);

  const secondo = await submitEcho({
    payload: { delayMs: 1_500 },
    headers: { "Idempotency-Key": "chiave-idempotente-1" },
  });
  assert.equal(secondo.status, 200);
  assert.equal(secondo.json.deduplicated, true);
  assert.equal(secondo.json.task.id, primo.json.task.id);

  await api("POST", `/api/tasks/${primo.json.task.id}/cancel`);
  await pollUntilStatus(primo.json.task.id, "cancelled");
});

test("cancel di un task running e retry manuale del task annullato", async () => {
  const submit = await submitEcho({ payload: { delayMs: 10_000 } });
  assert.equal(submit.status, 202);
  const taskId = submit.json.task.id;

  await pollUntilStatus(taskId, "running");

  const cancel = await api("POST", `/api/tasks/${taskId}/cancel`);
  assert.equal(cancel.status, 200);
  await pollUntilStatus(taskId, "cancelled");

  const retry = await api("POST", `/api/tasks/${taskId}/retry`);
  assert.equal(retry.status, 202);
  assert.notEqual(retry.json.task.id, taskId);

  await api("POST", `/api/tasks/${retry.json.task.id}/cancel`);
  await pollUntilStatus(retry.json.task.id, "cancelled");
});

test("le stats della coda espongono conteggi, risorse e tempi medi", async () => {
  const submit = await submitEcho({ payload: { marker: "timing" } });
  await pollUntilStatus(submit.json.task.id, "completed");

  const stats = await api("GET", "/api/tasks/queue/status");
  assert.equal(stats.status, 200);
  assert.ok(stats.json.queue.timings.global.completedCount >= 1);
  assert.ok(stats.json.queue.timings.global.avgExecutionMs >= 0);
  assert.ok(stats.json.queue.timings.byTaskType["system.echo"]);
  assert.ok(stats.json.queue.resources);

  const risorse = await api("GET", "/api/resources/status");
  assert.equal(risorse.status, 200);
  assert.ok(risorse.json.resources.cardtrader.rateLimit);
});
