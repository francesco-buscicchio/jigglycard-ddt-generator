const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePriceReference } = require("../services/alignPrice");

test("un concorrente a 99,99 su una carta da 0,43 e' fuori scala", () => {
  const { maxSaneCents, restoreCents } = resolvePriceReference(43, 43);
  assert.equal(maxSaneCents, 543);
  assert.ok(9999 > maxSaneCents);
  assert.equal(restoreCents, null);
});

test("una carta finita a 99,99 torna al prezzo di carico", () => {
  const { maxSaneCents, restoreCents } = resolvePriceReference(9999, 43);
  assert.equal(maxSaneCents, 543);
  assert.equal(restoreCents, 43);
});

test("un rialzo normale resta permesso (2,97 -> 8,98)", () => {
  const { maxSaneCents } = resolvePriceReference(297, 250);
  assert.ok(898 <= maxSaneCents);
});

test("il riferimento segue il prezzo attuale se e' salito in modo sano", () => {
  const { maxSaneCents, restoreCents } = resolvePriceReference(2000, 1000);
  assert.equal(maxSaneCents, 10000);
  assert.equal(restoreCents, null);
});

test("senza prezzo di carico si usa il prezzo attuale", () => {
  assert.deepEqual(resolvePriceReference(200, undefined), {
    maxSaneCents: 1000,
    restoreCents: null,
  });
  assert.deepEqual(resolvePriceReference(NaN, undefined), {
    maxSaneCents: null,
    restoreCents: null,
  });
});
