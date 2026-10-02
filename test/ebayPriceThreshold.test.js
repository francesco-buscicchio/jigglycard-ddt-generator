const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSyncPrice } = require("../services/ebaySyncService");

const options = { markupPercent: 50 };
const settings = {};

function product(ctEur, rarity = "Holo Rare") {
  return {
    id: 1,
    price_cents: Math.round(ctEur * 100),
    properties_hash: { pokemon_rarity: rarity },
  };
}

test("sotto il 2% di variazione CT il prezzo eBay resta invariato", () => {
  const entry = { priceEur: 30, ctPriceEur: 20 };
  const result = resolveSyncPrice(entry, product(19.7), {}, options, settings);
  assert.equal(result.priceEur, 30);
  assert.equal(result.ctBaseEur, 20);
});

test("oltre il 2% il prezzo segue CT + ricarico e la base si aggiorna", () => {
  const entry = { priceEur: 30, ctPriceEur: 20 };
  const result = resolveSyncPrice(entry, product(19.5), {}, options, settings);
  assert.equal(result.priceEur, 29.25);
  assert.equal(result.ctBaseEur, 19.5);
});

test("anche i rialzi oltre il 2% aggiornano il prezzo", () => {
  const entry = { priceEur: 30, ctPriceEur: 20 };
  const result = resolveSyncPrice(entry, product(21), {}, options, settings);
  assert.equal(result.priceEur, 31.5);
});

test("il minimo per rarità resta applicato", () => {
  const entry = { priceEur: 1.2, ctPriceEur: 0.1 };
  const result = resolveSyncPrice(entry, product(0.05, "Uncommon"), {}, options, settings);
  assert.equal(result.priceEur, 1.2);
});

test("un prezzo fisso si applica sempre, senza soglia", () => {
  const entry = { priceEur: 5, ctPriceEur: 3 };
  const result = resolveSyncPrice(entry, product(3), { price: 4.99 }, options, settings);
  assert.equal(result.priceEur, 4.99);
});

test("inserzioni senza base CT: confronto diretto tra prezzo calcolato e online", () => {
  const small = resolveSyncPrice({ priceEur: 30 }, product(19.9), {}, options, settings);
  assert.equal(small.priceEur, 30);
  assert.equal(small.ctBaseEur, 19.9);
  const large = resolveSyncPrice({ priceEur: 30 }, product(25), {}, options, settings);
  assert.equal(large.priceEur, 37.5);
});

test("ricarico ridotto: sopra 2 EUR CT +25%, mai sotto 2 EUR, sotto resta +50%", () => {
  const reduced = { ...options, reducedMarkup: { thresholdEur: 2, markupPercent: 25 } };
  const price = (ct) => resolveSyncPrice({ priceEur: null }, product(ct), {}, reduced, settings).priceEur;
  assert.equal(price(1.2), 1.8); // 1,2 * 1,5 sotto soglia
  assert.equal(price(1.5), 2); // 2,25 a +50% ma 1,875 a +25%: si ferma a 2
  assert.equal(price(10), 12.5);
  // prezzo sempre crescente attorno alla soglia
  const values = [1.3, 1.34, 1.4, 1.6, 1.7].map(price);
  values.reduce((prev, cur) => { assert.ok(cur >= prev); return cur; });
});

test("un cambio di regola aggiorna il prezzo anche senza variazione CT", () => {
  const reduced = { ...options, reducedMarkup: { thresholdEur: 2, markupPercent: 25 } };
  const entry = { priceEur: 30, ctPriceEur: 20 };
  const result = resolveSyncPrice(entry, product(20), {}, reduced, settings);
  assert.equal(result.priceEur, 25);
});

test("prezzo bloccato di recente: resta quello online", () => {
  const entry = { priceEur: 30, ctPriceEur: 20, priceBlockedAt: new Date().toISOString() };
  const result = resolveSyncPrice(entry, product(10), {}, options, settings);
  assert.equal(result.priceEur, 30);
});

test("blocco prezzo scaduto: si torna ad aggiornare", () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const entry = { priceEur: 30, ctPriceEur: 20, priceBlockedAt: old };
  const result = resolveSyncPrice(entry, product(10), {}, options, settings);
  assert.equal(result.priceEur, 15);
});

test("la soglia è configurabile", () => {
  const entry = { priceEur: 30, ctPriceEur: 20 };
  const result = resolveSyncPrice(entry, product(19.5), {}, options, { priceUpdateThresholdPct: 5 });
  assert.equal(result.priceEur, 30);
});
