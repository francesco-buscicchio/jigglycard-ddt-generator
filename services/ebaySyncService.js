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

// Condizioni per le carte singole (categoria 183454): eBay accetta solo
// 4000 = USED_VERY_GOOD ("Non gradata") oppure 2750 ("Gradata"), e per le non
// gradate richiede il condition descriptor 40001 "Condizione della carta".
// Mappa condizione CardTrader -> valore del descrittore eBay.
const UNGRADED_CONDITION = "USED_VERY_GOOD";
const CARD_CONDITION_DESCRIPTOR_ID = "40001";
// Valori validi per EBAY_IT (da get_item_condition_policies):
// 400010 Near Mint or Better, 400015 Lightly Played (Excellent),
// 400016 Moderately Played (Very Good), 400017 Heavily Played (Poor).
const CONDITION_DESCRIPTOR_MAP = {
  mint: "400010",
  "near mint": "400010",
  "slightly played": "400015",
  "moderately played": "400016",
  played: "400017",
  "heavily played": "400017",
  poor: "400017",
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
  return UNGRADED_CONDITION;
}

function mapConditionDescriptor(cardTraderCondition) {
  const key = String(cardTraderCondition || "").toLowerCase();
  return CONDITION_DESCRIPTOR_MAP[key] ?? "400010";
}

function buildSku(product) {
  return `${SKU_PREFIX}${product.id}`;
}

function parseProductIdFromSku(sku) {
  if (!String(sku).startsWith(SKU_PREFIX)) return null;
  const id = Number(String(sku).slice(SKU_PREFIX.length));
  return Number.isFinite(id) ? id : null;
}

// Varianti che distinguono lotti della stessa carta (reverse holo, foil,
// prima edizione…): vanno nel titolo, sia per informare l'acquirente sia
// perché eBay rifiuta due inserzioni con titolo identico (anti-duplicati).
function getVariantTokens(propertiesHash = {}) {
  const tokens = [];
  for (const [key, value] of Object.entries(propertiesHash)) {
    if (value !== true && value !== "true") continue;
    const bare = key.toLowerCase();
    if (bare.endsWith("reverse")) tokens.push("Reverse Holo");
    else if (bare === "foil" || bare.endsWith("_foil")) tokens.push("Foil");
    else if (bare.endsWith("first_edition")) tokens.push("1a Edizione");
    else if (bare === "signed") tokens.push("Firmata");
    else if (bare === "altered") tokens.push("Alterata");
  }
  return tokens;
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

  const parts = [name, ...getVariantTokens(product.properties_hash)];
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

// eBay.it rifiuta le inserzioni a prezzo fisso sotto 1 EUR (errore 25016).
const EBAY_MIN_PRICE_EUR = 1;

// Prezzo minimo per rarità (sovrascrivibile da settings.rarityFloors). È un
// MINIMO: se CT + ricarico è più alto vale quello, così le carte di valore
// non vengono mai svendute.
const DEFAULT_RARITY_FLOORS = {
  common: 1,
  uncommon: 1.2,
  rare: 1,
  fixed: 1,
};

function getRarityFloor(product, options = {}) {
  const rarity = String(getProductRarity(product.properties_hash) ?? "").toLowerCase();
  const floors = options.rarityFloors ?? DEFAULT_RARITY_FLOORS;
  const floor = Number(floors[rarity]);
  return Number.isFinite(floor) && floor > 0 ? floor : null;
}

function computePriceValue(product, options = {}, override = {}) {
  const price = computeRawPriceValue(product, options, override);
  if (price == null) return null;
  const hasFixedPrice = Number.isFinite(Number(override.price)) && Number(override.price) > 0;
  const rarityFloor = hasFixedPrice ? null : getRarityFloor(product, options);
  return Math.max(price, rarityFloor ?? 0, EBAY_MIN_PRICE_EUR);
}

function computeRawPriceValue(product, options = {}, override = {}) {
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

// Gioco (item specific obbligatorio su eBay.it, categoria 183454) dedotto dal
// prefisso delle proprietà CardTrader; i valori sono quelli suggeriti dalla
// Taxonomy API di eBay.
const GAME_ASPECT_BY_PREFIX = {
  pokemon: "Pokémon",
  mtg: "Magic: The Gathering",
  yugioh: "Yu-Gi-Oh!",
  ygo: "Yu-Gi-Oh!",
  dragonball: "Dragon Ball Super Card Game",
  onepiece: "GCC One Piece",
  ff: "Final Fantasy TCG",
  digimon: "GCC Digimon",
  lorcana: "Disney Lorcana TCG",
  vanguard: "Cardfight!! Vanguard TCG",
  ws: "Weiss Schwarz",
  swu: "GCC Star Wars",
  gundam: "Gundam War TCG",
  fab: "Flesh and Blood TCG",
};

function detectGameAspect(propertiesHash = {}) {
  for (const key of Object.keys(propertiesHash)) {
    const prefix = key.toLowerCase().split("_")[0];
    if (GAME_ASPECT_BY_PREFIX[prefix]) return GAME_ASPECT_BY_PREFIX[prefix];
  }
  return null;
}

function getProductRarity(propertiesHash = {}) {
  const key = Object.keys(propertiesHash).find((k) =>
    k.toLowerCase().endsWith("rarity"),
  );
  return key ? String(propertiesHash[key]) : null;
}

function getCollectorNumber(propertiesHash = {}) {
  const key = Object.keys(propertiesHash).find((k) =>
    k.toLowerCase().includes("collector_number"),
  );
  return key ? String(propertiesHash[key]) : null;
}

// Item specifics con i nomi localizzati richiesti/raccomandati da eBay.it.
function buildAspects(product, settings = {}) {
  const props = product.properties_hash ?? {};
  const aspects = { ...(settings.defaultAspects ?? {}) };

  const game = detectGameAspect(props) ?? settings.defaultGameAspect ?? null;
  if (game) aspects["Gioco"] = [game];

  const language = getProductLanguage(props);
  if (language) {
    aspects["Lingua"] = [LANGUAGE_LABELS[language] ?? language.toUpperCase()];
  }

  const expansion =
    product.expansion?.name_en ?? product.expansion?.name ?? null;
  if (expansion) {
    aspects["Set"] = [String(expansion).slice(0, 65)];
  }

  const name = product.name_en ?? product.name;
  if (name) {
    aspects["Nome della carta"] = [String(name).slice(0, 65)];
  }

  const rarity = getProductRarity(props);
  if (rarity) aspects["Rarità"] = [String(rarity).slice(0, 65)];

  const collectorNumber = getCollectorNumber(props);
  if (collectorNumber) {
    aspects["Numero della carta"] = [collectorNumber.slice(0, 65)];
  }

  const variantTokens = getVariantTokens(props);
  if (variantTokens.includes("Reverse Holo")) aspects["Finitura"] = ["Reverse Holo"];
  else if (variantTokens.includes("Foil")) aspects["Finitura"] = ["Holo"];

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
    rarityFloors: options.rarityFloors ?? settings.rarityFloors ?? DEFAULT_RARITY_FLOORS,
  };
}

// Le carte sotto la soglia (default 2 EUR) usano la policy "economica", che
// aggiunge la spedizione non tracciata; le altre solo spedizione tracciata.
const DEFAULT_CHEAP_SHIPPING_THRESHOLD_EUR = 2;
// Cambi di policy per giro di sincronizzazione (ognuno riscrive un'offerta).
const POLICY_SWITCH_MAX_PER_RUN = 200;
const POLICY_SWITCH_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const REPUBLISH_CONCURRENCY = 4;

function selectFulfillmentPolicyId(priceEur, settings) {
  const threshold = Number(settings.cheapShippingThresholdEur) || DEFAULT_CHEAP_SHIPPING_THRESHOLD_EUR;
  if (settings.cheapFulfillmentPolicyId && Number(priceEur) < threshold) {
    return settings.cheapFulfillmentPolicyId;
  }
  return settings.fulfillmentPolicyId;
}

// Il prezzo eBay segue CardTrader solo quando il prezzo CT si è spostato di
// oltre la soglia (default 2%) rispetto alla base registrata all'ultimo
// caricamento/aggiornamento: evita un aggiornamento al giorno per i piccoli
// ribassi CT. I prezzi fissi (override) si applicano sempre subito.
const DEFAULT_PRICE_UPDATE_THRESHOLD_PCT = 2;

function resolveSyncPrice(entry, product, override, options, settings) {
  if (!product) return { priceEur: entry.priceEur ?? null, ctBaseEur: entry.ctPriceEur ?? null };

  const ctNow = Number(product.price_cents) / 100;
  const computed = computePriceValue(product, options, override);
  const hasFixedPrice = Number.isFinite(Number(override.price)) && Number(override.price) > 0;
  const recorded = Number(entry.priceEur);
  if (hasFixedPrice || !Number.isFinite(recorded) || !Number.isFinite(ctNow)) {
    return { priceEur: computed, ctBaseEur: Number.isFinite(ctNow) ? ctNow : null };
  }

  const threshold =
    (Number(settings.priceUpdateThresholdPct) || DEFAULT_PRICE_UPDATE_THRESHOLD_PCT) / 100;
  const base = Number(entry.ctPriceEur);

  if (!Number.isFinite(base) || base <= 0) {
    // Inserzioni caricate prima della regola: si confronta direttamente il
    // prezzo eBay calcolato con quello online.
    const drift = recorded > 0 ? Math.abs(computed - recorded) / recorded : 1;
    return drift > threshold
      ? { priceEur: computed, ctBaseEur: ctNow }
      : { priceEur: recorded, ctBaseEur: ctNow };
  }

  const drift = Math.abs(ctNow - base) / base;
  return drift > threshold
    ? { priceEur: computed, ctBaseEur: ctNow }
    : { priceEur: recorded, ctBaseEur: base };
}

// Proposta d'acquisto: rifiuto automatico sotto autoDeclinePct del prezzo,
// accettazione automatica da autoAcceptPct in su (percentuali sul prezzo).
const DEFAULT_BEST_OFFER = { enabled: true, autoAcceptPct: 90, autoDeclinePct: 70 };

function getBestOfferSettings(settings) {
  return { ...DEFAULT_BEST_OFFER, ...(settings.bestOffer ?? {}) };
}

function buildBestOfferTerms(priceEur, settings) {
  const config = getBestOfferSettings(settings);
  if (!config.enabled || !Number.isFinite(Number(priceEur))) return null;

  const round = (value) => Math.round(value * 100) / 100;
  const autoAccept = round((priceEur * config.autoAcceptPct) / 100);
  const autoDecline = round((priceEur * config.autoDeclinePct) / 100);
  const terms = { bestOfferEnabled: true };
  // eBay richiede rifiuto < accettazione < prezzo.
  if (config.autoAcceptPct > 0 && autoAccept < priceEur) {
    terms.autoAcceptPrice = { value: autoAccept.toFixed(2), currency: "EUR" };
  }
  if (config.autoDeclinePct > 0 && autoDecline < autoAccept) {
    terms.autoDeclinePrice = { value: autoDecline.toFixed(2), currency: "EUR" };
  }
  return terms;
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

  // Le carte gradate richiedono descrittori di gradazione (ente, voto,
  // certificato) che CardTrader non fornisce in modo strutturato: vanno
  // pubblicate a mano o escluse.
  if (product.graded) {
    throw new Error(
      "Carta gradata: eBay richiede ente e voto di gradazione. Pubblicarla manualmente oppure escluderla.",
    );
  }

  const description = buildDescription(product, settings, override);
  const inventoryItem = {
    availability: {
      shipToLocationAvailability: { quantity },
    },
    condition: mapCondition(getProductCondition(product.properties_hash), settings),
    // Obbligatorio per le carte non gradate: "Condizione della carta" (40001).
    conditionDescriptors: [
      {
        name: CARD_CONDITION_DESCRIPTOR_ID,
        values: [mapConditionDescriptor(getProductCondition(product.properties_hash))],
      },
    ],
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
      fulfillmentPolicyId: selectFulfillmentPolicyId(priceValue, settings),
      paymentPolicyId: settings.paymentPolicyId,
      returnPolicyId: settings.returnPolicyId,
    },
  };

  const bestOfferTerms = buildBestOfferTerms(priceValue, settings);
  if (bestOfferTerms) offerBody.listingPolicies.bestOfferTerms = bestOfferTerms;

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
    fulfillmentPolicyId: offerBody.listingPolicies.fulfillmentPolicyId,
    // Prezzo su cui sono calcolate le soglie della proposta d'acquisto: se il
    // prezzo cambia, le soglie vanno ricalcolate (vedi syncQuantities).
    bestOfferPriceEur: bestOfferTerms ? priceValue : null,
    // Prezzo CardTrader su cui è basato il prezzo eBay (base della soglia 2%).
    ctPriceEur: Number(product.price_cents) / 100,
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
        ctPriceEur: outcome.ctPriceEur,
        quantity: outcome.quantity,
        fulfillmentPolicyId: outcome.fulfillmentPolicyId,
        bestOfferPriceEur: outcome.bestOfferPriceEur,
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

// --- Sincronizzazione quantità/prezzi CardTrader -> inserzioni eBay ---
//
// Per ogni articolo nello storico pubblicazioni confronta quantità e prezzo
// correnti (da CardTrader + override) con quelli dell'ultima pubblicazione:
//   - cambiati        -> bulk_update_price_quantity (25 SKU per chiamata)
//   - quantità a zero -> l'inserzione risulta esaurita (stato OUT_OF_STOCK)
//   - tornato disponibile dopo un OUT_OF_STOCK -> ripubblicazione completa
async function syncQuantities(rawOptions = {}) {
  const settings = ebayService.getSettings();
  const options = withDefaultMarkup(rawOptions, settings);
  const overrides = ebayService.getOverrides();
  const history = ebayService.getPublishedHistory();
  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService, { force: true });
  const productById = new Map(products.map((product) => [product.id, product]));

  const toUpdate = [];
  const toRevive = [];
  const toSwitchPolicy = [];
  const pendingCtBases = {};
  const bestOfferEnabled = getBestOfferSettings(settings).enabled;
  const maxRepublishPerRun =
    Number(rawOptions.maxRepublishPerRun) || POLICY_SWITCH_MAX_PER_RUN;
  const results = [];
  let checked = 0;
  let unchanged = 0;

  for (const [key, entry] of Object.entries(history)) {
    if (entry.status !== "PUBLISHED" && entry.status !== "OUT_OF_STOCK") continue;
    checked += 1;

    const productId = Number(key);
    const override = overrides[key] ?? {};
    const product = productById.get(productId);

    // Prodotto sparito dall'export CardTrader (venduto del tutto) o escluso
    // nel frattempo: la quantità su eBay deve andare a zero.
    const quantity =
      product && !override.excluded ? computeQuantity(product, override) : 0;
    const { priceEur, ctBaseEur } = resolveSyncPrice(entry, product, override, options, settings);

    if (entry.status === "OUT_OF_STOCK") {
      if (quantity > 0 && product) {
        toRevive.push({ product, override });
      } else {
        unchanged += 1;
      }
      continue;
    }

    // Prezzo che attraversa la soglia della spedizione economica: la policy
    // va cambiata, e per farlo serve riscrivere l'offerta (non il bulk update).
    const recordedPolicy = entry.fulfillmentPolicyId ?? settings.fulfillmentPolicyId;
    const desiredPolicy = selectFulfillmentPolicyId(priceEur, settings);
    const switchFailedRecently =
      entry.policySwitchFailedAt &&
      Date.now() - Date.parse(entry.policySwitchFailedAt) < POLICY_SWITCH_RETRY_MS;
    // Proposta d'acquisto: soglie assenti o calcolate su un prezzo diverso
    // da quello attuale (evita accettazioni automatiche sotto prezzo).
    const bestOfferStale =
      bestOfferEnabled && priceEur != null && Number(entry.bestOfferPriceEur) !== priceEur;
    if (
      product &&
      quantity > 0 &&
      desiredPolicy &&
      (desiredPolicy !== recordedPolicy || bestOfferStale) &&
      !switchFailedRecently &&
      toSwitchPolicy.length < maxRepublishPerRun
    ) {
      toSwitchPolicy.push({ product, override, priceEur, ctBaseEur });
      continue;
    }

    const qtyChanged = Number(entry.quantity) !== quantity;
    const priceChanged =
      priceEur != null && Number(entry.priceEur) !== priceEur;
    if (!qtyChanged && !priceChanged) {
      // Base CT mancante (inserzioni caricate prima di questa regola):
      // la si registra senza toccare eBay.
      if (ctBaseEur != null && entry.ctPriceEur == null) {
        pendingCtBases[key] = ctBaseEur;
      }
      unchanged += 1;
      continue;
    }

    if (!entry.offerId) {
      results.push({
        productId,
        sku: entry.sku,
        ok: false,
        error:
          "offerId mancante nello storico: eseguire 'Sincronizza storico da eBay' nella tab Pubblicati.",
      });
      continue;
    }

    toUpdate.push({
      productId,
      sku: entry.sku,
      offerId: entry.offerId,
      quantity,
      priceEur,
      ctBaseEur,
    });
  }

  // eBay rifiuta quantità 0 su un'offerta pubblicata (errore 25004): gli
  // esauriti vanno ritirati, e tornano online via ripubblicazione (toRevive).
  const soldOutItems = toUpdate.filter((item) => item.quantity === 0);
  for (const item of soldOutItems) {
    try {
      await ebayService.withdrawOffer(item.offerId);
      ebayService.recordPublished(item.productId, {
        quantity: 0,
        status: "OUT_OF_STOCK",
      });
      results.push({ ...item, ok: true, soldOut: true });
    } catch (error) {
      results.push({ ...item, ok: false, error: error.message });
    }
  }

  const toBulkUpdate = toUpdate.filter((item) => item.quantity > 0);
  for (let i = 0; i < toBulkUpdate.length; i += 25) {
    const chunk = toBulkUpdate.slice(i, i + 25);
    const requests = chunk.map((item) => ({
      sku: item.sku,
      shipToLocationAvailability: { quantity: item.quantity },
      offers: [
        {
          offerId: item.offerId,
          availableQuantity: item.quantity,
          ...(item.priceEur != null
            ? { price: { value: item.priceEur.toFixed(2), currency: "EUR" } }
            : {}),
        },
      ],
    }));

    try {
      const response = await ebayService.bulkUpdatePriceQuantity(requests);
      const responseBySku = new Map(
        (response.responses ?? []).map((item) => [item.sku, item]),
      );

      for (const item of chunk) {
        const outcome = responseBySku.get(item.sku);
        const ok = !outcome || Number(outcome.statusCode) < 300;
        if (!ok) {
          results.push({
            ...item,
            ok: false,
            error: `HTTP ${outcome.statusCode}: ${JSON.stringify(outcome.errors ?? [])}`,
          });
          continue;
        }

        const patch = {
          quantity: item.quantity,
          status: item.quantity === 0 ? "OUT_OF_STOCK" : "PUBLISHED",
        };
        if (item.priceEur != null) patch.priceEur = item.priceEur;
        if (item.ctBaseEur != null) patch.ctPriceEur = item.ctBaseEur;
        ebayService.recordPublished(item.productId, patch);
        results.push({ ...item, ok: true, soldOut: item.quantity === 0 });
      }
    } catch (error) {
      for (const item of chunk) {
        results.push({ ...item, ok: false, error: error.message });
      }
    }
  }

  // Ripubblicazione completa per gli articoli tornati disponibili: una
  // inserzione esaurita non si riattiva con il solo aggiornamento quantità.
  for (const { product, override } of toRevive) {
    try {
      const outcome = await publishProduct(product, settings, {
        ...options,
        cardTraderService,
        override,
      });
      ebayService.recordPublished(product.id, {
        sku: outcome.sku,
        offerId: outcome.offerId,
        listingId: outcome.listingId,
        priceEur: outcome.priceEur,
        ctPriceEur: outcome.ctPriceEur,
        quantity: outcome.quantity,
        fulfillmentPolicyId: outcome.fulfillmentPolicyId,
        bestOfferPriceEur: outcome.bestOfferPriceEur,
        status: "PUBLISHED",
      });
      results.push({ ...outcome, ok: true, revived: true });
    } catch (error) {
      results.push({
        productId: product.id,
        sku: buildSku(product),
        ok: false,
        error: error.message,
      });
    }
  }

  // Ripubblicazioni in parallelo (ognuna richiede 3-4 chiamate eBay).
  const republishQueue = [...toSwitchPolicy];
  await Promise.all(Array.from({ length: REPUBLISH_CONCURRENCY }, async () => {
    while (republishQueue.length > 0) {
      await republishOne(republishQueue.shift());
    }
  }));

  async function republishOne({ product, override, priceEur, ctBaseEur }) {
    try {
      // Il prezzo resta quello deciso dalla soglia del 2%: cambiare policy o
      // soglie della proposta non deve ritoccare il prezzo.
      const outcome = await publishProduct(product, settings, {
        ...options,
        priceOverrides: priceEur != null ? { [String(product.id)]: priceEur } : undefined,
        cardTraderService,
        override,
      });
      ebayService.recordPublished(product.id, {
        ctPriceEur: ctBaseEur,
        priceEur: outcome.priceEur,
        quantity: outcome.quantity,
        fulfillmentPolicyId: outcome.fulfillmentPolicyId,
        bestOfferPriceEur: outcome.bestOfferPriceEur,
        policySwitchFailedAt: null,
        status: "PUBLISHED",
      });
      results.push({ ...outcome, ok: true, policySwitched: true });
    } catch (error) {
      // Tipicamente foto sotto risoluzione: l'inserzione resta com'è e il
      // cambio viene ritentato solo dopo POLICY_SWITCH_RETRY_MS.
      ebayService.recordPublished(product.id, {
        policySwitchFailedAt: new Date().toISOString(),
        status: "PUBLISHED",
      });
      results.push({ productId: product.id, sku: buildSku(product), ok: false, error: error.message });
    }
  }

  // Basi CT delle inserzioni caricate prima della regola del 2%: un'unica
  // scrittura sullo storico riletto ora (non sovrascrive gli aggiornamenti
  // fatti durante il giro).
  const baseKeys = Object.keys(pendingCtBases);
  if (baseKeys.length > 0) {
    const fresh = ebayService.getPublishedHistory();
    for (const key of baseKeys) {
      if (fresh[key] && fresh[key].ctPriceEur == null) {
        fresh[key] = { ...fresh[key], ctPriceEur: pendingCtBases[key] };
      }
    }
    ebayService.replacePublishedHistory(fresh);
  }

  return {
    checked,
    unchanged,
    ctBasesRecorded: baseKeys.length,
    policySwitched: results.filter((r) => r.ok && r.policySwitched).length,
    updated: results.filter((r) => r.ok && !r.soldOut && !r.revived && !r.policySwitched).length,
    soldOut: results.filter((r) => r.ok && r.soldOut).length,
    revived: results.filter((r) => r.ok && r.revived).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    syncedAt: new Date().toISOString(),
  };
}

// --- Pubblicazione automatica dei prodotti CardTrader nuovi ---
//
// Pubblica i prodotti mai pubblicati (assenti dallo storico), esclusi:
// esclusi manuali, sigillati (senza rarità), gradate, quantità zero.
// I prodotti rifiutati da eBay finiscono nel registro fallimenti e vengono
// ritentati solo dopo AUTO_PUBLISH_RETRY_MS.
const AUTO_PUBLISH_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// Regola temporanea per risparmiare la quota di inserzioni gratuite: fino
// alla data indicata non si pubblicano le carte delle rarità elencate con
// valore CardTrader sotto la soglia (settings.autoPublishSkip).
function isSkippedByQuotaRule(product, settings, now = Date.now()) {
  const rule = settings.autoPublishSkip;
  if (!rule?.until || now >= Date.parse(rule.until)) return false;
  const rarity = String(getProductRarity(product.properties_hash) ?? "").toLowerCase();
  const rarities = (rule.rarities ?? []).map((r) => String(r).toLowerCase());
  if (!rarities.includes(rarity)) return false;
  const ctPrice = Number(product.price_cents) / 100;
  return Number.isFinite(ctPrice) && ctPrice < Number(rule.maxCtPriceEur ?? 1);
}

async function autoPublishNewProducts(rawOptions = {}) {
  const settings = ebayService.getSettings();
  assertSettingsReady(settings);
  const maxPerRun = Math.max(1, Number(rawOptions.maxPerRun) || 100);

  const cardTraderService = createCardTraderService(rawOptions.runtimeConfig ?? {});
  const products = await loadProducts(cardTraderService, { force: true });
  const history = ebayService.getPublishedHistory();
  const overrides = ebayService.getOverrides();
  const failures = ebayService.getAutoPublishFailures();
  const now = Date.now();

  const candidates = products.filter((product) => {
    const key = String(product.id);
    if (history[key]) return false;
    if (overrides[key]?.excluded) return false;
    if (Number(product.quantity ?? 0) < 1) return false;
    if (product.graded) return false;
    if (!getProductRarity(product.properties_hash)) return false;
    if (isSkippedByQuotaRule(product, settings, now)) return false;
    const failure = failures[key];
    if (failure && now - Date.parse(failure.at) < AUTO_PUBLISH_RETRY_MS) return false;
    return true;
  });

  const batch = candidates.slice(0, maxPerRun).map((product) => product.id);
  if (batch.length === 0) {
    return { candidates: 0, published: 0, failed: 0, remaining: 0, results: [] };
  }

  const outcome = await publishProducts(batch, { ...rawOptions, skipPublished: true });

  const nextFailures = { ...ebayService.getAutoPublishFailures() };
  for (const result of outcome.results) {
    const key = String(result.productId);
    if (result.ok) delete nextFailures[key];
    else nextFailures[key] = { at: new Date().toISOString(), error: result.error };
  }
  ebayService.saveAutoPublishFailures(nextFailures);

  return {
    candidates: candidates.length,
    published: outcome.succeeded,
    failed: outcome.failed,
    remaining: Math.max(0, candidates.length - batch.length),
    results: outcome.results,
  };
}

// --- Vendite eBay -> scala quantità su CardTrader ---
//
// Ogni vendita eBay di uno SKU CT-<id> viene scalata una sola volta dal
// prodotto CardTrader (registro processedSales). Al primo avvio il registro
// viene solo inizializzato: le vendite già presenti erano state gestite a mano.
async function syncSalesToCardTrader(options = {}) {
  const cardTraderService = createCardTraderService(options.runtimeConfig ?? {});
  const sales = await ebayService.getRecentSales({ days: 3 });
  const existing = ebayService.getProcessedSales();
  const saleKey = (sale) => sale.orderLineItemId || sale.transactionId;

  if (existing === null) {
    const seeded = {};
    for (const sale of sales) {
      seeded[saleKey(sale)] = { at: new Date().toISOString(), seeded: true };
    }
    ebayService.saveProcessedSales(seeded);
    return { initialized: true, seeded: sales.length, decremented: 0, failed: 0, results: [] };
  }

  const processed = { ...existing };
  const results = [];

  for (const sale of sales) {
    const key = saleKey(sale);
    if (processed[key]) continue;

    const productId = parseProductIdFromSku(sale.sku);
    if (!productId) {
      // Inserzione non creata da questa integrazione: nulla da scalare.
      processed[key] = { at: new Date().toISOString(), skipped: "sku non CT" };
      continue;
    }

    try {
      await cardTraderService.incrementProductQuantity(productId, -sale.quantity);
      processed[key] = { at: new Date().toISOString(), productId, quantity: sale.quantity };
      results.push({ productId, sku: sale.sku, quantity: sale.quantity, title: sale.title, ok: true });
    } catch (error) {
      // Non marcata come elaborata: verrà ritentata al prossimo giro.
      results.push({ productId, sku: sale.sku, ok: false, error: error.message });
    }
  }

  // Tiene solo le chiavi recenti per non far crescere il registro all'infinito.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(processed)) {
    if (Date.parse(value.at) < cutoff) delete processed[key];
  }
  ebayService.saveProcessedSales(processed);

  return {
    initialized: false,
    decremented: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
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
  syncQuantities,
  syncSalesToCardTrader,
  autoPublishNewProducts,
  resolveSyncPrice,
  compareProduct,
  compareProducts,
};
