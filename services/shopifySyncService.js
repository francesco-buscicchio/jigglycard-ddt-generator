// Fetch massivo dei dati Shopify per conto del CMS.
// Il task scarica tutto da Shopify (parte lenta: paginazione + rate limit),
// salva uno snapshot a chunk nel database del tenant e notifica il CMS via
// callback: sara' il CMS ad applicare lo snapshot con la sua logica di dominio
// (ledger inventario, lifecycle, ecc.), che non viene duplicata qui.

const { ObjectId } = require("mongodb");
const { connectDB } = require("../config/db");
const { isAbortError } = require("../utils/abort");

const SNAPSHOTS_COLLECTION = "shopify_sync_snapshots";
const SNAPSHOT_CHUNKS_COLLECTION = "shopify_sync_snapshot_chunks";
const CHUNK_SIZE = 100;
const SHOPIFY_MAX_RETRIES = 5;
const CALLBACK_MAX_RETRIES = 3;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseLinkHeader(header) {
  if (!header) return null;
  const nextMatch = String(header)
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.includes('rel="next"'));

  if (!nextMatch) return null;
  const urlMatch = nextMatch.match(/<([^>]+)>/);
  return urlMatch?.[1] ?? null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("Operazione annullata"));
        },
        { once: true },
      );
    }
  });
}

class ShopifyFetchError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ShopifyFetchError";
    this.statusCode = status;
  }
}

async function fetchShopifyPaginated(initialUrl, accessToken, key, { signal } = {}) {
  const items = [];
  let nextUrl = initialUrl;
  let retries = 0;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        Accept: "application/json",
      },
      signal,
    });

    if (response.status === 429) {
      if (retries >= SHOPIFY_MAX_RETRIES) {
        throw new ShopifyFetchError(429, `Rate limit Shopify persistente su ${key}`);
      }
      retries += 1;
      const retryAfterSeconds = Number(response.headers.get("retry-after")) || 2;
      await sleep(retryAfterSeconds * 1000, signal);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ShopifyFetchError(
        response.status,
        text || `Errore Shopify ${key}: ${response.status} ${response.statusText}`,
      );
    }

    retries = 0;
    const payload = await response.json();
    items.push(...(payload?.[key] ?? []));
    nextUrl = parseLinkHeader(response.headers.get("link"));
  }

  return items;
}

function resolveShopifyConnection(requestEnv = {}) {
  const shop = normalizeText(requestEnv.shopifyShop);
  const accessToken = normalizeText(requestEnv.shopifyAccessToken);
  const apiVersion = normalizeText(requestEnv.shopifyApiVersion) || "2026-01";

  if (!shop || !accessToken) {
    throw new Error(
      "Credenziali Shopify mancanti: servono gli header x-shopify-shop e x-shopify-access-token.",
    );
  }

  return {
    shop,
    accessToken,
    apiVersion,
    baseAdminUrl: `https://${shop}/admin/api/${apiVersion}`,
  };
}

async function resolveTenantDb(requestEnv = {}) {
  return connectDB({
    mongoUri: requestEnv.effectiveMongoUri,
    dbName: requestEnv.dbName,
  });
}

async function saveSnapshot(db, { kind, shop, sections, counts }) {
  const snapshotId = new ObjectId();
  const now = new Date();
  const chunksCollection = db.collection(SNAPSHOT_CHUNKS_COLLECTION);

  for (const [section, items] of Object.entries(sections)) {
    for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
      await chunksCollection.insertOne({
        snapshotId,
        section,
        seq: Math.floor(offset / CHUNK_SIZE),
        items: items.slice(offset, offset + CHUNK_SIZE),
        createdAt: now,
      });
    }
  }

  await db.collection(SNAPSHOTS_COLLECTION).insertOne({
    _id: snapshotId,
    kind,
    shop,
    status: "ready",
    sections: Object.fromEntries(
      Object.entries(sections).map(([section, items]) => [section, items.length]),
    ),
    counts,
    createdAt: now,
  });

  return snapshotId.toString();
}

async function notifyCallback(payload, body, { signal } = {}) {
  const callbackUrl = normalizeText(payload?.callbackUrl);
  if (!callbackUrl) return { notified: false };

  let lastError = null;
  for (let attempt = 1; attempt <= CALLBACK_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sync-secret": normalizeText(payload?.callbackSecret),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (response.ok) {
        return { notified: true };
      }

      lastError = new Error(
        `Callback CMS fallita: ${response.status} ${response.statusText}`,
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }

    if (attempt < CALLBACK_MAX_RETRIES) {
      await sleep(attempt * 2000, signal);
    }
  }

  throw lastError ?? new Error("Callback CMS fallita");
}

async function runFetchTask({ kind, payload, requestEnv, signal, collect }) {
  const connection = resolveShopifyConnection(requestEnv);
  const db = await resolveTenantDb(requestEnv);

  const callbackBase = {
    kind,
    syncLogId: normalizeText(payload?.syncLogId) || null,
    dbName: normalizeText(requestEnv?.dbName),
    shop: connection.shop,
  };

  try {
    const { sections, counts } = await collect({ connection, db, signal });
    const snapshotId = await saveSnapshot(db, {
      kind,
      shop: connection.shop,
      sections,
      counts,
    });

    await notifyCallback(payload, {
      ...callbackBase,
      status: "ready",
      snapshotId,
      counts,
    });

    return { snapshotId, counts, shop: connection.shop };
  } catch (error) {
    if (!isAbortError(error)) {
      // Prova a chiudere il sync log lato CMS anche in caso di errore.
      await notifyCallback(payload, {
        ...callbackBase,
        status: "error",
        error: error?.message ?? "Errore sconosciuto",
      }).catch(() => {});
    }
    throw error;
  }
}

async function fetchProductsSnapshot({ payload, requestEnv, signal }) {
  return runFetchTask({
    kind: "products",
    payload,
    requestEnv,
    signal,
    collect: async ({ connection, signal: taskSignal }) => {
      const { baseAdminUrl, accessToken } = connection;

      const products = await fetchShopifyPaginated(
        `${baseAdminUrl}/products.json?limit=250`,
        accessToken,
        "products",
        { signal: taskSignal },
      );
      const customCollections = await fetchShopifyPaginated(
        `${baseAdminUrl}/custom_collections.json?limit=250`,
        accessToken,
        "custom_collections",
        { signal: taskSignal },
      );
      const smartCollections = await fetchShopifyPaginated(
        `${baseAdminUrl}/smart_collections.json?limit=250`,
        accessToken,
        "smart_collections",
        { signal: taskSignal },
      );
      const collections = [...customCollections, ...smartCollections];

      // Membership prodotto->collezione: la parte piu' lenta (una paginazione
      // per collezione), che e' il motivo per cui il fetch vive qui.
      const collectionProducts = [];
      for (const collection of collections) {
        const collectionId = Number(collection.id);
        if (!Number.isFinite(collectionId)) continue;

        const members = await fetchShopifyPaginated(
          `${baseAdminUrl}/products.json?collection_id=${collectionId}&fields=id&limit=250`,
          accessToken,
          "products",
          { signal: taskSignal },
        );

        for (const member of members) {
          const productId = Number(member.id);
          if (!Number.isFinite(productId)) continue;
          collectionProducts.push({ collectionId, productId });
        }
      }

      return {
        sections: { products, collections, collectionProducts },
        counts: {
          products: products.length,
          collections: collections.length,
          collectionProducts: collectionProducts.length,
        },
      };
    },
  });
}

async function fetchInventorySnapshot({ payload, requestEnv, signal }) {
  return runFetchTask({
    kind: "inventory",
    payload,
    requestEnv,
    signal,
    collect: async ({ connection, signal: taskSignal }) => {
      const { baseAdminUrl, accessToken } = connection;

      const products = await fetchShopifyPaginated(
        `${baseAdminUrl}/products.json?fields=id,options,variants&limit=250`,
        accessToken,
        "products",
        { signal: taskSignal },
      );
      const locations = await fetchShopifyPaginated(
        `${baseAdminUrl}/locations.json?limit=250`,
        accessToken,
        "locations",
        { signal: taskSignal },
      );

      const inventoryLevels = [];
      for (const location of locations) {
        const locationId = Number(location.id);
        if (!Number.isFinite(locationId)) continue;

        const levels = await fetchShopifyPaginated(
          `${baseAdminUrl}/inventory_levels.json?location_ids=${locationId}&limit=250`,
          accessToken,
          "inventory_levels",
          { signal: taskSignal },
        );
        inventoryLevels.push(...levels);
      }

      return {
        sections: { products, locations, inventoryLevels },
        counts: {
          products: products.length,
          locations: locations.length,
          inventoryLevels: inventoryLevels.length,
        },
      };
    },
  });
}

async function fetchShopSnapshot({ payload, requestEnv, signal }) {
  return runFetchTask({
    kind: "shop",
    payload,
    requestEnv,
    signal,
    collect: async ({ connection, signal: taskSignal }) => {
      const response = await fetch(
        `${connection.baseAdminUrl}/shop.json`,
        {
          headers: {
            "X-Shopify-Access-Token": connection.accessToken,
            Accept: "application/json",
          },
          signal: taskSignal,
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ShopifyFetchError(
          response.status,
          text || `Errore Shopify shop: ${response.status}`,
        );
      }

      const body = await response.json();
      const shopProperties = body?.shop ? [body.shop] : [];

      return {
        sections: { shop: shopProperties },
        counts: { shop: shopProperties.length },
      };
    },
  });
}

module.exports = {
  fetchProductsSnapshot,
  fetchInventorySnapshot,
  fetchShopSnapshot,
  // esposti per i test
  fetchShopifyPaginated,
  parseLinkHeader,
  ShopifyFetchError,
  SNAPSHOTS_COLLECTION,
  SNAPSHOT_CHUNKS_COLLECTION,
  CHUNK_SIZE,
};
