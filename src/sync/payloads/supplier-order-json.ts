import { rounded } from './venta-confirmada.payload';
export const SUPPLIER_ORDER_MAX_ITEMS = 50;
export const SUPPLIER_ORDER_MAX_PAYLOAD_BYTES = 81920;
export function orderRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Objeto requerido');
  return value as Record<string, unknown>;
}
export function orderInt(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('Entero fuera de rango');
  return value;
}
export function orderText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > max ||
    value !== value.trim()
  )
    throw new Error('Texto fuera de rango');
  return value;
}
export function orderUuid(value: unknown): string {
  const s = orderText(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      s,
    )
  )
    throw new Error('UUID v4 requerido');
  return s;
}
export function orderLines<T>(
  value: unknown,
  parse: (v: unknown) => T,
  key: (v: T) => string,
): readonly T[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > SUPPLIER_ORDER_MAX_ITEMS
  )
    throw new Error('Se requieren 1..50 partidas');
  const result = value.map(parse);
  if (new Set(result.map(key)).size !== result.length)
    throw new Error('Identidad duplicada');
  return Object.freeze(result);
}
export function orderPayloadSize(json: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(json), 'utf8') >
    SUPPLIER_ORDER_MAX_PAYLOAD_BYTES
  )
    throw new Error('Payload excede 80 KiB');
}
export function orderAmount(
  price: number,
  quantity: number,
  reference: number,
): number {
  orderInt(price);
  orderInt(quantity, 1);
  orderInt(reference, 1);
  return rounded(price, quantity, reference);
}
export function orderTotal(values: readonly (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  const sum = values.reduce<bigint>((a, b) => a + BigInt(b!), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Total fuera de rango');
  return Number(sum);
}
