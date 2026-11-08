const fs = require('node:fs');
const path = require('node:path');
const paths = require('../storage/paths');
const { readMediaMetadata } = require('../storage/metadataStore');
const { badRequest, notFound, internal } = require('../utils/httpErrors');

/**
 * Lists published media items from storage/media sorted by createdAt DESC.
 * Skips corrupt metadata JSONs (logged via console.warn) and orphan JSONs whose media file is missing.
 *
 * @param {string} storageRoot
 * @param {object} [options]
 * @param {number|string} [options.limit=100]
 * @returns {Promise<Array<{ mediaId: string, name: string, size: number, contentType: string, sha256: string, createdAt: string, url: string }>>}
 */
async function listMedia(storageRoot, { limit = 100 } = {}) {
  // 1. Validate limit parameter
  let parsedLimit = 100;
  if (limit !== undefined && limit !== null) {
    if (typeof limit === 'string') {
      if (!/^\d+$/.test(limit.trim())) {
        throw badRequest(`Invalid limit parameter "${limit}". Must be an integer between 1 and 500.`);
      }
      parsedLimit = Number(limit.trim());
    } else if (typeof limit === 'number') {
      parsedLimit = limit;
    } else {
      throw badRequest('Invalid limit parameter. Must be an integer between 1 and 500.');
    }

    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      throw badRequest(`Limit parameter must be an integer between 1 and 500. Got: ${limit}`);
    }
  }

  // 2. Read storage/media directory (GET must not create directories)
  const mediaDirectory = paths.mediaDir(storageRoot);

  let entries = [];
  try {
    entries = await fs.promises.readdir(mediaDirectory);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  // 3. Filter files matching <valid-id>.json
  const jsonFiles = entries.filter((file) => {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) return false;
    const id = file.slice(0, -5);
    try {
      paths.assertValidId(id);
      return true;
    } catch {
      return false;
    }
  });

  const items = [];

  for (const jsonFile of jsonFiles) {
    const mediaId = jsonFile.slice(0, -5);
    const metaPath = path.join(mediaDirectory, jsonFile);

    let record = null;
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      record = JSON.parse(raw);
    } catch (parseErr) {
      console.warn(`[MediaCatalog] Skipping corrupt metadata file "${jsonFile}": ${parseErr.message}`);
      continue;
    }

    if (!record || typeof record !== 'object' || record.mediaId !== mediaId) {
      console.warn(`[MediaCatalog] Skipping invalid metadata structure in "${jsonFile}"`);
      continue;
    }

    // Validate storedFile name (${mediaId}.${ext})
    const storedFile = record.storedFile;
    if (typeof storedFile !== 'string') {
      continue;
    }

    const dotIndex = storedFile.lastIndexOf('.');
    if (dotIndex === -1) {
      continue;
    }
    const prefix = storedFile.slice(0, dotIndex);
    const ext = storedFile.slice(dotIndex + 1);
    if (prefix !== mediaId) {
      continue;
    }

    let filePath;
    try {
      paths.assertValidExt(ext);
      filePath = paths.mediaPath(mediaId, ext, storageRoot);
    } catch {
      continue;
    }

    // Verify media file exists via fs.promises.stat (skip orphan JSONs)
    try {
      const st = await fs.promises.stat(filePath);
      if (st.size !== record.size) {
        // Size mismatch or corrupt file - skip from list
        continue;
      }
    } catch (statErr) {
      if (statErr.code === 'ENOENT') {
        // Orphan json whose media file is deleted
        continue;
      }
      throw statErr;
    }

    items.push({
      mediaId: record.mediaId,
      name: record.originalName,
      size: record.size,
      contentType: record.contentType,
      sha256: record.sha256,
      createdAt: record.createdAt,
      url: `/api/media/${record.mediaId}`
    });
  }

  // 4. Sort newest first (createdAt DESC)
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // 5. Apply limit
  return items.slice(0, parsedLimit);
}

/**
 * Retrieves a media item by ID, validating file existence and ledger consistency.
 *
 * @param {string} mediaId
 * @param {string} storageRoot
 * @returns {Promise<{ record: object, filePath: string, stat: import('node:fs').Stats }>}
 */
async function getMedia(mediaId, storageRoot) {
  // Validate ID format (throws notFound 404)
  paths.assertValidId(mediaId);

  // Read media metadata (returns null if missing)
  const record = await readMediaMetadata(mediaId, storageRoot);
  if (!record) {
    throw notFound(`Media resource "${mediaId}" not found`);
  }

  // Re-validate storedFile name from JSON
  const storedFile = record.storedFile;
  if (typeof storedFile !== 'string') {
    throw notFound(`Media file for "${mediaId}" not found`);
  }

  const dotIndex = storedFile.lastIndexOf('.');
  if (dotIndex === -1) {
    throw notFound(`Media file for "${mediaId}" not found`);
  }
  const prefix = storedFile.slice(0, dotIndex);
  const ext = storedFile.slice(dotIndex + 1);
  if (prefix !== mediaId) {
    throw notFound(`Media file for "${mediaId}" not found`);
  }

  const validExt = paths.assertValidExt(ext);
  const filePath = paths.mediaPath(mediaId, validExt, storageRoot);

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw notFound(`Media file for "${mediaId}" not found`);
    }
    throw err;
  }

  if (stat.size !== record.size) {
    console.error(`[MediaCatalog] Media file size mismatch for mediaId "${mediaId}": expected ${record.size}, found ${stat.size}`);
    throw internal('Media file is inconsistent');
  }

  return { record, filePath, stat };
}

module.exports = {
  listMedia,
  getMedia
};
