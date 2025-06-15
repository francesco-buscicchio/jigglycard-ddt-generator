const fs = require("fs");
const { google } = require("googleapis");
const mime = require("mime-types");
const { Readable } = require("stream");

const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

/**
 * Carica un file su Drive.
 * @param {string} filePath
 * @param {string} fileName
 * @param {string} [folderId]
 * @returns {Promise<{id, webViewLink, webContentLink}>}
 */
exports.uploadFile = async (filePath, fileName, folderId) => {
  const fileMetadata = {
    name: fileName,
    parents: folderId ? [folderId] : [],
  };

  const media = {
    mimeType: mime.lookup(filePath) || "application/octet-stream",
    body: fs.createReadStream(filePath),
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, webViewLink, webContentLink",
  });

  return res.data;
};

/**
 * Trova o crea una sottocartella "DDT [anno]" dentro una cartella padre.
 * @param {string} parentFolderId – ID della cartella "DDT"
 * @param {string} folderName     – es. "DDT 2025"
 * @returns {Promise<string>}     – ID della sottocartella
 */
async function getOrCreateSubfolder(parentFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // Crea se non esiste
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });

  return createRes.data.id;
}

exports.getNextDDTNumber = async () => {
  const year = new Date().getFullYear(); // es. 2025
  const rootId = process.env.DDT_ROOT_FOLDER_ID;
  const yearFolderName = `DDT ${year}`;

  // 1️⃣ Cerca la sottocartella "DDT YYYY"
  const folderRes = await drive.files.list({
    q:
      `'${rootId}' in parents and name = '${yearFolderName}' ` +
      `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (folderRes.data.files.length === 0) {
    // Nessun DDT per quest'anno → primo numero sarà 1
    return 1;
  }

  const folderId = folderRes.data.files[0].id;

  // 2️⃣ Elenca i file nella cartella annuale
  const filesRes = await drive.files.list({
    q:
      `'${folderId}' in parents and trashed = false ` +
      `and mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(name)",
    pageSize: 1000,
  });

  // 3️⃣ Estrai i numeri già usati
  const numbers = filesRes.data.files
    .map((f) => {
      const m = f.name.match(/^\d{4}-(\d+)\.pdf$/);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(Boolean) // rimuovi null
    .sort((a, b) => a - b);

  // 4️⃣ Trova il primo “buco” o max+1
  let next = 1;
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      next = i + 1; // primo numero mancante
      break;
    }
  }
  if (
    next === 1 &&
    numbers.length &&
    numbers[numbers.length - 1] === numbers.length
  ) {
    next = numbers.length + 1; // nessun buco trovato
  }

  return next;
};

/** Scarica il contenuto di un file Drive come stringa */
async function downloadText(fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" }, // alt=media → body = dati del file
    { responseType: "stream" }
  ); // :contentReference[oaicite:0]{index=0}

  return new Promise((resolve, reject) => {
    let data = "";
    res.data
      .on("data", (chunk) => (data += chunk))
      .on("end", () => resolve(data))
      .on("error", reject);
  });
}

/** Aggiorna (sovrascrive) un file testo con `content` */
function uploadText(fileId, content) {
  return drive.files.update({
    // :contentReference[oaicite:1]{index=1}
    fileId,
    media: {
      mimeType: "text/plain",
      body: Readable.from([content]),
    },
  });
}

/** Trova (o crea) il file processed_orders.txt e torna il suo ID */
async function getOrCreateProcessedFile() {
  // 1. cerco nella cartella DDT
  const res = await drive.files.list({
    q:
      `'${ROOT_DDT_ID}' in parents and name='${PROCESSED_FILE_NAME}' ` +
      `and mimeType='text/plain' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (res.data.files.length) {
    return res.data.files[0].id;
  }

  // 2. se non c'è, lo creo vuoto
  const create = await drive.files.create({
    requestBody: {
      name: PROCESSED_FILE_NAME,
      mimeType: "text/plain",
      parents: [ROOT_DDT_ID],
    },
    media: { mimeType: "text/plain", body: "" }, // uploadType=media :contentReference[oaicite:2]{index=2}
    fields: "id",
  });

  return create.data.id;
}

exports.downloadText = async (fileId) => {
  const res = await drive.files.get(
    { fileId, alt: "media" }, // alt=media → body = dati del file
    { responseType: "stream" }
  ); // :contentReference[oaicite:0]{index=0}

  return new Promise((resolve, reject) => {
    let data = "";
    res.data
      .on("data", (chunk) => (data += chunk))
      .on("end", () => resolve(data))
      .on("error", reject);
  });
};

exports.uploadText = async (fileId, content) => {
  return drive.files.update({
    fileId,
    media: {
      mimeType: "text/plain",
      body: Readable.from([content]),
    },
  });
};

exports.getOrCreateProcessedFile = async (fileId, content) => {
  const res = await drive.files.list({
    q:
      `'${process.env.ROOT_DDT_ID}' in parents and name='${process.env.PROCESSED_FILE_NAME}' ` +
      `and mimeType='text/plain' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (res.data.files.length) {
    return res.data.files[0].id;
  }

  const create = await drive.files.create({
    requestBody: {
      name: PROCESSED_FILE_NAME,
      mimeType: "text/plain",
      parents: [ROOT_DDT_ID],
    },
    media: { mimeType: "text/plain", body: "" },
    fields: "id",
  });

  return create.data.id;
};
