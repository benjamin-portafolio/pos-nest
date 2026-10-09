import { EventEntity } from '../../entities/event.entity';
import { PushEventDto } from '../dto/push-events.dto';
import { ProveedorCreadoPayload } from './proveedor-creado.payload';
import { ProveedorActualizadoPayload } from './proveedor-actualizado.payload';
import { ProductoCreadoPayload } from './producto-creado.payload';
import { ProductoActualizadoPayload } from './producto-actualizado.payload';
import { supplierBaseSequence } from './supplier-event-envelope';

function canonical(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  try {
    switch (type) {
      case ProveedorCreadoPayload.eventType:
        return ProveedorCreadoPayload.fromJson(payload).toJson();
      case ProveedorActualizadoPayload.eventType:
        return ProveedorActualizadoPayload.fromJson(payload).toJson();
      case ProductoCreadoPayload.eventType:
        return ProductoCreadoPayload.fromJson(payload).toJson({
          includeCategoryDependency: false,
          includeInventoryEventDependencies: false,
        });
      case ProductoActualizadoPayload.eventType:
        return ProductoActualizadoPayload.fromJson(payload).toJson();
    }
  } catch {
    /* Un rechazo también es una intención inmutable. */
  }
  return payload;
}
/** Compara JSON por valor, incluso si pg/Jest crean arrays en otro realm. */
function jsonValue(value: unknown): string {
  const normalize = (item: any): any =>
    Array.isArray(item)
      ? Array.from(item, normalize)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, normalize(item[key])]),
          )
        : item;
  return JSON.stringify(normalize(value));
}
function hasSuppliers(payload: Record<string, unknown>): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (
    Array.isArray(payload.variants) &&
    payload.variants.some((v) => v && typeof v === 'object' && 'suppliers' in v)
  )
    return true;
  return ['before', 'after'].some(
    (key) =>
      payload[key] != null &&
      typeof payload[key] === 'object' &&
      hasSuppliers(payload[key] as Record<string, unknown>),
  );
}
export function isSupplierContractEvent(event: PushEventDto): boolean {
  return (
    event?.event_type === ProveedorCreadoPayload.eventType ||
    event?.event_type === ProveedorActualizadoPayload.eventType ||
    (event?.aggregate_type === 'product' && hasSuppliers(event.payload))
  );
}
/** Conserva la deduplicación legada; verifica la intención de los contratos nuevos. */
export function supplierDuplicateMatches(
  event: PushEventDto,
  old: EventEntity,
): boolean {
  const relevant =
    event.aggregate_type === 'supplier' ||
    old.aggregateType === 'supplier' ||
    (event.aggregate_type === 'product' && hasSuppliers(event.payload)) ||
    (old.aggregateType === 'product' && hasSuppliers(old.payload));
  if (!relevant) return true;
  try {
    return (
      event.event_type === old.eventType &&
      event.aggregate_type === old.aggregateType &&
      event.aggregate_id.toLowerCase() === old.aggregateId.toLowerCase() &&
      event.device_id === old.deviceId &&
      event.user_id === old.userId &&
      (event.local_sequence ?? null) === old.localSequence &&
      (event.base_version ?? null) === old.baseVersion &&
      supplierBaseSequence(event.base_server_sequence) ===
        (old.baseServerSequence == null
          ? null
          : Number(old.baseServerSequence)) &&
      new Date(event.created_at_local).getTime() ===
        old.createdAtLocal.getTime() &&
      jsonValue(canonical(event.event_type, event.payload)) ===
        jsonValue(canonical(old.eventType, old.payload))
    );
  } catch {
    return false;
  }
}
