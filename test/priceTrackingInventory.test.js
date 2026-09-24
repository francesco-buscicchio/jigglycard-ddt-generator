const test = require("node:test");
const assert = require("node:assert/strict");
const {
  syncCardTraderInventory,
} = require("../services/priceTrackingService");

// Mini-Mongo in memoria con il sottoinsieme di API usato dal tracking:
// permette di testare lo snapshot inventario senza un'istanza reale.
function matchesFilter(document, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === "object" && "$ne" in expected) {
      return actual !== expected.$ne;
    }
    return actual === expected;
  });
}

class FakeCollection {
  constructor() {
    this.documents = [];
    this.nextId = 1;
  }

  async createIndex() {}

  find(filter = {}) {
    const matches = this.documents.filter((document) =>
      matchesFilter(document, filter),
    );
    return {
      sort: () => ({ toArray: async () => structuredClone(matches) }),
      toArray: async () => structuredClone(matches),
    };
  }

  async insertOne(document) {
    const stored = { _id: this.nextId++, ...structuredClone(document) };
    this.documents.push(stored);
    return { insertedId: stored._id };
  }

  async updateOne(filter, update) {
    const target = this.documents.find((document) =>
      matchesFilter(document, filter),
    );
    if (target && update.$set) Object.assign(target, structuredClone(update.$set));
    return { modifiedCount: target ? 1 : 0 };
  }

  async bulkWrite(operations) {
    let modifiedCount = 0;
    for (const operation of operations) {
      if (operation.insertOne) {
        await this.insertOne(operation.insertOne.document);
      } else if (operation.updateOne) {
        const result = await this.updateOne(
          operation.updateOne.filter,
          operation.updateOne.update,
        );
        modifiedCount += result.modifiedCount;
      } else if (operation.updateMany) {
        for (const document of this.documents) {
          if (!matchesFilter(document, operation.updateMany.filter)) continue;
          Object.assign(
            document,
            structuredClone(operation.updateMany.update.$set),
          );
          modifiedCount += 1;
        }
      }
    }
    return { modifiedCount };
  }
}

class FakeDb {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new FakeCollection());
    }
    return this.collections.get(name);
  }
}

function buildProduct(overrides = {}) {
  return {
    id: 1001,
    blueprint_id: 5001,
    price_cents: 250,
    quantity: 3,
    name_en: "Pikachu",
    expansion: { id: 77 },
    properties_hash: {
      condition: "Near Mint",
      pokemon_language: "en",
      collector_number: "025",
      pokemon_reverse: false,
      first_edition: false,
      pokemon_rarity: "Common",
    },
    ...overrides,
  };
}

const EXPANSIONS = new Map([[77, { code: "BS", name: "Base Set" }]]);

test("registra gli articoli nuovi con il prezzo di carico anche senza vendite", async () => {
  const db = new FakeDb();
  const now = new Date("2026-09-20T10:00:00Z");

  const result = await syncCardTraderInventory(
    {},
    {
      db,
      now,
      source: "align-price",
      products: [
        buildProduct(),
        buildProduct({ id: 1002, blueprint_id: 5002, price_cents: 1200 }),
      ],
      expansionsById: EXPANSIONS,
    },
  );

  assert.equal(result.newItems, 2);
  assert.equal(result.itemCount, 2);
  assert.equal(result.totalQuantity, 6);

  const items = db.collection("price_tracking_items").documents;
  assert.equal(items.length, 2);
  const first = items.find((item) => item.itemKey === "ct:1001");
  assert.equal(first.initialPriceCents, 250);
  assert.equal(first.lastPriceCents, 250);
  assert.equal(first.lastQuantity, 3);
  assert.equal(first.initialPriceSource, "cardtrader-snapshot");
  assert.equal(first.active, true);
  assert.deepEqual(first.initialAt, now);
  assert.equal(first.identityKey, "bs|25|near mint|en|false|false");
  assert.equal(first.set, "Base Set");
  assert.equal(first.setCode, "BS");

  // Nessuna vendita: il tracking degli articoli e' indipendente dagli ordini.
  assert.equal(db.collection("price_tracking_sales").documents.length, 0);

  const snapshots = db.collection("price_tracking_snapshots").documents;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sourceFile, "align-price");
  assert.equal(snapshots[0].newItems, 2);
  assert.equal(result.snapshotId, snapshots[0]._id);
});

test("gli articoli gia' noti mantengono il prezzo di carico e quelli spariti vengono disattivati", async () => {
  const db = new FakeDb();
  const firstRun = new Date("2026-09-01T10:00:00Z");
  const secondRun = new Date("2026-09-20T10:00:00Z");

  await syncCardTraderInventory(
    {},
    {
      db,
      now: firstRun,
      products: [
        buildProduct(),
        buildProduct({ id: 1002, blueprint_id: 5002, price_cents: 1200 }),
      ],
      expansionsById: EXPANSIONS,
    },
  );

  // Il prezzatore ha abbassato il prezzo del primo e il secondo non e' piu' a
  // listino (venduto o rimosso).
  const result = await syncCardTraderInventory(
    {},
    {
      db,
      now: secondRun,
      products: [buildProduct({ price_cents: 180, quantity: 2 })],
      expansionsById: EXPANSIONS,
    },
  );

  assert.equal(result.newItems, 0);
  assert.equal(result.itemCount, 1);

  const items = db.collection("price_tracking_items").documents;
  const first = items.find((item) => item.itemKey === "ct:1001");
  assert.equal(first.initialPriceCents, 250, "il prezzo di carico non cambia");
  assert.deepEqual(first.initialAt, firstRun);
  assert.equal(first.lastPriceCents, 180);
  assert.equal(first.lastQuantity, 2);
  assert.deepEqual(first.lastSeenAt, secondRun);

  const second = items.find((item) => item.itemKey === "ct:1002");
  assert.equal(second.active, false);
  assert.equal(second.lastQuantity, 0);
  assert.equal(second.initialPriceCents, 1200);
});

test("un articolo nuovo eredita il prezzo di carico dal gemello Cardmarket", async () => {
  const db = new FakeDb();
  const loadedAt = new Date("2026-08-15T09:00:00Z");
  await db.collection("price_tracking_items").insertOne({
    platform: "cardmarket",
    itemKey: "cm-1",
    identityKey: "bs|25|near mint|en|false|false",
    initialPriceCents: 300,
    initialAt: loadedAt,
    lastPriceCents: 300,
    lastQuantity: 1,
    active: true,
  });

  const result = await syncCardTraderInventory(
    {},
    {
      db,
      now: new Date("2026-09-20T10:00:00Z"),
      products: [buildProduct({ price_cents: 250 })],
      expansionsById: EXPANSIONS,
    },
  );

  assert.equal(result.newItems, 1);
  assert.equal(result.linkedToCardmarket, 1);

  const item = db
    .collection("price_tracking_items")
    .documents.find((document) => document.itemKey === "ct:1001");
  assert.equal(item.initialPriceCents, 300);
  assert.deepEqual(item.initialAt, loadedAt);
  assert.equal(item.initialPriceSource, "cardmarket");
  assert.equal(item.lastPriceCents, 250);
});

test("senza prodotti forniti scarica export ed espansioni dal servizio CardTrader", async () => {
  const db = new FakeDb();
  const calls = [];
  const fakeService = {
    async getMyProducts() {
      calls.push("export");
      return { data: [buildProduct()] };
    },
    async getExpansions() {
      calls.push("expansions");
      return { data: [{ id: 77, code: "BS", name: "Base Set" }] };
    },
  };

  const result = await syncCardTraderInventory(
    {},
    { db, cardTraderService: fakeService },
  );

  assert.deepEqual(calls.sort(), ["expansions", "export"]);
  assert.equal(result.newItems, 1);
  const snapshots = db.collection("price_tracking_snapshots").documents;
  assert.equal(snapshots[0].sourceFile, "cardtrader-api");
});
