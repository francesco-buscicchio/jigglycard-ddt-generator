import { IncomingForm } from "formidable";
import fs from "fs";
import fsPromises from "fs/promises";
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

  const form = new IncomingForm({
    multiples: true,
    uploadDir,
    keepExtensions: true,
    filename: (_, file) => file.originalFilename || `upload-${Date.now()}.csv`,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("Errore parsing form:", err);
      return res.status(500).send("Errore nel parsing del form");
    }

    const ordersFile = files["orders"];
    const articlesFile = files["articles"];

    try {
      if (ordersFile[0]?.filepath) {
        const newOrdersPath = path.join(
          uploadDir,
          ordersFile[0].originalFilename
        );
        await fsPromises.rename(ordersFile[0].filepath, newOrdersPath);
        ordersFile.filepath = newOrdersPath;
      }
      if (articlesFile[0]?.filepath) {
        const newArticlesPath = path.join(
          uploadDir,
          articlesFile[0].originalFilename
        );
        await fsPromises.rename(articlesFile[0].filepath, newArticlesPath);
        articlesFile.filepath = newArticlesPath;
      }
    } catch (renameErr) {
      console.error("Errore nel rinominare i file:", renameErr);
      return res.status(500).send("Errore nella ridenominazione dei file.");
    }

    const { status, message } = await uploadCSV({ files, fields });
    res.status(status).send(message);
  });
}
