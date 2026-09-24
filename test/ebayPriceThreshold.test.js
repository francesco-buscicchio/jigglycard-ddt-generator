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

test("la soglia è configurabile", () => {
  const entry = { priceEur: 30, ctPriceEur: 20 };
  const result = resolveSyncPrice(entry, product(19.5), {}, options, { priceUpdateThresholdPct: 5 });
  assert.equal(result.priceEur, 30);
});
