const fs = require("fs");
const path = require("path");
const {
  ALIGN_PRICE_INTER_GAME_DELAY_MS,
  ALIGN_PRICE_EXPANSION_CONCURRENCY,
  ALIGN_PRICE_LANGUAGE_FILTER,
  ALIGN_PRICE_BULK_UPDATE,
  ALIGN_PRICE_BULK_UPDATE_SIZE,
  ALIGN_PRICE_JOB_WAIT_MS,
  ALIGN_PRICE_TRACK_INVENTORY,
} = require("../config/config");
const { createCardTraderService } = require("./cardTraderService");
const { syncCardTraderInventory } = require("./priceTrackingService");
const { sleep, throwIfAborted, isAbortError } = require("../utils/abort");

const ABORT_MESSAGE = "Allineamento prezzi annullato.";

const BLOCKED_COUNTRIES = new Set(["US", "CA", "NZ"]);
const MY_USERNAME = "Jigglycard";
const POKEMON_GAME_ID = 5;
const DRAGON_BALL_GAME_ID = 9;
const ONE_PIECE_GAME_ID = 15;
const JAPANESE_LANGS = new Set(["jp", "jap", "ja"]);
const CONDITION_ORDER = [
  "near mint",
  "slightly played",
  "moderately played",
  "played",
  "poor",
];
// Percentuali applicate al primo (piu' economico) concorrente delle condizioni
// migliori; al risultato si aggiunge sempre il candidato "primo della stessa
// condizione - 1 centesimo" e si sceglie il minore.
// slightly played = Excellent, moderately played = Good.
const CONDITION_PERCENT_RULES = {
  "slightly played": { "near mint": 0.85 },
  "moderately played": { "near mint": 0.7, "slightly played": 0.85 },
  played: {
    "near mint": 0.4,
    "slightly played": 0.55,
    "moderately played": 0.7,
  },
  poor: {
    "near mint": 0.25,
    "slightly played": 0.4,
    "moderately played": 0.55,
    played: 0.85,
  },
};
// Sopra questa soglia il nuovo prezzo non puo' superare il prezzo attuale
// aumentato del 1000% (cioe' 11 volte il prezzo attuale).
const PRICE_INCREASE_CAP_THRESHOLD_CENTS = 10000;
const MAX_PRICE_INCREASE_FACTOR = 11;
const GAME_CONFIGS = {
  pokemon: {
    slug: "pokemon",
    gameId: POKEMON_GAME_ID,
    languageKey: "pokemon_language",
    allowedLanguages: new Set(["jp", "it", "en"]),
    matchKeys: [
      "condition",
      "pokemon_reverse",
      "pokemon_language",
      "signed",
      "altered",
      "first_edition",
      "graded",
    ],
    minAllowedPriceCents: (item) => getPokemonMinAllowedPriceCents(item),
  },
  onepiece: {
    slug: "onepiece",
    gameId: ONE_PIECE_GAME_ID,
    languageKey: "onepiece_language",
    allowedLanguages: new Set(["jp", "en"]),
    matchKeys: [
      "condition",
      "onepiece_language",
      "signed",
      "altered",
      "graded",
      "tournament_legal",
    ],
    minAllowedPriceCents: () => 0,
  },
  dragonball: {
    slug: "dragonball",
    gameId: DRAGON_BALL_GAME_ID,
    languageKey: "dragonball_language",
    allowedLanguages: new Set(["en", "jp"]),
    matchKeys: [
      "condition",
      "dragonball_language",
      "signed",
      "altered",
      "graded",
      "tournament_legal",
      "dragonball_foil",
    ],
    minAllowedPriceCents: () => 0,
  },
};

function feeCentsFromPrice(priceCents) {
  const price = priceCents / 100;
  if (price <= 0.25) return 9;
  if (price <= 3.0) return 10;
  if (price <= 5.0) return 11;
  if (price <= 7.0) return 14;
  if (price <= 10.0) return 15;
  if (price <= 15.0) return 21;
  if (price <= 20.0) return 27;
  if (price <= 30.0) return 40;
  if (price <= 40.0) return 52;
  return 64;
}

function netPriceCents(priceCents) {
  if (!Number.isFinite(priceCents)) return null;
  const net = priceCents - feeCentsFromPrice(priceCents);
  return net < 0 ? 0 : net;
}

function propertiesMatch(listingProps, myProps, matchKeys) {
  const lp = listingProps || {};
  const mp = myProps || {};
  return matchKeys.every((key) => lp[key] === mp[key]);
}

function propertiesMatchWithoutCondition(listingProps, myProps, matchKeys) {
  let lp = { ...listingProps } || {};
  let mp = { ...myProps } || {};
  lp.condition = "";
  mp.condition = "";
  return matchKeys.every((key) => lp[key] === mp[key]);
}

function gradedMatch(listing, item) {
  if (typeof item?.graded === "undefined") return true;
  return listing?.graded === item?.graded;
}

function getRarity(item) {
  return (
    item?.properties_hash?.pokemon_rarity ??
    item?.properties_hash?.onepiece_rarity ??
    item?.properties_hash?.dragonball_rarity ??
    ""
  );
}

function getCondition(value) {
  return normalizeText(value);
}

function getConditionBounds(condition, listings) {
  const currentIndex = CONDITION_ORDER.indexOf(condition);
  if (currentIndex === -1) {
    return {
      floorCents: null,
      ceilingCents: null,
    };
  }

  let floorCents = null;
  let ceilingCents = null;

  for (const listing of listings) {
    const listingCondition = getCondition(listing?.properties_hash?.condition);
    const listingIndex = CONDITION_ORDER.indexOf(listingCondition);
    const priceCents = Number(listing?.price_cents);

    if (listingIndex === -1 || !Number.isFinite(priceCents)) continue;

    if (listingIndex < currentIndex) {
      const maxAllowedCents = Math.max(0, priceCents - 1);
      ceilingCents =
        ceilingCents === null
          ? maxAllowedCents
          : Math.min(ceilingCents, maxAllowedCents);
    }

    if (listingIndex > currentIndex) {
      const minAllowedCents = priceCents + 1;
      floorCents =
        floorCents === null
          ? minAllowedCents
          : Math.max(floorCents, minAllowedCents);
    }
  }

  return {
    floorCents,
    ceilingCents,
  };
}

function getPokemonMinAllowedPriceCents(item) {
  const rarity = getRarity(item).toLowerCase();
  const productName = normalizeText(item?.name_en ?? item?.name);
  const hasFixedExOrV =
    rarity === "fixed" &&
    (productName.includes(" ex") || productName.includes(" v"));

  if (hasFixedExOrV) {
    return 25;
  }

  const condition = String(item?.properties_hash?.condition ?? "")
    .trim()
    .toLowerCase();
  if (condition !== "near mint") return 0;

  if (rarity === "illustration rare") {
    return 150;
  }
  if (rarity === "shiny holo rare") {
    return 80;
  }
  if (rarity === "ultra rare" || rarity === "rare ace") {
    return 25;
  }
  return 0;
}

function getItemLanguage(item, gameConfig) {
  return normalizeText(item?.properties_hash?.[gameConfig.languageKey]);
}

function isEligibleItemForGame(item, gameConfig) {
  return (
    item?.game_id === gameConfig.gameId &&
    gameConfig.allowedLanguages.has(getItemLanguage(item, gameConfig))
  );
}

function filterListingsForItem(item, sourceListings, gameConfig) {
  if (item?.graded) return [];

  const itemCondition = getCondition(item?.properties_hash?.condition);
  let listings = sourceListings;

  if (itemCondition === "near mint") {
    return listings.filter(
      (listing) =>
        propertiesMatch(
          listing?.properties_hash,
          item?.properties_hash,
          gameConfig.matchKeys,
        ) && gradedMatch(listing, item),
    );
  }

  listings = listings.filter(
    (listing) =>
      propertiesMatchWithoutCondition(
        listing?.properties_hash,
        item?.properties_hash,
        gameConfig.matchKeys,
      ) && gradedMatch(listing, item),
  );

  if (itemCondition === "slightly played") {
    return listings.filter((listing) => {
      const condition = getCondition(listing?.properties_hash?.condition);
      return condition === "slightly played" || condition === "near mint";
    });
  }

  if (itemCondition === "moderately played") {
    return listings.filter((listing) => {
      const condition = getCondition(listing?.properties_hash?.condition);
      return (
        condition === "moderately played" ||
        condition === "slightly played" ||
        condition === "near mint"
      );
    });
  }

  if (itemCondition === "played") {
    return listings.filter((listing) => {
      const condition = getCondition(listing?.properties_hash?.condition);
      return (
        condition === "played" ||
        condition === "moderately played" ||
        condition === "slightly played" ||
        condition === "near mint"
      );
    });
  }

  if (itemCondition === "poor") {
    return listings.filter((listing) => {
      const condition = getCondition(listing?.properties_hash?.condition);
      return (
        condition === "poor" ||
        condition === "played" ||
        condition === "moderately played" ||
        condition === "slightly played" ||
        condition === "near mint"
      );
    });
  }

  return listings;
}

function csvEscape(value) {
  if (value === null || typeof value === "undefined") return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isIllustrationRareBlueprint(blueprint) {
  return (
    normalizeText(blueprint?.fixed_properties?.pokemon_rarity) ===
    "illustration rare"
  );
}

function isUltraRareBlueprint(blueprint) {
  return (
    normalizeText(blueprint?.fixed_properties?.pokemon_rarity) === "ultra rare"
  );
}

function getTargetBlueprintType(blueprint) {
  if (isIllustrationRareBlueprint(blueprint)) {
    return {
      rarity: "Illustration Rare",
      maxPriceCents: 85,
    };
  }

  if (isUltraRareBlueprint(blueprint)) {
    return {
      rarity: "Ultra Rare",
      maxPriceCents: 19,
    };
  }

  return null;
}

function isNearMintJapaneseListing(listing) {
  const props = listing?.properties_hash ?? {};
  const condition = normalizeText(props.condition);
  const language = normalizeText(props.pokemon_language ?? props.language);
  return condition === "near mint" && JAPANESE_LANGS.has(language);
}

function extractCartProductIds(node, productIds = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) {
      extractCartProductIds(item, productIds);
    }
    return productIds;
  }

  if (!node || typeof node !== "object") {
    return productIds;
  }

  if (Number.isFinite(node.product_id)) {
    productIds.add(node.product_id);
  }

  if (Number.isFinite(node?.product?.id)) {
    productIds.add(node.product.id);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      extractCartProductIds(value, productIds);
    }
  }

  return productIds;
}

function formatEuroFromCents(priceCents) {
  if (!Number.isFinite(priceCents)) return "n/a";
  return `EUR ${(priceCents / 100).toFixed(2)}`;
}

function resolveCartProductId(listing) {
  const candidates = [listing?.product_id, listing?.product?.id, listing?.id];

  for (const candidate of candidates) {
    const numericCandidate = Number(candidate);
    if (Number.isFinite(numericCandidate)) {
      return numericCandidate;
    }
  }

  return null;
}

function filterMarketplaceListings(listings = []) {
  return listings.filter((listing) => {
    const hubOk = listing?.user?.can_sell_via_hub === true;
    const countryOk = !BLOCKED_COUNTRIES.has(listing?.user?.country_code);
    return hubOk && countryOk;
  });
}

function getExpansionId(item) {
  const expansionId = Number(item?.expansion?.id);
  return Number.isFinite(expansionId) ? expansionId : null;
}

// Tiene solo i campi usati dal confronto prezzi: una singola espansione puo'
// restituire decine di migliaia di listing e il resto del payload e' peso morto.
function leanListing(listing) {
  return {
    id: listing?.id,
    price_cents: listing?.price_cents,
    graded: listing?.graded,
    properties_hash: listing?.properties_hash,
    user: { username: listing?.user?.username },
  };
}

function collectListingsByBlueprint(target, groupedListings, blueprintIds) {
  const entries =
    groupedListings && typeof groupedListings === "object"
      ? Object.entries(groupedListings)
      : [];

  for (const [rawBlueprintId, listings] of entries) {
    const blueprintId = Number(rawBlueprintId);
    if (!Number.isFinite(blueprintId)) continue;
    if (blueprintIds && !blueprintIds.has(blueprintId)) continue;

    const kept = filterMarketplaceListings(
      Array.isArray(listings) ? listings : [],
    ).map(leanListing);
    if (kept.length === 0) continue;

    const existing = target.get(blueprintId);
    if (existing) existing.push(...kept);
    else target.set(blueprintId, kept);
  }

  return target;
}

// Registra nel tracking prezzi l'inventario appena esportato: gli articoli
// nuovi entrano con il prezzo di carico corrente (l'export precede qualsiasi
// aggiornamento di prezzo), anche se non sono stati venduti. Non deve mai
// bloccare l'allineamento: se Mongo non risponde si logga e si prosegue.
async function trackInventoryExport(
  cardtraderService,
  exportRes,
  runtimeConfig = {},
) {
  if (!ALIGN_PRICE_TRACK_INVENTORY) return null;
  const products = Array.isArray(exportRes?.data) ? exportRes.data : [];
  if (products.length === 0) return null;

  throwIfAborted(runtimeConfig.signal, ABORT_MESSAGE);
  const startedAt = Date.now();
  try {
    const result = await syncCardTraderInventory(runtimeConfig, {
      products,
      cardTraderService,
      source: "align-price",
    });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[ALIGN-PRICE][tracking] Inventario registrato in ${seconds}s | articoli=${result.itemCount} | nuovi=${result.newItems} | collegati a Cardmarket=${result.linkedToCardmarket}`,
    );
    return result;
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn(
      `[ALIGN-PRICE][tracking] Registrazione inventario saltata (${error.message})`,
    );
    return null;
  }
}

// Scarica products/export e lo registra nel tracking prima di restituirlo.
async function fetchInventoryExport(cardtraderService, runtimeConfig = {}) {
  throwIfAborted(runtimeConfig.signal, ABORT_MESSAGE);
  const exportRes = await cardtraderService.getMyProducts();
  await trackInventoryExport(cardtraderService, exportRes, runtimeConfig);
  return exportRes;
}

async function alignPricesForGame(
  gameConfig,
  runtimeConfig = {},
  sharedExport = null,
) {
  const cardtraderService = createCardTraderService(runtimeConfig);
  const taskSignal = runtimeConfig.signal;
  const exportStartedAt = Date.now();
  console.log(
    `[ALIGN-PRICE][${gameConfig.slug}] Avvio allineamento per game_id=${gameConfig.gameId}`,
  );

  const exportRes =
    sharedExport ??
    (await fetchInventoryExport(cardtraderService, runtimeConfig));
  const myItems = Array.isArray(exportRes?.data)
    ? exportRes.data.filter((item) => isEligibleItemForGame(item, gameConfig))
    : [];
  const exportDurationSeconds = Math.max(
    0,
    Math.round((Date.now() - exportStartedAt) / 1000),
  );
  const totalItems = myItems.length;
  const rows = [];
  let checkedItems = 0;
  let processingStartedAt = null;

  // Un gruppo per espansione: il marketplace si scarica una volta sola per
  // espansione (e solo nelle lingue che teniamo davvero a magazzino), si
  // processano tutti gli item del gruppo e poi la memoria viene liberata.
  const groups = new Map();
  const itemsWithoutExpansion = [];
  for (const item of myItems) {
    const expansionId = getExpansionId(item);
    if (expansionId === null) {
      itemsWithoutExpansion.push(item);
      continue;
    }

    let group = groups.get(expansionId);
    if (!group) {
      group = {
        expansionId,
        items: [],
        languages: new Set(),
        blueprintIds: new Set(),
      };
      groups.set(expansionId, group);
    }

    group.items.push(item);
    const language = getItemLanguage(item, gameConfig);
    if (language) group.languages.add(language);
    const blueprintId = Number(item?.blueprint_id);
    if (Number.isFinite(blueprintId)) group.blueprintIds.add(blueprintId);
  }
  const groupList = [...groups.values()];

  const bulkSize = Math.max(1, ALIGN_PRICE_BULK_UPDATE_SIZE);
  const pendingPriceUpdates = [];
  const bulkJobs = [];
  let queuedUpdates = 0;

  function queuePriceUpdate(productId, priceCents) {
    const id = Number(productId);
    if (!Number.isFinite(id)) return;
    pendingPriceUpdates.push({ id, price: priceCents / 100 });
    queuedUpdates += 1;
  }

  // POST /products/bulk_update accorpa fino a bulkSize prodotti in una sola
  // richiesta asincrona, al posto di una PUT per prodotto.
  async function flushPriceUpdates(force = false) {
    while (
      pendingPriceUpdates.length >= bulkSize ||
      (force && pendingPriceUpdates.length > 0)
    ) {
      const batch = pendingPriceUpdates.splice(0, bulkSize);
      throwIfAborted(taskSignal, ABORT_MESSAGE);

      if (!ALIGN_PRICE_BULK_UPDATE) {
        for (const update of batch) {
          try {
            await cardtraderService.updateProductPrice(
              update.id,
              Math.round(update.price * 100),
            );
          } catch (error) {
            if (isAbortError(error)) throw error;
          }
        }
        continue;
      }

      try {
        const response = await cardtraderService.bulkUpdateProducts(batch);
        const jobUuid = response?.data?.job;
        if (jobUuid) bulkJobs.push(jobUuid);
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn(
          `[ALIGN-PRICE][${gameConfig.slug}] bulk_update fallito per ${batch.length} prodotti (${error.message})`,
        );
      }
    }
  }

  async function waitForBulkJobs() {
    const totals = { ok: 0, warning: 0, error: 0, pending: 0 };
    if (bulkJobs.length === 0) return totals;

    const deadline = Date.now() + Math.max(0, ALIGN_PRICE_JOB_WAIT_MS);
    for (const uuid of bulkJobs) {
      while (true) {
        throwIfAborted(taskSignal, ABORT_MESSAGE);
        if (Date.now() > deadline) {
          totals.pending += 1;
          break;
        }

        let jobData = null;
        try {
          const response = await cardtraderService.getJob(uuid);
          jobData = response?.data ?? null;
        } catch (error) {
          if (isAbortError(error)) throw error;
          totals.pending += 1;
          break;
        }

        const state = jobData?.state;
        if (state === "completed" || state === "unprocessable") {
          totals.ok += Number(jobData?.stats?.ok) || 0;
          totals.warning += Number(jobData?.stats?.warning) || 0;
          totals.error += Number(jobData?.stats?.error) || 0;
          break;
        }

        await sleep(250, taskSignal);
      }
    }

    return totals;
  }

  async function fetchGroupListingsByBlueprint(group) {
    const byBlueprint = new Map();
    for (const blueprintId of group.blueprintIds) {
      throwIfAborted(taskSignal, ABORT_MESSAGE);
      try {
        const response = await cardtraderService.getProduct(blueprintId);
        collectListingsByBlueprint(
          byBlueprint,
          response?.data,
          group.blueprintIds,
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    return byBlueprint;
  }

  async function fetchGroupListings(group) {
    const languages = ALIGN_PRICE_LANGUAGE_FILTER
      ? [...group.languages].filter(Boolean)
      : [];
    // Senza lingue note si scarica l'espansione intera, come prima.
    const variants = languages.length > 0 ? languages : [null];

    try {
      const responses = await Promise.all(
        variants.map((language) =>
          cardtraderService.getMarketplaceProductsByExpansionId(
            group.expansionId,
            { language },
          ),
        ),
      );

      const byBlueprint = new Map();
      for (const response of responses) {
        collectListingsByBlueprint(
          byBlueprint,
          response?.data,
          group.blueprintIds,
        );
      }
      return byBlueprint;
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn(
        `[ALIGN-PRICE][${gameConfig.slug}] Fallback fetch per blueprint: expansion_id=${group.expansionId} (${error.message})`,
      );
      return fetchGroupListingsByBlueprint(group);
    }
  }

  // Le espansioni successive vengono precaricate mentre si elabora quella
  // corrente: e' il vero collo di bottiglia, perche' ogni chiamata marketplace
  // puo' durare diversi secondi e prima veniva attesa in serie.
  const expansionConcurrency = Math.max(1, ALIGN_PRICE_EXPANSION_CONCURRENCY);
  const inflightGroups = new Map();

  function ensureGroupFetch(group) {
    let pending = inflightGroups.get(group.expansionId);
    if (!pending) {
      pending = fetchGroupListings(group).then(
        (listings) => ({ listings }),
        (error) => ({ error }),
      );
      inflightGroups.set(group.expansionId, pending);
    }
    return pending;
  }

  function reportProgress() {
    checkedItems += 1;
    if (checkedItems % 50 !== 0 && checkedItems !== totalItems) return;

    const startedAt = processingStartedAt ?? Date.now();
    const elapsedSeconds = Math.max(
      1,
      Math.round((Date.now() - startedAt) / 1000),
    );
    const itemsPerSecond = checkedItems / elapsedSeconds;
    const remainingItems = Math.max(0, totalItems - checkedItems);
    const etaSeconds =
      itemsPerSecond > 0 ? Math.round(remainingItems / itemsPerSecond) : null;
    const rateText = itemsPerSecond.toFixed(2).replace(".", ",");
    const etaText =
      etaSeconds === null
        ? "n/a"
        : `${Math.floor(etaSeconds / 60)}m ${String(etaSeconds % 60).padStart(
            2,
            "0",
          )}s`;

    console.log(
      `[ALIGN-PRICE][${gameConfig.slug}] ${checkedItems}/${totalItems} prezzi controllati | speed: ${rateText} item/s | eta: ${etaText}`,
    );
  }

  function processItem(item, cachedListings) {
    const blueprintId = item?.blueprint_id;
    if (!blueprintId) return;

    const myPriceCents = Number(item?.price_cents);
    const myNetCents = Number.isFinite(myPriceCents) ? myPriceCents : null;

    try {
      const listings = filterListingsForItem(
        item,
        cachedListings,
        gameConfig,
      ).sort((a, b) => a.price_cents - b.price_cents);

      if (listings.length === 0) return;

      const myListing =
        listings.find((listing) => listing?.user?.username === MY_USERNAME) ||
        null;
      const competitors = listings.filter(
        (listing) => listing?.user?.username !== MY_USERNAME,
      );

      if (competitors.length === 0) return;

      const itemCondition = getCondition(item?.properties_hash?.condition);
      // Listings ordinati per prezzo crescente: il primo di ogni condizione
      // e' il piu' economico.
      const cheapestByCondition = new Map();
      for (const listing of competitors) {
        const condition = getCondition(listing?.properties_hash?.condition);
        if (!cheapestByCondition.has(condition)) {
          cheapestByCondition.set(condition, listing);
        }
      }

      const candidates = [];
      const percentRules = CONDITION_PERCENT_RULES[itemCondition] ?? {};
      for (const [condition, factor] of Object.entries(percentRules)) {
        const listing = cheapestByCondition.get(condition);
        const listingNetCents = listing
          ? netPriceCents(listing.price_cents)
          : null;
        if (typeof listingNetCents === "number") {
          candidates.push({
            listing,
            cents: Math.round(listingNetCents * factor),
          });
        }
      }
      const sameConditionListing = cheapestByCondition.get(itemCondition);
      const sameConditionNetCents = sameConditionListing
        ? netPriceCents(sameConditionListing.price_cents)
        : null;
      if (typeof sameConditionNetCents === "number") {
        candidates.push({
          listing: sameConditionListing,
          cents: sameConditionNetCents - 1,
        });
      }

      if (candidates.length === 0) return;

      const bestCandidate = candidates.reduce((best, candidate) =>
        candidate.cents < best.cents ? candidate : best,
      );
      const bestCompetitor = bestCandidate.listing;
      const competitorNetCents = netPriceCents(bestCompetitor.price_cents);
      const targetNetCentsRaw = Math.max(2, bestCandidate.cents);
      const minPriceCents = gameConfig.minAllowedPriceCents(item);
      let targetNetCents = Math.max(targetNetCentsRaw, minPriceCents);

      if (
        Number.isFinite(myPriceCents) &&
        myPriceCents > 0 &&
        targetNetCents > PRICE_INCREASE_CAP_THRESHOLD_CENTS
      ) {
        const maxAllowedCents = myPriceCents * MAX_PRICE_INCREASE_FACTOR;
        if (targetNetCents > maxAllowedCents) {
          targetNetCents = maxAllowedCents;
        }
      }

      rows.push({
        blueprint_id: blueprintId,
        my_product_id: item?.id ?? "",
        my_listing_id: myListing?.id ?? "",
        expansion_name: item?.expansion_name ?? "",
        product_name: item?.name_en ?? item?.name ?? "",
        my_price_cents: Number.isFinite(myPriceCents) ? myPriceCents : "",
        my_net_cents: myNetCents ?? "",
        competitor_username: bestCompetitor?.user?.username ?? "",
        competitor_price_cents: bestCompetitor?.price_cents ?? "",
        competitor_net_cents: competitorNetCents ?? "",
        target_net_cents: targetNetCents ?? "",
      });

      if (
        typeof targetNetCents === "number" &&
        targetNetCents !== myPriceCents
      ) {
        queuePriceUpdate(item.id, targetNetCents);
      }
    } catch (_err) {
      // Ignora errori per produrre solo il CSV finale.
    }
  }

  function processGroupItems(group, listingsByBlueprint) {
    for (const item of group.items) {
      const blueprintId = Number(item?.blueprint_id);
      processItem(item, listingsByBlueprint.get(blueprintId) ?? []);
      reportProgress();
    }
  }

  processingStartedAt = Date.now();
  console.log(
    `[ALIGN-PRICE][${gameConfig.slug}] Export completato in ${exportDurationSeconds}s | items=${totalItems} | expansions=${groupList.length} | prefetch=${expansionConcurrency} | lingue=${
      ALIGN_PRICE_LANGUAGE_FILTER ? "filtrate" : "tutte"
    }`,
  );

  for (let index = 0; index < groupList.length; index += 1) {
    throwIfAborted(taskSignal, ABORT_MESSAGE);

    const windowEnd = Math.min(groupList.length, index + expansionConcurrency);
    for (let ahead = index; ahead < windowEnd; ahead += 1) {
      ensureGroupFetch(groupList[ahead]);
    }

    const group = groupList[index];
    const { listings, error } = await ensureGroupFetch(group);
    inflightGroups.delete(group.expansionId);

    if (error) {
      if (isAbortError(error)) throw error;
      checkedItems += group.items.length;
      continue;
    }

    processGroupItems(group, listings);
    await flushPriceUpdates(false);
  }

  for (const item of itemsWithoutExpansion) {
    throwIfAborted(taskSignal, ABORT_MESSAGE);
    const blueprintId = Number(item?.blueprint_id);
    if (!Number.isFinite(blueprintId)) {
      reportProgress();
      continue;
    }

    try {
      const response = await cardtraderService.getProduct(blueprintId);
      const byBlueprint = collectListingsByBlueprint(
        new Map(),
        response?.data,
        null,
      );
      processItem(item, byBlueprint.get(blueprintId) ?? []);
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    reportProgress();
  }

  await flushPriceUpdates(true);
  const jobTotals = await waitForBulkJobs();
  if (queuedUpdates > 0) {
    console.log(
      `[ALIGN-PRICE][${gameConfig.slug}] Prezzi aggiornati: ${queuedUpdates} | job=${bulkJobs.length} | ok=${jobTotals.ok} warning=${jobTotals.warning} error=${jobTotals.error} in-corso=${jobTotals.pending}`,
    );
  }

  const headers = [
    "blueprint_id",
    "my_product_id",
    "my_listing_id",
    "expansion_name",
    "product_name",
    "my_price_cents",
    "my_net_cents",
    "competitor_username",
    "competitor_price_cents",
    "competitor_net_cents",
    "target_net_cents",
  ];

  rows.sort((a, b) => {
    const aId = Number(a.blueprint_id);
    const bId = Number(b.blueprint_id);
    if (Number.isFinite(aId) && Number.isFinite(bId)) return bId - aId;
    return String(b.blueprint_id).localeCompare(String(a.blueprint_id));
  });

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }

  const outPath = path.join(
    __dirname,
    "..",
    "excel_export",
    `align-price-${gameConfig.slug}.csv`,
  );
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`[ALIGN-PRICE][${gameConfig.slug}] CSV scritto in ${outPath}`);

  return { totalItems, rows: rows.length, outPath };
}

exports.alignPokemonPrices = async (runtimeConfig = {}) =>
  alignPricesForGame(GAME_CONFIGS.pokemon, runtimeConfig);

exports.alignDragonBallPrices = async (runtimeConfig = {}) =>
  alignPricesForGame(GAME_CONFIGS.dragonball, runtimeConfig);

exports.alignOnePiecePrices = async (runtimeConfig = {}) =>
  alignPricesForGame(GAME_CONFIGS.onepiece, runtimeConfig);

exports.alignPrices = async (runtimeConfig = {}) => {
  // products/export restituisce l'intero inventario (tutti i giochi) e su
  // collezioni grandi costa parecchi secondi: lo scarichiamo una volta sola.
  const cardtraderService = createCardTraderService(runtimeConfig);
  const sharedExport = await fetchInventoryExport(
    cardtraderService,
    runtimeConfig,
  );

  const results = [];
  results.push(
    await alignPricesForGame(GAME_CONFIGS.pokemon, runtimeConfig, sharedExport),
  );
  if (ALIGN_PRICE_INTER_GAME_DELAY_MS > 0) {
    await sleep(ALIGN_PRICE_INTER_GAME_DELAY_MS, runtimeConfig.signal);
  }
  results.push(
    await alignPricesForGame(
      GAME_CONFIGS.dragonball,
      runtimeConfig,
      sharedExport,
    ),
  );
  if (ALIGN_PRICE_INTER_GAME_DELAY_MS > 0) {
    await sleep(ALIGN_PRICE_INTER_GAME_DELAY_MS, runtimeConfig.signal);
  }
  results.push(
    await alignPricesForGame(
      GAME_CONFIGS.onepiece,
      runtimeConfig,
      sharedExport,
    ),
  );
  return results;
};
