import { downloadFileByName } from "../../controllers/driveController.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Metodo non consentito");
  }

  const name = req.query.name;
  const { status, data, file } = await downloadFileByName(name);

  if (status !== 200) {
    return res.status(status).send(data);
  }

  try {
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Content-Type", file.mimeType);
    file.stream.pipe(res);
  } catch (error) {
    console.error("Errore stream file:", error);
    res.status(500).send("Errore durante il download");
  }
}
