// Progressive enhancement: all tour captions remain readable without JavaScript.
const groups = document.querySelectorAll('[data-tabs]');
for (const group of groups) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  const select = (selected, focus = false) => {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
    if (focus) selected.focus();
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next], true);
    });
  }
  select(tabs[0]);
}

const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let playing = !motionPreference.matches;
let format = 'webp';
const motionButton = document.querySelector('.motion-toggle');
function updateRecordings() {
  for (const image of document.querySelectorAll('img[data-static]')) {
    const source = playing ? (image.dataset.fixedAnimation || image.dataset[format]) : image.dataset.static;
    if (image.getAttribute('src') !== source) image.setAttribute('src', source);
  }
  motionButton.textContent = playing ? 'Pause recordings' : 'Play recordings';
  motionButton.setAttribute('aria-pressed', String(playing));
}
for (const button of document.querySelectorAll('[data-format]')) {
  button.addEventListener('click', () => {
    format = button.dataset.format;
    for (const other of document.querySelectorAll('[data-format]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    updateRecordings();
  });
}
motionButton.addEventListener('click', () => {
  playing = !playing;
  updateRecordings();
});
motionPreference.addEventListener('change', (event) => {
  playing = !event.matches;
  updateRecordings();
});
updateRecordings();

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied!';
      button.dataset.copied = 'true';
      status.textContent = 'Command copied to clipboard.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Select & copy';
      status.textContent = 'Clipboard unavailable. Command selected; use your system copy shortcut.';
    }
    window.setTimeout(() => {
      button.textContent = 'Copy';
      delete button.dataset.copied;
    }, 2500);
  });
}

const lightbox = document.getElementById('lightbox');
const enlargedImage = lightbox.querySelector('img');
for (const button of document.querySelectorAll('.zoomable')) {
  button.addEventListener('click', () => {
    const image = button.querySelector('img');
    enlargedImage.src = image.currentSrc || image.src;
    enlargedImage.alt = image.alt;
    for (const key of ['static', 'fixedAnimation', 'webp', 'gif']) {
      if (image.dataset[key]) enlargedImage.dataset[key] = image.dataset[key];
    }
    lightbox.showModal();
  });
}
lightbox.addEventListener('click', (event) => {
  if (event.target !== lightbox) return;
  const bounds = lightbox.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) lightbox.close();
});
lightbox.addEventListener('close', () => {
  enlargedImage.removeAttribute('src');
  for (const key of Object.keys(enlargedImage.dataset)) delete enlargedImage.dataset[key];
});
