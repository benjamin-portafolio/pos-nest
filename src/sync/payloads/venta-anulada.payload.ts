import {
  parseSaleAdjustmentPayload,
  SaleAdjustmentPayloadData,
} from './sale-adjustment-data';
export class VentaAnuladaPayload {
  static readonly aggregateType = 'sale';
  static readonly eventType = 'venta_anulada';
  private constructor(readonly adjustment: SaleAdjustmentPayloadData) {}
  static fromJson(json: Record<string, unknown>): VentaAnuladaPayload {
    const p = parseSaleAdjustmentPayload(json);
    if (p.kind !== 'void' || p.schema_version !== 1)
      throw new Error('Tipo o versión inválidos.');
    return new VentaAnuladaPayload(p);
  }
  toJson(): Record<string, unknown> {
    return { ...this.adjustment };
  }
}
