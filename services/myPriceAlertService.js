const { getDB } = require("../config/db");

async function clearMyPriceAlert(dbOptions = {}) {
  const db = await getDB(dbOptions);
  await db.collection("myErrorPriceAlert").deleteMany();
}

async function saveMyPriceAlert(alert, dbOptions = {}) {
  const db = await getDB(dbOptions);

  const { language, userID, productId, blueprintId, checked, ...rest } = alert;

  const result = await db.collection("myErrorPriceAlert").updateOne(
    {
      language,
      userID,
      productId,
      blueprintId,
    },
    { $setOnInsert: { ...rest, checked } },
    { upsert: true }
  );

  return !!result.upsertedCount;
}

module.exports = { saveMyPriceAlert, clearMyPriceAlert };
