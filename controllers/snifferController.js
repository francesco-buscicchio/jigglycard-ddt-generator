const snifferService = require("../services/snifferService");

export async function sniffCardtraderProducts() {
  try {
    await snifferService.sniffCardtraderProducts(); // aspetta tutto
    return {
      status: 200,
      data: "Sniffer completato.",
    };
  } catch (error) {
    console.error("❌ Errore nel controller:", error);
    return {
      status: 500,
      data: "Errore nello sniffer.",
    };
  }
}
