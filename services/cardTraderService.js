const axios = require("axios");
const { CARDTRADER_TOKEN } = require("../config/config");
const { formatDate } = require("../utils/dateUtils");

const headers = {
  headers: {
    Authorization: `Bearer ${process.env.CARDTRADER_TOKEN}`,
  },
};

const cardTraderApiBaseUrl = process.env.CARDTRADER_API_BASE_URL;
exports.fetchOrders = async () => {
  let orders = [],
    page = 1,
    limit = 100;
  const fromDate = formatDate(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));

  while (true) {
    const { data } = await axios.get(
      "https://api.cardtrader.com/api/v2/orders",
      {
        headers: headers.headers,
        params: { sort: "date.desc", from: fromDate, page, limit },
      }
    );
    if (!data.length) break;
    orders = orders.concat(data);
    page++;
  }
  return orders.filter((o) => o.state === "paid");
};

exports.fetchOrderDetails = async (orderId) => {
  const { data } = await axios.get(
    `https://api.cardtrader.com/api/v2/orders/${orderId}`,
    headers
  );
  return data;
};

exports.getExpansions = async () => {
  const url = `${cardTraderApiBaseUrl}/expansions`;
  const result = await axios.get(url, headers);
  return result;
};

exports.getBlueprintsByExpansionId = async (expansion_id) => {
  const url = `${cardTraderApiBaseUrl}/blueprints/export?expansion_id=${expansion_id}`;
  const result = await axios.get(url, headers);
  return result;
};

exports.getMyProducts = async () => {
  const url = `${cardTraderApiBaseUrl}/products/export`;
  const result = await axios.get(url, headers);
  return result;
};

exports.getProduct = async (blueprint_id) => {
  const url = `${cardTraderApiBaseUrl}/marketplace/products?blueprint_id=${blueprint_id}`;
  const result = await axios.get(url, headers);
  return result;
};

exports.getCategories = async () => {
  const url = `${cardTraderApiBaseUrl}/categories`;
  const result = await axios.get(url, headers);
  return result;
};
