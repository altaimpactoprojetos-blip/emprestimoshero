import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { prisma } from './prisma.js';
import { sha256 } from './crypto.js';

/**
 * Armazenamento privado de documentos.
 * Os arquivos nunca são servidos publicamente: o download passa pela API com verificação de permissão
 * e isolamento por empresa (prefixo companyId/ na chave).
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalStorageDriver implements StorageDriver {
  constructor(private base: string) {}
  private full(key: string) {
    const p = path.resolve(this.base, key);
    if (!p.startsWith(path.resolve(this.base))) throw new Error('Chave de armazenamento inválida');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
  async get(key: string) {
    return fs.readFile(this.full(key));
  }
  async delete(key: string) {
    await fs.rm(this.full(key), { force: true });
  }
}

export const storage: StorageDriver = new LocalStorageDriver(config.storage.localPath);

export async function storeFile(companyId: string, filename: string, mimeType: string, data: Buffer, uploadedById?: string | null) {
  const key = `${companyId}/${new Date().getUTCFullYear()}/${crypto.randomUUID()}${path.extname(filename).toLowerCase().slice(0, 10)}`;
  await storage.put(key, data);
  return prisma.storedFile.create({
    data: { companyId, storageKey: key, filename, mimeType, size: data.length, sha256: sha256(data), uploadedById: uploadedById ?? null },
  });
}

export async function readFile(companyId: string, fileId: string) {
  const f = await prisma.storedFile.findFirst({ where: { id: fileId, companyId } });
  if (!f) return null;
  const data = await storage.get(f.storageKey);
  return { file: f, data };
}
