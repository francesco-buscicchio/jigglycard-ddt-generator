const { getDB } = require("../config/db");

async function savePriceAlert(alert) {
  const db = await getDB();

  const { language, userID, productId, blueprintId, checked, ...rest } = alert;

  const result = await db.collection("errorPriceAlert").updateOne(
    {
      language,
      userID,
      productId,
      blueprintId,
    }, // filtro di unicità
    { $setOnInsert: { ...rest, checked } }, // inserisce solo se nuovo
    { upsert: true }
  );

  return !!result.upsertedCount; // true se ha inserito, false se già esisteva
}

module.exports = { savePriceAlert };
