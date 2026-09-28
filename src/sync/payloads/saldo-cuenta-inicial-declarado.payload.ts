import { integer } from './venta-confirmada.payload';

/**
 * Saldo inicial declarado de la cuenta bancaria unica.
 *
 * Hecho unico e inmutable, declarado una sola vez desde cualquier terminal y sin
 * sesion asociada: no abre ni cierra nada y no lleva binding de caja.
 *
 * `amount_minor` ADMITE NEGATIVO a proposito. Una cuenta sobregirada es una
 * declaracion legitima y recortarla a cero corromperia el estimado en silencio.
 * Es la unica divergencia de rango frente al resto del esquema, y coincide con
 * el validador `bankBalanceMinor` de la app.
 *
 * `as_of_ms` es la FRONTERA: el saldo declarado cubre todo lo anterior a ese
 * instante. La Fase 4 suma solo los movimientos posteriores.
 */
export class SaldoCuentaInicialDeclaradoPayload {
  static readonly aggregateType = 'account_balance_baseline';
  static readonly eventType = 'saldo_cuenta_inicial_declarado';
  /** Slot unico GLOBAL: el `refId` es constante, no el `device_id`. */
  static readonly slotRefType = 'account_balance_slot';
  static readonly slotRefId = 'unica';
  private constructor(readonly amountMinor: number, readonly asOfMs: number) {}
  static fromJson(p: Record<string, unknown>): SaldoCuentaInicialDeclaradoPayload {
    return new SaldoCuentaInicialDeclaradoPayload(
      bankBalanceMinor(p.amount_minor),
      integer(p.as_of_ms, 1),
    );
  }
  /** No hay nada previo: el hecho no depende de ningun otro evento. */
  get dependencyEventIds(): string[] {
    return [];
  }
  toJson(): Record<string, unknown> {
    return { amount_minor: this.amountMinor, as_of_ms: this.asOfMs };
  }
}

/**
 * Saldo en centavos con signo, rango simetrico al entero seguro. Se apoya en el
 * validador `integer` de existencia probada: la unica diferencia es que el minimo
 * es negativo, porque la cuenta puede estar sobregirada.
 */
export function bankBalanceMinor(value: unknown): number {
  return integer(value, -9007199254740991);
}
