'use strict';
const shotDialog = document.getElementById('shot-dialog');
const shotImage = document.getElementById('shot-image');
const shotTitle = document.getElementById('shot-title');
document.querySelectorAll('[data-shot]').forEach(link => {
  link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || typeof shotDialog.showModal !== 'function') return;
    event.preventDefault();
    shotImage.src = link.href;
    shotImage.alt = link.querySelector('img')?.alt || link.dataset.caption;
    shotTitle.textContent = link.dataset.caption;
    shotDialog.showModal();
  });
});
document.getElementById('close-shot').addEventListener('click', () => shotDialog.close());
shotDialog.addEventListener('click', event => {
  if (event.target !== shotDialog) return;
  const box = shotDialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) shotDialog.close();
});


// Preview controls change only the screenshot, leaving device preferences to the app.
document.querySelectorAll('[data-preview-theme]').forEach(button => {
  button.addEventListener('click', () => {
    const theme = button.dataset.previewTheme;
    const label = theme === 'light' ? 'Світла' : 'Темна';
    const preview = document.getElementById('theme-preview');
    const image = document.getElementById('theme-image');
    const source = `assets/android-${theme}-1.5.7.png`;
    image.src = source;
    image.alt = `${label} тема Світло: вибір адреси та погодинний графік`;
    preview.href = source;
    preview.dataset.caption = `${label} тема · Світло`;
    document.querySelectorAll('[data-preview-theme]').forEach(item => {
      item.setAttribute('aria-pressed', String(item === button));
    });
  });
});

// Explicit mobile tabs keep screenshot browsing separate from page scrolling.
(() => {
  const gallery = document.getElementById('screens');
  const tabList = gallery?.querySelector('.screen-tabs');
  if (!tabList) return;
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  const mobile = window.matchMedia('(max-width: 800px)');
  let selected = 0;

  function render() {
    const focus = document.activeElement;
    tabList.hidden = !mobile.matches;
    tabs.forEach((tab, index) => {
      const active = index === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = panels[index];
      panel.hidden = mobile.matches && !active;
      if (mobile.matches) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
      } else {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-labelledby');
      }
    });
    if (mobile.matches && panels.some(panel => panel.hidden && panel.contains(focus))) {
      tabs[selected].focus({ preventScroll: true });
    } else if (!mobile.matches && tabList.contains(focus)) {
      panels[selected].querySelector('a')?.focus({ preventScroll: true });
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { selected = index; render(); });
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      selected = next;
      render();
      tabs[next].focus();
    });
  });
  mobile.addEventListener('change', render);
  render();
})();

// Choose a phone without scrolling through two installation cards.
(() => {
  const section = document.getElementById('install');
  const tabList = section?.querySelector('.install-tabs');
  if (!tabList) return;
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let selected = appleMobile ? 1 : 0;

  function render() {
    tabs.forEach((tab, index) => {
      const active = index === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
    });
  }

  function selectFromHash(scroll) {
    const index = panels.findIndex(panel => location.hash === `#${panel.id}`);
    if (index === -1) return;
    selected = index;
    render();
    if (scroll) tabList.scrollIntoView({ block: 'start' });
  }

  panels.forEach((panel, index) => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabs[index].id);
    panel.tabIndex = 0;
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { selected = index; render(); });
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      selected = next;
      render();
      tabs[next].focus();
    });
  });
  section.querySelector('.install-grid').classList.add('is-switcher');
  tabList.hidden = false;
  render();
  selectFromHash(false);
  window.addEventListener('hashchange', () => selectFromHash(true));
})();
