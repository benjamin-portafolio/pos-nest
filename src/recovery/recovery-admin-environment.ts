import { TextDecoder } from 'node:util';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ADMIN_PASSWORD_HASH_KEY,
  ADMIN_LEGACY_HASH_KEY,
} from './recovery-admin-password';

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

async function removeIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Edit only active assignments, including multiline dotenv values, preserving other settings. */
export function adminPasswordEnvironment(
  contents: string,
  encoded: string,
): string {
  if (!/^\$argon2id\$v=19\$[A-Za-z0-9,+/=$]+$/.test(encoded))
    throw new Error('Hash administrativo inválido.');
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const assignment = `${ADMIN_PASSWORD_HASH_KEY}='${encoded}'${newline}`;
  const lines = contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i];
    const match =
      /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+)(.*?)(?:\r?\n)?$/.exec(
        first,
      );
    const block = [first];
    if (match) {
      const value = match[2];
      const quote = value[0];
      if (["'", '"', '`'].includes(quote)) {
        let rest = value.slice(1);
        const closed = () => {
          for (let j = 0; j < rest.length; j++) {
            if (rest[j] === quote && rest[j - 1] !== '\\') return true;
          }
          return false;
        };
        while (!closed()) {
          if (++i >= lines.length)
            throw new Error(
              'El archivo de entorno contiene un valor sin cerrar. No se modificó.',
            );
          block.push(lines[i]);
          rest += '\n' + lines[i];
        }
      }
      if ([ADMIN_PASSWORD_HASH_KEY, ADMIN_LEGACY_HASH_KEY].includes(match[1])) {
        if (!inserted) {
          output.push(assignment);
          inserted = true;
        }
        continue;
      }
    }
    output.push(...block);
  }
  let result = output.join('');
  if (!inserted)
    result += (result && !result.endsWith('\n') ? newline : '') + assignment;
  return result;
}

async function currentFile(path: string): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error(
        'El archivo de entorno debe ser un archivo regular sin enlaces.',
      );
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Same-directory atomic replacement. Does not load, log or expand the user's environment. */
export async function saveAdminPasswordEnvironment(
  path: string,
  encoded: string,
): Promise<void> {
  const lockPath = `${path}.recovery-admin.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = join(
    dirname(path),
    `${basename(path)}.${randomUUID()}.recovery-admin.tmp`,
  );
  try {
    const original = await currentFile(path);
    const updated = adminPasswordEnvironment(
      original
        ? new TextDecoder('utf-8', { fatal: true }).decode(original)
        : '',
      encoded,
    );
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(updated, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    const current = await currentFile(path);
    if (
      original === undefined
        ? current !== undefined
        : current === undefined || !original.equals(current)
    )
      throw new Error(
        'El archivo de entorno cambió durante la configuración. Vuelve a intentarlo.',
      );
    await rename(temporary, path);
  } finally {
    await lock.close();
    await unlink(lockPath);
    await removeIfPresent(temporary);
  }
}
