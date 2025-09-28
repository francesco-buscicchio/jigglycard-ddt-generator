import axios from "axios";
import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGODB_URI;
const CARDTRADER_API_BASE_URL = process.env.CARDTRADER_API_BASE_URL;
const CARDTRADER_TOKEN = process.env.CARDTRADER_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const headers = {
  headers: {
    Authorization: `Bearer ${CARDTRADER_TOKEN}`,
  },
};

const mapBoosterData = (booster) => {
  return {
    id: booster.id,
    name: booster.name,
    expansion_id: booster.expansion,
    cardmarket_id: booster.card_market_ids.length
      ? booster.card_market_ids[0]
      : 0,
    image_url: booster.image_url,
  };
};

const insertBoosterInToMongo = async (boosterJP) => {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    const db = client.db("CMS");
    const collection = db.collection("booster_jp");
    await collection.deleteMany({});
    await collection.insertMany(boosterJP);

    console.log("✅ Booster JP inseriti in MongoDB!");
  } catch (err) {
    console.error("❌ Errore MongoDB:", err);
  } finally {
    await client.close();
  }
};

const getExpansions = async () => {
  const url = `${CARDTRADER_API_BASE_URL}/expansions`;
  const result = await axios.get(url, headers);
  return result;
};

const getBlueprintsByExpansionId = async (expansion_id) => {
  const url = `${CARDTRADER_API_BASE_URL}/blueprints/export?expansion_id=${expansion_id}`;
  const result = await axios.get(url, headers);
  return result;
};

export const updateBooster = async () => {
  const boosterJp = [];
  const expansions = (await getExpansions()).data;

  const pkm_expansion = expansions.filter((val) => val.game_id === 5);

  for (let expansion of pkm_expansion) {
    await sleep(1000);
    const blueprints = (await getBlueprintsByExpansionId(expansion.id)).data;

    const filterBooster = blueprints.filter((val) => {
      if (val.category_id !== 66) return false;
      if (!Array.isArray(val.editable_properties)) return false;

      const langProp = val.editable_properties.find(
        (p) => p.name === "pokemon_language"
      );

      return langProp?.possible_values?.includes("jp");
    });

    if (filterBooster.length > 0) {
      for (let booster of filterBooster)
        boosterJp.push(mapBoosterData(booster));
    }
  }

  insertBoosterInToMongo(boosterJp);
};
