const snifferService = require("../services/snifferService");

export async function sniffCardtraderProducts() {
  try {
    snifferService
      .sniffCardtraderProducts()
      .then(() => console.log("Successfully sniffed out Cardtrader products."));
    return {
      status: 200,
      data: "It's beginning to sniff Cardtrader products.",
    };
  } catch (error) {
    console.error("❌ Errore in sniffCardtraderProducts:", error);
    return {
      status: 500,
      data: "An error occurred while processing Cardtrader sniffer",
    };
  }
}
