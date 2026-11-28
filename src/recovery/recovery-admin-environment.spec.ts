import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import {
  adminPasswordEnvironment,
  saveAdminPasswordEnvironment,
} from './recovery-admin-environment';
import {
  createAdminPasswordHash,
  verifyAdminPasswordHash,
} from './recovery-admin-password';

const key = 'POS_RECOVERY_ADMIN_PASSWORD_HASH';
const legacy = 'POS_RECOVERY_ADMIN_TOKEN_SHA256';
describe('private administrative environment configuration', () => {
  let directory: string;
  let encoded: string;
  beforeAll(async () => {
    encoded = await createAdminPasswordHash('Una contraseña elegida y privada');
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pos-admin-password-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves unrelated settings, comments, multiline strings and CRLF while replacing duplicate/legacy assignments', () => {
    const original = `# configuración\r\nDATABASE_PASSWORD='no tocar # $'\r\nOTHER="primera\r\n${legacy}=texto dentro de valor\r\núltima"\r\nexport ${legacy}=anterior\r\n${key}='vieja' # duplicada\r\n${key}='otra'\r\n`;
    const updated = adminPasswordEnvironment(original, encoded);
    const before = parse(original),
      after = parse(updated);
    expect(after.DATABASE_PASSWORD).toBe(before.DATABASE_PASSWORD);
    expect(after.OTHER).toBe(before.OTHER);
    expect(after[legacy]).toBeUndefined();
    expect(after[key]).toBe(encoded);
    expect(updated).toContain('# configuración\r\n');
    expect(updated.match(new RegExp('^' + key + '=', 'gm'))).toHaveLength(1);
    expect(updated.replaceAll('\r\n', '')).not.toContain('\n');
  });
  it('preserves escaped quotes inside multiline values with dotted dotenv keys', () => {
    const original =
      "OTHER.KEY='primera \\' comilla\n" + legacy + "=valor interno\núltima'\n";
    const updated = adminPasswordEnvironment(original, encoded);
    expect(updated.startsWith(original)).toBe(true);
    expect(parse(updated)['OTHER.KEY']).toBe(parse(original)['OTHER.KEY']);
    expect(parse(updated)[key]).toBe(encoded);
  });

  it('creates a private file readable by dotenv with only a salted hash and supports rotation', async () => {
    const path = join(directory, '.env');
    await saveAdminPasswordEnvironment(path, encoded);
    const stored = parse(await readFile(path));
    expect(stored[key]).toBe(encoded);
    expect(
      await verifyAdminPasswordHash(
        stored[key],
        'Una contraseña elegida y privada',
      ),
    ).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const newer = await createAdminPasswordHash(
      'Otra contraseña de instalación',
    );
    await saveAdminPasswordEnvironment(path, newer);
    expect(parse(await readFile(path))[key]).toBe(newer);
    expect(
      await verifyAdminPasswordHash(newer, 'Una contraseña elegida y privada'),
    ).toBe(false);
    expect(await readdir(directory)).toEqual(['.env']);
  });
  it('does not overwrite an environment locked by another setup process', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'DATABASE_HOST=conservar\n');
    await writeFile(path + '.recovery-admin.lock', '');
    await expect(
      saveAdminPasswordEnvironment(path, encoded),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('DATABASE_HOST=conservar\n');
  });
  it('does not follow symlinks or leave a partial file after invalid input', async () => {
    const real = join(directory, 'real.env'),
      path = join(directory, '.env');
    await writeFile(real, 'DATABASE_HOST=conservar\n');
    await symlink(real, path);
    await expect(saveAdminPasswordEnvironment(path, encoded)).rejects.toThrow();
    expect(await readFile(real, 'utf8')).toBe('DATABASE_HOST=conservar\n');
    await expect(
      saveAdminPasswordEnvironment(join(directory, 'new.env'), 'invalid'),
    ).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual(['.env', 'real.env']);
  });
  it('refuses unterminated multiline settings without modifying the file', async () => {
    const path = join(directory, '.env');
    const original = 'DATABASE_PASSWORD="sin cierre\n';
    await writeFile(path, original);
    await expect(saveAdminPasswordEnvironment(path, encoded)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
