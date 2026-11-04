"use strict";
//201: shared display decisions. LAB event transport/permission adapters stay elsewhere.
((root) => {
  const merge = (rows) => rows.reduce((out, row) => {
    const last = out.at(-1);
    if (last && last.end === row.start && last.state === row.state && last.kind === row.kind) last.end = row.end;
    else out.push({...row});
    return out;
  }, []);
  function timeline({start, end, plan, actual, through, factEnabled = true}) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const limit = Math.max(start, Math.min(end, through));
    const facts = []; let cursor = start;
    for (const row of actual || []) {
      const from = Math.max(cursor, start, row.start), to = Math.min(end, limit, row.end);
      if (to <= from || !["on", "off"].includes(row.state)) continue;
      if (from > cursor) facts.push({start:cursor, end:from, state:"unknown"});
      facts.push({start:from, end:to, state:row.state}); cursor = to;
    }
    if (cursor < limit) facts.push({start:cursor, end:limit, state:"unknown"});
    if (limit < end) facts.push({start:limit, end, state:"future"});
    const transitions = (actual || []).slice(1).flatMap((row, i) => {
      const previous = actual[i];
      return previous.end === row.start && previous.state !== row.state &&
        ["on","off"].includes(previous.state) && ["on","off"].includes(row.state) &&
        row.start >= start && row.start < end && row.start <= through
        ? [{at:row.start, state:row.state}] : [];
    });
    return {plan:merge(plan), fact:factEnabled ? merge(facts) : [{start,end,state:"disabled"}],
      transition:factEnabled ? transitions.at(-1) || null : null,
      now:through >= start && through < end ? through : null};
  }
  const noticeTypes = Object.freeze({
    off:{title:"Світло зникло", body:"За даними датчика", state:"off"},
    on:{title:"Світло з’явилося", body:"За даними датчика", state:"on"},
    lost:{title:"Зв’язок із датчиком втрачено", body:"Перевір пристрій і з’єднання", state:"unknown"},
  });
  const transitionType = (before, after) => ["on","off"].includes(before) && ["on","off"].includes(after)
    ? before === after ? null : after
    : ["on","off"].includes(before) && after === "offline" ? "lost" : null;
  const noticeEligible = (event, {now, member, enabled, entitled}) => Object.hasOwn(noticeTypes,event?.type) &&
    member && enabled && entitled && Number.isFinite(event.at) && event.at <= now && event.at > now - 7 * 86400000;
  function verifiedDistrict(row) {
    const metadata = row?.district;
    return metadata?.verified === true && typeof metadata.source === "string" && metadata.source.trim() &&
      typeof metadata.name === "string" && metadata.name.trim().length <= 120
      ? metadata.name.trim() : "";
  }
  //204: bindings are one-to-one within this installation. Authorization belongs to the server.
  function bindingCheck(addresses, profiles, addressId, sensorId) {
    const ids = new Set(addresses.map(row => row.id));
    const entries = Object.entries(profiles).filter(([id, p]) => ids.has(id) && p && p.state !== "none");
    if (!ids.has(addressId)) return "address";
    if (entries.some(([id]) => id === addressId)) return "occupied";
    if (entries.length >= 10) return "limit";
    if (entries.some(([, p]) => p.sensorId === sensorId)) return "duplicate";
    return null;
  }
  const api = {merge, timeline, noticeTypes, transitionType, noticeEligible, verifiedDistrict, bindingCheck};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SvitloDeviceUI = api;
})(typeof window === "undefined" ? globalThis : window);
