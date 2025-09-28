const cardtraderService = require("../services/cardTraderService.js");
const expansionsToIgnore = require("../helper/expansionsToIgnore.js");
const {
  savePriceAlert,
  clearPriceAlert,
} = require("../services/priceAlertService");
const { buildCardLinks } = require("../helper/urlGenerator.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    if (item.game_id !== 15 && item.game_id !== 5 && item.game_id !== 9)
      continue;
    await sleep(1000);
    const bluesprints = await cardtraderService.getBlueprintsByExpansionId(
      item.id
    );
    const blueprintsData = bluesprints.data;

    for (let blueprint of blueprintsData) {
      try {
        await sleep(1000);
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

          // Logica attuale
          await checkPriceDifferenceStandard(item, blueprint, lang, list);

          // Nuova logica US/CA vs EU
          await checkPriceDifferenceUSvsEU(item, blueprint, lang, list);
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
    });
  }
}
