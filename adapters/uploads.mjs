// Attachments. Files are written to disk beside the run that received them,
// because an agent reads a path - neither engine takes bytes over a socket.

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';

const MAX_BYTES = 32 * 1024 * 1024;

const ALLOWED = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
]);

export function createUploads({ dir }) {
  return {
    accepts(name) {
      return ALLOWED.has(extname(name).toLowerCase());
    },

    async save(name, bytes, runId) {
      const extension = extname(name).toLowerCase();
      if (!ALLOWED.has(extension)) throw new Error(`unsupported file type: ${extension || name}`);
      if (bytes.length > MAX_BYTES) throw new Error(`${name} is larger than 32MB`);

      const folder = join(dir, String(runId ?? 'loose'));
      await mkdir(folder, { recursive: true });

      // Keep the human name visible but never let it escape the folder.
      const safe = name.replace(/[^\w.-]+/g, '_').slice(-80);
      const path = join(folder, `${randomUUID().slice(0, 8)}-${safe}`);
      await writeFile(path, bytes);

      return { path, name, type: ALLOWED.get(extension), bytes: bytes.length };
    },
  };
}
