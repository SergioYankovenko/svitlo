import { rows } from "../app/lib/parsers.js";

export function providerQueue(root) {
  const hourly = rows(root.DISCONN_QUEUQ || []).map(r => r.QUEUE_INFO)
    .filter(s => typeof s === "string" && /погодин/i.test(s));
  const numbers = [...new Set(hourly.flatMap(s => [...s.matchAll(/([1-6])\s*черга\s*([12])\s*підчерга/gi)].map(m => m[1] + "." + m[2])))];
  const excluded = hourly.filter(s => /в\s+чергу\s+не\s+включено/i.test(s)).length;
  const unknown = hourly.filter(s => !/в\s+чергу\s+не\s+включено/i.test(s) && !/[1-6]\s*черга\s*[12]\s*підчерга/i.test(s)).length;
  if (numbers.length > 1 || (numbers.length && excluded)) return { queue: null, queueStatus: "ambiguous" };
  if (numbers.length === 1 && !unknown) return { queue: numbers[0], queueStatus: "matched" };
  if (hourly.length && excluded === hourly.length) return { queue: null, queueStatus: "not_in_queue", inclusion: "not_in_queue" };
  return { queue: null, queueStatus: numbers.length ? "partial_queue" : "queue_missing" };
}
