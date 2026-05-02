const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { pathToFileURL } = require("url");
const { throwIfAborted } = require("../utils/abort");

const execFileAsync = promisify(execFile);
const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xls", ".ods"]);
const RESULT_DIRECTORY = path.join(__dirname, "..", "pdf_export");

function sanitizeFilename(filename) {
  return String(filename || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureAllowedExcelExtension(filename) {
  const fileExtension = path.extname(String(filename || "")).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(fileExtension)) {
    throw new Error(
      "Formato non supportato. Carica un file .xlsx, .xls oppure .ods.",
    );
  }

  return fileExtension;
}

function getOfficeBinaryCandidates(sofficeBinaryPath) {
  return [
    sofficeBinaryPath,
    process.env.SOFFICE_BINARY_PATH,
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/snap/bin/libreoffice",
    "soffice",
    "libreoffice",
  ].filter(Boolean);
}

async function cleanupDirectory(directoryPath) {
  if (!directoryPath) return;
  await fsPromises.rm(directoryPath, { recursive: true, force: true });
}

async function convertExcelToPdf({
  inputPath,
  outputDir,
  profileDir,
  sofficeBinaryPath,
  timeoutMs,
  signal,
}) {
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
  for (const binaryPath of getOfficeBinaryCandidates(sofficeBinaryPath)) {
    try {
      throwIfAborted(signal, "Conversione Excel annullata.");
      await execFileAsync(binaryPath, args, {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
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
    ]
      .filter(Boolean)
      .join(" "),
  );
}

async function executeExcelConversionTask(payload = {}, { task, signal } = {}) {
  const {
    uploadedFilePath,
    originalFilename,
    workingDir,
    outputDir,
    profileDir,
    sofficeBinaryPath,
  } = payload;

  const safeOriginalFilename =
    originalFilename || path.basename(String(uploadedFilePath || ""));
  const fileExtension = ensureAllowedExcelExtension(safeOriginalFilename);
  const pdfFilename = `${path.basename(safeOriginalFilename, fileExtension)}.pdf`;
  const pdfPath = path.join(outputDir, pdfFilename);

  try {
    await fsPromises.mkdir(RESULT_DIRECTORY, { recursive: true });
    await convertExcelToPdf({
      inputPath: uploadedFilePath,
      outputDir,
      profileDir,
      sofficeBinaryPath,
      timeoutMs: task.timeoutMs,
      signal,
    });

    throwIfAborted(signal, "Conversione Excel annullata.");

    if (!fs.existsSync(pdfPath)) {
      throw new Error("Conversione completata ma PDF non trovato.");
    }

    const artifactFilename = `${task.id}-${sanitizeFilename(pdfFilename)}`;
    const artifactPath = path.join(RESULT_DIRECTORY, artifactFilename);
    await fsPromises.copyFile(pdfPath, artifactPath);

    const stats = await fsPromises.stat(artifactPath);
    return {
      artifactPath,
      filename: sanitizeFilename(pdfFilename),
      contentType: "application/pdf",
      bytes: stats.size,
    };
  } finally {
    await cleanupDirectory(workingDir);
  }
}

module.exports = {
  ALLOWED_EXTENSIONS,
  cleanupDirectory,
  ensureAllowedExcelExtension,
  executeExcelConversionTask,
  sanitizeFilename,
};
