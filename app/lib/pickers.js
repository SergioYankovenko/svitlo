// Native <select> remains the form model; the visible control uses the app's themed dialog.
const controls = new Map();
export function enhancePickers(root = document) {
  for (const [select, entry] of controls) {
    if (!select.isConnected) {
      entry.observer.disconnect();
      controls.delete(select);
    }
  }
  for (const select of root.querySelectorAll("select")) {
    if (controls.has(select)) continue;
    const label = select.labels?.[0];
    const title = label?.firstChild?.textContent?.trim() || "Оберіть значення";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "picker-trigger";
    button.id = "picker-" + select.id;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    select.hidden = true;
    select.after(button);
    if (label && label !== select.parentElement) label.htmlFor = button.id;
    const sync = () => {
      const text = select.selectedOptions[0]?.textContent || "Оберіть…";
      button.textContent = text + " ▾";
      button.disabled = select.disabled;
      button.setAttribute("aria-label", title + ": " + text);
    };
    const observer = new MutationObserver(sync);
    observer.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    select.addEventListener("change", sync);
    button.onclick = () => choose(select, button, title);
    controls.set(select, { observer });
    sync();
  }
}
function choose(select, trigger, title) {
  const dialog = document.createElement("dialog");
  dialog.className = "picker-dialog";
  dialog.setAttribute("aria-label", title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dialog-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Закрити");
  close.onclick = () => dialog.close();
  const heading = document.createElement("h2");
  heading.textContent = title;
  dialog.append(close, heading);
  const options = [...select.options].filter((o) => o.value && !o.disabled);
  const list = document.createElement("div");
  list.className = "picker-list";
  const paint = (query = "") => {
    list.replaceChildren();
    for (const option of options.filter((o) =>
      o.textContent
        .toLocaleLowerCase("uk")
        .includes(query.toLocaleLowerCase("uk")),
    )) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "picker-option";
      item.textContent = option.textContent;
      item.setAttribute("aria-pressed", String(option.selected));
      item.onclick = () => {
        select.value = option.value;
        dialog.close();
        select.dispatchEvent(new Event("change", { bubbles: true }));
      };
      list.append(item);
    }
    if (!list.children.length) {
      const empty = document.createElement("p");
      empty.textContent = "Нічого не знайдено";
      list.append(empty);
    }
  };
  if (options.length > 8) {
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Пошук";
    search.setAttribute("aria-label", "Пошук у списку");
    search.oninput = () => paint(search.value.trim());
    dialog.append(search);
  }
  dialog.append(list);
  paint();
  document.body.append(dialog);
  trigger.setAttribute("aria-expanded", "true");
  dialog.addEventListener(
    "close",
    () => {
      trigger.setAttribute("aria-expanded", "false");
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    },
    { once: true },
  );
  list.onkeydown = (event) => {
    const items = [...list.querySelectorAll("button")],
      index = items.indexOf(document.activeElement);
    if (!items.length) return;
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      items[next].focus();
    }
  };
  dialog.showModal();
  (
    dialog.querySelector("input") ||
    list.querySelector('[aria-pressed="true"]') ||
    list.querySelector("button") ||
    close
  ).focus();
}
