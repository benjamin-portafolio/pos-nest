import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Acceso compartido a los fixtures JSON del contrato de ingresos/gastos
 * (carpeta `08 - Roadmap/Ingresos y gastos por sesiones/Fixtures` del repo de
 * análisis). Los tests de payload y handlers leen la misma revisión que Dart.
 * Se puede redirigir con `POS_FINANCIAL_FIXTURES` si el repo cambia de lugar;
 * el origen de los archivos vive en el proyecto de análisis, no en este repo.
 */
export const FINANCIAL_FIXTURES_ROOT =
  process.env.POS_FINANCIAL_FIXTURES ||
  '/Users/benjamin/Library/CloudStorage/GoogleDrive-benjamin94833@gmail.com/My Drive/Projects/POS/analisis /08 - Roadmap/Ingresos y gastos por sesiones/Fixtures';

export function readFinancialFixture(
  relativePath: string,
): Record<string, unknown> {
  const raw = readFileSync(join(FINANCIAL_FIXTURES_ROOT, relativePath), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}
