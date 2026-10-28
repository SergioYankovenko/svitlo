// Wire categories remain hourly/planned/emergency for existing clients.
export const OUTAGE_TYPES_VERSION = 1;
export const categoryPriority = { emergency: 3, planned: 2, hourly: 1 };
export const eventKind = e =>
  e?.category === 'planned' && e.unplanned === true ? 'unplanned' : e?.category;
// Only nonempty legacy planned results may have lost DISCONN_TYPE. A successful
// new parse marks the category even when elapsed history can no longer be fetched.
export const needsOutageTypes = snapshot => {
  const c = snapshot?.categories?.planned;
  return !!c && c.outageTypesVersion !== OUTAGE_TYPES_VERSION &&
    !!c.events?.some(e => e.category === 'planned' && typeof e.unplanned !== 'boolean');
};
