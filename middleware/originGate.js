const DEFAULT_ALLOWED_PROD_HOSTS = ["vemlora.com", "www.vemlora.com"];
const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "Idempotency-Key",
  "x-api-key",
  "x-cardtrader-token",
  "x-mongodb-uri",
  "x-mongo-uri",
  "x-db-name",
  "x-soffice-binary-path",
  "x-cardtrader-api-base-url",
  "x-shopify-shop",
  "x-shopify-access-token",
  "x-shopify-api-version",
];
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function allowAllOrigins() {
  return process.env.ALLOW_ALL_ORIGINS === "true";
}

function parseAllowedHosts() {
  const rawHosts = process.env.ALLOWED_PROD_ORIGINS;
  if (!rawHosts) return DEFAULT_ALLOWED_PROD_HOSTS;

  return rawHosts
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function setCorsHeaders(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
  res.setHeader("Vary", "Origin");
}

module.exports = function originGate(req, res, next) {
  const origin = req.headers.origin;

  if (!isProduction() || allowAllOrigins()) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    return next();
  }

  if (!origin) {
    return res.status(403).json({
      error: "Origin mancante. In produzione sono accettate solo richieste da vemlora.com.",
    });
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return res.status(403).json({ error: "Origin non valida." });
  }

  const allowedHosts = parseAllowedHosts();
  const originHost = parsedOrigin.hostname.toLowerCase();
  const isAllowed = allowedHosts.includes(originHost);

  if (!isAllowed) {
    return res.status(403).json({
      error: `Origin non autorizzata: ${origin}`,
    });
  }

  setCorsHeaders(res, origin);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
};
