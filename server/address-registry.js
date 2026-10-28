const validKey = (a) => a && ["department", "cityId", "streetId", "house"].every(
  (k) => typeof a[k] === "string" && a[k].length > 0 && a[k].length <= 120,
);

export async function addressRecord(db, address) {
  if (!validKey(address) || !db.addressQueue) return null;
  return db.addressQueue(address);
}

export function catalogAddress(record) {
  if (!record || record.status === "service") return null;
  return {
    department: record.department,
    cityId: record.city_id,
    streetId: record.street_id,
    house: record.house,
    city: record.city,
    street: record.street,
    label: `${record.city}, ${record.street}, ${record.house}`,
  };
}

export function addressResolution(record, registry, now = Date.now()) {
  if (!record) return null;
  const meta = {
    addressRegistryVersion: record.batch.import_key,
    decisionSource: record.evidence?.origin || "curated_address_registry",
    estimated: record.is_estimate === true,
    confidence: record.confidence || null,
    addressReviewedAt: record.evidence?.address_reviewed_at || record.batch.reviewed_at,
    ...(record.evidence?.needsReview ? { needsReview: true, reviewReason: record.evidence.review_reason } : {}),
  };
  if (record.status !== "numeric") return {
    queue: null,
    status: "not_found",
    inclusion: record.status === "not_in_queue" ? "not_in_queue" : "service",
    ...meta,
  };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(now);
  const document = registry?.documents?.find((d) => d.queue === record.queue);
  if (!document || registry.validFrom > today || registry.validUntil < today)
    return { queue: null, status: "unavailable", ...meta };
  // Existing Android builds require this legacy transport tag and a real queue PDF.
  // The PDF defines the queue, not this address allocation. Preserve the actual
  // decision provenance separately; never manufacture a PDF address citation.
  return {
    queue: record.queue,
    status: "matched",
    source: "official_registry",
    scope: record.evidence?.pdf_mapping?.scope || "house",
    url: document.url,
    page: record.evidence?.pdf_mapping?.page || 1,
    referenceRole: record.evidence?.pdf_mapping ? "address_mapping" : "queue_definition_only",
    version: `addresses:${record.batch.import_key}:${registry.id}`,
    validUntil: registry.validUntil,
    checkedAt: now,
    ...meta,
  };
}
