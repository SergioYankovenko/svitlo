"use strict";
// PWA-SENSOR-ICONS-01: approved26px vector family, currentColor, no status inference.
window.SvitloSensorIcons=(()=>{
const plug="<path d=\"M8 3V8M16 3V8M6 8H18V13A6 6 0 0 1 6 13ZM12 19V22\"/>";
const states=[
  {
    "id": "sensor",
    "label": "Датчик",
    "kind": "Основна форма",
    "tone": "accent",
    "mark": "",
    "note": "Та сама вертикальна вилка, що в застосунку датчика."
  },
  {
    "id": "powered",
    "label": "Від мережі",
    "kind": "Як на твоєму зразку",
    "tone": "accent",
    "mark": "<circle cx=\"21\" cy=\"21\" r=\"2.35\" fill=\"currentColor\" stroke=\"none\"/>",
    "note": "Вилка з крапкою зі зразка. Цей варіант означає живлення, а не підтвердження прив’язки."
  },
  {
    "id": "connect",
    "label": "Підключити",
    "kind": "Дія · плюс",
    "tone": "accent",
    "mark": "<path d=\"M21 18.5v5M18.5 21h5\"/>",
    "note": "Дія підключення датчика до адреси."
  },
  {
    "id": "disconnect",
    "label": "Від’єднати",
    "kind": "Дія · мінус",
    "tone": "danger",
    "mark": "<path d=\"M18.5 21h5\"/>",
    "note": "Дія від’єднання датчика від адреси."
  },
  {
    "id": "connected",
    "label": "Підключено",
    "kind": "Стан · підтвердження",
    "tone": "accent",
    "mark": "<path d=\"m18.2 20.7 1.8 1.8 3.3-3.8\"/>",
    "note": "Прив’язку підтверджено; це не висновок про наявність електрики."
  },
  {
    "id": "waiting",
    "label": "Очікує підключення",
    "kind": "Стан · очікування",
    "tone": "muted",
    "mark": "<path d=\"M19.3 18.8a1.7 1.7 0 0 1 3.3.5c0 1-1.6 1.2-1.6 1.8\"/><circle cx=\"21\" cy=\"23\" r=\".6\" fill=\"currentColor\" stroke=\"none\"/>",
    "note": "Датчик ще очікує прив’язки. У телефоні його підтверджене живлення може залишатися зеленим."
  },
  {
    "id": "connecting",
    "label": "Підключення",
    "kind": "Стан · триває перевірка",
    "tone": "accent",
    "mark": "<path class=\"progress\" d=\"M21 18.5a2.5 2.5 0 1 1-2.5 2.5\"/>",
    "note": "Запит виконується. Підтвердження успіху ще немає."
  },
  {
    "id": "offline",
    "label": "Немає зв’язку",
    "kind": "Стан · сигнал втрачено",
    "tone": "muted",
    "mark": "<circle cx=\"21\" cy=\"21\" r=\"2.35\"/><path d=\"m19.35 22.65 3.3-3.3\"/>",
    "note": "Прив’язка залишається; свіжий сигнал відсутній. Це не означає відключення електрики."
  },
  {
    "id": "warning",
    "label": "Потрібна увага",
    "kind": "Стан · помилка",
    "tone": "warning",
    "mark": "<path d=\"M21 18.2v3\"/><circle cx=\"21\" cy=\"23\" r=\".6\" fill=\"currentColor\" stroke=\"none\"/>",
    "note": "Причину проблеми пояснює текст поруч."
  },
  {
    "id": "paused",
    "label": "Призупинено",
    "kind": "Стан · пауза",
    "tone": "muted",
    "mark": "<path d=\"M19.6 18.5v5m2.8-5v5\"/>",
    "note": "Надсилання даних призупинено."
  }
];
const sensorIcon=function icon(id,decorative=true){
 const state=states.find(s=>s.id===id)||states[0];
 return `<svg xmlns="http://www.w3.org/2000/svg" class="svitlo-sensor-icon svitlo-sensor-icon--${state.id}" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${decorative?'aria-hidden="true" focusable="false"':`role="img" aria-label="${state.label}"`}><g transform="translate(1 1)">${plug}${state.mark}</g></svg>`;
};

return {states,sensorIcon};
})();

// Keep the approved prototype typography/pager module unchanged; adapt only sensor glyphs.
(()=>{
 const ui=window.SvitloNativeUI,base=ui.icon;
 ui.sensorIcon=(state='sensor',cls='')=>window.SvitloSensorIcons.sensorIcon(state).replace('class="','class="glyph native-glyph '+cls+' ');
 ui.icon=(name,cls='')=>name==='sensor'?ui.sensorIcon('sensor',cls):base(name,cls);
})();
