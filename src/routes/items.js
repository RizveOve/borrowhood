const router = require('express').Router();
const multer = require('multer');
const { db } = require('../db');
const { requireAuth, requireHood, flash, isAdmin } = require('../auth');
const { getItem, canManage } = require('../items');
const { savePhoto, deletePhoto, sendPhoto, ALLOWED_TYPES } = require('../storage');
const { today, CAT_KEYS } = require('../util');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 }, // Netlify functions accept requests up to ~6 MB
  fileFilter: (req, file, cb) => cb(null, ALLOWED_TYPES.includes(file.mimetype)),
}).single('photo');

const parseUpload = (req, res) => new Promise((resolve) => {
  upload(req, res, (err) => resolve(err ? 'err.photo' : null));
});

function readItemForm(body = {}) {
  const v = {
    title: String(body.title || '').trim().slice(0, 80),
    category: CAT_KEYS.includes(body.category) ? body.category : '',
    location: String(body.location || '').trim().slice(0, 80),
    description: String(body.description || '').trim().slice(0, 1000),
  };
  let error = null;
  if (!v.title) error = 'err.title';
  else if (!v.category) error = 'err.category';
  else if (!v.location) error = 'err.location';
  return { v, error };
}

router.get('/photos/:key', requireAuth, (req, res) => sendPhoto(req.params.key, res));

const SORTS = ['near', 'new', 'popular', 'az'];

// Every logged-in user can see every item; filters narrow it down.
router.get('/items', requireAuth, (req, res) => {
  const f = {
    q: String(req.query.q || '').trim().slice(0, 80),
    category: CAT_KEYS.includes(req.query.category) ? req.query.category : '',
    hood: /^(mine|shelf|\d+)$/.test(req.query.hood || '') ? req.query.hood : '',
    avail: req.query.avail === '1' ? '1' : '',
    sort: SORTS.includes(req.query.sort) ? req.query.sort : 'near',
  };
  const t = today();
  const myHood = req.user.neighbourhood_id ?? -1;
  const where = [];
  const params = [t];
  if (f.q) {
    where.push('(i.title LIKE ? OR i.description LIKE ? OR i.location LIKE ? OR i.hood_name LIKE ?)');
    params.push(...Array(4).fill(`%${f.q}%`));
  }
  if (f.hood === 'mine') { where.push('i.is_org = 0 AND i.owner_hood = ?'); params.push(myHood); }
  else if (f.hood === 'shelf') where.push('i.is_org = 1');
  else if (f.hood) { where.push('i.is_org = 0 AND i.owner_hood = ?'); params.push(Number(f.hood)); }
  if (f.avail) where.push('out_until IS NULL');

  const order = {
    near: 'CASE WHEN i.is_org = 0 AND i.owner_hood = ? THEN 0 WHEN i.is_org = 1 THEN 1 ELSE 2 END, i.created_at DESC',
    new: 'i.created_at DESC',
    popular: 'times_lent DESC, i.created_at DESC',
    az: 'i.title COLLATE NOCASE',
  }[f.sort];
  if (f.sort === 'near') params.push(myHood);

  const matching = db.prepare(`
    SELECT * FROM (
      SELECT i.*, u.name AS owner_name, u.neighbourhood_id AS owner_hood, n.name AS hood_name,
        (SELECT MAX(l.end_date) FROM loans l
          WHERE l.item_id = i.id AND l.status = 'approved' AND l.start_date <= ?) AS out_until,
        (SELECT COUNT(*) FROM loans l WHERE l.item_id = i.id AND l.status IN ('approved', 'returned')) AS times_lent
      FROM items i JOIN users u ON u.id = i.owner_id
      LEFT JOIN neighbourhoods n ON n.id = u.neighbourhood_id
    ) i
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}, i.id DESC`).all(...params);

  // Category counts reflect the other filters, so the sidebar shows what each choice would give.
  const catCounts = { '': matching.length };
  for (const it of matching) catCounts[it.category] = (catCounts[it.category] || 0) + 1;
  const items = f.category ? matching.filter((it) => it.category === f.category) : matching;

  const hoods = db.prepare(`SELECT n.id, n.name, COUNT(i.id) AS items FROM neighbourhoods n
    JOIN users u ON u.neighbourhood_id = n.id JOIN items i ON i.owner_id = u.id AND i.is_org = 0
    GROUP BY n.id ORDER BY n.name`).all();
  const active = ['category', 'hood', 'avail'].filter((k) => f[k]).length + (f.q ? 1 : 0);
  res.render('items', { title: req.t('browse.title'), items, f, hoods, SORTS, active, catCounts, wide: true });
});

router.get('/items/new', requireAuth, requireHood, (req, res) => {
  res.render('item-form', { title: req.t('form.new_title'), item: {}, error: null });
});

router.post('/items', requireAuth, requireHood, async (req, res) => {
  const uploadError = await parseUpload(req, res);
  const { v, error } = readItemForm(req.body);
  if (uploadError || error) {
    return res.status(400).render('item-form', { title: req.t('form.new_title'), item: v, error: uploadError || error });
  }
  const photoKey = req.file ? await savePhoto(req.file) : null;
  const r = db.prepare(`INSERT INTO items (owner_id, is_org, title, category, location, description, photo_key)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, isAdmin(req.user) ? 1 : 0, v.title, v.category, v.location, v.description || null, photoKey);
  flash(req, 'ok', req.t('flash.listed'));
  res.redirect('/items/' + r.lastInsertRowid);
});

router.get('/items/:id', requireAuth, (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).render('error', { title: req.t('err.not_found'), message: req.t('item.not_found') });
  const t = today();
  const manage = canManage(req.user, item);
  const bookings = db.prepare(`SELECT start_date, end_date FROM loans
    WHERE item_id = ? AND status = 'approved' AND end_date >= ? ORDER BY start_date`).all(item.id, t);
  const mine = db.prepare(`SELECT * FROM loans WHERE item_id = ? AND borrower_id = ?
    AND status IN ('pending', 'approved') ORDER BY start_date`).all(item.id, req.user.id);
  const requests = manage
    ? db.prepare(`SELECT l.*, b.name AS borrower_name, b.flat AS borrower_flat FROM loans l
        JOIN users b ON b.id = l.borrower_id
        WHERE l.item_id = ? AND l.status IN ('pending', 'approved') ORDER BY l.status DESC, l.start_date`).all(item.id)
    : [];
  res.render('item', { title: item.title, item, manage, bookings, mine, requests, error: /^err\.\w+$/.test(req.query.error || '') ? req.query.error : null, wide: true });
});

router.get('/items/:id/edit', requireAuth, (req, res) => {
  const item = getItem(req.params.id);
  if (!item || !canManage(req.user, item)) return res.sendStatus(404);
  res.render('item-form', { title: req.t('form.edit_title'), item, error: null });
});

router.post('/items/:id/edit', requireAuth, async (req, res) => {
  const item = getItem(req.params.id);
  if (!item || !canManage(req.user, item)) return res.sendStatus(404);
  const uploadError = await parseUpload(req, res);
  const { v, error } = readItemForm(req.body);
  if (uploadError || error) {
    return res.status(400).render('item-form', { title: req.t('form.edit_title'), item: { ...item, ...v }, error: uploadError || error });
  }
  if (req.file) {
    const photoKey = await savePhoto(req.file);
    db.prepare('UPDATE items SET photo_key = ?, photo_credit = NULL, photo_source = NULL WHERE id = ?').run(photoKey, item.id);
    await deletePhoto(item.photo_key);
  }
  db.prepare('UPDATE items SET title = ?, category = ?, location = ?, description = ? WHERE id = ?')
    .run(v.title, v.category, v.location, v.description || null, item.id);
  flash(req, 'ok', req.t('flash.saved'));
  res.redirect('/items/' + item.id);
});

router.post('/items/:id/delete', requireAuth, async (req, res) => {
  const item = getItem(req.params.id);
  if (!item || !canManage(req.user, item)) return res.sendStatus(404);
  const out = db.prepare("SELECT 1 FROM loans WHERE item_id = ? AND status = 'approved'").get(item.id);
  if (out) {
    flash(req, 'error', req.t('flash.item_out'));
    return res.redirect('/items/' + item.id);
  }
  // Pickup/return photos go with the loans (ON DELETE CASCADE), so collect their files first.
  const loanPhotos = db.prepare(`SELECT p.photo_key FROM loan_photos p JOIN loans l ON l.id = p.loan_id
    WHERE l.item_id = ?`).all(item.id);
  db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
  await deletePhoto(item.photo_key);
  for (const p of loanPhotos) await deletePhoto(p.photo_key);
  flash(req, 'ok', req.t('flash.item_removed', { title: item.title }));
  res.redirect(req.get('Referer')?.includes('/admin') ? '/admin' : '/me');
});

module.exports = router;
