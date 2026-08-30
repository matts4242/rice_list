'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const sharp = require('sharp');

const config = require('../config');
const { randomId } = require('../lib/tokens');

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Buffer in memory: files are small, capped, and every one is re-encoded by
// sharp before it ever reaches disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.listings.maxImageBytes,
    files: config.listings.maxImages,
  },
  fileFilter(req, file, cb) {
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      return;
    }
    cb(null, true);
  },
});

/**
 * Re-encode uploads to stripped JPEGs plus a thumbnail. Decoding through sharp
 * is what makes an upload safe: anything that isn't a real image fails here,
 * and EXIF (including GPS coordinates) never survives the round trip.
 */
async function processImages(files = []) {
  const written = [];
  try {
    for (const file of files.slice(0, config.listings.maxImages)) {
      const name = `${Date.now().toString(36)}-${randomId(8)}`;
      const image = sharp(file.buffer, { failOn: 'error' }).rotate();

      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error('Unreadable image');
      }

      await image
        .clone()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(path.join(config.uploadDir, `${name}.jpg`));
      written.push(`${name}.jpg`);

      await image
        .clone()
        .resize({ width: 480, height: 360, fit: 'cover' })
        .jpeg({ quality: 75, mozjpeg: true })
        .toFile(path.join(config.uploadDir, `${name}-thumb.jpg`));
    }
    return written;
  } catch (error) {
    await deleteImages(written);
    throw error;
  }
}

async function deleteImages(filenames = []) {
  await Promise.all(
    filenames.flatMap((filename) => {
      const base = filename.replace(/\.jpg$/, '');
      return [`${base}.jpg`, `${base}-thumb.jpg`].map((name) =>
        fs.rm(path.join(config.uploadDir, name), { force: true })
      );
    })
  );
}

function thumbFor(filename) {
  return filename.replace(/\.jpg$/, '-thumb.jpg');
}

module.exports = { upload, processImages, deleteImages, thumbFor, ACCEPTED_MIME };
