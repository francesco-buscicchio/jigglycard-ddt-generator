const cardtraderService = require("../services/cardTraderService.js");
const expansionsToIgnore = require("../helper/expansionsToIgnore.js");
const { saveProduct } = require("../services/productService.js");
const {
  savePriceAlert,
  clearPriceAlert,
} = require("../services/priceAlertService");
const {
  saveMyPriceAlert,
  clearMyPriceAlert,
} = require("../services/myPriceAlertService");
const { buildCardLinks } = require("../helper/urlGenerator.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.copyProductsCardtrader = async () => {
  const expansions = (await cardtraderService.getExpansions()).data;
  await sleep(2000);
  const categories = (await cardtraderService.getCategories()).data;
  await sleep(2000);
  for (let expansion of expansions) {
    if (
      expansion.game_id !== 5 &&
      expansion.game_id !== 9 &&
      expansion.game_id !== 15
    )
      continue;

    const bluesprints = (
      await cardtraderService.getBlueprintsByExpansionId(expansion.id)
    ).data;

    await sleep(2000);

    for (let blueprint of bluesprints) {
      const category = categories.filter((val) => {
        return val.id === blueprint.category_id;
      });

      const productData = {
        id: blueprint.id,
        name: blueprint.name,
        cardmarket_id:
          blueprint.card_market_ids.length > 0
            ? blueprint.card_market_ids[0]
            : 0,
        category_id: category[0].id,
        category_name: category[0].name,
        game_id: category[0].game_id,
        image_url: blueprint.image_url,
        expansion_code: expansion.code,
        expansion_name: expansion.name,
        rarity:
          blueprint.game_id === 5
            ? blueprint.fixed_properties.pokemon_rarity
            : blueprint.game_id === 9
            ? blueprint.fixed_properties.dragonball_rarity
            : blueprint.fixed_properties.onepiece_rarity,
      };

      await saveProduct(productData);
    }
  }
};

exports.sniffCardtraderProducts = async () => {
  await clearPriceAlert();
  const expansions = await cardtraderService.getExpansions();
  const expansionsData = expansions.data;
  for (let item of expansionsData) {
    const expansionsToIgnoreList =
      expansionsToIgnore.getExpansionsToNotIgnore();

    if (
      !expansionsToIgnoreList.filter((val) => {
        return val.id == item.id && val.game_id == item.game_id;
      }).length > 0
    ) {
      console.log(
        `Ignoring expansion: ${item.name}, ID: ${item.id}, GameID: ${item.game_id}`
      );
      continue;
    }
    console.log(
      `Processing expansion: ${item.name}, ID: ${item.id}, GameID: ${item.game_id}`
    );
    // Prende in considerazione solo i set di carte di Pokemon e One Piece
    if (
      //item.game_id !== 15 &&
      item.game_id !== 5
      //&& item.game_id !== 9
    )
      continue;
    await sleep(500);
    const bluesprints = await cardtraderService.getBlueprintsByExpansionId(
      item.id
    );
    const blueprintsData = bluesprints.data;

    for (let blueprint of blueprintsData) {
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
      try {
        await sleep(500);
        const product = await cardtraderService.getProduct(blueprint.id);
        let productData = product.data[blueprint.id];
        productData = productData.filter((val) => {
          return (
            val.user.can_sell_via_hub == true &&
            val.properties_hash.condition === "Near Mint"
          );
        });
        if (productData.length < 2) continue;

        const allowedLang = ["it", "jp", "jap", "en"];
        const groups = new Map();

        for (const prod of productData) {
          const p = prod.properties_hash ?? {};
          const lang =
            allowedLang.find(
              (l) =>
                l === p.language ||
                l === p.pokemon_language ||
                l === p.onepiece_language ||
                l === p.dragonball_language
            ) ?? null;

          if (!lang) continue;
          if (!groups.has(lang)) groups.set(lang, []);
          groups.get(lang).push(prod);
        }

        for (const [lang, list] of groups) {
          list.sort((a, b) => a.price_cents - b.price_cents);

          if (list.length < 2) continue;

          await checkPriceDifferenceStandard(item, blueprint, lang, list);
          await checkPriceDifferenceUSvsEU(item, blueprint, lang, list);
          await checkLowPriceByRarity(item, blueprint, lang, list, [
            { name: "Illustration Rare", maxPrice: 51 },
            { name: "Double Rare", maxPrice: 15 },
            { name: "Triple Rare", maxPrice: 15 },
            { name: "Rare Holo V", maxPrice: 15 },
            { name: "Shiny Holo Rare", maxPrice: 30 },
            { name: "Secret Rare", maxPrice: 50 },
          ]);
        }
      } catch (error) {
        console.error(
          `Error processing blueprint ${blueprint.id} for expansion ${item.id}:`,
          error
        );
      }
    }
  }
};

exports.checkMyProductsAgainstMarket = async () => {
  await clearMyPriceAlert();
  const exportRes = await cardtraderService.getMyProducts();
  const myItems = Array.isArray(exportRes?.data) ? exportRes.data : [];

  for (const item of myItems) {
    try {
      await sleep(2000);

      const blueprintId = item.blueprint_id;
      const myPrice = item.price_cents;

      const product = await cardtraderService.getProduct(blueprintId);
      let listings = product?.data?.[blueprintId] || [];

      // Filtri standard
      listings = listings.filter((l) => {
        const hubOk = l?.user?.can_sell_via_hub === true;
        const countryOk =
          l?.user?.country_code !== "US" &&
          l?.user?.country_code !== "CA" &&
          l?.user?.country_code !== "NZ";

        return hubOk && countryOk;
      });

      if (listings.length === 0) continue;

      listings.sort((a, b) => a.price_cents - b.price_cents);

      const myProduct = listings.filter(
        (l) => l?.user?.username === "Jigglycard"
      )[0];
      const others = listings.filter(
        (l) =>
          l?.user?.username !== "Jigglycard" &&
          l?.graded === myProduct.graded &&
          l?.properties_hash.pokemon_language ===
            myProduct.properties_hash.pokemon_language &&
          l?.properties_hash.condition == myProduct.properties_hash.condition
      );
      if (others.length === 0) continue;

      const othersBest = others[0];
      const diffCents = othersBest.price_cents - myProduct.price_cents;

      if (Math.abs(diffCents) >= 1) {
        // lingua calcolata con la logica allowedLang
        const allowedLang = ["it", "jp", "jap", "en"];
        const p = item.properties_hash ?? {};
        const lang =
          allowedLang.find(
            (l) =>
              l === p.language ||
              l === p.pokemon_language ||
              l === p.onepiece_language ||
              l === p.dragonball_language
          ) ?? null;

        console.log(
          `[MY-GAP] ${item?.expansion_name ?? ""} - ${
            item?.blueprint_name ?? ""
          } | lang=${lang ?? "n/a"} | mine=${myPrice} vs other=${
            othersBest.price_cents
          } (+${diffCents}c)`
        );

        await saveMyPriceAlert({
          setName: item?.expansion_name ?? "",
          blueprintName: item?.name_en ?? "",
          language: lang,
          minorPrice: myProduct.price_cents,
          secondPrice: othersBest.price_cents,
          productId: item?.id,
          blueprintId: blueprintId,
          userID: othersBest?.user?.id,
          tcgID: item?.game_id ?? null,
          collector_number: item?.properties_hash?.collector_number ?? null,
          timestamp: new Date(),
          checked: false,
        });
      }
    } catch (err) {
      console.error(
        `Errore su blueprint ${item?.blueprint_id} (mio prodotto id ${item?.id}):`,
        err
      );
    }
  }
};

// 1) Primo vs secondo prezzo
async function checkPriceDifferenceStandard(item, blueprint, lang, list) {
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
    await savePriceAlert({
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
    });
  }
}

// 2) Primo americano/canadese vs primo europeo
async function checkPriceDifferenceUSvsEU(item, blueprint, lang, list) {
  // Divido prodotti in gruppi
  const usCa = list.filter(
    (p) =>
      p.user.country_code === "US" ||
      p.user.country_code === "CA" ||
      p.user.country_code === "NZ"
  );
  const eu = list.filter(
    (p) =>
      p.user.country_code !== "US" ||
      p.user.country_code === "CA" ||
      p.user.country_code === "NZ"
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
    await savePriceAlert({
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
    });
  }
}

// Controllo generico su rarità con prezzo sotto soglia
async function checkLowPriceByRarity(item, blueprint, lang, list, configList) {
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
        await savePriceAlert({
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
        });

        console.log(
          `[LOW-PRICE-RARITY] ${item.name} - ${blueprint.name} | lang=${lang} | rarità=${rarity} | prezzo=${prod.price_cents}c`
        );
      }
    }
  }
}
