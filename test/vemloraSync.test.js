const test = require("node:test");
const assert = require("node:assert/strict");
const { createVemloraSync, groupByBlueprint } = require("../services/vemloraSyncService");

const silentLog = { log() {}, warn() {}, error() {} };

const exportRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    blueprint_id: 1000 + Math.floor(index / 2),
    quantity: 1,
  }));

// CMS finto: risponde alle fasi secondo uno script per percorso.
function fakeCms(scripts = {}) {
  const calls = [];
  const counters = {};
  return {
    calls,
    http: {
      async post(url, body, options) {
        const path = url.split("/cardtrader-sync/")[1];
        calls.push({ path, body, secret: options.headers["x-cron-secret"] });
        counters[path] = (counters[path] ?? 0) + 1;
        const script = scripts[path];
        const step = Array.isArray(script)
          ? script[Math.min(counters[path] - 1, script.length - 1)]
          : script;
        if (step instanceof Error) throw step;
        if (typeof step === "function") return { data: step(body) };
        return { data: step ?? { ok: true } };
      },
    },
  };
}

const httpError = (status) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });

const baseScripts = () => ({
  start: { ok: true, runId: "run-1" },
  upload: (body) => ({ ok: true, uploaded: body.blueprints.length }),
  products: [{ done: false, phase: "blueprints", remaining: 10 }, { done: true, totals: { created: 3 } }],
  storefront: { done: true, phase: "done", upserted: 5 },
  finish: { ok: true, products: { stats: { created: 3 } }, storefront: { upserted: 5 } },
});

test("l'export si raggruppa per blueprint", () => {
  const grouped = groupByBlueprint([
    { blueprint_id: 1 },
    { blueprint_id: 2 },
    { blueprint_id: 1 },
    { blueprint_id: null },
  ]);
  assert.deepEqual(
    grouped.map((row) => [row.blueprintId, row.items.length]),
    [
      [1, 2],
      [2, 1],
    ],
  );
});

test("start, upload a blocchi, fasi fino a done, finish", async () => {
  const cms = fakeCms(baseScripts());
  const sync = createVemloraSync({
    http: cms.http,
    baseUrl: "https://cms.test",
    secret: "s3cret",
    fetchExport: async () => exportRows(1000), // 500 blueprint
    wait: async () => {},
    log: silentLog,
  });

  const result = await sync();

  assert.deepEqual(
    cms.calls.map((call) => call.path),
    ["start", "upload", "upload", "products", "products", "storefront", "finish"],
  );
  assert.equal(cms.calls[0].body.expectedBlueprints, 500);
  assert.equal(cms.calls[1].body.blueprints.length, 400);
  assert.equal(cms.calls[2].body.blueprints.length, 100);
  assert.ok(cms.calls.every((call) => call.secret === "s3cret"));
  assert.ok(cms.calls.slice(1).every((call) => call.body.runId === "run-1"));
  assert.equal(result.blueprints, 500);
  assert.deepEqual(result.calls, { products: 2, storefront: 1 });
  assert.deepEqual(result.products, { created: 3 });
});

test("504 e lock occupato si ritentano, la fase riprende", async () => {
  const scripts = baseScripts();
  scripts.products = [httpError(504), httpError(409), { done: true, totals: {} }];
  const cms = fakeCms(scripts);
  const waits = [];
  const sync = createVemloraSync({
    http: cms.http,
    fetchExport: async () => exportRows(4),
    wait: async (ms) => waits.push(ms),
    log: silentLog,
  });

  await sync();

  assert.equal(cms.calls.filter((call) => call.path === "products").length, 3);
  assert.deepEqual(waits, [5_000, 15_000]);
});

test("un errore nei prodotti non ferma il catalogo e il passo risulta fallito", async () => {
  const scripts = baseScripts();
  scripts.products = httpError(400);
  const cms = fakeCms(scripts);
  const sync = createVemloraSync({
    http: cms.http,
    fetchExport: async () => exportRows(4),
    wait: async () => {},
    log: silentLog,
  });

  await assert.rejects(sync(), /products: HTTP 400/);
  assert.deepEqual(
    cms.calls.map((call) => call.path),
    ["start", "upload", "products", "storefront", "finish"],
  );
});

test("export vuoto: nessuna chiamata al CMS", async () => {
  const cms = fakeCms(baseScripts());
  const sync = createVemloraSync({
    http: cms.http,
    fetchExport: async () => [],
    wait: async () => {},
    log: silentLog,
  });

  await assert.rejects(sync(), /Export CardTrader vuoto/);
  assert.equal(cms.calls.length, 0);
});
