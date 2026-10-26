'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const sharp = require('sharp');

const config = require('../config');
const { randomId } = require('../lib/tokens');

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// The text fields the listing forms send, with room to spare. These bound
// what an anonymous request can make the parser buffer before the CSRF
// check, which can only run once the body is parsed.
const MAX_FIELDS = 20;
// In bytes, not characters: an 8000-character description is up to ~32 KB
// of UTF-8, more with the CRLF line endings browsers send.
const MAX_FIELD_BYTES = 64 * 1024;

// File size says little about decoded size: a 180 KB GIF can declare
// 16383×16383 pixels and cost gigabytes to decode. JPEG is decoded at a
// fraction of its size when it is being scaled down (shrink-on-load), so it
// keeps sharp's own ceiling and real 100+ megapixel phone photos still work;
// every other format is decoded at full size and gets a tighter cap.
const MAX_PIXELS = {
  jpeg: 0x3fff * 0x3fff, // sharp's default limitInputPixels
  other: 25_000_000,
};

// Buffer in memory: files are small, capped, and every one is re-encoded by
// sharp before it ever reaches disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.listings.maxImageBytes,
    files: config.listings.maxImages,
    fields: MAX_FIELDS,
    fieldNameSize: 100,
    fieldSize: MAX_FIELD_BYTES,
    parts: MAX_FIELDS + config.listings.maxImages,
  },
  fileFilter(req, file, cb) {
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      return;
    }
    cb(null, true);
  },
});

/** An image the poster can fix by choosing another file, and how to say so. */
function rejectImage(userMessage) {
  return Object.assign(new Error(userMessage), { userMessage });
}

// One upload is decoded at a time, process-wide. The pixel caps bound what
// a single image can cost; without this, that cost multiplies by however
// many uploads arrive together.
let queue = Promise.resolve();
function oneAtATime(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Re-encode uploads to stripped JPEGs plus a thumbnail. Decoding through sharp
 * is what makes an upload safe: anything that isn't a real image fails here,
 * and EXIF (including GPS coordinates) never survives the round trip.
 *
 * Errors carrying a userMessage are the poster's to fix; any other error
 * means the file could not be read at all.
 */
function processImages(files = []) {
  return oneAtATime(() => encodeImages(files));
}

async function encodeImages(files) {
  const written = [];
  try {
    for (const file of files.slice(0, config.listings.maxImages)) {
      const name = `${Date.now().toString(36)}-${randomId(8)}`;
      // metadata() reads only the header, so the size check below happens
      // before anything is decoded. Transparent areas become white rather
      // than JPEG's default black, which would swallow dark content.
      const image = sharp(file.buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS.jpeg })
        .rotate()
        .flatten({ background: '#ffffff' });

      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error('Unreadable image');
      }
      const limit = metadata.format === 'jpeg' ? MAX_PIXELS.jpeg : MAX_PIXELS.other;
      if (metadata.width * metadata.height > limit) {
        throw rejectImage(
          `That image is too large (over ${Math.floor(limit / 1e6)} megapixels). Try a smaller one.`
        );
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

module.exports = { upload, processImages, deleteImages, thumbFor, ACCEPTED_MIME, MAX_PIXELS };
