import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import {
  adminPasswordProblem,
  createAdminPasswordHash,
} from './recovery-admin-password';
import { saveAdminPasswordEnvironment } from './recovery-admin-environment';

/** Local operator only. No database connection, HTTP listener or automatic server restart. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Configurar contraseña administrativa: npm run admin:password -- [--env-file /ruta/al/.env]',
    );
    return;
  }
  if (
    args.length &&
    (args.length !== 2 || args[0] !== '--env-file' || !args[1])
  )
    throw new Error(
      'Argumentos inválidos. Usa --help. La contraseña no se acepta como argumento.',
    );
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error(
      'Ejecuta el asistente en una terminal interactiva. No acepta contraseñas por tubería.',
    );
  const envPath = args.length
    ? resolve(args[1])
    : resolve(__dirname, '..', '..', '.env');
  console.log(`Configuración administrativa del servidor. Archivo: ${envPath}`);
  console.log(
    'Se establecerá o reemplazará la contraseña administrativa. No cambia datos de negocio.',
  );
  const { default: password } = await import('@inquirer/password');
  const value = await password({
    message: 'Nueva contraseña (15 a 128 caracteres):',
    mask: false,
    toggleMask: false,
    validate: (input) => adminPasswordProblem(input) ?? true,
  });
  await password({
    message: 'Repite la contraseña:',
    mask: false,
    toggleMask: false,
    validate: (input) => input === value || 'Las contraseñas no coinciden.',
  });
  const encoded = await createAdminPasswordHash(value);
  await saveAdminPasswordEnvironment(envPath, encoded);
  console.log(
    'Contraseña administrativa guardada con Argon2id. No tiene caducidad automática.',
  );
  console.log(
    'Reinicia NestJS para aplicar el cambio e ingresa tu contraseña en Administración del servidor.',
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.error(
        'Configuración cancelada. No se guardó una nueva contraseña.',
      );
    } else {
      // Filesystem/terminal errors may contain private data; never dump the error object.
      console.error(
        'No se pudo guardar la contraseña. Revisa la terminal, argumentos, permisos y que no exista otro asistente en ejecución. Usa --help.',
      );
    }
    process.exitCode = 1;
  });
}
