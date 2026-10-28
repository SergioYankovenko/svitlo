import { clock, duration } from './time.js';
import { isOutage } from './schedule.js';

// Use exact, day-clipped segments; display rounding may hide a short outage.
export function canShareDay(state) {
  return !!state?.hours?.some(hour => hour.segments.some(segment =>
    isOutage(segment.kind) && segment.end > segment.start));
}

export function preferences(value = {}) {
  return { schedule: value.schedule !== false,
    publication: (value.publication ?? value.schedule) !== false,
    change: (value.change ?? value.schedule) !== false,
    emergency: value.emergency !== false, reminder: value.reminder !== false,
    restoration: value.restoration !== false,
    lead: [5,15,30,60].includes(+value.lead) ? +value.lead : 30 };
}
export function dateLabel(date, capital = false) {
  const [y,m,d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return '';
  const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
  const month = months[m-1];
  return month ? `${d} ${capital ? month[0].toUpperCase()+month.slice(1) : month}` : '';
}
export function messageTitle(m) {
  if (m.kind !== 'schedule' || m.special || /скас|непевн|уточн|невизнач/i.test(m.title || '')) return m.title;
  return `Графік на ${dateLabel(m.date)}${(m.revisionType === 'change' || !m.revisionType && /оновлен/i.test(m.title||'')) ? ' оновлено' : ''}`;
}
export function notificationBody(p) {
  return p.snapshot?.queue ? `Підчерга ${p.snapshot.queue}` : p.address?.city || 'Ваша адреса';
}
export function reminderTitle(restore, target) {
  return `${restore ? 'Очікуване відновлення' : 'Відключення'} о ${clock(target)}`;
}
export function shareText(snapshot, date, state) {
  return [`Графік · ${dateLabel(date,true)}${snapshot.queue ? ' · Черга '+snapshot.queue : ''}`,
    state.totals ? `Зі світлом: ${duration(state.totals.on)}\nБез світла: ${duration(state.totals.off)}` : 'Немає точних даних',
    state.events.map(e => clock(e.start)+'–'+(e.end ? (clock(e.end)==='00:00' ? '24:00' : clock(e.end)) : '?')).join(', '),
    '-----------------', 'Встановити собі', 'https://sergioyankovenko.github.io/svitlo/'].join('\n');
}
