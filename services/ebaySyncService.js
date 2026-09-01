const ebayService = require("./ebayService");
const { createCardTraderService } = require("./cardTraderService");

// Sincronizzazione inventario CardTrader -> eBay.
// Flusso di pubblicazione per ogni prodotto selezionato:
//   1. createOrReplaceInventoryItem (SKU = CT-<productId>)
//   2. createOffer / updateOffer (marketplace, categoria, prezzo, policy)
//   3. publishOffer -> genera l'inserzione (listingId)
// I valori generati (titolo, descrizione, prezzo, immagine, quantità) possono
// essere personalizzati per prodotto tramite gli override salvati nello store.

const SKU_PREFIX = "CT-";
const DEFAULT_CATEGORY_ID = "183454"; // CCG - Carte singole
const TITLE_MAX_LENGTH = 80;

// Mappa condizioni CardTrader -> condizioni eBay (Inventory API).
// Per le carte da gioco eBay usa in genere 4000 (= USED_VERY_GOOD, "Ungraded").
const CONDITION_MAP = {
  mint: "USED_VERY_GOOD",
  "near mint": "USED_VERY_GOOD",
  "slightly played": "USED_VERY_GOOD",
  "moderately played": "USED_GOOD",
  played: "USED_GOOD",
  "heavily played": "USED_ACCEPTABLE",
  poor: "USED_ACCEPTABLE",
};

const LANGUAGE_LABELS = {
  it: "Italiano",
  en: "Inglese",
  fr: "Francese",
  de: "Tedesco",
  es: "Spagnolo",
  pt: "Portoghese",
  jp: "Giapponese",
  ja: "Giapponese",
  kr: "Coreano",
  ko: "Coreano",
  cn: "Cinese",
  "zh-cn": "Cinese",
  ru: "Russo",
};

// Cache in-memory dei blueprint per espansione (per ricavare le immagini).
const blueprintCacheByExpansion = new Map();

// Cache dell'export prodotti CardTrader: evita di riscaricare 9000+ prodotti
// per ogni apertura del dettaglio o modifica dalla UI.
const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;
let productsCache = { items: null, at: 0 };

async function loadProducts(cardTraderService, { force = false } = {}) {
  const isFresh =
    productsCache.items && Date.now() - productsCache.at < PRODUCTS_CACHE_TTL_MS;
  if (!force && isFresh) return productsCache.items;

  const exportRes = await cardTraderService.getMyProducts();
  const products = Array.isArray(exportRes?.data) ? exportRes.data : [];
  await attachExpansionNames(products, cardTraderService);
  productsCache = { items: products, at: Date.now() };
  return products;
}

// L'export prodotti CardTrader non include il nome dell'espansione: lo
// arricchiamo con /expansions (una sola chiamata, riusata per tutti i prodotti).
async function attachExpansionNames(products, cardTraderService) {
  let expansionById = new Map();
  try {
    const response = await cardTraderService.getExpansions();
    const expansions = Array.isArray(response?.data) ? response.data : [];
    expansionById = new Map(expansions.map((expansion) => [expansion.id, expansion]));
  } catch {
    return products;
  }

  for (const product of products) {
    const expansionId = product?.expansion?.id ?? product?.expansion_id;
    const expansion = expansionById.get(expansionId);
    if (!expansion) continue;
    product.expansion = {
      ...(product.expansion ?? { id: expansionId }),
      code: product.expansion?.code ?? expansion.code ?? null,
      name_en: product.expansion?.name_en ?? expansion.name ?? null,
    };
  }

  return products;
}

function getProductLanguage(propertiesHash = {}) {
  const languageKey = Object.keys(propertiesHash).find((key) =>
    key.endsWith("_language"),
  );
  const value = languageKey ? propertiesHash[languageKey] : null;
  return value ? String(value).toLowerCase() : null;
}

function getProductCondition(propertiesHash = {}) {
  const value = propertiesHash.condition;
  return value ? String(value) : null;
}

function mapCondition(cardTraderCondition, settings = {}) {
  if (settings.conditionOverride) return settings.conditionOverride;
  const key = String(cardTraderCondition || "").toLowerCase();
  return CONDITION_MAP[key] ?? "USED_VERY_GOOD";
}

function buildSku(product) {
  return `${SKU_PREFIX}${product.id}`;
}

function parseProductIdFromSku(sku) {
  if (!String(sku).startsWith(SKU_PREFIX)) return null;
  const id = Number(String(sku).slice(SKU_PREFIX.length));
  return Number.isFinite(id) ? id : null;
}

function buildGeneratedTitle(product) {
  const name = product.name_en ?? product.name ?? `Prodotto ${product.id}`;
  const expansion =
    product.expansion?.name_en ?? product.expansion?.name ?? null;
  const condition = getProductCondition(product.properties_hash);
  const language = getProductLanguage(product.properties_hash);
  const languageLabel = language
    ? (LANGUAGE_LABELS[language] ?? language.toUpperCase())
    : null;

  const parts = [name];
  if (expansion) parts.push(expansion);
  if (condition) parts.push(condition);
  if (languageLabel) parts.push(languageLabel);

  let title = parts.join(" - ");
  while (title.length > TITLE_MAX_LENGTH && parts.length > 1) {
    parts.pop();
    title = parts.join(" - ");
  }

  return title.slice(0, TITLE_MAX_LENGTH);
}

function buildTitle(product, override = {}) {
  if (override.title) return String(override.title).slice(0, TITLE_MAX_LENGTH);
  return buildGeneratedTitle(product);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildGeneratedDescription(product) {
  const condition = getProductCondition(product.properties_hash);
  const language = getProductLanguage(product.properties_hash);
  const expansion =
    product.expansion?.name_en ?? product.expansion?.name ?? null;

  const lines = [
    `<p><strong>${escapeHtml(product.name_en ?? product.name ?? "")}</strong></p>`,
  ];
  if (expansion) lines.push(`<p>Espansione: ${escapeHtml(expansion)}</p>`);
  if (condition) lines.push(`<p>Condizione: ${escapeHtml(condition)}</p>`);
  if (language) {
    lines.push(
      `<p>Lingua: ${escapeHtml(LANGUAGE_LABELS[language] ?? language.toUpperCase())}</p>`,
    );
  }
  if (product.description) {
    lines.push(`<p>${escapeHtml(String(product.description))}</p>`);
  }

  return lines.join("\n");
}

function buildDescription(product, settings = {}, override = {}) {
  // La descrizione personalizzata è testo semplice inserito dalla UI: viene
  // convertita in HTML preservando gli a-capo.
  const body = override.description
    ? `<p>${escapeHtml(String(override.description)).replace(/\r?\n/g, "<br>")}</p>`
    : buildGeneratedDescription(product);

  if (settings.descriptionFooter) {
    return `${body}\n<p>${settings.descriptionFooter}</p>`;
  }
  return body;
}

function normalizeImageUrl(rawUrl) {
  if (!rawUrl) return null;
  const value = String(rawUrl);
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("/")) return `https://www.cardtrader.com${value}`;
  return null;
}

// Recupera l'URL immagine del blueprint del prodotto (cache per espansione).
async function resolveBlueprintImageUrl(product, cardTraderService) {
  const expansionId = product.expansion?.id ?? product.expansion_id;
  const blueprintId = product.blueprint_id;
  if (!expansionId || !blueprintId) return null;

  if (!blueprintCacheByExpansion.has(expansionId)) {
    try {
      const response =
        await cardTraderService.getBlueprintsByExpansionId(expansionId);
      const blueprints = Array.isArray(response?.data) ? response.data : [];
      const byId = new Map(blueprints.map((bp) => [bp.id, bp]));
      blueprintCacheByExpansion.set(expansionId, byId);
    } catch {
      blueprintCacheByExpansion.set(expansionId, new Map());
    }
  }

  const blueprint = blueprintCacheByExpansion.get(expansionId).get(blueprintId);
  if (!blueprint) return null;

  // Priorità alla risoluzione: image.url è l'originale ad alta risoluzione,
  // image.show è la variante media, image_url/preview è la miniatura.
  return (
    normalizeImageUrl(blueprint.image?.url) ??
    normalizeImageUrl(blueprint.image?.show?.url) ??
    normalizeImageUrl(blueprint.image_url) ??
    normalizeImageUrl(blueprint.image?.preview?.url) ??
    null
  );
}

// Variante a bassa risoluzione (miniature UI): evita di scaricare l'originale
// dove non serve.
async function resolveBlueprintPreviewImageUrl(product, cardTraderService) {
  const expansionId = product.expansion?.id ?? product.expansion_id;
  const blueprint = blueprintCacheByExpansion.get(expansionId)?.get(product.blueprint_id);
  if (!blueprint) return null;
  return (
    normalizeImageUrl(blueprint.image?.preview?.url) ??
    normalizeImageUrl(blueprint.image_url) ??
    null
  );
}

async function resolveImageUrl(product, settings, override, cardTraderService) {
  if (override.imageUrl) return String(override.imageUrl);
  return (
    (await resolveBlueprintImageUrl(product, cardTraderService)) ??
    settings.defaultImageUrl ??
    null
  );
}

function computePriceValue(product, options = {}, override = {}) {
  if (Number.isFinite(Number(override.price)) && Number(override.price) > 0) {
    return Number(Number(override.price).toFixed(2));
  }

  const requestOverride = options.priceOverrides?.[String(product.id)];
  if (Number.isFinite(Number(requestOverride)) && Number(requestOverride) > 0) {
    return Number(Number(requestOverride).toFixed(2));
  }

  const baseCents = Number(product.price_cents);
  if (!Number.isFinite(baseCents)) return null;
  const factor = 1 + (Number(options.markupPercent) || 0) / 100;
  return Number(((baseCents / 100) * factor).toFixed(2));
}

// Quantità effettiva: eventuale override, comunque mai oltre la disponibilità
// reale su CardTrader (per non vendere carte che non ci sono).
function computeQuantity(product, override = {}) {
  const available = Number(product.quantity ?? 0);
  const requested = Number(override.quantity);
  if (Number.isFinite(requested) && requested >= 0) {
    return Math.min(available, Math.floor(requested));
  }
  return available;
}

function buildAspects(product, settings = {}) {
  const aspects = { ...(settings.defaultAspects ?? {}) };

  const language = getProductLanguage(product.properties_hash);
  if (language) {
    aspects.Language = [LANGUAGE_LABELS[language] ?? language.toUpperCase()];
  }

  const expansion =
    product.expansion?.name_en ?? product.expansion?.name ?? null;
  if (expansion) {
    aspects["Set"] = [String(expansion).slice(0, 65)];
  }

  const name = product.name_en ?? product.name;
  if (name) {
    aspects["Card Name"] = [String(name).slice(0, 65)];
  }

  aspects.Graded = [product.graded ? "Yes" : "No"];

  return aspects;
}

// Anteprima della mappatura, usata dalla UI per mostrare cosa verrà pubblicato.
function buildListingPreview(product, settings = {}, options = {}, override = {}) {
  const overriddenFields = Object.keys(override);
  return {
    productId: product.id,
    sku: buildSku(product),
    title: buildTitle(product, override),
    quantity: computeQuantity(product, override),
    cardTraderQuantity: Number(product.quantity ?? 0),
    cardTraderPriceEur: Number.isFinite(Number(product.price_cents))
      ? Number(product.price_cents) / 100
      : null,
    ebayPriceEur: computePriceValue(product, options, override),
    condition: mapCondition(getProductCondition(product.properties_hash), settings),
    cardTraderCondition: getProductCondition(product.properties_hash),
    language: getProductLanguage(product.properties_hash),
    expansion: product.expansion?.name_en ?? product.expansion?.name ?? null,
    expansionCode: product.expansion?.code ?? null,
    graded: Boolean(product.graded),
    bundle: Boolean(product.bundle),
    tag: product.tag ?? null,
    // Tutte le proprietà CardTrader del prodotto (foil, rarità, reverse,
    // firmata, prima edizione…): la UI ci costruisce sopra i filtri dinamici.
    properties: product.properties_hash ?? {},
    excluded: Boolean(override.excluded),
    overriddenFields,
    hasOverrides: overriddenFields.length > 0,
  };
}

// Se la richiesta non specifica un ricarico, vale quello di default salvato
// nelle Impostazioni (settings.markupPercent).
function withDefaultMarkup(options, settings) {
  const provided = Number(options.markupPercent);
  return {
    ...options,
    markupPercent: Number.isFinite(provided) && options.markupPercent != null
      ? provided
      : Number(settings.markupPercent) || 0,
  };
}

function assertSettingsReady(settings) {
  const missing = [];
  if (!settings.fulfillmentPolicyId) missing.push("policy di spedizione");
  if (!settings.paymentPolicyId) missing.push("policy di pagamento");
  if (!settings.returnPolicyId) missing.push("policy di reso");
  if (!settings.merchantLocationKey) missing.push("sede di spedizione");

  if (missing.length > 0) {
    throw new Error(
      `Impostazioni eBay incomplete: configurare ${missing.join(", ")} nella sezione Impostazioni.`,
    );
  }
}

// Pubblica (o aggiorna) un singolo prodotto CardTrader su eBay.
async function publishProduct(product, settings, options = {}) {
  const override = options.override ?? {};
  const sku = buildSku(product);
  const quantity = computeQuantity(product, override);
  const priceValue = computePriceValue(product, options, override);

  if (!Number.isFinite(priceValue) || priceValue <= 0) {
    throw new Error("Prezzo non valido: impossibile pubblicare.");
  }
  if (quantity < 1) {
    throw new Error("Quantità zero: nulla da pubblicare.");
  }

  const cardTraderService = options.cardTraderService ?? createCardTraderService();
  const imageUrl = await resolveImageUrl(
    product,
    settings,
    override,
    cardTraderService,
  );

  if (!imageUrl) {
    throw new Error(
      "Nessuna immagine disponibile: eBay richiede almeno una foto. Impostare un'immagine di default nelle Impostazioni o una foto nel dettaglio prodotto.",
    );
  }

  const description = buildDescription(product, settings, override);
  const inventoryItem = {
    availability: {
      shipToLocationAvailability: { quantity },
    },
    condition: mapCondition(getProductCondition(product.properties_hash), settings),
    product: {
      title: buildTitle(product, override),
      description,
      aspects: buildAspects(product, settings),
      imageUrls: [imageUrl],
    },
  };

  await ebayService.createOrReplaceInventoryItem(sku, inventoryItem);

  const offerBody = {
    sku,
    marketplaceId: ebayService.getMarketplaceId(),
    format: "FIXED_PRICE",
    availableQuantity: quantity,
    categoryId: String(settings.categoryId || DEFAULT_CATEGORY_ID),
    merchantLocationKey: settings.merchantLocationKey,
    listingDescription: description,
    pricingSummary: {
      price: { value: priceValue.toFixed(2), currency: "EUR" },
    },
    listingPolicies: {
      fulfillmentPolicyId: settings.fulfillmentPolicyId,
      paymentPolicyId: settings.paymentPolicyId,
      returnPolicyId: settings.returnPolicyId,
    },
  };

  const existingOffers = await ebayService.getOffersBySku(sku);
  let offerId;
  let alreadyPublished = false;

  if (existingOffers.length > 0) {
    offerId = existingOffers[0].offerId;
    alreadyPublished = existingOffers[0].status === "PUBLISHED";
    await ebayService.updateOffer(offerId, offerBody);
  } else {
    const created = await ebayService.createOffer(offerBody);
    offerId = created.offerId;
  }

  let listingId = existingOffers[0]?.listing?.listingId ?? null;
  if (!alreadyPublished) {
    const published = await ebayService.publishOffer(offerId);
    listingId = published.listingId ?? listingId;
  }

  return {
    productId: product.id,
    sku,
    offerId,
    listingId,
    updated: alreadyPublished,
    priceEur: priceValue,
    quantity,
  };
}

// Pubblica un elenco di prodotti (per id CardTrader). Esecuzione sequenziale
// per rispettare i rate limit eBay; ogni errore è isolato al singolo prodotto.
async function publishProducts(productIds, rawOptions = {}) {
  const settings = ebayService.getSettings();
  assertSettingsReady(settings);
  const options = withDefaultMarkup(rawOptions, settings);

  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService, { force: true });
  const productById = new Map(products.map((product) => [product.id, product]));
  const overrides = ebayService.getOverrides();
  const history = ebayService.getPublishedHistory();
  const skipPublished = options.skipPublished !== false;

  const results = [];
  for (const rawId of productIds) {
    const productId = Number(rawId);
    const product = productById.get(productId);

    if (!product) {
      results.push({
        productId,
        ok: false,
        error: "Prodotto non trovato nell'inventario CardTrader.",
      });
      continue;
    }

    // Prodotto escluso da eBay (es. sigillati): mai pubblicato.
    if (overrides[String(productId)]?.excluded) {
      results.push({
        productId,
        sku: buildSku(product),
        ok: true,
        skipped: true,
        excluded: true,
      });
      continue;
    }

    // Già pubblicato in passato: viene saltato, a meno che l'utente non abbia
    // chiesto esplicitamente di aggiornare anche i già pubblicati.
    const historyEntry = history[String(productId)];
    if (skipPublished && historyEntry?.status === "PUBLISHED") {
      results.push({
        productId,
        sku: buildSku(product),
        ok: true,
        skipped: true,
        listingId: historyEntry.listingId ?? null,
      });
      continue;
    }

    try {
      const outcome = await publishProduct(product, settings, {
        ...options,
        cardTraderService,
        override: overrides[String(productId)] ?? {},
      });
      ebayService.recordPublished(productId, {
        sku: outcome.sku,
        offerId: outcome.offerId,
        listingId: outcome.listingId,
        priceEur: outcome.priceEur,
        quantity: outcome.quantity,
        title: buildTitle(product, overrides[String(productId)] ?? {}),
        status: "PUBLISHED",
      });
      results.push({ ...outcome, ok: true });
    } catch (error) {
      results.push({
        productId,
        sku: buildSku(product),
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    total: results.length,
    succeeded: results.filter((result) => result.ok && !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

// Inventario CardTrader con anteprima mappatura eBay e stato offerta.
async function getInventoryPreview(rawOptions = {}) {
  const settings = ebayService.getSettings();
  const options = withDefaultMarkup(rawOptions, settings);
  const overrides = ebayService.getOverrides();
  const history = ebayService.getPublishedHistory();
  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService, {
    force: options.force ?? false,
  });

  return products.map((product) => {
    const preview = buildListingPreview(
      product,
      settings,
      options,
      overrides[String(product.id)] ?? {},
    );
    const historyEntry = history[String(product.id)];
    preview.published = historyEntry
      ? {
          status: historyEntry.status ?? "PUBLISHED",
          listingId: historyEntry.listingId ?? null,
          publishedAt: historyEntry.publishedAt ?? null,
          lastPublishedAt: historyEntry.lastPublishedAt ?? null,
        }
      : null;
    return preview;
  });
}

// Dettaglio completo di un prodotto: come apparirà l'annuncio eBay (titolo,
// descrizione, foto, condizione, item specifics) più i valori generati di
// base, per permettere alla UI il confronto generato/personalizzato.
async function getProductDetail(productId, rawOptions = {}) {
  const settings = ebayService.getSettings();
  const options = withDefaultMarkup(rawOptions, settings);
  const override = ebayService.getOverrides()[String(productId)] ?? {};
  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService);
  const product = products.find((item) => item.id === Number(productId));

  if (!product) {
    throw new Error("Prodotto non trovato nell'inventario CardTrader.");
  }

  const blueprintImageUrl = await resolveBlueprintImageUrl(
    product,
    cardTraderService,
  );
  const blueprintImageUrlPreview = await resolveBlueprintPreviewImageUrl(
    product,
    cardTraderService,
  );
  const effectiveImageUrl =
    override.imageUrl ?? blueprintImageUrl ?? settings.defaultImageUrl ?? null;

  return {
    ...buildListingPreview(product, settings, options, override),
    descriptionHtml: buildDescription(product, settings, override),
    imageUrl: effectiveImageUrl,
    blueprintImageUrl,
    blueprintImageUrlPreview,
    aspects: buildAspects(product, settings),
    categoryId: String(settings.categoryId || DEFAULT_CATEGORY_ID),
    descriptionFooter: settings.descriptionFooter ?? null,
    override,
    generated: {
      title: buildGeneratedTitle(product),
      descriptionHtml: buildGeneratedDescription(product),
      priceEur: computePriceValue(product, options, {}),
    },
  };
}

// --- Confronto prezzi con i competitor su eBay (Browse API) ---

function median(sortedValues) {
  if (sortedValues.length === 0) return null;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[mid]
    : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function buildCompareQuery(product) {
  const name = product.name_en ?? product.name ?? "";
  const expansion = product.expansion?.name_en ?? product.expansion?.name ?? "";
  // Il numero di collezione distingue le versioni della stessa carta
  // (regular vs Full Art vs secret): senza, la ricerca le mescola.
  const props = product.properties_hash ?? {};
  const collectorKey = Object.keys(props).find((key) =>
    key.toLowerCase().includes("collector_number"),
  );
  const collectorNumber = collectorKey ? String(props[collectorKey]) : "";
  return `${name} ${collectorNumber} ${expansion}`.replace(/\s+/g, " ").trim().slice(0, 100);
}

// Confronta il nostro prezzo con le inserzioni attive sul marketplace.
// Confronto sul totale (prezzo + spedizione), che è ciò che vede l'acquirente.
async function compareProductPrices(product, settings, override, options = {}) {
  const query = buildCompareQuery(product);
  const response = await ebayService.browseSearch({
    q: query,
    categoryIds: String(settings.categoryId || DEFAULT_CATEGORY_ID),
    limit: 25,
    sort: "price",
    filter: "buyingOptions:{FIXED_PRICE},priceCurrency:EUR",
  });

  const competitors = (response.itemSummaries ?? [])
    .map((summary) => {
      const price = Number(summary.price?.value);
      const shippingRaw = Number(
        summary.shippingOptions?.[0]?.shippingCost?.value,
      );
      const shipping = Number.isFinite(shippingRaw) ? shippingRaw : null;
      return {
        itemId: summary.itemId,
        title: summary.title,
        price,
        shipping,
        total: Number.isFinite(price) ? price + (shipping ?? 0) : null,
        condition: summary.condition ?? null,
        seller: summary.seller?.username ?? null,
        feedbackPercent: summary.seller?.feedbackPercentage ?? null,
        url: summary.itemWebUrl ?? null,
      };
    })
    .filter((item) => Number.isFinite(item.total));

  const totals = competitors.map((item) => item.total).sort((a, b) => a - b);
  const ourPrice = computePriceValue(product, options, override);
  const minTotal = totals[0] ?? null;
  const medianTotal = median(totals);

  let position = null;
  if (ourPrice != null && minTotal != null) {
    if (ourPrice <= minTotal) position = "cheapest";
    else if (medianTotal != null && ourPrice <= medianTotal) position = "below-median";
    else position = "above-median";
  }

  return {
    productId: product.id,
    sku: buildSku(product),
    query,
    ourPrice,
    competitorCount: competitors.length,
    minTotal,
    medianTotal,
    deltaVsMinPercent:
      ourPrice != null && minTotal ? Number((((ourPrice - minTotal) / minTotal) * 100).toFixed(1)) : null,
    position,
    competitors: competitors.slice(0, 10),
  };
}

async function compareProduct(productId, rawOptions = {}) {
  const settings = ebayService.getSettings();
  const options = withDefaultMarkup(rawOptions, settings);
  const override = ebayService.getOverrides()[String(productId)] ?? {};
  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService);
  const product = products.find((item) => item.id === Number(productId));
  if (!product) {
    throw new Error("Prodotto non trovato nell'inventario CardTrader.");
  }
  return compareProductPrices(product, settings, override, options);
}

// Confronto massivo (max ~50 per volta, con concorrenza limitata per
// rispettare i rate limit della Browse API).
async function compareProducts(productIds, rawOptions = {}) {
  const settings = ebayService.getSettings();
  const options = withDefaultMarkup(rawOptions, settings);
  const overrides = ebayService.getOverrides();
  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService);
  const productById = new Map(products.map((product) => [product.id, product]));

  const queue = [...productIds];
  const results = [];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length > 0) {
      const productId = Number(queue.shift());
      const product = productById.get(productId);
      if (!product) {
        results.push({ productId, ok: false, error: "Prodotto non trovato." });
        continue;
      }
      try {
        const outcome = await compareProductPrices(
          product,
          settings,
          overrides[String(productId)] ?? {},
          options,
        );
        // La lista completa dei competitor serve solo nel dettaglio singolo.
        const { competitors, ...summary } = outcome;
        results.push({ ...summary, title: buildTitle(product, overrides[String(productId)] ?? {}), ok: true });
      } catch (error) {
        results.push({ productId, sku: buildSku(product), ok: false, error: error.message });
      }
    }
  });
  await Promise.all(workers);

  return {
    total: results.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

// Elenco offerte eBay esistenti (per la tab "Pubblicati" della UI).
async function getPublishedOffers({ limit = 200 } = {}) {
  const offers = [];
  let offset = 0;
  const pageSize = 100;

  while (offers.length < limit) {
    const page = await ebayService.getInventoryItems({
      limit: pageSize,
      offset,
    });
    const items = page.inventoryItems ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const skuOffers = await ebayService.getOffersBySku(item.sku);
      for (const offer of skuOffers) {
        offers.push({
          sku: item.sku,
          productId: parseProductIdFromSku(item.sku),
          title: item.product?.title ?? null,
          offerId: offer.offerId,
          status: offer.status,
          listingId: offer.listing?.listingId ?? null,
          priceEur: offer.pricingSummary?.price?.value ?? null,
          quantity: offer.availableQuantity ?? null,
        });
      }
    }

    offset += pageSize;
    if (items.length < pageSize) break;
  }

  return offers.slice(0, limit);
}

// Ritira un'offerta e (opzionalmente) elimina l'inventory item associato.
// Lo storico conserva la voce con stato RITIRATO: cosi' resta traccia e il
// prodotto puo' essere ripubblicato senza essere saltato.
async function removeListing({ offerId, sku, deleteItem = false }) {
  if (offerId) {
    await ebayService.withdrawOffer(offerId);
  }
  if (deleteItem && sku) {
    await ebayService.deleteInventoryItem(sku);
  }

  const productId = parseProductIdFromSku(sku);
  if (productId) {
    ebayService.setPublishedStatus(productId, "WITHDRAWN");
  }

  return { ok: true };
}

// Ricostruisce lo storico pubblicazioni leggendo le offerte reali da eBay:
// utile al primo avvio o se lo store locale si e' perso/disallineato.
async function syncPublishedFromEbay() {
  const offers = await getPublishedOffers({ limit: 1000 });
  const existing = ebayService.getPublishedHistory();
  const published = {};

  for (const offer of offers) {
    if (!offer.productId) continue;
    const key = String(offer.productId);
    const previous = existing[key] ?? {};
    published[key] = {
      sku: offer.sku,
      offerId: offer.offerId,
      listingId: offer.listingId,
      title: offer.title ?? previous.title ?? null,
      priceEur: offer.priceEur != null ? Number(offer.priceEur) : previous.priceEur ?? null,
      quantity: offer.quantity ?? previous.quantity ?? null,
      status: offer.status === "PUBLISHED" ? "PUBLISHED" : "UNPUBLISHED",
      publishedAt: previous.publishedAt ?? new Date().toISOString(),
      lastPublishedAt: previous.lastPublishedAt ?? new Date().toISOString(),
    };
  }

  ebayService.replacePublishedHistory(published);
  return { total: Object.keys(published).length };
}

module.exports = {
  SKU_PREFIX,
  DEFAULT_CATEGORY_ID,
  buildSku,
  buildTitle,
  buildListingPreview,
  publishProduct,
  publishProducts,
  getInventoryPreview,
  getProductDetail,
  getPublishedOffers,
  removeListing,
  syncPublishedFromEbay,
  compareProduct,
  compareProducts,
};
