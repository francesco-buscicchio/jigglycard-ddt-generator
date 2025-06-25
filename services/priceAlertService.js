const { getDB } = require("../config/db");

async function savePriceAlert(alert) {
  const db = await getDB();

  const { setName, blueprintName, language, userID, productId, blueprintId } =
    alert;

  const result = await db.collection("errorPriceAlert").updateOne(
    {
      setName,
      blueprintName,
      language,
      userID,
      productId,
      blueprintId,
    }, // filtro “unicità”
    { $setOnInsert: { ...alert } }, // dati da inserire solo se nuovo
    { upsert: true }
  );

  return !!result.upsertedCount; // true se ha inserito, false se già esisteva
}

module.exports = { savePriceAlert };
