function extractBearerToken(authorizationHeader) {
  const value = String(authorizationHeader || "").trim();
  if (!value.toLowerCase().startsWith("bearer ")) return "";
  return value.slice(7).trim();
}

module.exports = function apiAuth(req, res, next) {
  const configuredApiKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (!configuredApiKey) return next();

  const providedApiKey =
    String(req.headers["x-api-key"] || "").trim() ||
    extractBearerToken(req.headers.authorization);

  if (providedApiKey !== configuredApiKey) {
    return res.status(401).json({
      error: "API key mancante o non valida.",
      requestId: req.requestId ?? null,
    });
  }

  return next();
};
