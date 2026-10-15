// Report prezzi a fine ciclo di sincronizzazione: confronta l'inventario
// CardTrader appena aggiornato con la fotografia dell'ultimo report inviato e
// manda per email le carte con le variazioni di prezzo maggiori e quanto è
// cambiato il valore totale (prezzo x quantità).
//
// La fotografia si salva solo dopo un invio riuscito: i giri senza report e
// quelli con l'email fallita non la toccano, quindi il report successivo
// copre tutto il periodo dall'ultimo invio.
const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEZONE = "Europe/Rome";

const normalizeText = (value) => String(value ?? "").trim();

const pickProperty = (properties, suffix) => {
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (key === suffix || key.endsWith(`_${suffix}`)) return value;
  }
  return undefined;
};

function toSnapshotEntry(item) {
  const properties = item?.properties_hash ?? {};
  return {
    name: normalizeText(item?.name_en ?? item?.name),
    blueprintId: Number(item?.blueprint_id) || null,
    expansionId: Number(item?.expansion?.id) || null,
    condition: normalizeText(properties.condition),
    language: normalizeText(pickProperty(properties, "language")),
    foil: pickProperty(properties, "foil") === true,
    priceCents: Math.round(Number(item?.price_cents) || 0),
    quantity: Math.max(0, Math.trunc(Number(item?.quantity) || 0)),
  };
}

/** Fotografia per inserzione CardTrader (id prodotto), serializzabile in JSON. */
function buildPriceSnapshot(items, takenAt = new Date()) {
  const entries = {};
  for (const item of items ?? []) {
    const id = Number(item?.id);
    if (!Number.isFinite(id)) continue;
    entries[id] = toSnapshotEntry(item);
  }
  return { takenAt: new Date(takenAt).toISOString(), items: entries };
}

const totalValueCents = (entries) =>
  Object.values(entries).reduce((sum, entry) => sum + entry.priceCents * entry.quantity, 0);

function comparePriceSnapshots(previous, current, { top = 20 } = {}) {
  const currentEntries = current.items;
  const valueAfterCents = totalValueCents(currentEntries);
  const listings = Object.keys(currentEntries).length;

  if (!previous) {
    return { first: true, listings, valueAfterCents };
  }

  const previousEntries = previous.items;
  const changes = [];
  let priceEffectCents = 0;
  let newListings = 0;

  for (const [id, entry] of Object.entries(currentEntries)) {
    const before = previousEntries[id];
    if (!before) {
      newListings += 1;
      continue;
    }
    if (before.priceCents === entry.priceCents) continue;

    const deltaCents = entry.priceCents - before.priceCents;
    priceEffectCents += deltaCents * entry.quantity;
    changes.push({
      id: Number(id),
      ...entry,
      oldCents: before.priceCents,
      newCents: entry.priceCents,
      deltaCents,
      deltaPct: before.priceCents > 0 ? (deltaCents / before.priceCents) * 100 : null,
    });
  }

  const removedListings = Object.keys(previousEntries).filter(
    (id) => !currentEntries[id],
  ).length;
  const valueBeforeCents = totalValueCents(previousEntries);
  const valueDeltaCents = valueAfterCents - valueBeforeCents;

  return {
    first: false,
    since: previous.takenAt,
    listings,
    previousListings: Object.keys(previousEntries).length,
    newListings,
    removedListings,
    changed: changes.length,
    increased: changes.filter((change) => change.deltaCents > 0).length,
    decreased: changes.filter((change) => change.deltaCents < 0).length,
    topIncreases: changes
      .filter((change) => change.deltaCents > 0)
      .sort((a, b) => b.deltaCents - a.deltaCents)
      .slice(0, top),
    topDecreases: changes
      .filter((change) => change.deltaCents < 0)
      .sort((a, b) => a.deltaCents - b.deltaCents)
      .slice(0, top),
    valueBeforeCents,
    valueAfterCents,
    valueDeltaCents,
    valueDeltaPct: valueBeforeCents > 0 ? (valueDeltaCents / valueBeforeCents) * 100 : null,
    // Quanto della variazione viene dai cambi di prezzo; il resto sono
    // quantità (vendite, nuovi carichi, inserzioni tolte o aggiunte).
    priceEffectCents,
    quantityEffectCents: valueDeltaCents - priceEffectCents,
  };
}

// useGrouping "always": in italiano le cifre da quattro altrimenti restano
// senza punto (7712,18 accanto a 226.341,52).
const euro = (cents) =>
  (cents / 100).toLocaleString("it-IT", {
    style: "currency",
    currency: "EUR",
    useGrouping: "always",
  });

const signedEuro = (cents) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${euro(Math.abs(cents))}`;

const signedPct = (pct) =>
  pct === null || pct === undefined
    ? "—"
    : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toLocaleString("it-IT", { maximumFractionDigits: 1 })}%`;

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const formatDate = (value, timezone) =>
  new Date(value).toLocaleString("it-IT", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const variantLabel = (change) =>
  [change.condition, change.language ? change.language.toUpperCase() : "", change.foil ? "Foil" : ""]
    .filter(Boolean)
    .join(" · ");

const outcomeLabel = (outcome) => {
  if (outcome.status === "ok") return `ok (${Math.round((outcome.elapsedMs ?? 0) / 1000)} s)`;
  if (outcome.status === "skipped") return `saltato: ${outcome.reason ?? ""}`;
  return `FALLITO: ${outcome.error ?? ""}`;
};

// Layout email: solo tabelle e stili inline, l'unico modo per avere la stessa
// resa in Gmail, Outlook e sui client mobili. Una sola colonna di contenuto,
// così regge anche lo schermo stretto di un telefono.
const COLORS = {
  page: "#eef1f5",
  card: "#ffffff",
  soft: "#f8fafc",
  ink: "#111827",
  muted: "#6b7280",
  line: "#e5e7eb",
  header: "#0f172a",
  up: "#047857",
  upBg: "#d1fae5",
  down: "#b91c1c",
  downBg: "#fee2e2",
  flat: "#374151",
  flatBg: "#f3f4f6",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const toneOf = (cents) =>
  cents > 0
    ? { color: COLORS.up, background: COLORS.upBg }
    : cents < 0
      ? { color: COLORS.down, background: COLORS.downBg }
      : { color: COLORS.flat, background: COLORS.flatBg };

const badge = (label, cents) => {
  const tone = toneOf(cents);
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${tone.background};color:${tone.color};font-weight:700;font-size:13px;white-space:nowrap">${escapeHtml(label)}</span>`;
};

const sectionTitle = (title) =>
  `<tr><td style="padding:26px 24px 10px;font-size:17px;font-weight:700;color:${COLORS.ink}">${escapeHtml(title)}</td></tr>`;

// Riquadro principale: valore inventario e sua variazione.
const heroBlock = ({ label, value, badgeHtml, detail }) => `
  <tr><td style="padding:20px 24px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.soft};border:1px solid ${COLORS.line};border-radius:14px">
      <tr><td style="padding:18px 20px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:${COLORS.muted}">${escapeHtml(label)}</div>
        <div style="font-size:28px;font-weight:800;color:${COLORS.ink};margin-top:4px">${value}</div>
        ${badgeHtml ? `<div style="margin-top:8px">${badgeHtml}</div>` : ""}
        ${detail ? `<div style="font-size:13px;color:${COLORS.muted};margin-top:8px">${detail}</div>` : ""}
      </td></tr>
    </table>
  </td></tr>`;

// Elenco "voce: valore": va a capo da solo su schermi stretti.
const factsBlock = (facts) => `
  <tr><td style="padding:14px 24px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${facts
        .map(
          ([label, value], index) => `<tr>
            <td style="padding:9px 0;${index ? `border-top:1px solid ${COLORS.line};` : ""}font-size:14px;color:${COLORS.muted}">${escapeHtml(label)}</td>
            <td align="right" style="padding:9px 0 9px 12px;${index ? `border-top:1px solid ${COLORS.line};` : ""}font-size:14px;font-weight:700;color:${COLORS.ink}">${value}</td>
          </tr>`,
        )
        .join("")}
    </table>
  </td></tr>`;

function renderChangesSection(title, changes, expansionNames) {
  if (!changes.length) {
    return `${sectionTitle(title)}<tr><td style="padding:0 24px;color:${COLORS.muted};font-size:14px">Nessuna variazione dall'ultimo report.</td></tr>`;
  }

  const rows = changes
    .map((change, index) => {
      const details = [
        expansionNames.get(change.expansionId),
        variantLabel(change),
        `qtà ${change.quantity}`,
      ]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ");
      return `<tr><td style="padding:12px 14px;${index ? `border-top:1px solid ${COLORS.line};` : ""}background:${index % 2 ? "#fbfbfc" : COLORS.card}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top" style="padding-right:10px">
            <div style="font-size:15px;font-weight:700;color:${COLORS.ink};line-height:1.3">${escapeHtml(change.name)}</div>
            <div style="font-size:12px;color:${COLORS.muted};margin-top:3px;line-height:1.4">${details}</div>
            <div style="font-size:13px;color:${COLORS.muted};margin-top:5px">${euro(change.oldCents)} → <b style="color:${COLORS.ink}">${euro(change.newCents)}</b></div>
          </td>
          <td valign="top" align="right" width="1%" style="white-space:nowrap">
            ${badge(signedEuro(change.deltaCents), change.deltaCents)}
            <div style="font-size:12px;font-weight:600;color:${toneOf(change.deltaCents).color};margin-top:5px">${signedPct(change.deltaPct)}</div>
          </td>
        </tr></table>
      </td></tr>`;
    })
    .join("");

  return `${sectionTitle(title)}<tr><td style="padding:0 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.line};border-radius:12px;border-collapse:separate;overflow:hidden">
      ${rows}
    </table>
  </td></tr>`;
}

function renderOutcomes(outcomes) {
  if (!outcomes.length) return "";
  const dot = (status) =>
    status === "ok" ? COLORS.up : status === "skipped" ? "#9ca3af" : COLORS.down;
  const items = outcomes
    .map(
      (outcome) => `<tr>
        <td width="18" valign="top" style="padding:6px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dot(outcome.status)}"></span></td>
        <td style="padding:3px 0;font-size:14px;color:${COLORS.ink}"><b>${escapeHtml(outcome.step)}</b> <span style="color:${COLORS.muted}">${escapeHtml(outcomeLabel(outcome))}</span></td>
      </tr>`,
    )
    .join("");
  return `${sectionTitle("Esito dell'ultimo giro")}
    <tr><td style="padding:0 24px"><table role="presentation" cellpadding="0" cellspacing="0">${items}</table></td></tr>`;
}

function renderLayout({ preheader, title, subtitle, body }) {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};font-family:${FONT}">
    <tr><td align="center" style="padding:20px 8px">
      <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:${COLORS.card};border-radius:16px;overflow:hidden">
        <tr><td style="background:${COLORS.header};padding:22px 24px">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd">Jigglycard · Sincronizzazione</div>
          <div style="font-size:24px;font-weight:800;color:#ffffff;margin-top:6px;line-height:1.2">${escapeHtml(title)}</div>
          <div style="font-size:13px;color:#cbd5e1;margin-top:6px;line-height:1.4">${escapeHtml(subtitle)}</div>
        </td></tr>
        ${body}
        <tr><td style="height:24px"></td></tr>
        <tr><td style="padding:18px 24px 22px;font-size:12px;line-height:1.5;color:${COLORS.muted};border-top:1px solid ${COLORS.line}">
          Email automatica del ciclo di sincronizzazione CardTrader → Vemlora → eBay.
          Le variazioni sono rispetto all'ultimo report inviato.
          Il valore inventario è la somma di prezzo × quantità delle inserzioni CardTrader.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderPriceReport({
  report,
  outcomes = [],
  takenAt,
  expansionNames = new Map(),
  timezone = DEFAULT_TIMEZONE,
}) {
  const when = formatDate(takenAt, timezone);
  const outcomeLines = outcomes.map((outcome) => `${outcome.step}: ${outcomeLabel(outcome)}`);

  if (report.first) {
    const subject = `Sync CardTrader ${when}: prima fotografia prezzi`;
    const text = [
      `Prima fotografia dei prezzi CardTrader: ${report.listings} inserzioni, valore ${euro(report.valueAfterCents)}.`,
      "Dal prossimo report questa email elencherà le variazioni di prezzo.",
      "",
      "Esito dell'ultimo giro:",
      ...outcomeLines,
    ].join("\n");
    const html = renderLayout({
      preheader: `Prima fotografia: ${report.listings} inserzioni, valore ${euro(report.valueAfterCents)}`,
      title: "Prima fotografia dei prezzi",
      subtitle: when,
      body: `${heroBlock({
        label: "Valore inventario",
        value: euro(report.valueAfterCents),
        detail: `${report.listings.toLocaleString("it-IT")} inserzioni su CardTrader`,
      })}
        <tr><td style="padding:16px 24px 0;font-size:14px;line-height:1.5;color:${COLORS.ink}">Dal prossimo report questa email elencherà le carte con le variazioni di prezzo maggiori.</td></tr>
        ${renderOutcomes(outcomes)}`,
    });
    return { subject, html, text };
  }

  const since = formatDate(report.since, timezone);
  const subject =
    `Sync CardTrader ${when}: ${report.changed} prezzi cambiati, ` +
    `valore ${signedEuro(report.valueDeltaCents)} (${signedPct(report.valueDeltaPct)})`;

  const summaryRows = [
    ["Prezzi cambiati", `${report.changed} su ${report.listings} inserzioni (↑ ${report.increased} · ↓ ${report.decreased})`],
    ["Valore inventario", `${euro(report.valueBeforeCents)} → ${euro(report.valueAfterCents)}`],
    ["Variazione totale", `${signedEuro(report.valueDeltaCents)} (${signedPct(report.valueDeltaPct)})`],
    ["di cui cambi di prezzo", signedEuro(report.priceEffectCents)],
    ["di cui quantità (vendite, carichi)", signedEuro(report.quantityEffectCents)],
    ["Inserzioni nuove / tolte", `${report.newListings} / ${report.removedListings}`],
  ];

  const describe = (change) =>
    `${change.name}${expansionNames.get(change.expansionId) ? ` (${expansionNames.get(change.expansionId)})` : ""}` +
    `${variantLabel(change) ? ` [${variantLabel(change)}]` : ""}: ` +
    `${euro(change.oldCents)} → ${euro(change.newCents)} (${signedEuro(change.deltaCents)}, ${signedPct(change.deltaPct)}), qtà ${change.quantity}`;

  const text = [
    `Sincronizzazione CardTrader ${when} (variazioni dal ${since})`,
    "",
    ...summaryRows.map(([label, value]) => `${label}: ${value}`),
    "",
    "Rialzi maggiori:",
    ...(report.topIncreases.length ? report.topIncreases.map(describe) : ["nessuno"]),
    "",
    "Ribassi maggiori:",
    ...(report.topDecreases.length ? report.topDecreases.map(describe) : ["nessuno"]),
    "",
    "Esito dell'ultimo giro:",
    ...outcomeLines,
  ].join("\n");

  const colored = (cents) =>
    `<span style="color:${toneOf(cents).color}">${signedEuro(cents)}</span>`;

  const html = renderLayout({
    preheader: `${report.changed} prezzi cambiati · valore ${signedEuro(report.valueDeltaCents)} (${signedPct(report.valueDeltaPct)})`,
    title: `${report.changed} prezzi cambiati`,
    subtitle: `${when} · rispetto al report del ${since}`,
    body: `${heroBlock({
      label: "Valore inventario",
      value: euro(report.valueAfterCents),
      badgeHtml: badge(
        `${signedEuro(report.valueDeltaCents)} (${signedPct(report.valueDeltaPct)})`,
        report.valueDeltaCents,
      ),
      detail: `rispetto a ${euro(report.valueBeforeCents)}`,
    })}
      ${factsBlock([
        [
          "Prezzi cambiati",
          `${report.changed} <span style="font-weight:600;color:${COLORS.up}">↑${report.increased}</span> <span style="font-weight:600;color:${COLORS.down}">↓${report.decreased}</span>`,
        ],
        ["Effetto cambi di prezzo", colored(report.priceEffectCents)],
        ["Effetto quantità (vendite, carichi)", colored(report.quantityEffectCents)],
        ["Inserzioni nuove / tolte", `${report.newListings} / ${report.removedListings}`],
      ])}
      ${renderChangesSection("Rialzi maggiori", report.topIncreases, expansionNames)}
      ${renderChangesSection("Ribassi maggiori", report.topDecreases, expansionNames)}
      ${renderOutcomes(outcomes)}`,
  });

  return { subject, html, text };
}

function loadSnapshot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Scrittura atomica: un processo interrotto non lascia un file a metà.
function saveSnapshot(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot));
  fs.renameSync(temporary, file);
}

// Le scadenze cadono su multipli fissi dell'intervallo (contati in UTC): il
// report parte al primo giro dopo la scadenza, e un giro più lento del solito
// non fa slittare quelli dopo.
function nextReportAt(lastTakenAt, intervalMs) {
  const last = Date.parse(lastTakenAt);
  if (!intervalMs || !Number.isFinite(last)) return null;
  return new Date(Math.floor(last / intervalMs) * intervalMs + intervalMs);
}

function createPriceReport({
  fetchItems,
  fetchExpansionNames = async () => new Map(),
  send,
  snapshotFile,
  recipients,
  top = 20,
  intervalMs = 0,
  timezone = DEFAULT_TIMEZONE,
  now = () => new Date(),
}) {
  // Il ciclo lo chiede prima di eseguire il passo: null se il report è dovuto
  // (o non c'è ancora un invio precedente), altrimenti il motivo del salto.
  const skipReason = () => {
    const previous = loadSnapshot(snapshotFile);
    const dueAt = previous ? nextReportAt(previous.takenAt, intervalMs) : null;
    if (!dueAt || now() >= dueAt) return null;
    return (
      `ultimo report del ${formatDate(previous.takenAt, timezone)}, ` +
      `il prossimo dopo le ${formatDate(dueAt, timezone)}`
    );
  };

  async function sendPriceReport({ outcomes = [] } = {}) {
    const takenAt = now();
    const current = buildPriceSnapshot(await fetchItems(), takenAt);
    const report = comparePriceSnapshots(loadSnapshot(snapshotFile), current, { top });

    const expansionNames = report.first
      ? new Map()
      : await fetchExpansionNames().catch(() => new Map());
    const message = renderPriceReport({ report, outcomes, takenAt, expansionNames, timezone });

    await send({ to: recipients, ...message });
    saveSnapshot(snapshotFile, current);

    return report.first
      ? { first: true, listings: report.listings }
      : {
          changed: report.changed,
          increased: report.increased,
          decreased: report.decreased,
          valueDeltaCents: report.valueDeltaCents,
        };
  }

  sendPriceReport.skipReason = skipReason;
  return sendPriceReport;
}

module.exports = {
  buildPriceSnapshot,
  comparePriceSnapshots,
  renderPriceReport,
  nextReportAt,
  createPriceReport,
  loadSnapshot,
  saveSnapshot,
};
