import {
  CategoriaEventContract,
  CATEGORIA_CREADA,
  CATEGORIA_ACTUALIZADA,
  CATEGORIA_MOVIDA,
} from '../sync/payloads/categoria-event-contract';
import { CategoriaEliminadaPayload } from '../sync/payloads/categoria-eliminada.payload';
import { recoveryAssert } from './recovery-business-validation';

/** Existing legacy category parsers, presented as the common pure parser port. */
export function recoveryLegacyCatalogParser(type: string) {
  const parse =
    type === CATEGORIA_CREADA
      ? CategoriaEventContract.parseCategoriaCreadaPayload.bind(
          CategoriaEventContract,
        )
      : type === CATEGORIA_ACTUALIZADA
        ? CategoriaEventContract.parseCategoriaActualizadaPayload.bind(
            CategoriaEventContract,
          )
        : type === CATEGORIA_MOVIDA
          ? CategoriaEventContract.parseCategoriaMovidaPayload.bind(
              CategoriaEventContract,
            )
          : null;
  if (parse)
    return {
      eventType: type,
      aggregateType: 'category',
      fromJson: (json: any) => {
        const p: any = parse(json);
        recoveryAssert(
          !p.error,
          'events',
          'category',
          p.error ?? 'invalid_payload',
        );
        const data =
          type === CATEGORIA_CREADA
            ? { name: p.name, color_key: p.colorKey, sort_order: p.sortOrder }
            : type === CATEGORIA_ACTUALIZADA
              ? {
                  base_event_id: p.baseEventId,
                  changed_fields: p.changedFields,
                  changes: {
                    ...(p.name ? { name: p.name } : {}),
                    ...(p.colorKey ? { color_key: p.colorKey } : {}),
                  },
                }
              : {
                  base_event_id: p.baseEventId,
                  changed_fields: ['sort_order'],
                  changes: { sort_order: { from: p.fromOrder, to: p.toOrder } },
                  displaced_category: {
                    category_id: p.displacedCategoryId,
                    base_event_id: p.displacedBaseEventId,
                    base_version: p.displacedBaseVersion,
                    base_server_sequence: p.displacedBaseServerSequence,
                    sort_order: {
                      from: p.displacedFromOrder,
                      to: p.displacedToOrder,
                    },
                  },
                };
        return { toJson: () => data };
      },
    };
  if (type === 'espacio_creado')
    return {
      eventType: type,
      aggregateType: 'espacio',
      fromJson: (j: any) => {
        recoveryAssert(
          typeof j.nombre === 'string' &&
            !!j.nombre.trim() &&
            (j.identificacion === null ||
              typeof j.identificacion === 'string') &&
            [0, 1, 'sin_restriccion', 'solo_restringido'].includes(
              j.visibilidad,
            ),
          'events',
          type,
          'invalid_payload',
        );
        return {
          toJson: () => ({
            nombre: j.nombre.trim(),
            identificacion: j.identificacion,
            visibilidad:
              j.visibilidad === 'sin_restriccion'
                ? 0
                : j.visibilidad === 'solo_restringido'
                  ? 1
                  : j.visibilidad,
          }),
        };
      },
    };
  return null;
}
export const RECOVERY_CATEGORY_DELETE = CategoriaEliminadaPayload;
