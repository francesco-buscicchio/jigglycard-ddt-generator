const snifferService = require("../services/snifferService");

exports.sniffCardtraderProducts = async (req, res) => {
  try {
    snifferService
      .sniffCardtraderProducts()
      .then(() => {
        console.log("SniffCardtraderProducts completed successfully");
      })
      .catch((error) => {
        console.error("Sniffer error:", error);
      });

    res.status(202).send("Sniffer started for Cardtrader products.");
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send("An error occurred while initiating Cardtrader sniffer.");
  }
};
