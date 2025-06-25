import { processOrders } from "../services/orderService.js";

export async function fetchAndProcessOrders() {
  try {
    await processOrders();
    return {
      status: 200,
      message: "DDTs generated successfully for new orders.",
    };
  } catch (error) {
    console.error("❌ Errore in fetchAndProcessOrders:", error);
    return {
      status: 500,
      message: "An error occurred while processing orders.",
    };
  }
}
