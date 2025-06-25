import formidable from "formidable";
import fs from "fs";
import path from "path";
import { uploadCSV } from "../../controllers/cardmarketController.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).end("Metodo non consentito");

  const uploadDir = path.join(process.cwd(), "cardmarket-file");
  fs.mkdirSync(uploadDir, { recursive: true });

  const form = new formidable.IncomingForm({
    multiples: true,
    uploadDir,
    keepExtensions: true,
    filename: (_, file) => file.originalFilename,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("Errore parsing form:", err);
      return res.status(500).send("Errore nel parsing del form");
    }

    const { status, message } = await uploadCSV({ files, fields });
    res.status(status).send(message);
  });
}
