import { fetchAndProcessOrders } from "../../controllers/cardtraderController.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const { status, message } = await fetchAndProcessOrders();
  res.status(status).send(message);
}
