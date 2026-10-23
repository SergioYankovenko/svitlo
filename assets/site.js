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
