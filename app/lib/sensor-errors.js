// Interpret public codes only; do not display arbitrary server details or QR proofs.
const messages={
  owner_qr_not_available:'Код недійсний або вже застарів. Відкрий новий QR на телефоні-датчику.',
  owner_qr_already_used:'Цей код уже використано. Відкрий новий QR на телефоні-датчику.',
  invalid_phone_packet:'Код датчика не підходить. Зчитай його ще раз або введи вручну.',
  invalid_sensor_packet:'Не вдалося перевірити код. Онови застосунок і спробуй ще раз.',
  sensor_not_available:'Датчик недоступний. Перевір актуальний QR на телефоні-датчику.',
  subscription_required:'Для підключення датчика потрібна підписка.',
  subscription_check_unavailable:'Не вдалося перевірити доступ. Спробуй трохи пізніше.',
  first_connection_requires_profile:'Спочатку вибери адресу для датчика.',
  profile_not_available:'Адреса недоступна. Вибери її знову.',
  profile_requires_reselection:'Для цієї адреси потрібно повторно вибрати будинок.',
  profile_line_not_available:'Лінія живлення цієї адреси недоступна. Перевір адресу.',
  profile_already_has_sensor:'До цієї лінії вже підключено датчик.',
  profile_already_linked:'До цієї адреси вже підключено датчик.',
  sensor_requires_explicit_relocation:'Датчик уже має точку вимірювання. Його не можна підключити до іншої адреси цим кодом.',
  viewer_requires_profile:'Спочатку вибери адресу для датчика.',
  viewer_sensor_mismatch:'Код не відповідає цьому датчику.',
  sensor_membership_limit:'Досягнуто ліміту підключених датчиків.',
  profile_limit:'Досягнуто ліміту адрес.',
  sensor_session_required:'Сеанс завершився. Відкрий застосунок знову.',
};
export function sensorConnectError(error){
  if(Object.hasOwn(messages,error?.code))return messages[error.code];
  if(error?.status===401)return 'Сеанс завершився. Відкрий застосунок знову.';
  if(error?.status===403)return 'Не вдалося підтвердити доступ. Онови застосунок і спробуй ще раз.';
  if(error?.status===429)return 'Забагато спроб. Зачекай і спробуй ще раз.';
  if(error?.name==='AbortError')return 'Сервер не відповів вчасно. Спробуй підтвердити ще раз.';
  return 'Не вдалося підключити датчик. Перевір зв’язок і спробуй ще раз.';
}
