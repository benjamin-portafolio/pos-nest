import { hash, verify, argon2id } from 'argon2';

export const ADMIN_PASSWORD_HASH_KEY = 'POS_RECOVERY_ADMIN_PASSWORD_HASH';
export const ADMIN_LEGACY_HASH_KEY = 'POS_RECOVERY_ADMIN_TOKEN_SHA256';
export const ADMIN_PASSWORD_MAX_CHARACTERS = 128;

/** Preserve spaces and Unicode exactly; only terminal/HTTP control characters are excluded. */
export function acceptsAdminSecret(value: string): boolean {
  return (
    value.length > 0 &&
    [...value].length <= ADMIN_PASSWORD_MAX_CHARACTERS &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}

export function adminPasswordProblem(value: string): string | undefined {
  if (!acceptsAdminSecret(value) || [...value].length < 15 || !value.trim())
    return 'Usa entre 15 y 128 caracteres, sin saltos de línea ni caracteres de control. Se permiten espacios y acentos.';
}

export async function createAdminPasswordHash(
  password: string,
): Promise<string> {
  const problem = adminPasswordProblem(password);
  if (problem) throw new Error(problem);
  return await hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  });
}

export async function verifyAdminPasswordHash(
  encoded: string,
  password: string,
): Promise<boolean> {
  if (!encoded.startsWith('$argon2id$v=19$'))
    throw new Error('Invalid administrative password configuration');
  return verify(encoded, password);
}
