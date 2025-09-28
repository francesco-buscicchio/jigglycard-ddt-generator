require("dotenv").config();

module.exports = {
  PORT: process.env.PORT || 3000,
  CARDTRADER_TOKEN: process.env.CARDTRADER_TOKEN,
  PROCESSED_ORDERS_FILE: "processed_orders.txt",
  DDT_NUMBER_FILE: "ddt_number.txt",
  TEMPLATE_FILE: "./template.xlsx",
  CARDMARKET_DIR: "cardmarket-file",
};
