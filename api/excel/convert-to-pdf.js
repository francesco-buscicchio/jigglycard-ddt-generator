import { IncomingForm } from "formidable";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { pathToFileURL } from "url";

const execFileAsync = promisify(execFile);
const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".ods"]);
const OFFICE_BINARY_CANDIDATES = [
  process.env.SOFFICE_BINARY_PATH,
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/snap/bin/libreoffice",
  "soffice",
  "libreoffice",
].filter(Boolean);

export const config = {
  api: {
    bodyParser: false,
  },
};

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getUploadedFile(files) {
  const candidates = [
    files.file,
    files.excel,
    files.xlsx,
  ].flat().filter(Boolean);

  return candidates[0] ?? null;
}

async function cleanupDirectory(directoryPath) {
  if (!directoryPath) return;
  await fsPromises.rm(directoryPath, { recursive: true, force: true });
}

async function convertExcelToPdf(inputPath, outputDir, profileDir) {
  const args = [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nolockcheck",
    "--nofirststartwizard",
    "--convert-to",
    "pdf:calc_pdf_Export",
    "--outdir",
    outputDir,
    inputPath,
  ];

  let lastError = null;
  for (const binaryPath of OFFICE_BINARY_CANDIDATES) {
    try {
      await execFileAsync(binaryPath, args);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }

  throw new Error(
    [
      "LibreOffice non trovato sul server.",
      "Installa il binario `soffice` sulla VM Google oppure configura `SOFFICE_BINARY_PATH`.",
      lastError?.message,
    ].filter(Boolean).join(" "),
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const workingDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "excel-to-pdf-"),
  );
  const outputDir = path.join(workingDir, "output");
  const profileDir = path.join(workingDir, "lo-profile");
  await fsPromises.mkdir(outputDir, { recursive: true });
  await fsPromises.mkdir(profileDir, { recursive: true });

  const form = new IncomingForm({
    multiples: false,
    uploadDir: workingDir,
    keepExtensions: true,
    maxFiles: 1,
    filename: (_, file) => {
      const originalFilename = file.originalFilename || `excel-${Date.now()}.xlsx`;
      return sanitizeFilename(originalFilename);
    },
  });

  try {
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, fields, parsedFiles) => {
        if (error) return reject(error);
        resolve({ fields, files: parsedFiles });
      });
    });

    const uploadedFile = getUploadedFile(files);
    if (!uploadedFile?.filepath) {
      return res.status(400).json({
        error: "Nessun file Excel ricevuto. Usa il campo `file` nel form-data.",
      });
    }

    const originalFilename = uploadedFile.originalFilename || path.basename(uploadedFile.filepath);
    const fileExtension = path.extname(originalFilename).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(fileExtension)) {
      return res.status(400).json({
        error: "Formato non supportato. Carica un file .xlsx, .xls oppure .ods.",
      });
    }

    const pdfFilename = `${path.basename(originalFilename, fileExtension)}.pdf`;
    const pdfPath = path.join(outputDir, pdfFilename);

    await convertExcelToPdf(uploadedFile.filepath, outputDir, profileDir);

    if (!fs.existsSync(pdfPath)) {
      throw new Error("Conversione completata ma PDF non trovato.");
    }

    const pdfBuffer = await fsPromises.readFile(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilename(pdfFilename)}"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.status(200).end(pdfBuffer);
  } catch (error) {
    console.error("Errore conversione Excel -> PDF:", error);
    return res.status(500).json({
      error: "Errore durante la conversione Excel -> PDF",
      details: error?.message ?? "Errore sconosciuto",
    });
  } finally {
    await cleanupDirectory(workingDir);
  }
}
