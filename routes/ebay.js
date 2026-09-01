const express = require("express");
const ebayService = require("../services/ebayService");
const ebaySyncService = require("../services/ebaySyncService");

const router = express.Router();

// Wrapper per gestire in modo uniforme gli errori degli handler async.
function asyncHandler(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      console.error(
        `[EBAY] Errore requestId=${req.requestId ?? "n/a"} su ${req.method} ${req.originalUrl}:`,
        error.message,
      );
      res.status(error.status && error.status >= 400 ? 502 : 500).json({
        error: error.message,
        details: error.details ?? null,
        requestId: req.requestId ?? null,
      });
    });
  };
}

// --- Stato e autenticazione ---

router.get("/status", (_req, res) => {
  res.json(ebayService.getConnectionStatus());
});

router.get(
  "/auth/url",
  asyncHandler(async (_req, res) => {
    res.json({ url: ebayService.buildAuthUrl() });
  }),
);

// Callback OAuth (se l'accepted URL della RuName punta a questo server).
router.get(
  "/auth/callback",
  asyncHandler(async (req, res) => {
    const code = String(req.query.code || "").trim();
    if (!code) {
      return res.status(400).send("Codice di autorizzazione mancante.");
    }

    await ebayService.exchangeAuthCode(code);
    res.send(
      "<html><body style='font-family:sans-serif'><h2>Account eBay collegato ✔</h2><p>Puoi chiudere questa pagina e tornare all'interfaccia.</p></body></html>",
    );
  }),
);

// Inserimento manuale del codice (o dell'URL completo di redirect).
router.post(
  "/auth/code",
  asyncHandler(async (req, res) => {
    let code = String(req.body?.code || "").trim();
    if (!code) {
      return res.status(400).json({ error: "Campo 'code' mancante." });
    }

    // Accetta anche l'URL completo incollato dal browser.
    if (code.includes("code=")) {
      try {
        const parsed = new URL(code);
        code = parsed.searchParams.get("code") ?? code;
      } catch {
        const match = code.match(/code=([^&\s]+)/);
        if (match) code = decodeURIComponent(match[1]);
      }
    }

    await ebayService.exchangeAuthCode(code);
    res.json({ connected: true });
  }),
);

router.post("/auth/disconnect", (_req, res) => {
  ebayService.disconnect();
  res.json({ connected: false });
});

// --- Impostazioni ---

router.get("/settings", (_req, res) => {
  res.json(ebayService.getSettings());
});

router.put("/settings", (req, res) => {
  const allowedKeys = [
    "fulfillmentPolicyId",
    "paymentPolicyId",
    "returnPolicyId",
    "merchantLocationKey",
    "categoryId",
    "conditionOverride",
    "defaultImageUrl",
    "descriptionFooter",
    "markupPercent",
  ];

  const patch = {};
  for (const key of allowedKeys) {
    if (key in (req.body ?? {})) patch[key] = req.body[key];
  }

  res.json(ebayService.saveSettings(patch));
});

// Policy di vendita + sedi, per popolare i menu della UI.
router.get(
  "/policies",
  asyncHandler(async (_req, res) => {
    const [fulfillment, payment, returns, locations] = await Promise.all([
      ebayService.getFulfillmentPolicies(),
      ebayService.getPaymentPolicies(),
      ebayService.getReturnPolicies(),
      ebayService.getInventoryLocations(),
    ]);

    res.json({
      fulfillmentPolicies: fulfillment.map((policy) => ({
        id: policy.fulfillmentPolicyId,
        name: policy.name,
      })),
      paymentPolicies: payment.map((policy) => ({
        id: policy.paymentPolicyId,
        name: policy.name,
      })),
      returnPolicies: returns.map((policy) => ({
        id: policy.returnPolicyId,
        name: policy.name,
      })),
      locations: locations.map((location) => ({
        key: location.merchantLocationKey,
        name: location.name ?? location.merchantLocationKey,
      })),
    });
  }),
);

// Crea una sede di spedizione minimale (richiesta da eBay per pubblicare).
router.post(
  "/locations",
  asyncHandler(async (req, res) => {
    const {
      key = "magazzino-principale",
      name = "Magazzino principale",
      city,
      postalCode,
      country = "IT",
    } = req.body ?? {};

    if (!city || !postalCode) {
      return res
        .status(400)
        .json({ error: "Campi 'city' e 'postalCode' obbligatori." });
    }

    await ebayService.createInventoryLocation(key, {
      name,
      location: {
        address: { city, postalCode, country },
      },
      merchantLocationStatus: "ENABLED",
      locationTypes: ["WAREHOUSE"],
    });

    res.json({ merchantLocationKey: key });
  }),
);

// --- Override per prodotto (modifiche da UI: prezzo, titolo, descrizione…) ---

const OVERRIDE_FIELDS = ["price", "title", "description", "imageUrl", "quantity", "excluded"];

router.get("/overrides", (_req, res) => {
  res.json(ebayService.getOverrides());
});

// Merge di override per uno o più prodotti. Un valore null cancella il campo;
// un prodotto con valore null viene reimpostato ai valori generati.
router.put("/overrides", (req, res) => {
  const incoming = req.body?.overrides;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ error: "Campo 'overrides' mancante." });
  }

  const sanitized = {};
  for (const [productId, value] of Object.entries(incoming)) {
    if (value === null) {
      sanitized[productId] = null;
      continue;
    }
    if (typeof value !== "object") continue;

    const cleanValue = {};
    for (const field of OVERRIDE_FIELDS) {
      if (field in value) cleanValue[field] = value[field];
    }
    sanitized[productId] = cleanValue;
  }

  res.json(ebayService.saveOverrides(sanitized));
});

// --- Inventario e pubblicazione ---

router.get(
  "/inventory",
  asyncHandler(async (req, res) => {
    // Senza parametro vale il ricarico di default delle Impostazioni.
    const markupPercent =
      req.query.markupPercent === undefined
        ? undefined
        : Number(req.query.markupPercent) || 0;
    const force = req.query.force === "true";
    const items = await ebaySyncService.getInventoryPreview({
      markupPercent,
      force,
    });
    res.json({ total: items.length, items });
  }),
);

// Dettaglio prodotto: anteprima completa dell'annuncio (titolo, descrizione,
// foto, item specifics) con i valori generati e gli override correnti.
router.get(
  "/inventory/:productId/preview",
  asyncHandler(async (req, res) => {
    const markupPercent =
      req.query.markupPercent === undefined
        ? undefined
        : Number(req.query.markupPercent) || 0;
    const detail = await ebaySyncService.getProductDetail(req.params.productId, {
      markupPercent,
    });
    res.json(detail);
  }),
);

// --- Confronto prezzi con i competitor ---

router.get(
  "/inventory/:productId/compare",
  asyncHandler(async (req, res) => {
    const outcome = await ebaySyncService.compareProduct(req.params.productId);
    res.json(outcome);
  }),
);

router.post(
  "/compare",
  asyncHandler(async (req, res) => {
    const { productIds } = req.body ?? {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: "Campo 'productIds' mancante o vuoto." });
    }
    if (productIds.length > 50) {
      return res.status(400).json({
        error: "Massimo 50 prodotti per confronto (rate limit eBay).",
      });
    }
    const outcome = await ebaySyncService.compareProducts(productIds);
    res.json(outcome);
  }),
);

// --- Storico pubblicazioni ---

router.get("/published", (_req, res) => {
  res.json(ebayService.getPublishedHistory());
});

// Ricostruisce lo storico leggendo le offerte reali dall'account eBay.
router.post(
  "/published/sync",
  asyncHandler(async (_req, res) => {
    const outcome = await ebaySyncService.syncPublishedFromEbay();
    res.json(outcome);
  }),
);

router.post(
  "/publish",
  asyncHandler(async (req, res) => {
    const {
      productIds,
      markupPercent,
      priceOverrides = {},
      skipPublished = true,
    } = req.body ?? {};

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res
        .status(400)
        .json({ error: "Campo 'productIds' mancante o vuoto." });
    }
    if (productIds.length > 200) {
      return res.status(400).json({
        error: "Massimo 200 prodotti per richiesta di pubblicazione.",
      });
    }

    const outcome = await ebaySyncService.publishProducts(productIds, {
      markupPercent,
      priceOverrides,
      skipPublished,
    });
    res.json(outcome);
  }),
);

router.get(
  "/offers",
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const offers = await ebaySyncService.getPublishedOffers({ limit });
    res.json({ total: offers.length, offers });
  }),
);

router.post(
  "/offers/:offerId/withdraw",
  asyncHandler(async (req, res) => {
    const { offerId } = req.params;
    const { sku, deleteItem = false } = req.body ?? {};
    const outcome = await ebaySyncService.removeListing({
      offerId,
      sku,
      deleteItem,
    });
    res.json(outcome);
  }),
);

module.exports = router;
