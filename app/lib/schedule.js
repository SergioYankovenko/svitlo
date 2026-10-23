import { civil, dayKey, addDays, fresh, monday } from "./time.js";
export function emergencyPolicy(data, now) {
  const commands = (data?.emergencies || [])
    .filter(
      (x) =>
        (!x.queues.length || x.queues.includes(data.queue)) &&
        x.effectiveAt <= now &&
        x.publishedAt <= now + 300000,
    )
    .sort(
      (a, b) => b.effectiveAt - a.effectiveAt || b.publishedAt - a.publishedAt,
    );
  const command = commands[0];
  if (!command) return { active: false, validity: "active" };
  const active =
    !command.ended &&
    fresh(data.feedCheckedAt, now) &&
    data.feedCheckedAt >= command.publishedAt &&
    now <
      (command.until ??
        Math.max(command.effectiveAt, command.publishedAt) + 7200000);
  let validity = command.validity;
  if (command.ended && validity === "unknown") {
    const prior = commands.find((x) => !x.ended);
    validity = prior?.validity === "suspended" ? "suspended" : "active";
  }
  return { active, validity, command };
}
export function dayState(data, date, now = Date.now()) {
  const from = civil(date),
    until = civil(addDays(date, 1)),
    plan = data?.plans?.find((x) => x.date === date && x.queue === data.queue),
    policy = emergencyPolicy(data, now);
  let validity = policy.validity;
  if (
    plan &&
    !plan.uncertain &&
    plan.publishedAt > (policy.command?.publishedAt || 0)
  )
    validity = "active";
  const categories = data?.categories || {};
  const complete =
    ["hourly", "planned", "emergency"].every(
      (k) =>
        fresh(categories[k]?.checkedAt, now) &&
        categories[k]?.sourceAt &&
        !data?.failures?.includes(k),
    ) &&
    fresh(data?.feedCheckedAt, now) &&
    !data?.feedFailed;
  let events = Object.values(categories)
    .flatMap((x) => x.events || [])
    .filter((x) => x.start < until && (x.end === null || x.end > from));
  if (plan && !plan.uncertain)
    events = [...events.filter((x) => x.category !== "hourly"), ...plan.events];
  const known = plan
    ? !plan.uncertain
    : complete &&
      (date === dayKey(now) ||
        events.some((x) => x.category === "hourly" && x.end));
  if (validity !== "active")
    events = events
      .filter(
        (x) =>
          x.category !== "hourly" ||
          x.start < Math.min(now, policy.command?.effectiveAt ?? now),
      )
      .map((x) =>
        x.category === "hourly"
          ? {
              ...x,
              end: Math.min(x.end ?? now, policy.command?.effectiveAt ?? now),
            }
          : x,
      );
  const open = events.some((x) => x.end === null && x.start <= now);
  const uncertain = !known || validity !== "active" || open;
  const stale = !complete;
  const hours = [];
  for (let t = from; t < until; t += 3600000) {
    const end = Math.min(t + 3600000, until),
      bounds = new Set([t, end]);
    for (const e of events) {
      if (e.start > t && e.start < end) bounds.add(e.start);
      const eEnd = e.end ?? now;
      if (eEnd > t && eEnd < end) bounds.add(eEnd);
    }
    if (now > t && now < end) bounds.add(now);
    const b = [...bounds].sort((a, b) => a - b),
      segments = [];
    for (let i = 0; i < b.length - 1; i++) {
      const s = b[i],
        e = b[i + 1],
        matches = events
          .filter((x) => x.start < e && (x.end ?? now) > s)
          .sort(
            (a, b) =>
              ({ emergency: 3, planned: 2, hourly: 1 })[b.category] -
              { emergency: 3, planned: 2, hourly: 1 }[a.category],
          );
      segments.push({
        start: s,
        end: e,
        kind: matches[0]?.category || (uncertain ? "unknown" : "clear"),
      });
    }
    hours.push({ start: t, end, segments });
  }
  const lost = hours
    .flatMap((x) => x.segments)
    .filter((x) => ["hourly", "planned", "emergency"].includes(x.kind))
    .reduce((n, x) => n + (x.end - x.start) / 60000, 0);
  return {
    date,
    plan,
    policy: { ...policy, validity },
    hours,
    events,
    known,
    uncertain,
    stale,
    available:
      !!plan || events.length > 0 || (date === dayKey(now) && complete),
    totals: uncertain ? null : { off: lost, on: (until - from) / 60000 - lost },
  };
}
export function canNextWeek(data, now) {
  const next = addDays(monday(dayKey(now)), 7);
  return !!data?.plans?.some(
    (p) => p.date === next && p.queue === data.queue && !p.uncertain,
  );
}
export function countdown(data, now) {
  const state = dayState(data, dayKey(now), now);
  if (state.events.some((x) => x.start <= now && x.end === null))
    return { label: "Час відновлення уточнюється" };
  if (state.uncertain || state.stale)
    return { label: "Час відключень уточнюється" };
  const tomorrow = dayState(data, addDays(dayKey(now), 1), now),
    events = [...state.events, ...(!tomorrow.uncertain ? tomorrow.events : [])]
      .filter((x) => x.end > now)
      .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const e of events) {
    const last = merged.at(-1);
    if (last && e.start <= last.end) last.end = Math.max(last.end, e.end);
    else merged.push({ ...e });
  }
  const current = merged.find((x) => x.start <= now && x.end > now);
  if (current)
    return {
      label: "До відновлення",
      target: current.end,
      minutes: Math.ceil((current.end - now) / 60000),
    };
  const next = merged.find((x) => x.start > now);
  return next
    ? {
        label: "До відключення",
        target: next.start,
        minutes: Math.ceil((next.start - now) / 60000),
      }
    : { label: "Не заплановано" };
}
