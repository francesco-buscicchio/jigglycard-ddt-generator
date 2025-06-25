import { getDDTList } from "../../controllers/driveController.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const { status, data } = await getDDTList();
  res.status(status).send(data);
}
