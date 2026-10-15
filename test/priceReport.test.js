const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildPriceSnapshot,
  comparePriceSnapshots,
  renderPriceReport,
  nextReportAt,
  createPriceReport,
} = require("../services/priceReportService");

const listing = (id, priceCents, quantity, overrides = {}) => ({
  id,
  blueprint_id: 1000 + id,
  name_en: `Carta ${id}`,
  price_cents: priceCents,
  quantity,
  expansion: { id: 42 },
  properties_hash: { condition: "Near Mint", pokemon_language: "it", pokemon_reverse: false },
  ...overrides,
});

const snapshotOf = (items, takenAt = "2026-10-02T07:00:00Z") => buildPriceSnapshot(items, takenAt);

test("variazioni di prezzo e valore totale rispetto al giro precedente", () => {
  const previous = snapshotOf([
    listing(1, 1000, 2), // +5 €
    listing(2, 500, 1), // −2 €
    listing(3, 200, 4), // invariata, ma 1 venduta
    listing(4, 300, 1), // tolta
  ]);
  const current = snapshotOf([
    listing(1, 1500, 2),
    listing(2, 300, 1),
    listing(3, 200, 3),
    listing(5, 100, 2), // nuova
  ]);

  const report = comparePriceSnapshots(previous, current, { top: 10 });

  assert.equal(report.changed, 2);
  assert.equal(report.increased, 1);
  assert.equal(report.decreased, 1);
  assert.deepEqual(report.topIncreases.map((change) => [change.id, change.deltaCents]), [[1, 500]]);
  assert.deepEqual(report.topDecreases.map((change) => [change.id, change.deltaCents]), [[2, -200]]);
  assert.equal(report.topDecreases[0].deltaPct, -40);

  // Prima: 20 + 5 + 8 + 3 = 36 €. Dopo: 30 + 3 + 6 + 2 = 41 €.
  assert.equal(report.valueBeforeCents, 3600);
  assert.equal(report.valueAfterCents, 4100);
  assert.equal(report.valueDeltaCents, 500);
  // Cambi di prezzo: +5 € x 2 − 2 € x 1 = +8 €; il resto (−3 €) sono quantità.
  assert.equal(report.priceEffectCents, 800);
  assert.equal(report.quantityEffectCents, -300);
  assert.equal(report.newListings, 1);
  assert.equal(report.removedListings, 1);
});

test("le liste si ordinano per variazione in euro e rispettano il limite", () => {
  const previous = snapshotOf([listing(1, 100, 1), listing(2, 100, 1), listing(3, 100, 1)]);
  const current = snapshotOf([listing(1, 150, 1), listing(2, 900, 1), listing(3, 300, 1)]);

  const report = comparePriceSnapshots(previous, current, { top: 2 });

  assert.deepEqual(report.topIncreases.map((change) => change.id), [2, 3]);
});

test("l'email riporta riepilogo, carte e variante", () => {
  const previous = snapshotOf([listing(1, 1000, 2, { name_en: "Pikachu <ex>" })]);
  const current = snapshotOf([listing(1, 1250, 2, { name_en: "Pikachu <ex>" })], "2026-10-02T07:30:00Z");
  const report = comparePriceSnapshots(previous, current);

  const message = renderPriceReport({
    report,
    takenAt: "2026-10-02T07:30:00Z",
    expansionNames: new Map([[42, "Ascesa Eroica"]]),
    outcomes: [{ step: "prezzi CardTrader", status: "ok", elapsedMs: 90_000 }],
  });

  assert.match(message.subject, /1 prezzi cambiati, valore \+5,00\s€ \(\+25%\)/);
  assert.match(message.html, /Pikachu &lt;ex&gt;/);
  assert.match(message.html, /Ascesa Eroica/);
  assert.match(message.text, /Near Mint · IT/);
  assert.match(message.text, /prezzi CardTrader: ok \(90 s\)/);
});

test("primo giro: fotografia salvata, email di avvio senza confronto", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "price-report-")), "snapshot.json");
  const sent = [];
  const report = createPriceReport({
    fetchItems: async () => [listing(1, 1000, 2)],
    send: async (message) => sent.push(message),
    snapshotFile: file,
    recipients: ["a@example.com", "b@example.com"],
    now: () => new Date("2026-10-02T07:00:00Z"),
  });

  const result = await report({ outcomes: [] });

  assert.deepEqual(result, { first: true, listings: 1 });
  assert.match(sent[0].subject, /prima fotografia/);
  assert.deepEqual(sent[0].to, ["a@example.com", "b@example.com"]);
  assert.ok(fs.existsSync(file));
});

test("se l'invio fallisce la fotografia precedente resta, il giro dopo la copre", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "price-report-")), "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(snapshotOf([listing(1, 1000, 1)])));
  let items = [listing(1, 1100, 1)];
  let fail = true;
  const sent = [];
  const report = createPriceReport({
    fetchItems: async () => items,
    send: async (message) => {
      if (fail) throw new Error("SMTP giù");
      sent.push(message);
    },
    snapshotFile: file,
    recipients: ["a@example.com"],
  });

  await assert.rejects(report(), /SMTP giù/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).items[1].priceCents, 1000);

  fail = false;
  items = [listing(1, 1300, 1)];
  const result = await report();
  // Variazione cumulata dal 10 € del giro riuscito precedente.
  assert.equal(result.valueDeltaCents, 300);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).items[1].priceCents, 1300);
});

test("le scadenze del report cadono su multipli fissi dell'intervallo", () => {
  const twoHours = 2 * 60 * 60 * 1000;
  assert.equal(nextReportAt("2026-10-15T08:05:30Z", twoHours).toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(nextReportAt("2026-10-15T09:59:00Z", twoHours).toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(nextReportAt("2026-10-15T08:05:30Z", 0), null);
  assert.equal(nextReportAt(undefined, twoHours), null);
});

test("ogni due ore: i giri in mezzo saltano e il confronto è con l'ultimo invio", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "price-report-")), "snapshot.json");
  let clock = new Date("2026-10-15T08:05:00Z");
  let items = [listing(1, 1000, 1)];
  const sent = [];
  const report = createPriceReport({
    fetchItems: async () => items,
    send: async (message) => sent.push(message),
    snapshotFile: file,
    recipients: ["a@example.com"],
    intervalMs: 2 * 60 * 60 * 1000,
    now: () => clock,
  });

  // Nessun invio precedente: il report è dovuto subito.
  assert.equal(report.skipReason(), null);
  await report();

  // Giri delle 08:35, 09:05, 09:35: report saltato, fotografia intatta
  // anche se nel frattempo i prezzi cambiano.
  for (const time of ["08:35", "09:05", "09:35"]) {
    clock = new Date(`2026-10-15T${time}:00Z`);
    items = [listing(1, 1000 + Number(time.slice(3)), 1)];
    assert.match(report.skipReason(), /prossimo dopo le/);
  }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).takenAt, "2026-10-15T08:05:00.000Z");

  clock = new Date("2026-10-15T10:05:00Z");
  items = [listing(1, 1250, 1)];
  assert.equal(report.skipReason(), null);
  const result = await report();

  // Variazione dal report delle 08:05 (10 €), non dal giro delle 09:35.
  assert.equal(result.valueDeltaCents, 250);
  assert.equal(sent.length, 2);
  assert.match(sent[1].html, /rispetto al report del 15\/10\/2026, 10:05/);
});
