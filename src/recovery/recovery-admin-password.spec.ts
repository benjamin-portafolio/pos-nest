import {
  adminPasswordProblem,
  createAdminPasswordHash,
  verifyAdminPasswordHash,
} from './recovery-admin-password';

describe('administrative password hashes', () => {
  it('generates independent Argon2id salts and verifies exact Unicode/space-preserving passwords', async () => {
    const password = '  contraseña 🔑 con espacios  ';
    const first = await createAdminPasswordHash(password);
    const second = await createAdminPasswordHash(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(first).not.toEqual(second);
    expect(first).not.toContain(password);
    expect(await verifyAdminPasswordHash(first, password)).toBe(true);
    expect(await verifyAdminPasswordHash(first, password.trim())).toBe(false);
    expect(
      await verifyAdminPasswordHash(first, 'una contraseña distinta'),
    ).toBe(false);
  });
  it('rejects short, excessive, control-only and malformed Unicode input on setup', async () => {
    for (const value of [
      '',
      'corta',
      ' '.repeat(20),
      'a'.repeat(129),
      'a'.repeat(20) + '\n',
      '\ud800'.repeat(20),
    ]) {
      expect(adminPasswordProblem(value)).toBeDefined();
      await expect(createAdminPasswordHash(value)).rejects.toThrow();
    }
    expect(adminPasswordProblem('🔑'.repeat(128))).toBeUndefined();
  });
});
