const axios = require("axios");
const { CARDTRADER_TOKEN } = require("../config/config");
const { formatDate } = require("../utils/dateUtils");

const headers = {
  headers: {
    Authorization: `Bearer ${process.env.CARDTRADER_TOKEN}`,
  },
};

const cardTraderApiBaseUrl =
  process.env.CARDTRADER_API_BASE_URL ?? "https://api.cardtrader.com/api/v2";
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_REQUESTS = 190;
const requestTimestamps = [];

async function throttleCardTraderRequest() {
  while (true) {
    const now = Date.now();

    while (
      requestTimestamps.length > 0 &&
      now - requestTimestamps[0] >= RATE_LIMIT_WINDOW_MS
    ) {
      requestTimestamps.shift();
    }

    if (requestTimestamps.length < RATE_LIMIT_MAX_REQUESTS) {
      requestTimestamps.push(now);
      return;
    }

    const waitMs = Math.max(
      50,
      RATE_LIMIT_WINDOW_MS - (now - requestTimestamps[0]) + 25,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function throttledRequest(config) {
  await throttleCardTraderRequest();
  return axios(config);
}

exports.fetchOrders = async () => {
  let orders = [],
    page = 1,
    limit = 100;
  const fromDate = formatDate(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));

  while (true) {
    const { data } = await throttledRequest({
      method: "get",
      url: "https://api.cardtrader.com/api/v2/orders",
      headers: headers.headers,
      params: { sort: "date.desc", from: fromDate, page, limit },
    });
    if (!data.length) break;
    orders = orders.concat(data);
    page++;
  }
  return orders.filter((o) => o.state === "paid");
};

exports.fetchOrderDetails = async (orderId) => {
  const { data } = await throttledRequest({
    method: "get",
    url: `https://api.cardtrader.com/api/v2/orders/${orderId}`,
    ...headers,
  });
  return data;
};

exports.getExpansions = async () => {
  const url = `${cardTraderApiBaseUrl}/expansions`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.getBlueprintsByExpansionId = async (expansion_id) => {
  const url = `${cardTraderApiBaseUrl}/blueprints/export?expansion_id=${expansion_id}`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.getMyProducts = async () => {
  const url = `${cardTraderApiBaseUrl}/products/export`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.getProduct = async (blueprint_id) => {
  const url = `${cardTraderApiBaseUrl}/marketplace/products?blueprint_id=${blueprint_id}`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.getMarketplaceProductsByExpansionId = async (expansionId) => {
  const url = `${cardTraderApiBaseUrl}/marketplace/products?expansion_id=${expansionId}`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.updateProductPrice = async (productId, priceCents) => {
  const url = `${cardTraderApiBaseUrl}/products/${productId}`;
  const result = await throttledRequest({
    method: "put",
    url,
    data: { price: priceCents / 100 },
    ...headers,
  });
  return result;
};

exports.getCategories = async () => {
  const url = `${cardTraderApiBaseUrl}/categories`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.getCart = async () => {
  const url = `${cardTraderApiBaseUrl}/cart`;
  const result = await throttledRequest({
    method: "get",
    url,
    ...headers,
  });
  return result;
};

exports.addProductToCart = async ({
  productId,
  quantity = 1,
  price = null,
  via_cardtrader_zero = false,
}) => {
  const url = `${cardTraderApiBaseUrl}/cart/add`;
  const payload = {
    product_id: productId,
    quantity,
    via_cardtrader_zero,
  };

  if (price !== null && typeof price !== "undefined") {
    payload.price = price;
  }

  const result = await throttledRequest({
    method: "post",
    url,
    data: payload,
    ...headers,
  });
  return result;
};
