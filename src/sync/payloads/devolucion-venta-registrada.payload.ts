import {
  parseSaleAdjustmentPayload,
  SaleAdjustmentPayloadData,
} from './sale-adjustment-data';
export class DevolucionVentaRegistradaPayload {
  static readonly aggregateType = 'sale';
  static readonly eventType = 'devolucion_venta_registrada';
  private constructor(readonly adjustment: SaleAdjustmentPayloadData) {}
  static fromJson(
    json: Record<string, unknown>,
  ): DevolucionVentaRegistradaPayload {
    const p = parseSaleAdjustmentPayload(json);
    if (p.kind !== 'return' || p.schema_version !== 1)
      throw new Error('Tipo o versión inválidos.');
    return new DevolucionVentaRegistradaPayload(p);
  }
  toJson(): Record<string, unknown> {
    return { ...this.adjustment };
  }
}
