const fs = require("fs");
const path = require("path");
const cardtraderService = require("./cardTraderService");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BLOCKED_COUNTRIES = new Set(["US", "CA", "NZ"]);
const MY_USERNAME = "Jigglycard";
const POKEMON_GAME_ID = 5;
const JAPANESE_LANGS = new Set(["jp", "jap", "ja"]);
const TEST_BLUEPRINT_ID = 277508; //350003; //;
const PROPS_TO_MATCH = [
  "condition",
  "pokemon_reverse",
  "pokemon_language",
  "signed",
  "altered",
  "first_edition",
  "graded",
];
const CONDITION_ORDER = [
  "near mint",
  "slightly played",
  "moderately played",
  "played",
  "poor",
];
const ALIGN_PRICE_WORKERS = 12;

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

function propertiesMatch(listingProps, myProps) {
  const lp = listingProps || {};
  const mp = myProps || {};
  return PROPS_TO_MATCH.every((key) => lp[key] === mp[key]);
}

function propertiesMatchWithoutCondition(listingProps, myProps) {
  let lp = { ...listingProps } || {};
  let mp = { ...myProps } || {};
  lp.condition = "";
  mp.condition = "";
  return PROPS_TO_MATCH.every((key) => lp[key] === mp[key]);
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

function minAllowedPriceCents(item) {
  const rarity = getRarity(item).toLowerCase();
  const productName = normalizeText(item?.name_en ?? item?.name);
  const hasFixedExOrV =
    rarity === "fixed" &&
    (productName.includes(" ex") || productName.includes(" v"));

  if (hasFixedExOrV) {
    console.log("Min price for fixed ex/v: 25");
    return 25;
  }

  const condition = String(item?.properties_hash?.condition ?? "")
    .trim()
    .toLowerCase();
  if (condition !== "near mint") return 0;

  if (rarity === "illustration rare") {
    console.log("Min price for illustration rare: 150");
    return 150;
  }
  if (rarity === "shiny holo rare") {
    console.log("Min price for shiny holo rare: 80");
    return 80;
  }
  if (rarity === "ultra rare" || rarity === "rare ace") {
    console.log("Min price for ultra rare: 25");
    return 25;
  }
  return 0;
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

async function waitBeforeCardTraderRequest(delayMs, label) {
  console.log(`[IR-CART] Attendo ${delayMs}ms prima della richiesta: ${label}`);
  await sleep(delayMs);
}

exports.addJapaneseIllustrationRaresToCart = async (options = {}) => {
  const {
    quantity = 1000,
    dryRun = false,
    delayMs = 1000,
    expansionLimit = 1000,
  } = options;

  console.log(
    `[IR-CART] Avvio ricerca prodotti | filtri=Illustration Rare < EUR 1, Ultra Rare < EUR 0.25 | quantity=${quantity} | dryRun=${dryRun} | expansionLimit=${expansionLimit}`,
  );

  let cartProductIds = new Set();
  try {
    await waitBeforeCardTraderRequest(delayMs, "getCart");
    console.log("[IR-CART] Lettura carrello corrente");
    const cartRes = await cardtraderService.getCart();
    cartProductIds = extractCartProductIds(cartRes?.data);
    console.log(
      `[IR-CART] Prodotti già presenti nel carrello: ${cartProductIds.size}`,
    );
  } catch (error) {
    console.error(
      "[IR-CART] Impossibile leggere il carrello corrente, continuo senza deduplica sul carrello:",
      error?.response?.data ?? error?.message ?? error,
    );
  }

  await waitBeforeCardTraderRequest(delayMs, "getExpansions");
  console.log("[IR-CART] Lettura espansioni CardTrader");
  const expansionsRes = await cardtraderService.getExpansions();
  const expansions = Array.isArray(expansionsRes?.data)
    ? expansionsRes.data
    : [];
  const pokemonExpansions = expansions.filter(
    (expansion) =>
      expansion?.game_id === POKEMON_GAME_ID &&
      !normalizeText(expansion?.name).includes("deck"),
  );
  const selectedExpansions = pokemonExpansions.slice(-expansionLimit);

  console.log(
    `[IR-CART] Espansioni totali=${expansions.length} | espansioni Pokemon senza deck=${pokemonExpansions.length} | ultime selezionate=${selectedExpansions.length}`,
  );

  const seenProductIds = new Set();
  const summary = {
    expansionsChecked: 0,
    blueprintsChecked: 0,
    candidateListings: 0,
    addedProducts: 0,
    skippedAlreadyInCart: 0,
    skippedDuplicatedInRun: 0,
    skippedInvalid: 0,
    skippedNoMatch: 0,
  };

  for (const expansion of selectedExpansions) {
    summary.expansionsChecked += 1;
    console.log(
      `[IR-CART] [Expansion ${summary.expansionsChecked}/${
        selectedExpansions.length
      }] ${expansion?.name ?? "n/a"} (#${expansion?.id ?? "n/a"})`,
    );

    await waitBeforeCardTraderRequest(
      delayMs,
      `getBlueprintsByExpansionId(${expansion.id})`,
    );
    const blueprintsRes = await cardtraderService.getBlueprintsByExpansionId(
      expansion.id,
    );
    const blueprints = Array.isArray(blueprintsRes?.data)
      ? blueprintsRes.data
      : [];
    const targetBlueprints = blueprints.filter(
      (blueprint) => getTargetBlueprintType(blueprint) !== null,
    );

    console.log(
      `[IR-CART] Blueprint trovati=${blueprints.length} | target rarity=${targetBlueprints.length}`,
    );

    if (targetBlueprints.length === 0) {
      continue;
    }

    await waitBeforeCardTraderRequest(
      delayMs,
      `getMarketplaceProductsByExpansionId(${expansion.id})`,
    );
    console.log(
      `[IR-CART] Scarico tutti i prodotti marketplace dell'espansione #${expansion.id}`,
    );
    const marketplaceRes =
      await cardtraderService.getMarketplaceProductsByExpansionId(expansion.id);
    const marketplaceByBlueprint =
      marketplaceRes?.data && typeof marketplaceRes.data === "object"
        ? marketplaceRes.data
        : {};

    for (const blueprint of targetBlueprints) {
      summary.blueprintsChecked += 1;
      const targetBlueprintType = getTargetBlueprintType(blueprint);
      const listings = Array.isArray(marketplaceByBlueprint[blueprint.id])
        ? marketplaceByBlueprint[blueprint.id]
        : [];

      console.log(
        `[IR-CART] Analizzo blueprint #${blueprint.id} | ${
          blueprint?.name ?? "n/a"
        } | rarity=${targetBlueprintType?.rarity ?? "n/a"} | listing=${
          listings.length
        }`,
      );

      const matchingListings = listings
        .filter((listing) => {
          const hasValidPrice = Number.isFinite(Number(listing?.price_cents));
          const hasQuantity = Number(listing?.quantity ?? 1) > 0;
          const canSellViaHub = listing?.user?.can_sell_via_hub === true;
          return (
            hasValidPrice &&
            hasQuantity &&
            canSellViaHub &&
            isNearMintJapaneseListing(listing) &&
            Number(listing.price_cents) < targetBlueprintType.maxPriceCents
          );
        })
        .sort((a, b) => a.price_cents - b.price_cents);

      if (matchingListings.length === 0) {
        summary.skippedNoMatch += 1;
        console.log(
          `[IR-CART] Nessun listing compatibile per blueprint #${blueprint.id}`,
        );
        continue;
      }

      console.log(
        `[IR-CART] Listing compatibili per blueprint #${blueprint.id}: ${
          matchingListings.length
        } | rarity=${
          targetBlueprintType?.rarity ?? "n/a"
        } | soglia=${formatEuroFromCents(targetBlueprintType?.maxPriceCents)}`,
      );

      for (const listing of matchingListings) {
        summary.candidateListings += 1;

        const productId = resolveCartProductId(listing);
        const listingId = Number(listing?.id);
        const priceCents = Number(listing?.price_cents);
        const seller = listing?.user?.username ?? "n/a";
        const viaCardTraderZero = Boolean(listing?.user?.can_sell_via_hub);

        if (!Number.isFinite(productId) || !Number.isFinite(priceCents)) {
          summary.skippedInvalid += 1;
          console.log(
            `[IR-CART] Skip listing non valido | blueprint=#${
              blueprint.id
            } | listingId=${listing?.id ?? "n/a"} | productId=${
              listing?.product_id ?? listing?.product?.id ?? "n/a"
            } | price=${listing?.price_cents ?? "n/a"}`,
          );
          continue;
        }

        if (seenProductIds.has(productId)) {
          summary.skippedDuplicatedInRun += 1;
          console.log(
            `[IR-CART] Skip prodotto già processato in questa esecuzione | productId=${productId}`,
          );
          continue;
        }

        if (cartProductIds.has(productId)) {
          summary.skippedAlreadyInCart += 1;
          seenProductIds.add(productId);
          console.log(
            `[IR-CART] Skip prodotto già presente nel carrello | productId=${productId} | listingId=${
              Number.isFinite(listingId) ? listingId : "n/a"
            } | seller=${seller} | price=${formatEuroFromCents(priceCents)}`,
          );
          continue;
        }

        console.log(
          `[IR-CART] Candidato | expansion=${
            expansion?.name ?? "n/a"
          } | blueprint=${blueprint?.name ?? "n/a"} | rarity=${
            targetBlueprintType?.rarity ?? "n/a"
          } | productId=${productId} | listingId=${
            Number.isFinite(listingId) ? listingId : "n/a"
          } | seller=${seller} | price=${formatEuroFromCents(
            priceCents,
          )} | ctZero=${viaCardTraderZero}`,
        );

        if (dryRun) {
          seenProductIds.add(productId);
          console.log(
            `[IR-CART] Dry run attivo, nessuna aggiunta eseguita | productId=${productId} | listingId=${
              Number.isFinite(listingId) ? listingId : "n/a"
            }`,
          );
          continue;
        }

        try {
          await waitBeforeCardTraderRequest(
            delayMs,
            `addProductToCart(${productId})`,
          );
          await cardtraderService.addProductToCart({
            productId,
            quantity,
            price: priceCents / 100,
            via_cardtrader_zero: viaCardTraderZero,
          });
          seenProductIds.add(productId);
          cartProductIds.add(productId);
          summary.addedProducts += 1;
          console.log(
            `[IR-CART] Aggiunto al carrello | productId=${productId} | listingId=${
              Number.isFinite(listingId) ? listingId : "n/a"
            } | seller=${seller} | price=${formatEuroFromCents(priceCents)}`,
          );
        } catch (error) {
          console.error(
            `[IR-CART] Errore aggiunta al carrello | productId=${productId} | listingId=${
              Number.isFinite(listingId) ? listingId : "n/a"
            }`,
            error?.response?.data ?? error?.message ?? error,
          );
        }
      }
    }
  }

  console.log(
    `[IR-CART] Fine esecuzione | expansions=${summary.expansionsChecked} | blueprints=${summary.blueprintsChecked} | candidateListings=${summary.candidateListings} | added=${summary.addedProducts} | alreadyInCart=${summary.skippedAlreadyInCart} | duplicatedInRun=${summary.skippedDuplicatedInRun} | invalid=${summary.skippedInvalid} | noMatchBlueprints=${summary.skippedNoMatch}`,
  );

  return summary;
};

exports.alignPrices = async () => {
  const exportRes = await cardtraderService.getMyProducts();
  const myItems = Array.isArray(exportRes?.data)
    ? exportRes.data //.filter((item) => item?.blueprint_id === TEST_BLUEPRINT_ID)
    : [];
  const totalItems = myItems.length;
  const rows = [];
  const marketplaceCache = new Map();
  let checkedItems = 0;
  let nextIndex = 0;

  function getCachedMarketplace(blueprintId) {
    if (!marketplaceCache.has(blueprintId)) {
      marketplaceCache.set(
        blueprintId,
        cardtraderService
          .getProduct(blueprintId)
          .then((product) => {
            const listings = Array.isArray(product?.data?.[blueprintId])
              ? product.data[blueprintId]
              : [];

            return listings.filter((listing) => {
              const hubOk = listing?.user?.can_sell_via_hub === true;
              const countryOk = !BLOCKED_COUNTRIES.has(
                listing?.user?.country_code,
              );
              return hubOk && countryOk;
            });
          })
          .catch((error) => {
            marketplaceCache.delete(blueprintId);
            throw error;
          }),
      );
    }

    return marketplaceCache.get(blueprintId);
  }

  function isEligibleLanguage(item) {
    return (
      item?.properties_hash?.pokemon_language === "jp" ||
      item?.properties_hash?.pokemon_language === "it"
    );
  }

  function filterListingsForItem(item, sourceListings) {
    if (item?.graded) return [];

    const itemCondition = getCondition(item?.properties_hash?.condition);
    let listings = sourceListings;

    if (itemCondition === "near mint") {
      return listings.filter(
        (listing) =>
          propertiesMatch(listing?.properties_hash, item?.properties_hash) &&
          gradedMatch(listing, item),
      );
    }

    listings = listings.filter(
      (listing) =>
        propertiesMatchWithoutCondition(
          listing?.properties_hash,
          item?.properties_hash,
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

  async function processItem(item) {
    if (item?.game_id !== POKEMON_GAME_ID || !isEligibleLanguage(item)) return;

    const blueprintId = item?.blueprint_id;
    if (!blueprintId) return;

    const myPriceCents = Number(item?.price_cents);
    const myNetCents = Number.isFinite(myPriceCents) ? myPriceCents : null;

    try {
      const cachedListings = await getCachedMarketplace(blueprintId);
      const listings = filterListingsForItem(item, cachedListings).sort(
        (a, b) => a.price_cents - b.price_cents,
      );

      if (listings.length === 0) return;

      const myListing =
        listings.find((listing) => listing?.user?.username === MY_USERNAME) ||
        null;
      const competitors = listings.filter(
        (listing) => listing?.user?.username !== MY_USERNAME,
      );

      if (competitors.length === 0) return;

      const bestCompetitor = competitors[0];
      const competitorNetCents = netPriceCents(bestCompetitor.price_cents);
      const targetNetCentsRaw =
        typeof competitorNetCents === "number"
          ? Math.max(2, competitorNetCents - 1)
          : null;
      const minPriceCents = minAllowedPriceCents(item);
      const targetNetCents =
        typeof targetNetCentsRaw === "number"
          ? Math.max(targetNetCentsRaw, minPriceCents)
          : null;

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
        try {
          await cardtraderService.updateProductPrice(item.id, targetNetCents);
        } catch (_err) {
          // Ignora errori di update per non bloccare il CSV.
        }
      }
    } catch (_err) {
      // Ignora errori per produrre solo il CSV finale.
    }
  }

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= totalItems) return;
      nextIndex += 1;

      checkedItems += 1;
      if (checkedItems % 50 === 0 || checkedItems === totalItems) {
        const percent =
          totalItems > 0
            ? ((checkedItems / totalItems) * 100).toFixed(2)
            : "0.00";
        const percentIt = percent.replace(".", ",");
        console.log(
          `[ALIGN-PRICE] ${checkedItems}/${totalItems} prezzi controllati, step: ${percentIt}%`,
        );
      }

      await processItem(myItems[currentIndex]);
    }
  }

  const workerCount = Math.max(
    1,
    Math.min(ALIGN_PRICE_WORKERS, totalItems || 1),
  );
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

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

  const outPath = path.join(__dirname, "..", "excel_export", "align-price.csv");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`[ALIGN-PRICE] CSV scritto in ${outPath}`);
};
