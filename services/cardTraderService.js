const axios = require("axios");
const { CARDTRADER_TOKEN } = require("../config/config");
const { formatDate } = require("../utils/dateUtils");

const headers = {
  Authorization: `Bearer ${CARDTRADER_TOKEN}`,
};

exports.fetchOrders = async () => {
  let orders = [],
    page = 1,
    limit = 100;
  const fromDate = formatDate(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));

  while (true) {
    const { data } = await axios.get(
      "https://api.cardtrader.com/api/v2/orders",
      {
        headers,
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
    { headers }
  );
  return data;
};
