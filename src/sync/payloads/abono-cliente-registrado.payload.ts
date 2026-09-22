import { requiredUuidV4 } from './inventory-movement.payload';
export class AbonoClienteRegistradoPayload {
  static readonly aggregateType = 'customer_payment';
  static readonly eventType = 'abono_cliente_registrado';
  private constructor(
    readonly clienteId: string,
    readonly clienteEventId: string,
    readonly amountMinor: number,
    readonly method: string,
    readonly reference: string | null,
    readonly occurredAtMs: number,
  ) {}
  static fromJson(j: Record<string, unknown>): AbonoClienteRegistradoPayload {
    if (
      j.currency !== 'MXN' ||
      !Number.isSafeInteger(j.occurred_at_ms) ||
      (j.occurred_at_ms as number) <= 0 ||
      !Number.isSafeInteger(j.amount_minor) ||
      (j.amount_minor as number) <= 0 ||
      !['cash', 'transfer'].includes(j.method as string) ||
      (j.reference != null && typeof j.reference !== 'string')
    )
      throw new Error('Abono inválido.');
    const reference = (j.reference as string | null)?.trim() || null;
    if ((reference?.length ?? 0) > 500)
      throw new Error('Referencia demasiado larga.');
    return new AbonoClienteRegistradoPayload(
      requiredUuidV4(j.cliente_id, 'cliente_id'),
      requiredUuidV4(j.cliente_event_id, 'cliente_event_id'),
      j.amount_minor as number,
      j.method as string,
      reference,
      j.occurred_at_ms as number,
    );
  }
  toJson(): Record<string, unknown> {
    return {
      cliente_id: this.clienteId,
      cliente_event_id: this.clienteEventId,
      amount_minor: this.amountMinor,
      occurred_at_ms: this.occurredAtMs,
      method: this.method,
      reference: this.reference,
      currency: 'MXN',
    };
  }
}
