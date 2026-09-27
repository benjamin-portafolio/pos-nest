import { isDeepStrictEqual } from 'util';
import { EventEntity } from '../../entities/event.entity';
import { PushEventDto } from '../dto/push-events.dto';
import { CajaAbiertaPayload } from './caja-abierta.payload';
import { CajaCerradaPayload } from './caja-cerrada.payload';
import { VentaConfirmadaPayload } from './venta-confirmada.payload';
import { AbonoClienteRegistradoPayload } from './abono-cliente-registrado.payload';
import { MovimientoFinancieroRegistradoPayload } from './movimiento-financiero-registrado.payload';
import { CashOperationPayload } from './cash-operation.payload';
function canonical(type:string,p:Record<string,unknown>):Record<string,unknown> {
 switch(type){case CajaAbiertaPayload.eventType:return CajaAbiertaPayload.fromJson(p).toJson();case CajaCerradaPayload.eventType:return CajaCerradaPayload.fromJson(p).toJson();case VentaConfirmadaPayload.eventType:return VentaConfirmadaPayload.fromJson(p).toJson();case AbonoClienteRegistradoPayload.eventType:return AbonoClienteRegistradoPayload.fromJson(p).toJson();case MovimientoFinancieroRegistradoPayload.eventType:return MovimientoFinancieroRegistradoPayload.fromJson(p).toJson();default:return p;}
}
/** La respuesta perdida solo puede reconocer la misma intención inmutable. */
export function cashDuplicateMatches(e:PushEventDto,old:EventEntity):boolean {
 const prior={...e,event_type:old.eventType,payload:old.payload};
 try {
  const types=[CajaAbiertaPayload.eventType,CajaCerradaPayload.eventType];
  if(!types.includes(e.event_type) && !types.includes(old.eventType) && !CashOperationPayload.hasBinding(e) && !CashOperationPayload.hasBinding(prior)) return true;
  return e.event_type===old.eventType && e.aggregate_type===old.aggregateType && e.aggregate_id===old.aggregateId && e.device_id===old.deviceId && e.user_id===old.userId && e.base_version===old.baseVersion && e.base_server_sequence==null && new Date(e.created_at_local).getTime()===old.createdAtLocal.getTime() && isDeepStrictEqual(canonical(e.event_type,e.payload),canonical(old.eventType,old.payload));
 } catch {return false;}
}
