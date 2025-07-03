const { processOrdersFromCSV } = require("../services/cardmarketService.js");

exports.fetchAndProcessCardmarketOrders = async (req, res) => {
  try {
    await processOrdersFromCSV();
    return {
      status: 200,
      message: "DDTs generated successfully for Cardmarket orders.",
    };
  } catch (error) {
    console.error(error);
    return {
      status: 500,
      message: "An error occurred while processing Cardmarket orders.",
    };
  }
};

exports.uploadCSV = async ({ files }) => {
  try {
    const file1 = files["orders"]?.[0];
    const file2 = files["articles"]?.[0];

    if (!file1 || !file2) {
      return {
        status: 400,
        message: "Entrambi i file devono essere caricati.",
      };
    }

    console.log("File salvati in:", file1.filepath, file2.filepath);
    return {
      status: 200,
      message: "File salvati con successo nella cartella 'cardmarket-file'.",
    };
  } catch (err) {
    console.error("Errore nel salvataggio dei file:", err);
    return {
      status: 500,
      message: "Errore durante il salvataggio dei file.",
    };
  }
};
