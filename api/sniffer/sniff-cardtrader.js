import { sniffCardtraderProducts } from "../../controllers/snifferController.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Metodo non consentito");
  }

  const { status, message } = await sniffCardtraderProducts();
  res.status(status).send(message);
}
