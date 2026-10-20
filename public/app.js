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

// Preview the photo and shrink big phone photos before upload (max 1600px JPEG).
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
    if (file.type === 'image/gif' || !window.DataTransfer) return;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5e6) return;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob) return;
      const dt = new DataTransfer();
      dt.items.add(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
      photo.files = dt.files;
    } catch { /* fall back to the original file */ }
  });
}

// Browse filters apply as soon as they change (the Apply button is only needed without JS).
document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
  form.querySelectorAll('.js-hide').forEach((el) => (el.hidden = true));
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'q') form.requestSubmit();
  });
});

// Chat: grow the message box with its content, send with Enter (Shift+Enter for a new line),
// and start at the newest message.
document.querySelectorAll('textarea[data-autogrow]').forEach((ta) => {
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      if (ta.value.trim()) ta.form.requestSubmit();
    }
  });
});
const latest = document.getElementById('latest');
if (latest) latest.scrollIntoView({ block: 'end' });
