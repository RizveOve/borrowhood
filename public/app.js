// Small progressive enhancements. Everything works without JavaScript.

// Confirm destructive actions.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});

// Keep the return date on or after the start date.
const start = document.querySelector('[data-start]');
const end = document.querySelector('[data-end]');
if (start && end) {
  const sync = () => {
    end.min = start.value;
    if (end.value && end.value < start.value) end.value = start.value;
  };
  start.addEventListener('change', sync);
  sync();
}

// Share invite link (native share sheet on phones, clipboard elsewhere).
document.querySelectorAll('[data-share]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const url = location.origin + btn.dataset.share;
    try {
      if (navigator.share) await navigator.share({ title: 'BorrowHood', text: btn.dataset.shareText, url });
      else {
        await navigator.clipboard.writeText(url);
        btn.textContent = btn.dataset.copied || 'Link copied ✓';
      }
    } catch { /* user dismissed */ }
  });
});

// Shrink big phone photos before upload (max 1600px JPEG). Returns the original file if it can't.
async function shrinkFile(file) {
  if (!file || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

// Item form: preview the chosen photo.
const photo = document.querySelector('[data-photo]');
const preview = document.querySelector('[data-preview]');
if (photo && preview) {
  photo.addEventListener('change', async () => {
    const file = photo.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.alt = '';
    img.src = URL.createObjectURL(file);
    preview.appendChild(img);
    if (!window.DataTransfer) return;
    const dt = new DataTransfer();
    dt.items.add(await shrinkFile(file));
    photo.files = dt.files;
  });
}

// Loan pickup / hand-back: photos can be picked one at a time (e.g. straight from the camera);
// they are collected, previewed and sent together with the confirm button.
document.querySelectorAll('[data-photo-step]').forEach((form) => {
  const input = form.querySelector('[data-step-photos]');
  const strip = form.querySelector('[data-step-preview]');
  const add = input.closest('label');
  const MAX = 6;
  if (!window.DataTransfer) return; // without it, the browser's own multi-select is used as is
  let chosen = [];
  // Put the chosen photos back into the input and redraw the previews, each with a remove button.
  const render = () => {
    const dt = new DataTransfer();
    chosen.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    strip.innerHTML = '';
    chosen.forEach((f, i) => {
      const fig = document.createElement('span');
      fig.className = 'step-photo';
      const img = document.createElement('img');
      img.alt = '';
      img.src = URL.createObjectURL(f);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'step-photo-del';
      del.textContent = '×';
      del.setAttribute('aria-label', form.dataset.removeLabel || 'Remove');
      del.addEventListener('click', () => {
        URL.revokeObjectURL(img.src);
        chosen.splice(i, 1);
        render();
      });
      fig.append(img, del);
      strip.appendChild(fig);
    });
    add.hidden = chosen.length >= MAX;
  };
  input.addEventListener('change', async () => {
    const picked = [...input.files].filter((f) => f.type.startsWith('image/'));
    form.classList.add('busy');
    for (const f of picked) if (chosen.length < MAX) chosen.push(await shrinkFile(f));
    form.classList.remove('busy');
    render();
  });
  // Last chance to check the photos: after confirming, they can't be changed.
  form.addEventListener('submit', (e) => {
    if (form.dataset.stepConfirm && !confirm(form.dataset.stepConfirm)) return e.preventDefault();
    form.classList.add('busy');
  });
});

// Browse filters apply as soon as they change (the Apply button is only needed without JS).
document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
  form.querySelectorAll('.js-hide').forEach((el) => (el.hidden = true));
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'q') form.requestSubmit();
  });
});
