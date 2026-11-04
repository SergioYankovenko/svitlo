"use strict";
// REF-01: shared, deterministic product decisions. No DOM, network or platform permissions.
window.SvitloPolicy = (() => {
  const copy = {
    cityIntro: [
      "Давай я допоможу налаштувати «Світло».",
      "Допоможу налаштувати «Світло».",
    ],
    cityQuestion: [
      "Як називається твоє місто чи село?",
      "Яке твоє місто чи село?",
    ],
    additionalIntro: [
      "Радий знову тебе бачити! Додамо ще одну адресу.",
      "Додамо ще одну адресу.",
    ],
    additionalQuestion: [
      "У якому місті чи селі вона знаходиться?",
      "Як називається місто чи село?",
    ],
    summary: [
      "Тут підсумки дня: скільки часу зі світлом і без нього.",
      "Тут час зі світлом і без нього за день.",
    ],
    graph: [
      "Ось тут живе твій графік. Обирай день угорі.",
      "Тут твій графік. Обирай день угорі.",
    ],
    address: [
      "Натисни адресу, щоб відкрити список. Через олівець там можна змінити назву або видалити адресу.",
      "Натисни адресу: у списку обирай, перейменовуй чи видаляй через олівець.",
    ],
    support: [
      "Ми раді допомагати тобі! Якщо хочеш, можеш підтримати й нас.",
      "Раді допомагати тобі! Можеш підтримати й нас.",
    ],
    shareCopy: [
      "Тут можеш скопіювати графік і надіслати його у Viber чи інший застосунок.",
      "Скопіюй графік і надішли у Viber чи інший застосунок.",
    ],
    privacyAndroid: [
      "Я не використовую GPS. Список твоїх адрес зберігаю на телефоні. Для пошуку графіка звертаюся до Обленерго та сервера «Світло».",
      "Я не використовую GPS. Адреси зберігаю на телефоні, а для пошуку звертаюся до Обленерго та сервера «Світло».",
    ],
    privacyPwa: [
      "Я не використовую GPS. Твої адреси зберігаю на сервері «Світло», а на пристрої залишаю офлайн-копію. Якщо ввімкнеш сповіщення, збережу й підписку.",
      "Я не використовую GPS. Адреси зберігаю на сервері «Світло», а офлайн-копію на пристрої. Якщо увімкнеш сповіщення, збережу й підписку.",
    ],
  };
  const compact = (font = 1, width = 414) => font >= 1.5 || width / font < 340;
  function text(id, state = {}, width = 414) {
    if (!copy[id]) throw new Error("Unknown copy decision: " + id);
    return copy[id][compact(Number(state.font) || 1, width) ? 1 : 0];
  }
  function dateAllowed(date, today, publication) {
    if (
      !window.SvitloClock.validDate(date) ||
      !window.SvitloClock.validDate(today)
    )
      return false;
    const d = window.SvitloClock.date(today);
    d.setUTCDate(d.getUTCDate() + 1);
    return (
      date === today ||
      publication !== "unpublished" ||
      date === window.SvitloClock.key(d)
    );
  }
  // Unknown/network-error is not confirmed absence. Adapters must preserve that distinction.
  function tourIds({ count, graph, summary, share }) {
    if (!count) return [];
    return [
      count === 1 ? "add" : "address",
      ...(graph ? ["week"] : []),
      ...(summary ? ["summary"] : []),
      ...(share ? ["share"] : []),
      "messages",
      "options",
    ];
  }
  function supportMigrate(saved, legacy = false) {
    if (!saved || saved.version !== 1)
      return {
        version: 1,
        clicked: false,
        hint: legacy ? "legacy" : "unseen",
        days: [],
        lastDate: null,
      };
    return {
      ...saved,
      clicked: saved.clicked === true,
      days: [
        ...new Set((Array.isArray(saved.days) ? saved.days : []).filter(window.SvitloClock.validDate)),
      ].slice(-3),
    };
  }
  function activeDay(support, date) {
    if (!window.SvitloClock.validDate(date) || support.lastDate === date)
      return;
    support.lastDate = date;
    if (!support.days.includes(date))
      support.days = [...support.days, date].slice(-3);
  }
  const supportEligible = (support, context) =>
    !support.clicked &&
    support.hint === "unseen" &&
    support.days.length >= 3 &&
    context.home &&
    context.visible &&
    !context.blocked;
  function summary(schedule, observation = null, preferActual = false) {
    const measured = observation?.available && observation.covered > 0;
    if (measured && (preferActual || schedule.publication !== "published")) {
      return {
        source: "device_observation", caption: "за фактом",
        partial: observation.unknown > 0, on: observation.on, off: observation.off,
        coverage: observation.covered, through: observation.through,
      };
    }
    if (schedule.publication === "published") {
      const partial = schedule.unknown > 0;
      const total = schedule.total ?? schedule.clear + schedule.out + schedule.unknown;
      const round = n => Math.max(0, Math.min(total, Math.round(n / 30) * 30));
      //183: round the union once; complement only a complete known day.
      const off = partial ? null : round(schedule.out);
      return {
        source: "official_schedule",
        caption: "за графіком",
        partial,
        on: partial ? (schedule.clear ? round(schedule.clear) : null) : total - off,
        off,
      };
    }
    return null;
  }
  return Object.freeze({
    text,
    compact,
    dateAllowed,
    tourIds,
    supportMigrate,
    activeDay,
    supportEligible,
    copy,
    summary,
  });
})();
