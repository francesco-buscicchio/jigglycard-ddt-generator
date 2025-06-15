const path = require("path");
const fs = require("fs");
const { parseCSV } = require("../utils/csvUtils");
const excelService = require("./excelService");
const fileService = require("./fileService");
const { Address, ShippingMethod, ShippingItem } = require("../models");
const { countryCodeToNameMap } = require("../const/countryCodeToNameMap");
const CARDMARKET_DIR = "cardmarket-file";

exports.processOrdersFromCSV = async () => {
  const ordersFile = getLatestFile(CARDMARKET_DIR, "orders-Jigglycard");
  const articlesFile = getLatestFile(CARDMARKET_DIR, "articles-Jigglycard");

  if (!ordersFile || !articlesFile) {
    throw new Error("Missing necessary Cardmarket CSV files.");
  }

  const ordersData = await parseCSV(ordersFile);
  const articlesData = await parseCSV(articlesFile);
  const currentDate = new Date();

  let ddtNumber = await fileService.getDDTNumber();
  const processedOrderIds = await fileService.getProcessedOrderIds();

  for (const order of ordersData) {
    if (
      order.status.trim().toLowerCase() !== "paid" &&
      order.status.trim().toLowerCase() !== "sent"
    )
      continue;
    const datePaid = new Date(order.datePaid);
    if (
      isNaN(datePaid.getTime()) ||
      currentDate - datePaid > 20 * 24 * 60 * 60 * 1000
    )
      continue;

    const orderId = order[`"idOrder"`];

    if (processedOrderIds.includes(orderId)) continue;

    const docAddress = new Address({
      name: order.shippingAddressName.trim(),
      street: `${order.shippingAddressStreet}${
        order.shippingAddressExtra ? ", " + order.shippingAddressExtra : ""
      }`.trim(),
      zip: order.shippingAddressZip.trim(),
      city: order.shippingAddressCity.trim(),
      state_or_province: "",
      country: convertCountryCodeToName(order.shippingAddressCountry.trim()),
      orderCode: orderId,
    });

    const shippingMethod = new ShippingMethod({
      id: null,
      name: order.shippingMethod.trim(),
      price:
        (convertPriceToCents(order.totalValue) -
          convertPriceToCents(order.articleValue)) /
        100,
    });

    const shippingItems = articlesData
      .filter((item) => item[`"idOrder"`] === orderId)
      .map(
        (item) =>
          new ShippingItem({
            name: item.name.trim(),
            collectionNumber: item.expansion ? item.expansion.trim() : "",
            price: convertPriceToCents(item.price) / 100,
            quantity: parseInt(item.items, 10) || 1,
          })
      );

    await excelService.generateExcel(
      ddtNumber,
      docAddress,
      shippingItems,
      shippingMethod
    );
    await fileService.logProcessedOrderId(orderId);
    ddtNumber++;
  }

  await fileService.updateDDTNumber(ddtNumber);
};

function getLatestFile(directory, prefix) {
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.startsWith(prefix))
    .map((file) => ({
      name: file,
      time: fs.statSync(path.join(directory, file)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  return files.length > 0 ? path.join(directory, files[0].name) : null;
}

function convertPriceToCents(priceString) {
  if (!priceString) return 0;
  return parseInt(priceString.replace(/[^\d]/g, ""), 10) * 100;
}

function convertCountryCodeToName(code) {
  return countryCodeToNameMap[code] || code;
}
