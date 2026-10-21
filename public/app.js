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

// ---- Live messages (polling: works on serverless hosting such as Netlify) ----

// Update the unread badge on every "Messages" link (desktop top nav + mobile tab bar).
function setInboxBadge(count) {
  document.querySelectorAll('a[href="/messages"]').forEach((link) => {
    const host = link.querySelector('.ic') || link;
    let dot = host.querySelector('.dot');
    if (!count) return dot && dot.remove();
    if (!dot) {
      dot = document.createElement('span');
      dot.className = host === link ? 'dot dot-inline' : 'dot';
      host.append(dot);
    }
    dot.textContent = count > 9 ? '9+' : count;
  });
}

// Run fn every `ms` while the tab is visible, and right away when the tab comes back.
function whileVisible(fn, ms) {
  let timer = null;
  const loop = async () => {
    clearTimeout(timer);
    if (document.visibilityState !== 'visible') return;
    try { await fn(); } catch { /* offline or server busy: try again next round */ }
    timer = setTimeout(loop, ms);
  };
  document.addEventListener('visibilitychange', loop);
  timer = setTimeout(loop, ms);
}

const getJson = (url) => fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : Promise.reject(r)));

const thread = document.querySelector('[data-thread]');
if (thread) {
  const convId = thread.dataset.thread;
  const list = thread.querySelector('.bubbles');
  const form = thread.querySelector('form.composer');
  const input = form.querySelector('textarea');
  const button = form.querySelector('button');
  let after = Number(thread.dataset.after) || 0;

  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  const add = (m) => {
    if (list.querySelector(`[data-id="${m.id}"]`)) return;
    list.querySelector('[data-empty]')?.remove();
    const stick = m.mine || nearBottom();
    const row = document.createElement('div');
    row.className = 'bubble-row ' + (m.mine ? 'mine' : 'theirs');
    row.dataset.id = m.id;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.body;
    const time = document.createElement('span');
    time.className = 'tiny muted';
    time.textContent = m.time;
    row.append(bubble, time);
    list.append(row);
    after = Math.max(after, m.id);
    if (stick) row.scrollIntoView({ block: 'end', behavior: 'smooth' });
  };

  whileVisible(async () => {
    const data = await getJson(`/messages/${convId}/updates?after=${after}`);
    data.messages.forEach(add);
    setInboxBadge(data.unread);
  }, 3000);

  // Send without reloading; fall back to a normal form post if anything goes wrong.
  form.addEventListener('submit', async (e) => {
    const body = input.value.trim();
    if (!body) return e.preventDefault();
    e.preventDefault();
    button.disabled = true;
    try {
      const r = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ body }),
      });
      if (!r.ok) throw new Error(r.status);
      add((await r.json()).message);
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    } catch {
      form.submit();
    } finally {
      button.disabled = false;
    }
  });
} else if (document.body.hasAttribute('data-auth')) {
  // Other pages: keep the Messages badge fresh. On the inbox, reload when something new arrives.
  const onInbox = !!document.querySelector('[data-inbox]');
  let last = null;
  whileVisible(async () => {
    const { unread } = await getJson('/messages/unread-count');
    if (onInbox && last !== null && unread > last && !document.activeElement?.matches('input, textarea')) location.reload();
    last = unread;
    setInboxBadge(unread);
  }, onInbox ? 5000 : 20000);
}
