import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Copias literales de los fixtures Dart; el manifiesto registra SHA256 de ambos. */
export function supplierFixture(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(
      resolve(__dirname, '../../test/fixtures/suppliers_v1', `${name}.json`),
      'utf8',
    ),
  );
}
