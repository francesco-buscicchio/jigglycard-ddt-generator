const { getDB } = require("../config/db");

async function clearMyPriceAlert() {
  const db = await getDB();
  await await db.collection("myErrorPriceAlert").deleteMany({ checked: false });
}

async function saveMyPriceAlert(alert) {
  const db = await getDB();

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
