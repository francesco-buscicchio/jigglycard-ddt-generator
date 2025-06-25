const cardmarketService = require("../services/cardmarketService");

exports.fetchAndProcessCardmarketOrders = async (req, res) => {
  try {
    await cardmarketService.processOrdersFromCSV();
    res.status(200).send("DDTs generated successfully for Cardmarket orders.");
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send("An error occurred while processing Cardmarket orders.");
  }
};

exports.uploadCSV = async (req, res) => {
  try {
    const file1 = req.files["orders"]?.[0];
    const file2 = req.files["articles"]?.[0];

    if (!file1 || !file2) {
      return res.status(400).send("Entrambi i file devono essere caricati.");
    }

    console.log("File salvati in:", file1.path, file2.path);
    res
      .status(200)
      .send("File salvati con successo nella cartella 'cardmarket-file'.");
  } catch (err) {
    console.error("Errore nel salvataggio dei file:", err);
    res.status(500).send("Errore durante il salvataggio dei file.");
  }
};
