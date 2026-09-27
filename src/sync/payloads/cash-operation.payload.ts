import { PushEventDto } from '../dto/push-events.dto';
import { CashBindingPayload } from './cash-binding.payload';
import { VentaConfirmadaPayload } from './venta-confirmada.payload';
import { AbonoClienteRegistradoPayload } from './abono-cliente-registrado.payload';
import { MovimientoFinancieroRegistradoPayload } from './movimiento-financiero-registrado.payload';
/** Derivación tipada del origen real: no acepta importes separados del pago. */
export class CashOperationPayload {
  private constructor(readonly cash: CashBindingPayload,readonly sourceType: string,readonly sourceId: string,readonly direction: string,readonly amountMinor: number) {}
  static hasBinding(e: PushEventDto): boolean { return [VentaConfirmadaPayload.eventType,AbonoClienteRegistradoPayload.eventType,MovimientoFinancieroRegistradoPayload.eventType].includes(e.event_type) && e.payload.cash!=null; }
  static fromEvent(e: PushEventDto): CashOperationPayload | null {
    switch(e.event_type) {
      case VentaConfirmadaPayload.eventType: { const p=VentaConfirmadaPayload.fromJson(e.payload); return p.cash ? new CashOperationPayload(p.cash,'sale_payment',p.paymentId!,'in',p.totalMinor) : null; }
      case AbonoClienteRegistradoPayload.eventType: { const p=AbonoClienteRegistradoPayload.fromJson(e.payload); return p.cash ? new CashOperationPayload(p.cash,'customer_payment',e.aggregate_id,'in',p.amountMinor) : null; }
      case MovimientoFinancieroRegistradoPayload.eventType: { const p=MovimientoFinancieroRegistradoPayload.fromJson(e.payload); return p.cash ? new CashOperationPayload(p.cash,'financial_entry',e.aggregate_id,p.direction,p.amountMinor) : null; }
      default: return null;
    }
  }
}
