const fs = require("fs");
const path = require("path");
const {
  describeIdempotency,
  listTaskDefinitions,
} = require("../config/taskDefinitions");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "endpoint-weights.md");

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "";
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  return `${value}ms`;
}

function formatResources(resources = []) {
  return resources.map((resource) => `\`${resource}\``).join(", ");
}

function formatTaskRow(definition) {
  return [
    definition.taskType,
    definition.endpoint,
    definition.method,
    definition.description,
    definition.weight,
    formatResources(definition.resources),
    definition.concurrencyGroup,
    formatDuration(definition.timeoutMs),
    definition.maxRetries,
    describeIdempotency(definition.idempotency),
    definition.operationalNotes,
  ]
    .map(escapeCell)
    .join(" | ");
}

function generateEndpointWeightsDoc() {
  const rows = listTaskDefinitions()
    .slice()
    .sort((left, right) => {
      if (left.endpoint !== right.endpoint) {
        return left.endpoint.localeCompare(right.endpoint);
      }
      return left.taskType.localeCompare(right.taskType);
    })
    .map((definition) => `| ${formatTaskRow(definition)} |`)
    .join("\n");

  return `# Endpoint Weights And Queue Contracts

Riferimento ufficiale per priorita, risorse e policy dei task accodati dal server CMS.

Fonte unica: \`config/taskDefinitions.js\`
Generazione: \`npm run docs:generate\`
Verifica: \`npm run docs:check\`

## Regole Globali

- Peso piu basso = priorita piu alta.
- A parita di peso vale FIFO sulla sequenza di enqueue.
- Gli endpoint accodano solo \`taskType\` e payload; peso, timeout, retry, risorse, idempotenza e concorrenza sono letti dal registry.
- Task type sconosciuti o assenti dal registry vengono rifiutati da \`services/requestQueue.js\`.
- I task CardTrader dichiarano la risorsa \`cardtrader\`, un gruppo \`cardtrader-*\` e \`rateLimitGroup: "cardtrader"\`.

## Endpoint Che Accodano Task

| Task type | Endpoint | Metodo HTTP | Descrizione | Peso | Risorse richieste | Gruppo di concorrenza | Timeout | Max retry | Idempotenza | Note operative |
| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- |
${rows}

## Endpoint Operativi

| Endpoint | Metodo | Descrizione | Accoda task | Note |
| --- | --- | --- | --- | --- |
| \`/api/tasks\` | \`GET\` | Lista task con filtri \`status\`, \`taskType\`, \`limit\`. | No | Usa i metadati pubblici prodotti dalla coda. |
| \`/api/tasks\` | \`POST\` | Crea genericamente un task JSON supportato. | Si | Accetta solo task con \`allowApiCreate: true\`; ignora peso, retry e timeout inviati dal client. |
| \`/api/tasks/definitions\` | \`GET\` | Espone il catalogo task centralizzato. | No | Fonte per CMS admin e integrazioni interne. |
| \`/api/tasks/:taskId\` | \`GET\` | Legge stato dettagliato di un task. | No | Include eventi recenti e metadati di scheduling. |
| \`/api/tasks/:taskId/result\` | \`GET\` | Scarica il risultato del task completato. | No | Stream binario se esiste \`artifactPath\`, altrimenti JSON. |
| \`/api/tasks/:taskId/cancel\` | \`POST\` | Annulla un task se possibile. | No | Per i task running invia abort al worker. |
| \`/api/tasks/:taskId/retry\` | \`POST\` | Rilancia un task failed/cancelled se marcato safe. | Si | Il nuovo task riusa la definizione del registry. |
| \`/api/resources/status\` | \`GET\` | Stato risorse e rate limit CardTrader. | No | Mostra capacita e utilizzo delle risorse. |
| \`/api/queue/stats\` | \`GET\` | Statistiche complete della coda. | No | Snapshot operativo dello scheduler. |
| \`/api/queue/status\` | \`GET\` | Alias compatibile dello snapshot coda. | No | Mantiene compatibilita con endpoint precedente. |
| \`/api/cardtrader/actions\` | \`GET\` | Lista action CardTrader disponibili con metadata coda. | No | Deriva le action dal registry. |

## Header Operativi

- \`Idempotency-Key\`: usato quando la policy del task lo prevede o come dedupe key esplicita.
- \`x-cardtrader-token\`: obbligatorio per i task CardTrader.
- \`x-mongodb-uri\` oppure \`x-mongo-uri\`: obbligatorio per i task che scrivono su MongoDB.
- \`x-db-name\`: opzionale, default \`CMS\`.
- \`x-soffice-binary-path\`: opzionale per conversione Excel se LibreOffice non e nel PATH.
- \`x-cardtrader-api-base-url\`: opzionale per ambienti CardTrader non standard.
- \`x-api-key\` oppure \`Authorization: Bearer <key>\`: obbligatorio se \`INTERNAL_API_KEY\` e configurata sul server.

## Rischi Operativi

- I task CardTrader non devono bypassare la coda centrale.
- Il client non puo controllare priorita, peso, retry, timeout, risorse o gruppi di concorrenza.
- La coda attuale resta in memoria: dopo crash il tracking storico sopravvive solo finche il processo resta vivo.
- I file \`api/*\` legacy Vercel presenti in repo non sono la fonte primaria per il server Express e vanno considerati separatamente.
`;
}

function main() {
  const generated = generateEndpointWeightsDoc();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT_PATH)
      ? fs.readFileSync(OUTPUT_PATH, "utf8")
      : "";
    if (current !== generated) {
      console.error(
        "docs/endpoint-weights.md non e allineato a config/taskDefinitions.js. Esegui npm run docs:generate.",
      );
      process.exitCode = 1;
    }
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, generated);
}

if (require.main === module) {
  main();
}

module.exports = {
  generateEndpointWeightsDoc,
};
