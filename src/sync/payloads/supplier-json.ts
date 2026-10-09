/** Validación compartida con SupplierJson de Dart. No convierte dinero/fechas. */
export class SupplierJson {
  static trim(value: string): string {
    return value.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
  }
  static requiredText(value: unknown, field: string): string {
    if (typeof value !== 'string' || this.trim(value) === '')
      throw new Error(`${field} debe ser texto no vacío.`);
    return this.trim(value);
  }
  static optionalText(value: unknown, field: string): string | null {
    if (value == null) return null;
    if (typeof value !== 'string')
      throw new Error(`${field} debe ser texto o null.`);
    return this.trim(value) || null;
  }
  static uuid(value: unknown, field: string): string {
    const id = this.requiredText(value, field).toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      )
    )
      throw new Error(`${field} debe ser un UUID v4.`);
    return id;
  }
  static integer(value: unknown, field: string, min = 0): number {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < min
    )
      throw new Error(
        `${field} debe ser entero entre ${min} y ${Number.MAX_SAFE_INTEGER}.`,
      );
    return value;
  }
  static object(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`${field} debe ser un objeto JSON.`);
    return value as Record<string, unknown>;
  }
}
