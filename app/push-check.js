const output = document.querySelector("#result");
let localResult = "";
async function check() {
  try {
    const r = await navigator.serviceWorker.getRegistration("./");
    const cacheNames = (await caches.keys()).filter(k => k.startsWith("svitlo-pwa-"));
    const sub = await r?.pushManager.getSubscription();
    const notifications = (await r?.getNotifications()) || [];
    const receipt = await (
      await caches.match(new URL("push-receipt.json", location.href).href)
    )?.json();
    output.textContent = `Дозвіл: ${Notification.permission}\nФоновий модуль: ${r?.active?.state || "не активний"}\nОновлення: ${r?.waiting?.state || r?.installing?.state || "немає"}\nКеш: ${cacheNames.join(", ")}\nPush-підписка: ${sub ? "є" : "немає"}\nСтворені сповіщення: ${notifications.length}\n${notifications.map((n) => n.title).join("\n")}\nОстання подія push: ${receipt ? new Date(receipt.at).toLocaleString("uk-UA") + " · " + receipt.stage + " " + receipt.error : "не зафіксована"}\n${localResult}`;
  } catch (e) {
    output.textContent = "Перевірка недоступна: " + e.message;
  }
}
document.querySelector("#refresh").onclick = check;
document.querySelector("#local").onclick = async () => {
  try {
    const r = await navigator.serviceWorker.ready;
    await r.showNotification("Світло — перевірка показу", {
      body: "Локальна перевірка Chrome та системних налаштувань.",
      icon: new URL("icons/icon-192.png", location.href).href,
      tag: "svitlo-local-check",
    });
    localResult = "Локальний виклик showNotification: виконано без помилки";
    await check();
  } catch (e) {
    output.textContent = "Браузер не зміг створити повідомлення: " + e.message;
  }
};
check();

document.querySelector("#update").onclick = async () => { const r = await navigator.serviceWorker.getRegistration("./"); await r?.update(); await check(); };
