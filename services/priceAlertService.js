const { getDB } = require("../config/db");

async function clearPriceAlert(dbOptions = {}) {
  const db = await getDB(dbOptions);
  await db.collection("errorPriceAlert").deleteMany({ checked: false });
}

async function savePriceAlert(alert, dbOptions = {}) {
  const db = await getDB(dbOptions);

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

async function hasPriceAlertByBlueprintAndPrice(
  blueprintId,
  minorPrice,
  dbOptions = {},
) {
  if (blueprintId == null || minorPrice == null) return false;
  const db = await getDB(dbOptions);
  const existing = await db.collection("errorPriceAlert").findOne({
    blueprintId,
    minorPrice,
  });
  return !!existing;
}

module.exports = {
  savePriceAlert,
  clearPriceAlert,
  hasPriceAlertByBlueprintAndPrice,
};
