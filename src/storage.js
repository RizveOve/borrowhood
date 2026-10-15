// Item photos: stored in a private S3 bucket when S3_BUCKET is set, otherwise on local disk.
// Photos are always served through the app (/photos/:key), so the bucket never needs to be public.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUCKET = process.env.S3_BUCKET;
const DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPES = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

let s3;
function s3Client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({});
  }
  return s3;
}

async function savePhoto(file) {
  const key = crypto.randomBytes(16).toString('hex') + '.' + EXT[file.mimetype];
  if (BUCKET) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: BUCKET, Key: 'items/' + key, Body: file.buffer, ContentType: file.mimetype,
    }));
  } else {
    await fs.promises.mkdir(DIR, { recursive: true });
    await fs.promises.writeFile(path.join(DIR, key), file.buffer);
  }
  return key;
}

async function deletePhoto(key) {
  if (!key || !KEY_RE.test(key)) return;
  try {
    if (BUCKET) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3Client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'items/' + key }));
    } else {
      await fs.promises.unlink(path.join(DIR, key));
    }
  } catch (e) {
    console.warn('[storage] delete failed', key, e.message);
  }
}

async function sendPhoto(key, res) {
  if (!KEY_RE.test(key)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=604800, immutable');
  if (!BUCKET) return res.sendFile(path.join(DIR, key), (err) => err && !res.headersSent && res.sendStatus(404));
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const obj = await s3Client().send(new GetObjectCommand({ Bucket: BUCKET, Key: 'items/' + key }));
    res.type(TYPES[key.split('.')[1]]);
    obj.Body.pipe(res);
  } catch {
    res.sendStatus(404);
  }
}

module.exports = { savePhoto, deletePhoto, sendPhoto, ALLOWED_TYPES: Object.keys(EXT) };
