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

// One native swipe track keeps all four screenshots under a shared introduction.
(() => {
  const gallery = document.querySelector('.screen-carousel');
  if (!gallery) return;
  const viewport = gallery.querySelector('.gallery-viewport');
  const slides = [...gallery.querySelectorAll('.gallery-slide')];
  const tabList = gallery.querySelector('.gallery-tabs');
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const previous = gallery.querySelector('.gallery-previous');
  const next = gallery.querySelector('.gallery-next');
  const counter = gallery.querySelector('.gallery-counter');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let selected = 0;
  let frame = 0;

  function revealTab() {
    const label = tabs[selected].getBoundingClientRect();
    const strip = tabList.getBoundingClientRect();
    if (label.left < strip.left + 6) {
      tabList.scrollBy({ left: label.left - strip.left - 6, behavior: 'auto' });
    } else if (label.right > strip.right - 6) {
      tabList.scrollBy({ left: label.right - strip.right + 6, behavior: 'auto' });
    }
  }

  function render(index) {
    selected = Math.max(0, Math.min(slides.length - 1, index));
    if (slides.some((slide, i) => i !== selected && slide.contains(document.activeElement))) {
      viewport.focus({ preventScroll: true });
    }
    tabs.forEach((tab, i) => {
      const active = i === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      slides[i].setAttribute('aria-hidden', String(!active));
      slides[i].querySelector('a').tabIndex = active ? 0 : -1;
    });
    previous.disabled = selected === 0;
    next.disabled = selected === slides.length - 1;
    counter.textContent = `${selected + 1} / ${slides.length}`;
    // Reveal the active label horizontally without moving the page vertically.
    revealTab();
  }

  function select(index) {
    const target = Math.max(0, Math.min(slides.length - 1, index));
    render(target);
    viewport.scrollTo({ left: slides[target].offsetLeft - slides[0].offsetLeft,
      behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  function keyboard(event, focusTab) {
    const target = event.key === 'ArrowRight' ? (selected + 1) % slides.length
      : event.key === 'ArrowLeft' ? (selected + slides.length - 1) % slides.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? slides.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    select(target);
    if (focusTab) tabs[target].focus({ preventScroll: true });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => keyboard(event, true));
    slides[index].setAttribute('role', 'tabpanel');
    slides[index].setAttribute('aria-labelledby', tab.id);
  });
  previous.addEventListener('click', () => select(selected - 1));
  next.addEventListener('click', () => select(selected + 1));
  viewport.addEventListener('keydown', event => keyboard(event, false));
  viewport.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render(Math.round(viewport.scrollLeft / viewport.clientWidth));
    });
  }, { passive: true });
  const resizeObserver = new ResizeObserver(() => {
    viewport.scrollTo({ left: slides[selected].offsetLeft - slides[0].offsetLeft, behavior: 'auto' });
    revealTab();
  });
  resizeObserver.observe(viewport);
  resizeObserver.observe(tabList);
  gallery.classList.add('is-slider');
  tabList.hidden = false;
  gallery.querySelector('.gallery-controls').hidden = false;
  viewport.scrollLeft = 0;
  render(0);
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
