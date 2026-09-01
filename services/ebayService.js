const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Integrazione eBay (Sell APIs): gestisce OAuth2 utente (authorization code +
// refresh token) e le chiamate alle API Inventory / Account. I token e le
// impostazioni vengono persistiti su file locale (ebay_store.json, gitignored).

const STORE_FILE = path.join(__dirname, "..", "ebay_store.json");

const ENVIRONMENTS = {
  production: {
    authBaseUrl: "https://auth.ebay.com/oauth2/authorize",
    apiBaseUrl: "https://api.ebay.com",
  },
  sandbox: {
    authBaseUrl: "https://auth.sandbox.ebay.com/oauth2/authorize",
    apiBaseUrl: "https://api.sandbox.ebay.com",
  },
};

const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
];

function getEnvName() {
  const value = String(process.env.EBAY_ENV || "production").toLowerCase();
  return value === "sandbox" ? "sandbox" : "production";
}

function getEnvConfig() {
  return ENVIRONMENTS[getEnvName()];
}

function getCredentials() {
  const clientId = String(process.env.EBAY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.EBAY_CLIENT_SECRET || "").trim();
  const ruName = String(process.env.EBAY_RU_NAME || "").trim();

  return { clientId, clientSecret, ruName };
}

function hasCredentials() {
  const { clientId, clientSecret, ruName } = getCredentials();
  return Boolean(clientId && clientSecret && ruName);
}

function getScopes() {
  const raw = String(process.env.EBAY_SCOPES || "").trim();
  if (!raw) return DEFAULT_SCOPES;
  return raw.split(/[\s,]+/).filter(Boolean);
}

function getMarketplaceId() {
  return String(process.env.EBAY_MARKETPLACE_ID || "EBAY_IT").trim();
}

// --- Persistenza token/impostazioni su file ---

function readStore() {
  try {
    // Il replace toglie l'eventuale BOM UTF-8 (file modificati a mano su Windows).
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function updateStore(patch) {
  const store = { ...readStore(), ...patch };
  writeStore(store);
  return store;
}

function getSettings() {
  return readStore().settings ?? {};
}

// Override per prodotto (prezzo, titolo, descrizione, immagine, quantità)
// impostati dalla UI: persistiti nello store, chiave = productId CardTrader.
function getOverrides() {
  return readStore().overrides ?? {};
}

function saveOverrides(patch) {
  const store = readStore();
  const overrides = { ...(store.overrides ?? {}) };

  for (const [productId, value] of Object.entries(patch ?? {})) {
    if (value === null) {
      delete overrides[productId];
      continue;
    }

    const current = { ...(overrides[productId] ?? {}) };
    for (const [field, fieldValue] of Object.entries(value ?? {})) {
      if (fieldValue === null || fieldValue === "" || typeof fieldValue === "undefined") {
        delete current[field];
      } else {
        current[field] = fieldValue;
      }
    }

    if (Object.keys(current).length === 0) delete overrides[productId];
    else overrides[productId] = current;
  }

  updateStore({ overrides });
  return overrides;
}

function saveSettings(settings) {
  const current = getSettings();
  const merged = { ...current, ...settings };
  updateStore({ settings: merged });
  return merged;
}

// Storico pubblicazioni: chiave = productId CardTrader. Serve a non
// ripubblicare gli stessi articoli e a mostrare lo stato in interfaccia.
function getPublishedHistory() {
  return readStore().published ?? {};
}

function recordPublished(productId, entry) {
  const store = readStore();
  const published = { ...(store.published ?? {}) };
  const existing = published[String(productId)] ?? {};
  const now = new Date().toISOString();
  published[String(productId)] = {
    ...existing,
    ...entry,
    status: entry.status ?? "PUBLISHED",
    publishedAt: existing.publishedAt ?? now,
    lastPublishedAt: now,
  };
  updateStore({ published });
  return published[String(productId)];
}

function setPublishedStatus(productId, status) {
  const store = readStore();
  const published = { ...(store.published ?? {}) };
  const existing = published[String(productId)];
  if (!existing) return null;
  published[String(productId)] = { ...existing, status };
  updateStore({ published });
  return published[String(productId)];
}

function replacePublishedHistory(published) {
  updateStore({ published });
  return published;
}

// --- OAuth2 ---

function buildAuthUrl() {
  const { clientId, ruName } = getCredentials();
  if (!hasCredentials()) {
    throw new Error(
      "Credenziali eBay mancanti: impostare EBAY_CLIENT_ID, EBAY_CLIENT_SECRET e EBAY_RU_NAME nel file .env.",
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: "code",
    scope: getScopes().join(" "),
  });

  return `${getEnvConfig().authBaseUrl}?${params.toString()}`;
}

async function requestToken(bodyParams) {
  const { clientId, clientSecret } = getCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const { data } = await axios.post(
    `${getEnvConfig().apiBaseUrl}/identity/v1/oauth2/token`,
    new URLSearchParams(bodyParams).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      timeout: 30_000,
    },
  );

  return data;
}

// Token applicativo (client credentials): basta client id/secret, non serve
// l'account collegato. Usato per le API pubbliche di ricerca (Browse API).
let appTokenCache = { token: null, expiresAt: 0 };

async function getApplicationToken() {
  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Credenziali eBay mancanti: impostare EBAY_CLIENT_ID ed EBAY_CLIENT_SECRET nel file .env.",
    );
  }

  if (appTokenCache.token && Date.now() < appTokenCache.expiresAt - 60_000) {
    return appTokenCache.token;
  }

  const data = await requestToken({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  appTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
  };
  return appTokenCache.token;
}

// Ricerca inserzioni attive sul marketplace (Browse API), per confronto prezzi.
async function browseSearch({ q, categoryIds, limit = 25, sort = "price", filter }) {
  const token = await getApplicationToken();

  try {
    const { data } = await axios.get(
      `${getEnvConfig().apiBaseUrl}/buy/browse/v1/item_summary/search`,
      {
        params: {
          q,
          category_ids: categoryIds,
          limit,
          sort,
          ...(filter ? { filter } : {}),
        },
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
          "Accept-Language": "it-IT",
        },
        timeout: 30_000,
      },
    );
    return data ?? {};
  } catch (error) {
    const wrapped = new Error(formatEbayError(error));
    wrapped.status = error?.response?.status;
    throw wrapped;
  }
}

// Scambia il codice di autorizzazione (dal redirect eBay) con i token.
async function exchangeAuthCode(code) {
  const { ruName } = getCredentials();
  const data = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: ruName,
  });

  updateStore({
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
    refreshToken: data.refresh_token,
    refreshTokenExpiresAt:
      Date.now() + (Number(data.refresh_token_expires_in) || 0) * 1000,
    connectedAt: new Date().toISOString(),
    environment: getEnvName(),
  });

  return { connected: true };
}

async function refreshAccessToken() {
  const store = readStore();
  if (!store.refreshToken) {
    throw new Error("Account eBay non collegato: eseguire prima la connessione OAuth.");
  }

  const data = await requestToken({
    grant_type: "refresh_token",
    refresh_token: store.refreshToken,
    scope: getScopes().join(" "),
  });

  updateStore({
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
  });

  return data.access_token;
}

// Restituisce un access token valido, rinnovandolo se scaduto o in scadenza.
async function getAccessToken() {
  const store = readStore();
  const expiresAt = Number(store.accessTokenExpiresAt) || 0;

  if (store.accessToken && Date.now() < expiresAt - 5 * 60 * 1000) {
    return store.accessToken;
  }

  return refreshAccessToken();
}

function disconnect() {
  const store = readStore();
  delete store.accessToken;
  delete store.accessTokenExpiresAt;
  delete store.refreshToken;
  delete store.refreshTokenExpiresAt;
  delete store.connectedAt;
  writeStore(store);
}

function getConnectionStatus() {
  const store = readStore();
  const refreshExpiresAt = Number(store.refreshTokenExpiresAt) || 0;
  const connected =
    Boolean(store.refreshToken) &&
    (refreshExpiresAt === 0 || Date.now() < refreshExpiresAt);

  return {
    environment: getEnvName(),
    marketplaceId: getMarketplaceId(),
    credentialsConfigured: hasCredentials(),
    connected,
    connectedAt: store.connectedAt ?? null,
    refreshTokenExpiresAt: refreshExpiresAt
      ? new Date(refreshExpiresAt).toISOString()
      : null,
    settings: store.settings ?? {},
  };
}

// --- Client API generico ---

function formatEbayError(error) {
  const response = error?.response;
  if (!response) return error.message;

  const apiErrors = response.data?.errors;
  if (Array.isArray(apiErrors) && apiErrors.length > 0) {
    return apiErrors
      .map((item) => {
        const params = Array.isArray(item.parameters)
          ? ` [${item.parameters.map((p) => `${p.name}=${p.value}`).join(", ")}]`
          : "";
        return `(${item.errorId}) ${item.longMessage || item.message}${params}`;
      })
      .join(" | ");
  }

  return `HTTP ${response.status}: ${JSON.stringify(response.data)}`;
}

async function apiRequest(method, apiPath, { data, params, headers } = {}) {
  const token = await getAccessToken();

  try {
    const response = await axios({
      method,
      url: `${getEnvConfig().apiBaseUrl}${apiPath}`,
      data,
      params,
      timeout: 60_000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Language": "it-IT",
        "Accept-Language": "it-IT",
        ...headers,
      },
    });
    return response.data ?? {};
  } catch (error) {
    const wrapped = new Error(formatEbayError(error));
    wrapped.status = error?.response?.status;
    wrapped.details = error?.response?.data;
    throw wrapped;
  }
}

// --- Account API: policy di vendita ---

async function getFulfillmentPolicies() {
  const data = await apiRequest("get", "/sell/account/v1/fulfillment_policy", {
    params: { marketplace_id: getMarketplaceId() },
  });
  return data.fulfillmentPolicies ?? [];
}

async function getPaymentPolicies() {
  const data = await apiRequest("get", "/sell/account/v1/payment_policy", {
    params: { marketplace_id: getMarketplaceId() },
  });
  return data.paymentPolicies ?? [];
}

async function getReturnPolicies() {
  const data = await apiRequest("get", "/sell/account/v1/return_policy", {
    params: { marketplace_id: getMarketplaceId() },
  });
  return data.returnPolicies ?? [];
}

// --- Inventory API: sedi ---

async function getInventoryLocations() {
  const data = await apiRequest("get", "/sell/inventory/v1/location", {
    params: { limit: 100 },
  });
  return data.locations ?? [];
}

async function createInventoryLocation(merchantLocationKey, locationBody) {
  return apiRequest(
    "post",
    `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
    { data: locationBody },
  );
}

// --- Inventory API: articoli e offerte ---

async function createOrReplaceInventoryItem(sku, itemBody) {
  return apiRequest(
    "put",
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { data: itemBody },
  );
}

async function deleteInventoryItem(sku) {
  return apiRequest(
    "delete",
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
  );
}

async function getOffersBySku(sku) {
  try {
    const data = await apiRequest("get", "/sell/inventory/v1/offer", {
      params: { sku, marketplace_id: getMarketplaceId() },
    });
    return data.offers ?? [];
  } catch (error) {
    // eBay risponde 404 quando lo SKU non ha offerte: non è un errore reale.
    if (error.status === 404) return [];
    throw error;
  }
}

async function createOffer(offerBody) {
  return apiRequest("post", "/sell/inventory/v1/offer", { data: offerBody });
}

async function updateOffer(offerId, offerBody) {
  return apiRequest(
    "put",
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { data: offerBody },
  );
}

async function publishOffer(offerId) {
  return apiRequest(
    "post",
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
  );
}

async function withdrawOffer(offerId) {
  return apiRequest(
    "post",
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
  );
}

async function getInventoryItems({ limit = 100, offset = 0 } = {}) {
  return apiRequest("get", "/sell/inventory/v1/inventory_item", {
    params: { limit, offset },
  });
}

module.exports = {
  getEnvName,
  getMarketplaceId,
  hasCredentials,
  buildAuthUrl,
  exchangeAuthCode,
  getAccessToken,
  getConnectionStatus,
  disconnect,
  getSettings,
  saveSettings,
  getOverrides,
  saveOverrides,
  getApplicationToken,
  browseSearch,
  getPublishedHistory,
  recordPublished,
  setPublishedStatus,
  replacePublishedHistory,
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
  getInventoryLocations,
  createInventoryLocation,
  createOrReplaceInventoryItem,
  deleteInventoryItem,
  getOffersBySku,
  createOffer,
  updateOffer,
  publishOffer,
  withdrawOffer,
  getInventoryItems,
};
