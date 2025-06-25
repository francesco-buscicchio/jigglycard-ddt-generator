import { fetchAndProcessCardmarketOrders } from "../../controllers/cardmarketController.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end("Metodo non consentito");

  const { status, message } = await fetchAndProcessCardmarketOrders();
  res.status(status).send(message);
}
