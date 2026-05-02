const { createCardTraderService } = require("../services/cardTraderService.js");
const expansionsToIgnore = require("../helper/expansionsToIgnore.js");
const {
  savePriceAlert,
  clearPriceAlert,
  hasPriceAlertByBlueprintAndPrice,
} = require("../services/priceAlertService");
const { buildCardLinks } = require("../helper/urlGenerator.js");
const { sleep, throwIfAborted } = require("../utils/abort");

const ALLOWED_LANGS = ["it", "jp", "jap", "en"];
const GRADED_PRICE_THRESHOLD_CENTS = 1500;

function detectListingLanguage(listing) {
  const p = listing?.properties_hash ?? {};
  return (
    ALLOWED_LANGS.find(
      (l) =>
        l === p.language ||
        l === p.pokemon_language ||
        l === p.onepiece_language ||
        l === p.dragonball_language,
    ) ?? null
  );
}

async function logGradedLowPrice(item, blueprint, listing, dbOptions = {}) {
  if (!listing?.graded) return;
  if (typeof listing.price_cents !== "number") return;
  if (listing.price_cents > GRADED_PRICE_THRESHOLD_CENTS) return;

  const alreadyExists = await hasPriceAlertByBlueprintAndPrice(
    blueprint?.id ?? null,
    listing.price_cents,
    dbOptions,
  );
  if (alreadyExists) return;

  const lang = detectListingLanguage(listing);
  await savePriceAlert(
    {
      setName: item?.name ?? "",
      blueprintName: blueprint?.name ?? "",
      language: lang,
      minorPrice: listing.price_cents,
      secondPrice: null,
      productId: listing?.id ?? null,
      blueprintId: blueprint?.id ?? null,
      userID: listing?.user?.id ?? null,
      tcgID: item?.game_id ?? null,
      urls: buildCardLinks(blueprint, listing),
      collector_number: listing?.properties_hash?.collector_number ?? null,
      timestamp: new Date(),
      checked: false,
      type: "Gradata a meno di 15 euro",
    },
    dbOptions,
  );
  console.log(
    `[GRADED-UNDER-15] ${item?.name ?? ""} - ${blueprint?.name ?? ""} | lang=${
      lang ?? "n/a"
    } | price=${listing.price_cents}c | seller=${
      listing?.user?.username ?? "n/a"
    } | id=${listing?.id ?? "n/a"}`,
  );
}

exports.sniffCardtraderProducts = async (runtimeConfig = {}) => {
  const cardtraderService = createCardTraderService(runtimeConfig);
  const dbOptions = {
    mongoUri: runtimeConfig.mongoUri,
    mongodbUri: runtimeConfig.mongodbUri,
    dbName: runtimeConfig.dbName,
  };
  const signal = runtimeConfig.signal;

  await clearPriceAlert(dbOptions);
  throwIfAborted(signal, "Sniffer CardTrader annullato.");
  const expansions = await cardtraderService.getExpansions();
  const expansionsData = expansions.data;
  let processedExpansions = 0;
  let processedBlueprints = 0;
  for (let item of expansionsData) {
    throwIfAborted(signal, "Sniffer CardTrader annullato.");
    const expansionsToIgnoreList =
      expansionsToIgnore.getExpansionsToNotIgnore();

    if (
      !expansionsToIgnoreList.filter((val) => {
        return val.id == item.id && val.game_id == item.game_id;
      }).length > 0
    ) {
      console.log(
        `Ignoring expansion: ${item.name}, ID: ${item.id}, GameID: ${item.game_id}`,
      );
      continue;
    }
    console.log(
      `Processing expansion: ${item.name}, ID: ${item.id}, GameID: ${item.game_id}`,
    );
    // Prende in considerazione solo i set di carte di Pokemon e One Piece
    if (
      //item.game_id !== 15 &&
      item.game_id !== 5
      //&& item.game_id !== 9
    )
      continue;
    processedExpansions += 1;
    await sleep(500, signal);
    const bluesprints = await cardtraderService.getBlueprintsByExpansionId(
      item.id,
    );
    const blueprintsData = bluesprints.data;

    for (let blueprint of blueprintsData) {
      throwIfAborted(signal, "Sniffer CardTrader annullato.");
      const rarity =
        blueprint.game_id === 5
          ? blueprint.fixed_properties.pokemon_rarity
          : blueprint.game_id === 9
          ? blueprint.fixed_properties.dragonball_rarity
          : blueprint.fixed_properties.onepiece_rarity;

      if (
        !rarity ||
        rarity.toLowerCase() === "common" ||
        rarity.toLowerCase() === "uncommon" ||
        rarity.toLowerCase() === "rare" ||
        rarity.toLowerCase() === "holo rare" ||
        rarity.toLowerCase() === "fixed"
      )
        continue;
      processedBlueprints += 1;
      try {
        await sleep(500, signal);
        const product = await cardtraderService.getProduct(blueprint.id);
        let productData = product.data[blueprint.id];
        productData = productData.filter((val) => {
          return (
            val.user.can_sell_via_hub == true &&
            val.properties_hash.condition === "Near Mint"
          );
        });
        for (const listing of productData) {
          await logGradedLowPrice(item, blueprint, listing, dbOptions);
        }

        if (productData.length < 2) continue;

        const groups = new Map();

        for (const prod of productData) {
          const lang = detectListingLanguage(prod);

          if (!lang) continue;
          if (!groups.has(lang)) groups.set(lang, []);
          groups.get(lang).push(prod);
        }

        for (const [lang, list] of groups) {
          list.sort((a, b) => a.price_cents - b.price_cents);

          if (list.length < 2) continue;

          await checkPriceDifferenceStandard(
            item,
            blueprint,
            lang,
            list,
            dbOptions,
          );
          await checkPriceDifferenceUSvsEU(
            item,
            blueprint,
            lang,
            list,
            dbOptions,
          );
          await checkLowPriceByRarity(item, blueprint, lang, list, [
            { name: "Illustration Rare", maxPrice: 51 },
            { name: "Double Rare", maxPrice: 15 },
            { name: "Triple Rare", maxPrice: 15 },
            { name: "Rare Holo V", maxPrice: 15 },
            { name: "Shiny Holo Rare", maxPrice: 30 },
            { name: "Secret Rare", maxPrice: 50 },
          ], dbOptions);
        }
      } catch (error) {
        console.error(
          `Error processing blueprint ${blueprint.id} for expansion ${item.id}:`,
          error,
        );
      }
    }
  }

  return {
    processedExpansions,
    processedBlueprints,
  };
};

// 1) Primo vs secondo prezzo
async function checkPriceDifferenceStandard(
  item,
  blueprint,
  lang,
  list,
  dbOptions = {},
) {
  list.sort((a, b) => a.price_cents - b.price_cents);

  if (list.length < 2) return;

  const [first, second] = list;
  const minorPrice = first.price_cents;
  const secondPrice = second.price_cents;
  const minorPriceAlert = minorPrice * 1.4;

  if (secondPrice - minorPriceAlert < 5) return;
  if (secondPrice - minorPrice < 100) return;

  // Caso speciale per reverse Pokémon
  if (
    item.game_id === 5 &&
    first.properties_hash.pokemon_reverse !==
      second.properties_hash.pokemon_reverse
  )
    return;

  if (minorPriceAlert < secondPrice) {
    const alreadyExists = await hasPriceAlertByBlueprintAndPrice(
      blueprint?.id ?? null,
      minorPrice,
      dbOptions,
    );
    if (alreadyExists) return;

    await savePriceAlert(
      {
        setName: item.name,
        blueprintName: blueprint.name,
        language: lang,
        minorPrice,
        secondPrice,
        productId: first.id,
        blueprintId: blueprint.id,
        userID: list[0].user.id,
        tcgID: item.game_id,
        urls: buildCardLinks(blueprint, list[0]),
        collector_number: first.properties_hash.collector_number,
        timestamp: new Date(),
        checked: false,
        type: "standard",
      },
      dbOptions,
    );
  }
}

// 2) Primo americano/canadese vs primo europeo
async function checkPriceDifferenceUSvsEU(
  item,
  blueprint,
  lang,
  list,
  dbOptions = {},
) {
  // Divido prodotti in gruppi
  const usCa = list.filter(
    (p) =>
      p.user.country_code === "US" ||
      p.user.country_code === "CA" ||
      p.user.country_code === "NZ",
  );
  const eu = list.filter(
    (p) =>
      p.user.country_code !== "US" ||
      p.user.country_code === "CA" ||
      p.user.country_code === "NZ",
  );

  if (usCa.length === 0 || eu.length === 0) return;

  // ordino per prezzo
  usCa.sort((a, b) => a.price_cents - b.price_cents);
  eu.sort((a, b) => a.price_cents - b.price_cents);

  const firstUSCA = usCa[0];
  const firstEU = eu[0];

  const minorPrice = firstUSCA.price_cents;
  const secondPrice = firstEU.price_cents;
  const minorPriceAlert = minorPrice * 1.4;

  if (secondPrice - minorPriceAlert < 5) return;
  if (secondPrice - minorPrice < 100) return;

  if (
    item.game_id === 5 &&
    firstUSCA.properties_hash.pokemon_reverse !==
      firstEU.properties_hash.pokemon_reverse
  )
    return;

  if (minorPriceAlert < secondPrice) {
    const alreadyExists = await hasPriceAlertByBlueprintAndPrice(
      blueprint?.id ?? null,
      minorPrice,
      dbOptions,
    );
    if (alreadyExists) return;

    await savePriceAlert(
      {
        setName: item.name,
        blueprintName: blueprint.name,
        language: lang,
        minorPrice,
        secondPrice,
        productId: firstUSCA.id,
        blueprintId: blueprint.id,
        userID: firstUSCA.user.id,
        tcgID: item.game_id,
        urls: buildCardLinks(blueprint, firstUSCA),
        collector_number: firstUSCA.properties_hash.collector_number,
        timestamp: new Date(),
        checked: false,
        type: "America vs Europe",
      },
      dbOptions,
    );
  }
}

// Controllo generico su rarità con prezzo sotto soglia
async function checkLowPriceByRarity(
  item,
  blueprint,
  lang,
  list,
  configList,
  dbOptions = {},
) {
  const prod = list[0];
  const rarity =
    prod.properties_hash?.pokemon_rarity ??
    prod.properties_hash?.onepiece_rarity ??
    prod.properties_hash?.dragonball_rarity ??
    null;

  if (!rarity) return;

  const rarityLower = rarity.toLowerCase();

  for (const config of configList) {
    // es: { name: "Illustration Rare", maxPrice: 51 }
    if (rarityLower === config.name.toLowerCase()) {
      if (prod.price_cents < config.maxPrice) {
        const alreadyExists = await hasPriceAlertByBlueprintAndPrice(
          blueprint?.id ?? null,
          prod.price_cents,
          dbOptions,
        );
        if (alreadyExists) return;

        await savePriceAlert(
          {
            setName: item.name,
            blueprintName: blueprint.name,
            language: lang,
            minorPrice: prod.price_cents,
            secondPrice: list[1].price_cents,
            productId: prod.id,
            blueprintId: blueprint.id,
            userID: prod.user.id,
            tcgID: item.game_id,
            urls: buildCardLinks(blueprint, prod),
            collector_number: prod.properties_hash?.collector_number ?? null,
            timestamp: new Date(),
            checked: false,
            type: `Rarità "${config.name}" sotto ${config.maxPrice / 100}€`,
          },
          dbOptions,
        );

        console.log(
          `[LOW-PRICE-RARITY] ${item.name} - ${blueprint.name} | lang=${lang} | rarità=${rarity} | prezzo=${prod.price_cents}c`,
        );
      }
    }
  }
}
