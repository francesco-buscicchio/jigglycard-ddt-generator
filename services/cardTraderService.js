const axios = require("axios");
const { CARDTRADER_TOKEN } = require("../config/config");
const { formatDate } = require("../utils/dateUtils");

const headers = {
  headers: {
    Authorization: `Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJjYXJkdHJhZGVyLXByb2R1Y3Rpb24iLCJzdWIiOiJhcHA6MTI5MTEiLCJhdWQiOiJhcHA6MTI5MTEiLCJleHAiOjQ5MDYxNjMxNTcsImp0aSI6ImMzMTg5ZWU5LWUxODYtNGUzOS05MzMzLWM4YTkyMjllNGMzYyIsImlhdCI6MTc1MDQ4OTU1NywibmFtZSI6IkppZ2dseWNhcmQgQXBwIDIwMjQxMTI4MTA0NzA4In0.QemL01Nfoner6rRXHJBAZJy_a61P3IVuM6-9C51f9cmg-qdPnmpSOa6xQzEVC3LY5_Jx3gwDDpInd6UcDQ301v0asIMI8Ws2avSiRqrSGKbJoDkOMWpREJFKHn98elomTj0R96njH8M4BtW06XoAYYRt0pBMH03ClDx_JjVog07UQGZ7OIaW2j7FnSgj3qmzspZMxRVUVyyBqNnZZY2r5tiuZPi1NgHBPHFYnBVCs86LD4Mp_bMHXzvCzuO84fy3_H0GvVoLIVLBW3bq8HQeb05lDIlycXlJINuue1MZQgpCse9fQTzJ61ixuATqJVgMmMvMxDuHmmr25L_o6mlZSA`,
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

exports.getExpansions = async () => {
  const url = `${cardTraderApiBaseUrl}/expansions`;
  const result = await axios.get(url, {
    headers: {
      Authorization: `Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJjYXJkdHJhZGVyLXByb2R1Y3Rpb24iLCJzdWIiOiJhcHA6MTI5MTEiLCJhdWQiOiJhcHA6MTI5MTEiLCJleHAiOjQ5MDYxNjMxNTcsImp0aSI6ImMzMTg5ZWU5LWUxODYtNGUzOS05MzMzLWM4YTkyMjllNGMzYyIsImlhdCI6MTc1MDQ4OTU1NywibmFtZSI6IkppZ2dseWNhcmQgQXBwIDIwMjQxMTI4MTA0NzA4In0.QemL01Nfoner6rRXHJBAZJy_a61P3IVuM6-9C51f9cmg-qdPnmpSOa6xQzEVC3LY5_Jx3gwDDpInd6UcDQ301v0asIMI8Ws2avSiRqrSGKbJoDkOMWpREJFKHn98elomTj0R96njH8M4BtW06XoAYYRt0pBMH03ClDx_JjVog07UQGZ7OIaW2j7FnSgj3qmzspZMxRVUVyyBqNnZZY2r5tiuZPi1NgHBPHFYnBVCs86LD4Mp_bMHXzvCzuO84fy3_H0GvVoLIVLBW3bq8HQeb05lDIlycXlJINuue1MZQgpCse9fQTzJ61ixuATqJVgMmMvMxDuHmmr25L_o6mlZSA`,
    },
  });
  return result;
};

exports.getBlueprintsByExpansionId = async (expansion_id) => {
  const url = `${cardTraderApiBaseUrl}/blueprints/export?expansion_id=${expansion_id}`;
  const result = await axios.get(url, headers);
  return result;
};

exports.getProduct = async (blueprint_id) => {
  const url = `${cardTraderApiBaseUrl}/marketplace/products?blueprint_id=${blueprint_id}`;
  const result = await axios.get(url, headers);
  return result;
};
