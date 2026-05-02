const axios = require("axios");
const { formatDate } = require("../utils/dateUtils");
const {
  CARDTRADER_REQUEST_TIMEOUT_MS,
  CARDTRADER_MAX_RETRIES,
  CARDTRADER_RETRY_BASE_DELAY_MS,
} = require("../config/config");
const cardTraderRateLimiter = require("./cardTraderRateLimiter");
const { sleep, throwIfAborted } = require("../utils/abort");

const DEFAULT_CARDTRADER_API_BASE_URL = "https://api.cardtrader.com/api/v2";

function resolveCardTraderToken(runtimeConfig = {}) {
  const token = runtimeConfig.cardTraderToken ?? process.env.CARDTRADER_TOKEN;
  if (!token) {
    throw new Error(
      "CARDTRADER_TOKEN mancante. Passalo nella richiesta oppure configurarlo nell'ambiente di esecuzione.",
    );
  }

  return token;
}

function resolveCardTraderApiBaseUrl(runtimeConfig = {}) {
  const runtimeBaseUrl = String(runtimeConfig.cardTraderApiBaseUrl ?? "").trim();
  if (runtimeBaseUrl) {
    return runtimeBaseUrl;
  }

  return (
    process.env.CARDTRADER_API_BASE_URL ??
    DEFAULT_CARDTRADER_API_BASE_URL
  );
}

function resolveRequestTimeoutMs(runtimeConfig = {}) {
  return Math.max(
    1,
    Number(runtimeConfig.requestTimeoutMs) || CARDTRADER_REQUEST_TIMEOUT_MS,
  );
}

function resolveMaxRetries(runtimeConfig = {}) {
  return Math.max(0, Number(runtimeConfig.maxRetries) || CARDTRADER_MAX_RETRIES);
}

function resolveRetryBaseDelayMs(runtimeConfig = {}) {
  return Math.max(
    100,
    Number(runtimeConfig.retryBaseDelayMs) || CARDTRADER_RETRY_BASE_DELAY_MS,
  );
}

function buildHeaders(runtimeConfig = {}) {
  return {
    Authorization: `Bearer ${resolveCardTraderToken(runtimeConfig)}`,
  };
}

function extractRetryAfterMs(error) {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];
  if (!retryAfterHeader) return null;

  const numericValue = Number(retryAfterHeader);
  if (Number.isFinite(numericValue)) {
    return Math.max(0, numericValue * 1000);
  }

  const parsedDate = Date.parse(retryAfterHeader);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return null;
}

function isRetryableError(error) {
  const status = Number(error?.response?.status);
  return (
    status === 429 ||
    status === 408 ||
    status === 409 ||
    status >= 500 ||
    error?.code === "ECONNABORTED" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNRESET"
  );
}

async function throttledRequest(config, runtimeConfig = {}) {
  const signal = runtimeConfig.signal ?? config.signal;
  const maxRetries = resolveMaxRetries(runtimeConfig);
  const retryBaseDelayMs = resolveRetryBaseDelayMs(runtimeConfig);
  const timeout = resolveRequestTimeoutMs(runtimeConfig);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(signal, "Richiesta CardTrader annullata.");
    await cardTraderRateLimiter.waitTurn({ signal });

    try {
      return await axios({
        timeout,
        signal,
        ...config,
      });
    } catch (error) {
      const retryAfterMs = extractRetryAfterMs(error);
      if (Number(error?.response?.status) === 429) {
        cardTraderRateLimiter.markRateLimited(retryAfterMs);
      }

      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const waitMs =
        retryAfterMs ??
        Math.min(30_000, retryBaseDelayMs * 2 ** attempt + attempt * 250);
      await sleep(waitMs, signal);
    }
  }

  throw new Error("Richiesta CardTrader fallita senza risposta utile.");
}

function createCardTraderService(runtimeConfig = {}) {
  async function fetchOrders() {
    let orders = [];
    let page = 1;
    const limit = 100;
    const fromDate = formatDate(
      new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
    );

    while (true) {
      throwIfAborted(runtimeConfig.signal, "Fetch ordini CardTrader annullato.");

      const { data } = await throttledRequest(
        {
          method: "get",
          url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/orders`,
          headers: buildHeaders(runtimeConfig),
          params: { sort: "date.desc", from: fromDate, page, limit },
        },
        runtimeConfig,
      );

      if (!Array.isArray(data) || data.length === 0) break;
      orders = orders.concat(data);
      page += 1;
    }

    return orders.filter((order) => order.state === "paid");
  }

  async function fetchOrderDetails(orderId) {
    const { data } = await throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/orders/${orderId}`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
    return data;
  }

  async function getExpansions() {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/expansions`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function getBlueprintsByExpansionId(expansionId) {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/blueprints/export?expansion_id=${expansionId}`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function getMyProducts() {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/products/export`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function getProduct(blueprintId) {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/marketplace/products?blueprint_id=${blueprintId}`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function getMarketplaceProductsByExpansionId(expansionId) {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/marketplace/products?expansion_id=${expansionId}`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function updateProductPrice(productId, priceCents) {
    return throttledRequest(
      {
        method: "put",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/products/${productId}`,
        headers: buildHeaders(runtimeConfig),
        data: { price: priceCents / 100 },
      },
      runtimeConfig,
    );
  }

  async function getCategories() {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/categories`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function getCart() {
    return throttledRequest(
      {
        method: "get",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/cart`,
        headers: buildHeaders(runtimeConfig),
      },
      runtimeConfig,
    );
  }

  async function addProductToCart({
    productId,
    quantity = 1,
    price = null,
    via_cardtrader_zero = false,
  }) {
    const payload = {
      product_id: productId,
      quantity,
      via_cardtrader_zero,
    };

    if (price !== null && typeof price !== "undefined") {
      payload.price = price;
    }

    return throttledRequest(
      {
        method: "post",
        url: `${resolveCardTraderApiBaseUrl(runtimeConfig)}/cart/add`,
        headers: buildHeaders(runtimeConfig),
        data: payload,
      },
      runtimeConfig,
    );
  }

  return {
    fetchOrders,
    fetchOrderDetails,
    getExpansions,
    getBlueprintsByExpansionId,
    getMyProducts,
    getProduct,
    getMarketplaceProductsByExpansionId,
    updateProductPrice,
    getCategories,
    getCart,
    addProductToCart,
  };
}

const defaultService = createCardTraderService();

module.exports = {
  cardTraderRateLimiter,
  createCardTraderService,
  ...defaultService,
};
