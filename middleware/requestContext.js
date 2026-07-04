const { randomUUID } = require("crypto");

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return String(value ?? "").trim();
}

function getHeader(req, headerName) {
  return normalizeHeaderValue(req.headers[headerName]);
}

module.exports = function requestContext(req, res, next) {
  const requestId = req.requestId || randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const cardTraderToken = getHeader(req, "x-cardtrader-token");
  const mongodbUri = getHeader(req, "x-mongodb-uri");
  const mongoUri = getHeader(req, "x-mongo-uri");
  const dbName = getHeader(req, "x-db-name") || "CMS";
  const sofficeBinaryPath = getHeader(req, "x-soffice-binary-path");
  const cardTraderApiBaseUrl = getHeader(req, "x-cardtrader-api-base-url");
  const shopifyShop = getHeader(req, "x-shopify-shop");
  const shopifyAccessToken = getHeader(req, "x-shopify-access-token");
  const shopifyApiVersion = getHeader(req, "x-shopify-api-version");

  req.requestContext = {
    requestId,
    requestEnv: {
      cardTraderToken,
      mongodbUri,
      mongoUri,
      effectiveMongoUri: mongodbUri || mongoUri,
      dbName,
      sofficeBinaryPath,
      cardTraderApiBaseUrl,
      shopifyShop,
      shopifyAccessToken,
      shopifyApiVersion,
    },
  };

  return next();
};
