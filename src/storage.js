// Item photos. Three backends, picked from the environment:
//   - Netlify Blobs when PHOTO_STORE=blobs (set automatically on Netlify)
//   - a private S3 bucket when S3_BUCKET is set (EC2 deployment)
//   - local disk otherwise (development)
// Photos are always served through the app (/photos/:key), so nothing needs to be public.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('./paths');

const BUCKET = process.env.S3_BUCKET;
const BACKEND = process.env.PHOTO_STORE === 'blobs' ? 'blobs' : BUCKET ? 's3' : 'disk';
const DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads');
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
const blobs = () => require('@netlify/blobs').getStore('photos');

async function savePhoto(file) {
  const key = crypto.randomBytes(16).toString('hex') + '.' + EXT[file.mimetype];
  if (BACKEND === 'blobs') {
    await blobs().set(key, file.buffer);
  } else if (BACKEND === 's3') {
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
    if (BACKEND === 'blobs') {
      await blobs().delete(key);
    } else if (BACKEND === 's3') {
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
  if (BACKEND === 'disk') return res.sendFile(path.join(DIR, key), (err) => err && !res.headersSent && res.sendStatus(404));
  try {
    res.type(TYPES[key.split('.')[1]]);
    if (BACKEND === 'blobs') {
      const data = await blobs().get(key, { type: 'arrayBuffer' });
      if (!data) return res.sendStatus(404);
      return res.send(Buffer.from(data));
    }
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const obj = await s3Client().send(new GetObjectCommand({ Bucket: BUCKET, Key: 'items/' + key }));
    obj.Body.pipe(res);
  } catch {
    if (!res.headersSent) res.sendStatus(404);
  }
}

module.exports = { savePhoto, deletePhoto, sendPhoto, ALLOWED_TYPES: Object.keys(EXT) };
