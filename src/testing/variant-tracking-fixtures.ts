import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Acceso compartido a los fixtures JSON del contrato de seguimiento de
 * existencias (carpeta `08 - Roadmap/Seguimiento de existencias/Fixtures` del
 * repo de análisis). Los tests de payload, migración y handlers leen la misma
 * revisión que Dart. Se puede redirigir con `POS_VARIANT_FIXTURES` si el repo
 * cambia de lugar; el origen de los archivos vive en el proyecto de análisis, no
 * en este repo.
 */
export const VARIANT_TRACKING_FIXTURES_ROOT =
  process.env.POS_VARIANT_FIXTURES ||
  '/Users/benjamin/Library/CloudStorage/GoogleDrive-benjamin94833@gmail.com/My Drive/Projects/POS/analisis /08 - Roadmap/Seguimiento de existencias/Fixtures';

export function readVariantTrackingFixture(
  relativePath: string,
): Record<string, unknown> {
  const raw = readFileSync(
    join(VARIANT_TRACKING_FIXTURES_ROOT, relativePath),
    'utf8',
  );
  return JSON.parse(raw) as Record<string, unknown>;
}
