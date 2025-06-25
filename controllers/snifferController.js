const snifferService = require("../services/snifferService");

exports.sniffCardtraderProducts = async (req, res) => {
  try {
    await snifferService.sniffCardtraderProducts();
    res.status(200).send("Sniffed successfully for Cardtrader products.");
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send("An error occurred while processing Cardtrader sniffer.");
  }
};
