const fs = require("fs");
const { google } = require("googleapis");
const mime = require("mime-types");
const { Readable } = require("stream");

const auth = new google.auth.GoogleAuth({
  credentials: {
    type: "service_account",
    project_id: "ddt-generation",
    private_key_id: "a2d9c36287fe3f92a1495b5cbbbf5ddfb2baee9d",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDKl17pC17p3nbH\nx5BGlJEw59C7PXML3BIukQ5vV6bTj7K1Ellz+NYJzskObt4esaGoSBgOw7R11C/b\nSyIwCcIZXv7jFXdzW4E6KHLJAZIJHqIbnAKQLTFaPuIsI/QoYLKQjD6Y8/prmWMz\nEU3utZR0Kz16ItTjIVcRfpXkt54dTDErGBxoRkVW2sHz6JFhJrBUcD5NgBGggHKf\n7PsVXqrV83nXIkeDZtzwBfH4YPpXGqrq6AJovgyu5W0tWtC5Tl/B14fiVa6WdPsC\nNmDA7vWEAj2tbkQNrgwWnRFUoqcVZ/DaTvA08YSvXYljPlS9F25exfCrTahISfZ8\nVtlB4jsDAgMBAAECggEAASsiVwHDyGGKGdji0iVlOPz9TTcrhLP+PtqDVM0Sn0HC\n7Bxw+6RBx8izjCvDiDXKEuhnix5B2jQhGoiyZ8iGoBLWMYUcLUQn2KgHEXW62+ab\nVMFvmllIYZbfQxXqAJmeLgtBCSzPEvPNiKve4TOW6ZyePCgbRjwY/nbWcn1EojKd\nqfkRkVQ/XLlNQwp78MnoY2Qe2avNvRvL2Z0Z53dHd59jq7FEiVjYu/xfsaJNdMho\nFKrz0VYzVMjwsKy5RGwBQh2qRCTrB5xeduwN0wWt93dMgBUKlawDRoR75TY2iVoz\nDX9GIgUUcvRTmBvxLD4BhFaTYQ19kR3CQJNA2N1cgQKBgQD8HOrxwOGQ82ah/eL1\nS6tSti6lo6l/V1nBk8ahE+aeNWXxBGQEOtyeLGfWS4BAXwYEwMrCoc/RjsN4o2Dy\nzSd6f2SF+ThaNuVKH5xQM+LdkOypib6gqgfPsfrDwZUYEPV+dZupD/uwuQSkPv+6\nytvRiAdRAX1/xnJtEyZbwiGUIwKBgQDNtv4SAOpU6nQicBlDLfcur4UoYZtfjTDg\n2r5hv6bTIKZk36cU0GhT30/DoLCUqZzeU2dq7NgbTgByxJ3M5ISSjaz9+evFyvlK\nbGjMGOV/eFKNyT7DagRou3wY9IDchKA5tb+4C8IKHnT3zzmrbgxeTIXtHxDBJ4wc\n0yzRZeA7oQKBgQCVp7jTjzKW79VxvZsXDzcA30Jrcu5vt/OA1G7pOT4BliMQYhHY\n7PP/NM7ix2i3TXDuK19xD8qkU8G3AAzRtHSF489RM/J+ou2TBZatiU9XROsnbKvr\nBWOjp7v6rhQJ+C8yRTAEuIcojXuy3+6//CFmjQAC1wafbbaJBwATIfb6zwKBgQCv\nr1J4ybNW5gxcxOOuTflGM7xC6mkpR4mw3t+s12J/+OhiSeeFjR8sUhDq/7cOn3RL\nI2u1E6TUXN9hJK2nqJnYF4rgNKq490nD16YAeFq3bGkEkhQ6C7bMQyIOpfHPYqz7\n3E5pvhDvV2eJo76au5dwiWXvRpKmg0HT9D3Yb2r7QQKBgQDTQyol33c6MkYknNRX\nl2S40y+CTBTCas+2Llv6BeLHHi0hmn61Vga+pHRBaxU7YyAqRZ5pdyr+GF2fuVWM\nsfFzlPlIMf3+PcXjR01ipUklMo05087kJqNY5u3vz/3LVCAtAK34L6aXLIjiQl9F\ntxE66lLEbqwW4SmqEqT70BsnCQ==\n-----END PRIVATE KEY-----\n",
    client_email: "ddt-generato@ddt-generation.iam.gserviceaccount.com",
    client_id: "116861297205519680644",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url:
      "https://www.googleapis.com/robot/v1/metadata/x509/ddt-generato%40ddt-generation.iam.gserviceaccount.com",
    universe_domain: "googleapis.com",
  },
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

async function getFilesInFolder(
  parentFolderID,
  folderName,
  fileType = "pdf",
  mapFile = true
) {
  const folderRes = await drive.files.list({
    q:
      `'${parentFolderID}' in parents and name = '${folderName}' ` +
      `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (folderRes.data.files.length === 0) {
    return 1;
  }

  const folderId = folderRes.data.files[0].id;

  const filesRes = await drive.files.list({
    q:
      `'${folderId}' in parents and trashed = false ` +
      `and mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(name)",
    pageSize: 1000,
  });

  if (mapFile)
    return filesRes.data.files
      .map((f) => {
        const safeType = fileType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // opzionale se proviene da input esterno

        const re = new RegExp(
          `^\\d{4}-(\\d+)(?:\\s*-\\s*[^.]+)?\\.${safeType}$`
        );

        const m = f.name.match(re);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
  else return filesRes.data.files;
}

exports.getDDTList = async (mapFile = true) => {
  const year = new Date().getFullYear(); // es. 2025
  const rootId = process.env.DDT_ROOT_FOLDER_ID;
  const rootDocumentsFolder = process.env.ROOT_DDT_ID;
  const yearFolderName = `DDT ${year}`;

  const files = await getFilesInFolder(
    rootId,
    yearFolderName,
    undefined,
    mapFile
  );
  const filesTemp = await getFilesInFolder(
    rootDocumentsFolder,
    "DDT TEMP",
    "xlsx",
    mapFile
  );

  const numbers = [...new Set(files.concat(filesTemp).filter(Boolean))];
  numbers.sort((a, b) => a - b);

  return numbers;
};

exports.getNextDDTNumber = async () => {
  const numbers = await this.getDDTList();

  let next = 1;
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      next = i + 1;
      break;
    }
  }
  if (
    next === 1 &&
    numbers.length &&
    numbers[numbers.length - 1] === numbers.length
  ) {
    next = numbers.length + 1;
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

exports.downloadFileByName = async (fileName) => {
  const year = new Date().getFullYear(); // es. 2025
  const yearFolderName = `DDT ${year}`;

  const rootId = process.env.DDT_ROOT_FOLDER_ID;
  const rootTemp = process.env.ROOT_DDT_ID;

  const findFileInFolder = async (parentId, folderName) => {
    const folderRes = await drive.files.list({
      q: `'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });

    if (!folderRes.data.files.length) return null;
    const folderId = folderRes.data.files[0].id;

    const fileRes = await drive.files.list({
      q: `'${folderId}' in parents and name = '${fileName}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "files(id, mimeType, name)",
      pageSize: 1,
    });

    return fileRes.data.files[0] || null;
  };

  const file =
    (await findFileInFolder(rootId, yearFolderName)) ||
    (await findFileInFolder(rootTemp, "DDT TEMP"));

  if (!file) return null;

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "stream" }
  );

  return {
    stream: res.data,
    mimeType: file.mimeType,
    name: file.name,
  };
};
