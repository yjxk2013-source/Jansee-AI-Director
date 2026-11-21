import { createReadStream } from "node:fs";
import { lstat, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

export interface LocalStorageConfig {
  rootDir: string;
  maxObjectBytes: number;
  minFreeBytes?: number;
}

export interface LocalObjectStorage {
  putFile(key: string, sourcePath: string): Promise<{ sizeBytes: number }>;
  getFilePath(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
  deleteExpired(prefix: string, olderThan: Date, now?: Date): Promise<number>;
  createSignedUrl?(key: string, options?: { downloadFilename?: string | undefined; ttlSeconds?: number | undefined }): Promise<string> | string;
}

function validateKey(key: string): string[] {
  const parts = key.split("/");
  if (key.length < 1 || key.length > 512 || parts.some((part) =>
    !/^[a-zA-Z0-9_-]{1,128}$/.test(part) || part === "." || part === "..")) {
    throw new Error("Invalid local storage key");
  }
  return parts;
}

export function createLocalObjectStorage(config: LocalStorageConfig): LocalObjectStorage {
  if (!config.rootDir || !isAbsolute(config.rootDir) || !Number.isSafeInteger(config.maxObjectBytes) || config.maxObjectBytes <= 0) {
    throw new Error("Local storage requires an absolute root and a positive object limit");
  }
  const root = resolve(config.rootDir);
  const minFreeBytes = Math.max(0, config.minFreeBytes ?? 512 * 1024 * 1024);

  async function ensureRoot(): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Local storage root must be a real directory");
  }

  function objectPath(key: string): string {
    const parts = validateKey(key);
    const target = resolve(root, ...parts);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Invalid local storage path");
    return target;
  }

  async function assertNoSymlinkParents(target: string, includeTarget = false): Promise<void> {
    const rel = relative(root, target);
    const parts = rel.split(sep);
    let current = root;
    const count = includeTarget ? parts.length : parts.length - 1;
    for (let i = 0; i < count; i += 1) {
      current = join(current, parts[i]!);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Local storage path contains an unsafe directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  return {
    async putFile(key, sourcePath) {
      await ensureRoot();
      const target = objectPath(key);
      await assertNoSymlinkParents(target);
      const source = await stat(sourcePath);
      if (!source.isFile() || source.size > config.maxObjectBytes) throw new Error("Source file is invalid or exceeds the object size limit");
      const disk = await statfs(root);
      const available = Number(disk.bavail) * Number(disk.bsize);
      if (available - source.size < minFreeBytes) throw new Error("Insufficient free disk space for upload");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await assertNoSymlinkParents(target);
      const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.part`);
      try {
        await pipeline(createReadStream(sourcePath), (await import("node:fs")).createWriteStream(temp, { flags: "wx", mode: 0o600 }));
        const written = await stat(temp);
        if (written.size !== source.size || written.size > config.maxObjectBytes) throw new Error("Stored file size verification failed");
        await rename(temp, target);
        return { sizeBytes: written.size };
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async getFilePath(key) {
      await ensureRoot();
      const target = objectPath(key);
      await assertNoSymlinkParents(target);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Stored object is not a regular file");
      return target;
    },

    async deleteObject(key) {
      await ensureRoot();
      const target = objectPath(key);
      await assertNoSymlinkParents(target);
      await rm(target, { force: true });
    },

    async deleteExpired(prefix, olderThan, now = new Date()) {
      const parts = validateKey(prefix);
      if (olderThan.getTime() > now.getTime()) throw new Error("Expiry cutoff cannot be in the future");
      const base = objectPath(prefix);
      await ensureRoot();
      await assertNoSymlinkParents(base, true);
      let removed = 0;
      const { readdir } = await import("node:fs/promises");
      const { join: joinPath } = await import("node:path");
      async function walk(directory: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const full = joinPath(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            const info = await lstat(full);
            if (info.mtimeMs <= olderThan.getTime()) {
              await rm(full, { force: true });
              removed += 1;
            }
          }
        }
      }
      try { await walk(base); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      void parts;
      return removed;
    },
  };
}

