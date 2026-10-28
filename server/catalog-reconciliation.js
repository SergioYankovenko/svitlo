import { registryMatch, normAddress } from "./queue-registry.js";
import confirmedAliases from "./catalog-aliases.js";
const addressKey = a => JSON.stringify([a.department, a.cityId ?? a.city_id, a.streetId ?? a.street_id, a.house]);

// Each revision is compared with the previously active PDF, never with a daily
// timestamp alone. Cosmetic reimports must not replace curated address evidence.
function matcher(version, now) {
  const houseSpecific = (version?.rules || []).some(r => r.houses?.length || r.excluded?.length);
  const cache = new Map();
  return address => {
    const key = JSON.stringify([normAddress(address.city), normAddress(address.street), houseSpecific ? address.house : "*"]);
    if (!cache.has(key)) cache.set(key, registryMatch(version, address, now));
    return cache.get(key);
  };
}

export function reconcileCatalog(rows, previous, next, now, aliases = confirmedAliases) {
  // The previous mapping remains comparison evidence at a season boundary, even
  // when its validity has just ended. It is never served as a current PDF.
  const previousTime = Math.min(now, Date.parse(previous.validUntil + "T00:00:00Z") - 86400000);
  const before = matcher(previous, previousTime), after = matcher(next, now);
  const overrides = [];
  const byKey = new Map(rows.map(row => [addressKey(row), row]));
  const aliasByKey = new Map(aliases.aliases.map(alias => [addressKey(alias.source), alias]));
  const counts = { changed: 0, carried: 0, needsReview: 0, unchanged: 0, service: 0 };
  for (const row of rows) {
    if (row.status === "service") { counts.service++; continue; }
    const address = { city: row.city, street: row.street, house: row.house };
    const alias = row.batch?.import_key === aliases.batchImportKey ? aliasByKey.get(addressKey(row)) : null;
    const target = alias && byKey.get(addressKey(alias.target));
    const aliasConflict = !!target && (target.status !== row.status || target.queue !== row.queue);
    const match = (lookup) => {
      const own = lookup(address);
      if (!target || aliasConflict) return own;
      const canonical = lookup({ city: target.city, street: target.street, house: target.house });
      if (own.status === "matched" && canonical.status === "matched" && own.queue !== canonical.queue)
        return { queue: null, status: "ambiguous" };
      return canonical.status === "matched" ? canonical : own;
    };
    const oldMatch = match(before), newMatch = match(after);
    const changed = oldMatch.status !== newMatch.status || oldMatch.queue !== newMatch.queue;
    const carry = !!row.override_registry_id;
    if (!changed && !carry && !aliasConflict) { counts.unchanged++; continue; }
    const numeric = row.status === "numeric";
    const supported = changed && numeric && newMatch.status === "matched"
      && ((oldMatch.status === "matched" && oldMatch.queue === row.queue) || row.is_estimate)
      && !row.evidence?.knownAccountExclusionsPreserved && !aliasConflict;
    const retained = !changed && carry;
    const needsReview = !supported && (changed || aliasConflict || row.evidence?.needsReview === true);
    const queue = supported ? newMatch.queue : row.queue;
    const isEstimate = supported ? false : numeric && (row.is_estimate || needsReview);
    const proof = supported || (retained && newMatch.status === "matched" && newMatch.queue === queue)
      ? { url: newMatch.url, page: newMatch.page, scope: newMatch.scope }
      : row.evidence?.pdf_mapping || null;
    overrides.push({
      department: row.department, city_id: row.city_id, street_id: row.street_id, house: row.house,
      status: row.status, queue, is_estimate: isEstimate,
      confidence: isEstimate ? (needsReview ? "low" : row.confidence) : null,
      evidence: {
        origin: supported ? "provider_pdf_change" : (needsReview ? "retained_pending_provider_review" : row.evidence?.origin),
        previous_queue: row.queue, previous_registry_id: previous.id,
        registry_id: next.id, needsReview,
        review_reason: aliasConflict ? "confirmed_alias_queue_disagreement" : needsReview ? (newMatch.status === "matched" ? "new_pdf_conflicts_with_address_evidence" : "changed_pdf_no_unique_address_match") : null,
        ...(target ? { alias_target: alias.target, alias_document: alias.document, alias_source: alias.sourceUrl } : {}),
        pdf_mapping: needsReview ? null : proof,
        address_reviewed_at: supported ? new Date(now).toISOString() : (row.evidence?.address_reviewed_at || row.batch?.reviewed_at),
      },
    });
    if (supported) counts.changed++;
    else if (needsReview) counts.needsReview++;
    else counts.carried++;
  }
  return { overrides, counts };
}

export async function catalogReconciliation(db, previous, next, now) {
  if (!previous || previous.id === next.id || !db.addressCatalogBatches) return null;
  const batches = [];
  for (const batch of await db.addressCatalogBatches()) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await db.addressCatalogPage(batch.id, offset);
      rows.push(...page);
      if (page.length < 1000) break;
    }
    if (rows.length !== batch.expected_total) throw Error("incomplete_address_catalog");
    const result = reconcileCatalog(rows, previous, next, now);
    batches.push({ batch_id: batch.id, total: rows.length, ...result });
  }
  return { previous_registry_id: previous.id, batches };
}
