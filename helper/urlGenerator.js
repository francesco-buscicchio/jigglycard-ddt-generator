const slugify = (txt) =>
  txt
    .toLowerCase()
    .replace(/'/g, "-") // sostituisce l’apostrofo con “-”
    .replace(/[^\w\s-]/g, "") // rimuove gli altri simboli speciali
    .replace(/\s+/g, "-") // spazi → “-”
    .replace(/-+/g, "-") // comprime multipli “-”
    .replace(/^-|-$/g, ""); // (opz.) toglie “-” in testa/coda

const normalizeVersion = (bp, pd) => {
  // usa blueprint.version o il collector_number del product
  const raw = bp.version || pd.properties_hash?.collector_number || "";
  return raw.replace("/", "-");
};

exports.buildCardLinks = (blueprint, product) => {
  const nameSlug = slugify(blueprint.name);
  const versionSlug = normalizeVersion(blueprint, product);
  const expansionName =
    blueprint.expansion?.name_en || product.expansion?.name_en || "";
  const expansionSlug = slugify(expansionName);

  const rarityRaw = blueprint.fixed_properties?.pokemon_rarity || "";
  const raritySlug = rarityRaw ? slugify(rarityRaw) : null;

  // link base
  const baseParts = [nameSlug, versionSlug, expansionSlug];
  const baseLink = "https://www.cardtrader.com/cards/" + baseParts.join("-");

  // link con rarità (se disponibile)
  const extendedLink = raritySlug
    ? `https://www.cardtrader.com/cards/${nameSlug}-${raritySlug}-${versionSlug}-${expansionSlug}`
    : baseLink;

  return [baseLink, extendedLink];
};
