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
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
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

// Retention degli artefatti PDF: elimina da pdf_export i file più vecchi del TTL.
// Copre i file orfani che pruneHistory non raggiunge (es. dopo un restart).
async function pruneExpiredArtifacts({ ttlMs, now = Date.now() } = {}) {
  const maxAgeMs = Math.max(60_000, Number(ttlMs) || 24 * 60 * 60 * 1000);
  let removedCount = 0;

  let entries;
  try {
    entries = await fsPromises.readdir(RESULT_DIRECTORY);
  } catch (error) {
    if (error.code === "ENOENT") return { removedCount };
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(RESULT_DIRECTORY, entry);
    try {
      const stats = await fsPromises.stat(entryPath);
      if (!stats.isFile()) continue;
      if (now - stats.mtimeMs > maxAgeMs) {
        await fsPromises.rm(entryPath, { force: true });
        removedCount += 1;
      }
    } catch {
      continue;
    }
  }

  return { removedCount };
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
  const uploadedFilename = path.basename(String(uploadedFilePath || ""));
  const uploadedFileExtension = path.extname(uploadedFilename).toLowerCase();
  const uploadedPdfFilename = `${path.basename(
    uploadedFilename,
    uploadedFileExtension || fileExtension,
  )}.pdf`;
  const originalPdfFilename = `${path.basename(safeOriginalFilename, fileExtension)}.pdf`;

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

    let resolvedPdfPath = path.join(outputDir, uploadedPdfFilename);
    if (!fs.existsSync(resolvedPdfPath)) {
      const fallbackOriginalPath = path.join(outputDir, originalPdfFilename);
      if (fs.existsSync(fallbackOriginalPath)) {
        resolvedPdfPath = fallbackOriginalPath;
      } else {
        const generatedPdfFiles = (await fsPromises.readdir(outputDir))
          .filter((entry) => entry.toLowerCase().endsWith(".pdf"))
          .sort();

        if (generatedPdfFiles.length === 1) {
          resolvedPdfPath = path.join(outputDir, generatedPdfFiles[0]);
        } else {
          throw new Error("Conversione completata ma PDF non trovato.");
        }
      }
    }

    const finalPdfFilename =
      sanitizeFilename(originalPdfFilename) || sanitizeFilename(uploadedPdfFilename);
    if (!fs.existsSync(resolvedPdfPath)) {
      throw new Error("Conversione completata ma PDF non trovato.");
    }

    const artifactFilename = `${task.id}-${finalPdfFilename}`;
    const artifactPath = path.join(RESULT_DIRECTORY, artifactFilename);
    await fsPromises.copyFile(resolvedPdfPath, artifactPath);

    const stats = await fsPromises.stat(artifactPath);
    return {
      artifactPath,
      filename: finalPdfFilename,
      contentType: "application/pdf",
      bytes: stats.size,
    };
  } finally {
    await cleanupDirectory(workingDir);
  }
}

module.exports = {
  ALLOWED_EXTENSIONS,
  RESULT_DIRECTORY,
  cleanupDirectory,
  ensureAllowedExcelExtension,
  executeExcelConversionTask,
  pruneExpiredArtifacts,
  sanitizeFilename,
};
