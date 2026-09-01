const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { getDB } = require("../config/db");
const { createCardTraderService } = require("./cardTraderService");

const ITEMS_COLLECTION = "price_tracking_items";
const SALES_COLLECTION = "price_tracking_sales";
const SNAPSHOTS_COLLECTION = "price_tracking_snapshots";

const PLATFORM_CARDMARKET = "cardmarket";
const PLATFORM_CARDTRADER = "cardtrader";

const CANCELLED_ORDER_STATES = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "rejected",
]);

// Mappe Cardmarket -> CardTrader per costruire la chiave identita' carta
// condivisa tra le due piattaforme.
const CM_CONDITION_MAP = {
  mt: "near mint",
  nm: "near mint",
  ex: "slightly played",
  gd: "moderately played",
  lp: "played",
  pl: "played",
  po: "poor",
};
const CM_LANGUAGE_MAP = {
  english: "en",
  italian: "it",
  japanese: "jp",
  german: "de",
  french: "fr",
  spanish: "es",
  portuguese: "pt",
  "portuguese (brazil)": "pt",
  korean: "kr",
  russian: "ru",
  dutch: "nl",
  polish: "pl",
  "chinese (simplified)": "zh-cn",
  "chinese (traditional)": "zh-tw",
};

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeCollectorNumber(value) {
  const base = String(value ?? "").split("/")[0].trim().toLowerCase();
  return base.replace(/^0+(?=\w)/, "");
}

function normalizeBoolean(value) {
  if (value === true) return true;
  const normalized = normalizeText(value);
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

// Chiave identita' carta condivisa tra piattaforme: set + numero + condizione
// + lingua + reverse + prima edizione (in convenzione CardTrader).
function buildIdentityKey({
  setCode,
  collectorNumber,
  condition,
  language,
  reverse,
  firstEdition,
}) {
  const cn = normalizeCollectorNumber(collectorNumber);
  const set = normalizeText(setCode);
  if (!set || !cn) return null;
  return [
    set,
    cn,
    normalizeText(condition),
    normalizeText(language),
    reverse === true,
    firstEdition === true,
  ].join("|");
}

function buildCardmarketIdentityKey(row) {
  return buildIdentityKey({
    setCode: row.setCode,
    collectorNumber: row.cn,
    condition:
      CM_CONDITION_MAP[normalizeText(row.condition)] ??
      normalizeText(row.condition),
    language:
      CM_LANGUAGE_MAP[normalizeText(row.language)] ??
      normalizeText(row.language),
    reverse: normalizeBoolean(row.isReverseHolo),
    firstEdition: normalizeBoolean(row.isFirstEd),
  });
}

function buildCardTraderIdentityKey(propertiesHash, expansionCode) {
  return buildIdentityKey({
    setCode: expansionCode,
    collectorNumber: propertiesHash?.collector_number,
    condition: propertiesHash?.condition,
    language: getCardTraderLanguage(propertiesHash),
    reverse: propertiesHash?.pokemon_reverse === true,
    firstEdition: propertiesHash?.first_edition === true,
  });
}

function parseEuroToCents(value) {
  const normalized = String(value ?? "").replace(",", ".").trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

async function ensureIndexes(db) {
  await db
    .collection(ITEMS_COLLECTION)
    .createIndex({ platform: 1, itemKey: 1 }, { unique: true });
  await db
    .collection(SALES_COLLECTION)
    .createIndex({ saleKey: 1 }, { unique: true });
  await db.collection(SALES_COLLECTION).createIndex({ platform: 1, soldAt: 1 });
}

function readCsvRows(csvPath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(
        csv({
          mapHeaders: ({ header }) =>
            String(header ?? "").replace(/^﻿/, "").trim(),
        }),
      )
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function buildCardmarketItemKey(row) {
  return [
    row.cardmarketId,
    normalizeText(row.condition),
    normalizeText(row.language),
    normalizeText(row.isFirstEd),
    normalizeText(row.isReverseHolo),
    normalizeText(row.isSigned),
    normalizeText(row.finishType),
  ].join("|");
}

// Aggrega le righe del CSV TCGPowertools per chiave articolo (le rare righe
// duplicate vengono sommate sulle quantita, prezzo minimo come riferimento).
function aggregateCardmarketRows(rows) {
  const byKey = new Map();

  for (const row of rows) {
    if (!row?.cardmarketId) continue;
    const priceCents = parseEuroToCents(row.price);
    const quantity = Number(row.quantity);
    if (priceCents === null || !Number.isFinite(quantity)) continue;

    const itemKey = buildCardmarketItemKey(row);
    const existing = byKey.get(itemKey);
    if (existing) {
      existing.quantity += quantity;
      existing.priceCents = Math.min(existing.priceCents, priceCents);
      continue;
    }

    byKey.set(itemKey, {
      itemKey,
      identityKey: buildCardmarketIdentityKey(row),
      cardmarketId: String(row.cardmarketId),
      name: row.name ?? "",
      nameIT: row.nameIT ?? "",
      set: row.set ?? "",
      setCode: row.setCode ?? "",
      cn: row.cn ?? "",
      rarity: row.rarity ?? "",
      condition: String(row.condition ?? "").trim(),
      language: String(row.language ?? "").trim(),
      attrs: {
        firstEd: normalizeText(row.isFirstEd) || null,
        reverseHolo: normalizeText(row.isReverseHolo) || null,
        signed: normalizeText(row.isSigned) || null,
        finish: normalizeText(row.finishType) || null,
      },
      quantity,
      priceCents,
    });
  }

  return byKey;
}

// Importa uno snapshot dell'inventario TCGPowertools (Cardmarket).
// - Articoli mai visti: registrati con prezzo di carico = prezzo attuale.
// - Cali di quantita rispetto allo snapshot precedente: vendite dedotte al
//   prezzo listato nello snapshot precedente.
// - Articoli spariti dal CSV: venduta la quantita residua.
// NB: rimozioni manuali dal listino vengono conteggiate come vendite.
async function importCardmarketSnapshot(csvPath, options = {}) {
  const db = await getDB(options);
  await ensureIndexes(db);

  const rows = await readCsvRows(csvPath);
  const snapshotItems = aggregateCardmarketRows(rows);
  if (snapshotItems.size === 0) {
    throw new Error(`Nessuna riga valida nel CSV: ${csvPath}`);
  }

  const itemsCol = db.collection(ITEMS_COLLECTION);
  const salesCol = db.collection(SALES_COLLECTION);
  const snapshotsCol = db.collection(SNAPSHOTS_COLLECTION);

  const previousSnapshot = await snapshotsCol.findOne(
    { platform: PLATFORM_CARDMARKET },
    { sort: { importedAt: -1 } },
  );
  const isFirstImport = !previousSnapshot;

  const existingItems = await itemsCol
    .find({ platform: PLATFORM_CARDMARKET })
    .toArray();
  const existingByKey = new Map(
    existingItems.map((item) => [item.itemKey, item]),
  );

  const now = new Date();
  const snapshotId = now.toISOString();
  const itemOps = [];
  const saleDocs = [];
  let newItems = 0;
  let restockedItems = 0;
  let soldUnits = 0;

  function pushSale(existing, quantitySold) {
    soldUnits += quantitySold;
    saleDocs.push({
      saleKey: `cm:${existing.itemKey}:${snapshotId}`,
      platform: PLATFORM_CARDMARKET,
      itemKey: existing.itemKey,
      name: existing.name,
      set: existing.set,
      setCode: existing.setCode,
      cn: existing.cn,
      rarity: existing.rarity,
      condition: existing.condition,
      language: existing.language,
      quantity: quantitySold,
      unitInitialPriceCents: existing.initialPriceCents ?? null,
      unitSalePriceCents: existing.lastPriceCents,
      initialAt: existing.initialAt ?? null,
      soldAt: now,
      source: "snapshot-diff",
    });
  }

  for (const snapshotItem of snapshotItems.values()) {
    const existing = existingByKey.get(snapshotItem.itemKey);

    if (!existing) {
      newItems += 1;
      itemOps.push({
        insertOne: {
          document: {
            platform: PLATFORM_CARDMARKET,
            itemKey: snapshotItem.itemKey,
            identityKey: snapshotItem.identityKey,
            cardmarketId: snapshotItem.cardmarketId,
            name: snapshotItem.name,
            nameIT: snapshotItem.nameIT,
            set: snapshotItem.set,
            setCode: snapshotItem.setCode,
            cn: snapshotItem.cn,
            rarity: snapshotItem.rarity,
            condition: snapshotItem.condition,
            language: snapshotItem.language,
            attrs: snapshotItem.attrs,
            initialPriceCents: snapshotItem.priceCents,
            initialAt: now,
            lastPriceCents: snapshotItem.priceCents,
            lastQuantity: snapshotItem.quantity,
            lastSeenAt: now,
            active: true,
          },
        },
      });
      continue;
    }

    const previousQuantity = Number(existing.lastQuantity ?? 0);
    if (snapshotItem.quantity < previousQuantity && !isFirstImport) {
      pushSale(existing, previousQuantity - snapshotItem.quantity);
    } else if (snapshotItem.quantity > previousQuantity) {
      restockedItems += 1;
    }

    itemOps.push({
      updateOne: {
        filter: { _id: existing._id },
        update: {
          $set: {
            identityKey: snapshotItem.identityKey,
            lastPriceCents: snapshotItem.priceCents,
            lastQuantity: snapshotItem.quantity,
            lastSeenAt: now,
            active: true,
          },
        },
      },
    });
  }

  // Articoli attivi non piu' presenti nel CSV: quantita residua venduta.
  if (!isFirstImport) {
    for (const existing of existingItems) {
      if (snapshotItems.has(existing.itemKey)) continue;
      if (!existing.active) continue;

      const remainingQuantity = Number(existing.lastQuantity ?? 0);
      if (remainingQuantity > 0) {
        pushSale(existing, remainingQuantity);
      }

      itemOps.push({
        updateOne: {
          filter: { _id: existing._id },
          update: { $set: { lastQuantity: 0, active: false } },
        },
      });
    }
  }

  if (itemOps.length > 0) {
    await itemsCol.bulkWrite(itemOps, { ordered: false });
  }
  if (saleDocs.length > 0) {
    try {
      await salesCol.insertMany(saleDocs, { ordered: false });
    } catch (error) {
      // Duplicati (stesso snapshot reimportato): ignora solo errori di chiave.
      if (error?.code !== 11000 && !error?.writeErrors) throw error;
    }
  }

  const totalQuantity = [...snapshotItems.values()].reduce(
    (sum, item) => sum + item.quantity,
    0,
  );

  await snapshotsCol.insertOne({
    platform: PLATFORM_CARDMARKET,
    importedAt: now,
    sourceFile: path.basename(csvPath),
    itemCount: snapshotItems.size,
    totalQuantity,
    newItems,
    restockedItems,
    salesDetected: saleDocs.length,
    soldUnits,
    firstImport: isFirstImport,
  });

  return {
    platform: PLATFORM_CARDMARKET,
    firstImport: isFirstImport,
    itemCount: snapshotItems.size,
    totalQuantity,
    newItems,
    restockedItems,
    salesDetected: saleDocs.length,
    soldUnits,
  };
}

function getCardTraderLanguage(propertiesHash) {
  const props = propertiesHash ?? {};
  return (
    props.pokemon_language ??
    props.onepiece_language ??
    props.dragonball_language ??
    props.language ??
    null
  );
}

function getCardTraderRarity(propertiesHash) {
  const props = propertiesHash ?? {};
  return (
    props.pokemon_rarity ??
    props.onepiece_rarity ??
    props.dragonball_rarity ??
    null
  );
}

function buildCardTraderFallbackKey(blueprintId, propertiesHash) {
  return [
    blueprintId,
    normalizeText(propertiesHash?.condition),
    normalizeText(getCardTraderLanguage(propertiesHash)),
  ].join("|");
}

// Sincronizza CardTrader: snapshot inventario (per i prezzi di carico) e
// ordini da venditore (vendite reali con prezzo esatto). Le vendite NON
// vengono dedotte dai cali di quantita per evitare doppi conteggi.
async function syncCardTrader(options = {}) {
  const db = await getDB(options);
  await ensureIndexes(db);

  const cardTraderService = createCardTraderService(options);
  const itemsCol = db.collection(ITEMS_COLLECTION);
  const salesCol = db.collection(SALES_COLLECTION);
  const snapshotsCol = db.collection(SNAPSHOTS_COLLECTION);
  const now = new Date();

  // --- Snapshot inventario ---
  const [exportRes, expansionsRes] = await Promise.all([
    cardTraderService.getMyProducts(),
    cardTraderService.getExpansions(),
  ]);
  const products = Array.isArray(exportRes?.data) ? exportRes.data : [];
  const expansionCodeById = new Map(
    (Array.isArray(expansionsRes?.data) ? expansionsRes.data : []).map(
      (expansion) => [expansion.id, expansion.code ?? ""],
    ),
  );

  // Articoli Cardmarket per chiave identita': il prezzo con cui un prodotto
  // viene caricato su TCGPowertools e' il vero prezzo di carico anche su
  // CardTrader (il primo prezzo che arriva a CardTrader per i prodotti nuovi).
  const cardmarketItems = await itemsCol
    .find({ platform: PLATFORM_CARDMARKET, identityKey: { $ne: null } })
    .toArray();
  const cardmarketByIdentity = new Map();
  for (const item of cardmarketItems) {
    if (!cardmarketByIdentity.has(item.identityKey)) {
      cardmarketByIdentity.set(item.identityKey, item);
    }
  }

  const existingItems = await itemsCol
    .find({ platform: PLATFORM_CARDTRADER })
    .toArray();
  const existingByKey = new Map(
    existingItems.map((item) => [item.itemKey, item]),
  );

  const seenKeys = new Set();
  const itemOps = [];
  const repairedItemKeys = new Map();
  let newItems = 0;
  let linkedToCardmarket = 0;

  for (const product of products) {
    const productId = product?.id;
    const priceCents = Number(product?.price_cents);
    if (!productId || !Number.isFinite(priceCents)) continue;

    const itemKey = `ct:${productId}`;
    seenKeys.add(itemKey);
    const existing = existingByKey.get(itemKey);
    const quantity = Number(product?.quantity ?? 0);
    const identityKey = buildCardTraderIdentityKey(
      product?.properties_hash,
      expansionCodeById.get(product?.expansion?.id),
    );
    const cardmarketTwin = identityKey
      ? cardmarketByIdentity.get(identityKey)
      : null;

    if (!existing) {
      newItems += 1;
      if (cardmarketTwin) linkedToCardmarket += 1;
      itemOps.push({
        insertOne: {
          document: {
            platform: PLATFORM_CARDTRADER,
            itemKey,
            identityKey,
            productId,
            blueprintId: product?.blueprint_id ?? null,
            fallbackKey: buildCardTraderFallbackKey(
              product?.blueprint_id,
              product?.properties_hash,
            ),
            name: product?.name_en ?? product?.name ?? "",
            set: product?.expansion_name ?? "",
            setCode: expansionCodeById.get(product?.expansion?.id) ?? "",
            rarity: getCardTraderRarity(product?.properties_hash) ?? "",
            condition: product?.properties_hash?.condition ?? "",
            language: getCardTraderLanguage(product?.properties_hash) ?? "",
            initialPriceCents: cardmarketTwin
              ? cardmarketTwin.initialPriceCents
              : priceCents,
            initialAt: cardmarketTwin ? cardmarketTwin.initialAt : now,
            initialPriceSource: cardmarketTwin
              ? "cardmarket"
              : "cardtrader-snapshot",
            lastPriceCents: priceCents,
            lastQuantity: quantity,
            lastSeenAt: now,
            active: true,
          },
        },
      });
      continue;
    }

    const updateSet = {
      identityKey,
      lastPriceCents: priceCents,
      lastQuantity: quantity,
      lastSeenAt: now,
      active: true,
    };

    // Riparazione: articoli registrati prima del collegamento a Cardmarket
    // ereditano ora il vero prezzo di carico dal gemello Cardmarket.
    if (cardmarketTwin && existing.initialPriceSource !== "cardmarket") {
      updateSet.initialPriceCents = cardmarketTwin.initialPriceCents;
      updateSet.initialAt = cardmarketTwin.initialAt;
      updateSet.initialPriceSource = "cardmarket";
      repairedItemKeys.set(itemKey, {
        initialPriceCents: cardmarketTwin.initialPriceCents,
        initialAt: cardmarketTwin.initialAt,
      });
      linkedToCardmarket += 1;
    }

    itemOps.push({
      updateOne: {
        filter: { _id: existing._id },
        update: { $set: updateSet },
      },
    });
  }

  for (const existing of existingItems) {
    if (seenKeys.has(existing.itemKey) || !existing.active) continue;
    itemOps.push({
      updateOne: {
        filter: { _id: existing._id },
        update: { $set: { lastQuantity: 0, active: false } },
      },
    });
  }

  if (itemOps.length > 0) {
    await itemsCol.bulkWrite(itemOps, { ordered: false });
  }

  // Riparazione retroattiva: le vendite gia' registrate su articoli appena
  // collegati a Cardmarket ricevono il vero prezzo di carico.
  let repairedSales = 0;
  if (repairedItemKeys.size > 0) {
    const saleRepairOps = [...repairedItemKeys.entries()].map(
      ([itemKey, initial]) => ({
        updateMany: {
          filter: { platform: PLATFORM_CARDTRADER, itemKey },
          update: {
            $set: {
              unitInitialPriceCents: initial.initialPriceCents,
              initialAt: initial.initialAt,
            },
          },
        },
      }),
    );
    const repairResult = await salesCol.bulkWrite(saleRepairOps, {
      ordered: false,
    });
    repairedSales = repairResult.modifiedCount ?? 0;
  }

  // Ricarica gli indici di lookup per collegare gli ordini ai prezzi di carico.
  const allItems = await itemsCol
    .find({ platform: PLATFORM_CARDTRADER })
    .toArray();
  const byProductId = new Map(
    allItems
      .filter((item) => item.productId)
      .map((item) => [String(item.productId), item]),
  );
  const byFallbackKey = new Map();
  for (const item of allItems) {
    if (item.fallbackKey && !byFallbackKey.has(item.fallbackKey)) {
      byFallbackKey.set(item.fallbackKey, item);
    }
  }

  // --- Ordini (vendite reali) ---
  const orders = await fetchSellerOrders(cardTraderService, options);
  const saleDocs = [];

  for (const order of orders) {
    const orderItems = Array.isArray(order?.order_items)
      ? order.order_items
      : [];

    orderItems.forEach((orderItem, index) => {
      const unitSaleCents = Number(orderItem?.seller_price?.cents);
      const quantity = Number(orderItem?.quantity ?? 0);
      if (!Number.isFinite(unitSaleCents) || quantity <= 0) return;

      const trackedItem =
        byProductId.get(String(orderItem?.product_id ?? "")) ??
        byFallbackKey.get(
          buildCardTraderFallbackKey(
            orderItem?.blueprint_id,
            orderItem?.properties,
          ),
        ) ??
        null;

      saleDocs.push({
        saleKey: `ct:${order.id}:${orderItem?.id ?? index}`,
        platform: PLATFORM_CARDTRADER,
        itemKey: trackedItem?.itemKey ?? null,
        orderId: order.id,
        orderCode: order.code ?? "",
        orderState: order.state ?? "",
        name: orderItem?.name ?? "",
        set: orderItem?.expansion ?? "",
        setCode: "",
        cn: orderItem?.properties?.collector_number ?? "",
        rarity:
          getCardTraderRarity(orderItem?.properties) ?? trackedItem?.rarity ?? "",
        condition: orderItem?.properties?.condition ?? "",
        language: getCardTraderLanguage(orderItem?.properties) ?? "",
        quantity,
        unitInitialPriceCents: trackedItem?.initialPriceCents ?? null,
        unitSalePriceCents: unitSaleCents,
        initialAt: trackedItem?.initialAt ?? null,
        soldAt: new Date(
          order?.paid_at ?? order?.created_at ?? orderItem?.created_at ?? now,
        ),
        source: "cardtrader-orders",
      });
    });
  }

  let insertedSales = 0;
  if (saleDocs.length > 0) {
    try {
      const result = await salesCol.insertMany(saleDocs, { ordered: false });
      insertedSales = result.insertedCount ?? 0;
    } catch (error) {
      // Ordini gia' registrati in sync precedenti: ignora i duplicati.
      if (error?.code === 11000 || error?.writeErrors) {
        insertedSales = error?.result?.insertedCount ?? 0;
      } else {
        throw error;
      }
    }
  }

  const totalQuantity = products.reduce(
    (sum, product) => sum + Number(product?.quantity ?? 0),
    0,
  );

  await snapshotsCol.insertOne({
    platform: PLATFORM_CARDTRADER,
    importedAt: now,
    sourceFile: "cardtrader-api",
    itemCount: seenKeys.size,
    totalQuantity,
    newItems,
    linkedToCardmarket,
    repairedSales,
    ordersFetched: orders.length,
    salesDetected: saleDocs.length,
    salesInserted: insertedSales,
  });

  return {
    platform: PLATFORM_CARDTRADER,
    itemCount: seenKeys.size,
    totalQuantity,
    newItems,
    linkedToCardmarket,
    repairedSales,
    ordersFetched: orders.length,
    salesDetected: saleDocs.length,
    salesInserted: insertedSales,
  };
}

async function fetchSellerOrders(cardTraderService, options = {}) {
  const fromDate =
    options.ordersFrom ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const orders = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const batch = await cardTraderService.fetchOrdersPage({
      from: fromDate,
      page,
      limit,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    orders.push(...batch);
    page += 1;
  }

  return orders.filter(
    (order) =>
      order?.order_as === "seller" &&
      !CANCELLED_ORDER_STATES.has(normalizeText(order?.state)),
  );
}

async function loadReportData(options = {}) {
  const db = await getDB(options);
  await ensureIndexes(db);

  const salesFilter = {};
  if (options.from || options.to) {
    salesFilter.soldAt = {};
    if (options.from) salesFilter.soldAt.$gte = new Date(options.from);
    if (options.to) {
      const to = new Date(options.to);
      to.setDate(to.getDate() + 1);
      salesFilter.soldAt.$lt = to;
    }
  }

  const [sales, items, snapshots] = await Promise.all([
    db.collection(SALES_COLLECTION).find(salesFilter).sort({ soldAt: 1 }).toArray(),
    db.collection(ITEMS_COLLECTION).find({}).toArray(),
    db
      .collection(SNAPSHOTS_COLLECTION)
      .find({})
      .sort({ importedAt: -1 })
      .limit(20)
      .toArray(),
  ]);

  return { sales, items, snapshots };
}

module.exports = {
  PLATFORM_CARDMARKET,
  PLATFORM_CARDTRADER,
  importCardmarketSnapshot,
  syncCardTrader,
  loadReportData,
};
