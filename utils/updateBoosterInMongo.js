const { getDB } = require("../config/db");
const { createCardTraderService } = require("../services/cardTraderService");
const { sleep, throwIfAborted } = require("./abort");

function mapBoosterData(booster) {
  return {
    id: booster.id,
    name: booster.name,
    expansion_id: booster.expansion,
    cardmarket_id: booster.card_market_ids.length
      ? booster.card_market_ids[0]
      : 0,
    image_url: booster.image_url,
  };
}

async function insertBoosterInMongo(boosterJP, runtimeConfig = {}) {
  const db = await getDB({
    mongoUri: runtimeConfig.mongoUri,
    mongodbUri: runtimeConfig.mongodbUri,
    dbName: runtimeConfig.dbName,
  });
  const collection = db.collection("booster_jp");

  if (boosterJP.length === 0) {
    return { scanned: 0, inserted: 0 };
  }

  const bulkOperations = boosterJP.map((item) => ({
    updateOne: {
      filter: { id: item.id },
      update: { $setOnInsert: item },
      upsert: true,
    },
  }));

  const result = await collection.bulkWrite(bulkOperations, { ordered: false });
  const inserted = Number(result.upsertedCount) || 0;

  console.log(`✅ Booster JP inseriti in MongoDB: ${inserted}`);
  return { scanned: boosterJP.length, inserted };
}

async function updateBooster(runtimeConfig = {}) {
  const cardTrader = createCardTraderService(runtimeConfig);
  const signal = runtimeConfig.signal;

  const boosterJp = [];
  throwIfAborted(signal, "Update booster annullato.");
  const expansions = (await cardTrader.getExpansions()).data;
  const pokemonExpansions = expansions.filter((value) => value.game_id === 5);

  for (const expansion of pokemonExpansions) {
    throwIfAborted(signal, "Update booster annullato.");
    await sleep(500, signal);
    const blueprints = (await cardTrader.getBlueprintsByExpansionId(expansion.id))
      .data;

    const filteredBoosters = blueprints.filter((value) => {
      if (value.category_id !== 66) return false;
      if (!Array.isArray(value.editable_properties)) return false;

      const langProp = value.editable_properties.find(
        (property) => property.name === "pokemon_language",
      );

      return langProp?.possible_values?.includes("jp");
    });

    for (const booster of filteredBoosters) {
      boosterJp.push(mapBoosterData(booster));
    }
  }

  const mongoResult = await insertBoosterInMongo(boosterJp, runtimeConfig);
  return {
    expansionsChecked: pokemonExpansions.length,
    boostersFound: boosterJp.length,
    ...mongoResult,
  };
}

module.exports = { updateBooster };
