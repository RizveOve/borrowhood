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
