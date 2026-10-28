export function enrollmentKey(address) {
  const values = [address?.department, address?.cityId, address?.streetId, address?.house];
  if (values.some(v => typeof v !== "string" || !v || v.length > 120)) return null;
  return JSON.stringify(values);
}
export async function enrollmentProof(owner, address) {
  const input = JSON.stringify([owner, enrollmentKey(address), address.account || "", address.city, address.street]);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))), b => b.toString(16).padStart(2,"0")).join("");
}
export function preparedSnapshot(value) {
  if (!value?.categories || value.failures?.length !== 0 || !Number.isFinite(value.checkedAt)) return null;
  const { categories, failures, errors, queue, checkedAt } = value;
  return { categories, failures, errors, queue, checkedAt };
}
