import { assertRecoveryProductShape } from './recovery-product-shape';
import { validateRecoverySales } from './recovery-sales-validation';
import { validateRecoveryCash } from './recovery-cash-validation';
import { validateRecoveryReconciliations } from './recovery-reconciliation-validation';
import { RECOVERY_SIDECAR_COLUMNS } from './recovery-sidecar-schema';
import { VentaConfirmadaPayload } from '../sync/payloads/venta-confirmada.payload';
import { VentaAnuladaPayload } from '../sync/payloads/venta-anulada.payload';
import { DevolucionVentaRegistradaPayload } from '../sync/payloads/devolucion-venta-registrada.payload';
import { OperacionVentaConciliadaPayload } from '../sync/payloads/operacion-venta-conciliada.payload';
import { CajaAbiertaPayload } from '../sync/payloads/caja-abierta.payload';
import { CajaCerradaPayload } from '../sync/payloads/caja-cerrada.payload';
import { validateRecoveryCatalog } from './recovery-catalog-validation';
import {
  recoveryLegacyCatalogParser,
  RECOVERY_CATEGORY_DELETE,
} from './recovery-catalog-contract';
import { ProductoCreadoPayload } from '../sync/payloads/producto-creado.payload';
import { ProductoActualizadoPayload } from '../sync/payloads/producto-actualizado.payload';
import { AbonoClienteRegistradoPayload } from '../sync/payloads/abono-cliente-registrado.payload';
import { MovimientoFinancieroRegistradoPayload } from '../sync/payloads/movimiento-financiero-registrado.payload';
import { assertRecoveryPayloadShape } from './recovery-payload-shape';
import {
  validateRecoveryFinancial,
  RECOVERY_FINANCIAL_PARSERS,
} from './recovery-financial-validation';
import { createHash } from 'node:crypto';
import {
  recoveryEventReferences,
  recoveryReferenceContext,
} from './recovery-event-references';
import { validateRecoveryInventory } from './recovery-inventory-validation';
import { RecursoInventarioCreadoPayload } from '../sync/payloads/recurso-inventario-creado.payload';
import { RecursoInventarioActualizadoPayload } from '../sync/payloads/recurso-inventario-actualizado.payload';
import { RecursoInventarioEliminadoPayload } from '../sync/payloads/recurso-inventario-eliminado.payload';
import { MovimientoInventarioRegistradoPayload } from '../sync/payloads/movimiento-inventario-registrado.payload';
import {
  RECOVERY_COLUMNS,
  RECOVERY_KEYS,
  RECOVERY_VALIDATED_TABLES,
} from './recovery-logical-schema';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ProveedorCreadoPayload } from '../sync/payloads/proveedor-creado.payload';
import { ProveedorActualizadoPayload } from '../sync/payloads/proveedor-actualizado.payload';
import { ClienteCreadoPayload } from '../sync/payloads/cliente-creado.payload';
import { ClienteActualizadoPayload } from '../sync/payloads/cliente-actualizado.payload';
import { canonical } from './recovery-contract';
import { recoveryError } from './recovery-errors';
import { INVENTORY_UNIT_SEED } from '../inventory/inventory-unit-seed';

/** Authoritative validators are explicit. A family without one cannot be activated. */
@Injectable()
export class RecoveryValidationService {
  async check(m: EntityManager, manifest: any) {
    const allowed: readonly string[] = [
      ...RECOVERY_VALIDATED_TABLES,
      'event_provenance',
      'sale_presentation_metadata',
      ...Object.keys(RECOVERY_SIDECAR_COLUMNS),
    ];
    // Fail closed until commercial validators for the other S1 families are accredited.
    const unsupported = manifest.chunks
      .filter((c: any) => !allowed.includes(c.entity))
      .map((c: any) => c.entity);
    if (unsupported.length)
      recoveryError(412, 'unsupported_business_validation', {
        entities: [...new Set(unsupported)],
      });
    const [wireUnits] = await m.query(
      "SELECT count(*)::int AS n FROM recovery_rows WHERE recovery_id=$1 AND entity='units'",
      [manifest.recovery_id],
    );
    if (wireUnits.n !== INVENTORY_UNIT_SEED.length)
      recoveryError(422, 'incomplete_units');
    const units = await m.query('SELECT * FROM units ORDER BY unit_id');
    if (
      units.length !== INVENTORY_UNIT_SEED.length ||
      units.some(
        (u) =>
          !INVENTORY_UNIT_SEED.some(
            (s) =>
              u.unit_id === s.unitId &&
              u.code === s.code &&
              u.name === s.name &&
              u.symbol === s.symbol &&
              u.dimension === s.dimension &&
              String(u.atomic_factor) === String(s.atomicFactor) &&
              u.max_fraction_digits === s.maxFractionDigits &&
              u.active,
          ),
      )
    )
      recoveryError(422, 'invalid_seed_units');
    const [unitMismatch] = await m.query(
      `SELECT s.row_key FROM recovery_rows s JOIN units u ON u.unit_id::text=s.row_data->>'unit_id' WHERE s.recovery_id=$1 AND s.entity='units' AND s.row_data IS DISTINCT FROM (to_jsonb(u)||jsonb_build_object('atomic_factor',u.atomic_factor::text)) LIMIT 1`,
      [manifest.recovery_id],
    );
    if (unitMismatch) recoveryError(422, 'invalid_seed_units');
    const parsers = [
      ProveedorCreadoPayload,
      ProveedorActualizadoPayload,
      ClienteCreadoPayload,
      ClienteActualizadoPayload,
      RecursoInventarioCreadoPayload,
      RecursoInventarioActualizadoPayload,
      RecursoInventarioEliminadoPayload,
      MovimientoInventarioRegistradoPayload,
      ...RECOVERY_FINANCIAL_PARSERS,
      ProductoCreadoPayload,
      ProductoActualizadoPayload,
      RECOVERY_CATEGORY_DELETE,
      VentaConfirmadaPayload,
      VentaAnuladaPayload,
      DevolucionVentaRegistradaPayload,
      OperacionVentaConciliadaPayload,
      CajaAbiertaPayload,
      CajaCerradaPayload,
    ];
    let after = '';
    for (;;) {
      const events = await m.query(
        'SELECT * FROM events WHERE event_id::text>$1 ORDER BY event_id LIMIT 500',
        [after],
      );
      if (!events.length) break;
      for (const e of events) {
        after = e.event_id;
        const parser: any =
          parsers.find((p) => p.eventType === e.event_type) ??
          recoveryLegacyCatalogParser(e.event_type);
        if (!parser || parser.aggregateType !== e.aggregate_type)
          recoveryError(412, 'unsupported_event_contract', {
            event_id: e.event_id,
            event_type: e.event_type,
          });
        let typed: any;
        try {
          typed = parser.fromJson(e.payload);
        } catch {
          recoveryError(422, 'invalid_event_payload', { event_id: e.event_id });
        }
        try {
          if (
            e.aggregate_type === 'supplier' ||
            e.aggregate_type === 'cliente'
          ) {
            if (canonical(typed.toJson()) !== canonical(e.payload))
              throw new Error('Noncanonical identity contract');
          } else if (
            [
              ProductoCreadoPayload.eventType,
              ProductoActualizadoPayload.eventType,
            ].includes(e.event_type)
          ) {
            assertRecoveryProductShape(
              e.payload,
              e.event_type === ProductoActualizadoPayload.eventType,
            );
          } else
            assertRecoveryPayloadShape(
              e.payload,
              typed.toJson(),
              e.event_type === RecursoInventarioCreadoPayload.eventType
                ? ['inventory_item.origin_variant_id']
                : [
                      VentaConfirmadaPayload.eventType,
                      AbonoClienteRegistradoPayload.eventType,
                      MovimientoFinancieroRegistradoPayload.eventType,
                    ].includes(e.event_type)
                  ? ['cash']
                  : [],
            );
        } catch {
          recoveryError(422, 'noncanonical_event_payload', {
            event_id: e.event_id,
          });
        }
        if (
          BigInt(e.server_sequence) >
            BigInt(manifest.baseline_high_watermark) ||
          BigInt(e.server_sequence) <= 0n
        )
          recoveryError(422, 'invalid_high_watermark');
        if (
          e.event_type.endsWith('_creado') &&
          (e.base_version !== 1 || e.base_server_sequence !== null)
        )
          recoveryError(422, 'invalid_event_version');
        if (e.event_type.endsWith('_actualizado') && !e.payload.base_event_id)
          recoveryError(422, 'dependency_missing', { event_id: e.event_id });
        const dep = e.payload.base_event_id;
        if (dep && ['supplier', 'cliente'].includes(e.aggregate_type)) {
          const [prior] = await m.query(
            'SELECT * FROM events WHERE event_id=$1',
            [dep],
          );
          if (
            !prior ||
            canonical(prior.payload.after ?? prior.payload) !==
              canonical(e.payload.before) ||
            e.base_version !==
              (prior.event_type.endsWith('_creado')
                ? 1
                : prior.base_version + 1) ||
            (e.base_server_sequence !== null &&
              String(e.base_server_sequence) !==
                String(prior.server_sequence)) ||
            prior.sync_status !== 'synced' ||
            prior.aggregate_id !== e.aggregate_id ||
            prior.aggregate_type !== e.aggregate_type ||
            BigInt(prior.server_sequence) >= BigInt(e.server_sequence)
          )
            recoveryError(422, 'dependency_missing', {
              event_id: e.event_id,
              dependency: dep,
            });
        }
      }
    }
    for (const [table, pk, aggregate] of [
      ['suppliers', 'supplier_id', 'supplier'],
      ['clientes', 'cliente_id', 'cliente'],
    ]) {
      const bad = await m.query(
        `SELECT p."${pk}" AS id FROM "${table}" p LEFT JOIN events c ON c.event_id=p.created_event_id LEFT JOIN events e ON e.event_id=p.last_event_id WHERE c.sync_status IS DISTINCT FROM 'synced' OR e.sync_status IS DISTINCT FROM 'synced' OR c.aggregate_id<>p."${pk}" OR e.aggregate_id<>p."${pk}" OR c.aggregate_type<>$1 OR e.aggregate_type<>$1 OR p.last_server_sequence IS DISTINCT FROM e.server_sequence OR p.version<>CASE WHEN e.event_type LIKE '%_creado' THEN 1 ELSE e.base_version+1 END OR EXISTS(SELECT 1 FROM events n WHERE n.aggregate_id=e.aggregate_id AND n.aggregate_type=e.aggregate_type AND n.sync_status='synced' AND n.server_sequence>e.server_sequence) OR p.active IS DISTINCT FROM true OR c.event_type<>$2 LIMIT 1`,
        [
          aggregate,
          aggregate === 'supplier' ? 'proveedor_creado' : 'cliente_creado',
        ],
      );
      if (bad.length)
        recoveryError(422, 'dependency_missing', {
          entity: table,
          id: bad[0].id,
        });
      const mismatch = await m.query(
        `SELECT p."${pk}" AS id FROM "${table}" p JOIN events e ON e.event_id=p.last_event_id WHERE CASE WHEN e.event_type LIKE '%_actualizado' THEN e.payload->'after' ELSE e.payload END IS DISTINCT FROM ${table === 'suppliers' ? "jsonb_build_object('name',p.name,'phone',p.phone,'notes',p.notes)" : "jsonb_build_object('nombre',p.nombre,'telefono',p.telefono)"} LIMIT 1`,
      );
      if (mismatch.length)
        recoveryError(422, 'business_invariant', {
          entity: table,
          id: mismatch[0].id,
        });
    }
    // Validate both directions: a projection cannot lose its creator, and an
    // accredited creation cannot disappear just by omitting its entity chunk.
    for (const [table, pk, aggregate, creation] of [
      ['suppliers', 'supplier_id', 'supplier', 'proveedor_creado'],
      ['clientes', 'cliente_id', 'cliente', 'cliente_creado'],
    ]) {
      const [missing] = await m.query(
        `SELECT e.event_id,e.aggregate_id FROM events e LEFT JOIN "${table}" p ON p."${pk}"=e.aggregate_id WHERE e.sync_status='synced' AND e.aggregate_type=$1 AND e.event_type=$2 AND (p."${pk}" IS NULL OR p.created_event_id IS DISTINCT FROM e.event_id) LIMIT 1`,
        [aggregate, creation],
      );
      if (missing)
        recoveryError(422, 'missing_projection', {
          entity: table,
          id: missing.aggregate_id,
          event_id: missing.event_id,
        });
    }
    // S3 emits one provenance row for every shared event, including an event
    // without sufficient official metadata (the latter lives only in sidecars).
    const [missingProvenance] = await m.query(
      `SELECT e.event_id FROM events e LEFT JOIN recovery_rows p ON p.recovery_id=$1 AND p.entity='event_provenance' AND p.row_data->>'event_id'=e.event_id::text WHERE p.row_key IS NULL LIMIT 1`,
      [manifest.recovery_id],
    );
    if (missingProvenance)
      recoveryError(422, 'missing_event_provenance', missingProvenance);
    await validateRecoveryCatalog(m);
    await validateRecoverySales(m);
    await validateRecoveryReconciliations(m, manifest.recovery_id);
    await validateRecoveryCash(m);
    await validateRecoveryInventory(m);
    await validateRecoveryFinancial(m);
    let refCursor = '';
    for (;;) {
      const page = await m.query(
        'SELECT * FROM event_refs WHERE event_ref_id::text>$1 ORDER BY event_ref_id LIMIT 500',
        [refCursor],
      );
      if (!page.length) break;
      for (const ref of page) {
        refCursor = ref.event_ref_id;
        const [event] = await m.query(
          'SELECT * FROM events WHERE event_id=$1',
          [ref.event_id],
        );
        if (
          !event ||
          event.sync_status !== 'synced' ||
          !recoveryEventReferences(
            event,
            await recoveryReferenceContext(m, event),
          ).some((expected) => canonical(expected) === canonical(ref))
        )
          recoveryError(422, 'invalid_reference', {
            event_ref_id: ref.event_ref_id,
            event_id: ref.event_id,
            event_type: event?.event_type,
            ref_type: ref.ref_type,
            ref_id: ref.ref_id,
            relationship: ref.relationship,
          });
      }
    }
    let provenanceAfter = '';
    for (;;) {
      const page = await m.query(
        "SELECT row_key,row_data FROM recovery_rows WHERE recovery_id=$1 AND entity='event_provenance' AND row_key>$2 ORDER BY row_key LIMIT 200",
        [manifest.recovery_id, provenanceAfter],
      );
      if (!page.length) break;
      for (const row of page) {
        provenanceAfter = row.row_key;
        const p = row.row_data;
        const [e] = await m.query('SELECT * FROM events WHERE event_id=$1', [
          p.event_id,
        ]);
        if (p.non_official_evidence === null) {
          if (
            !e ||
            p.application_status !== 'applied' ||
            p.delivery_status !==
              (e.sync_status === 'synced' ? 'delivered' : e.sync_status)
          )
            recoveryError(422, 'invalid_event_provenance', {
              event_id: p.event_id,
            });
        } else {
          const raw = p.non_official_evidence;
          const fields = [
            'event_id',
            'aggregate_type',
            'aggregate_id',
            'event_type',
            'device_id',
            'user_id',
            'local_sequence',
            'server_sequence',
            'base_server_sequence',
            'base_version',
            'created_at_local',
            'created_at_server',
            'payload',
            'application_status',
            'delivery_status',
            'rejection_reason',
          ];
          if (
            e ||
            !raw ||
            Array.isArray(raw) ||
            Object.keys(raw).length !== fields.length ||
            fields.some((k) => !Object.hasOwn(raw, k)) ||
            raw.event_id !== p.event_id ||
            raw.application_status !== 'applied' ||
            raw.delivery_status !== p.delivery_status ||
            !['rejected', 'conflict'].includes(raw.delivery_status) ||
            (raw.server_sequence !== null && raw.created_at_server !== null) ||
            String(raw.local_sequence) !== p.observed_local_sequence
          )
            recoveryError(422, 'invalid_non_official_evidence', {
              event_id: p.event_id,
            });
          const parser: any =
            parsers.find((x) => x.eventType === raw.event_type) ??
            recoveryLegacyCatalogParser(raw.event_type);
          try {
            if (!parser || parser.aggregateType !== raw.aggregate_type)
              throw new Error();
            assertRecoveryPayloadShape(
              raw.payload,
              parser.fromJson(raw.payload).toJson(),
            );
          } catch {
            recoveryError(422, 'incompatible_non_official_evidence', {
              event_id: p.event_id,
            });
          }
        }
      }
    }
    const duplicateCreators = await m.query(
      "SELECT aggregate_id FROM events WHERE sync_status='synced' AND event_type IN ('proveedor_creado','cliente_creado') GROUP BY aggregate_type,aggregate_id HAVING count(*)>1 LIMIT 1",
    );
    if (duplicateCreators.length)
      recoveryError(422, 'duplicate_aggregate_creation');
    const summary: Record<string, unknown> = {};
    const rowDigests: Record<string, string> = {};
    for (const table of RECOVERY_VALIDATED_TABLES) {
      const [r] = await m.query(
        `SELECT count(*)::text AS count FROM "${table}"`,
      );
      const fields = Object.entries(RECOVERY_COLUMNS[table]).filter(
        ([c]) => !(table === 'events' && c === 'updated_at_server'),
      );
      const projection =
        'jsonb_build_object(' +
        fields
          .flatMap(([name, type]) => [
            "'" + name + "'",
            type === 'bigint' || type === 'numeric'
              ? `r."${name}"::text`
              : type === 'timestamptz'
                ? `to_char(r."${name}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
                : `r."${name}"`,
          ])
          .join(',') +
        ')';
      const keys = RECOVERY_KEYS[table];
      const join = keys
        .map((k) => `r."${k}"::text=s.row_data->>'${k}'`)
        .join(' AND ');
      const [mismatch] = await m.query(
        `SELECT s.row_key FROM recovery_rows s LEFT JOIN "${table}" r ON ${join} WHERE s.recovery_id=$1 AND s.entity=$2 AND ${projection} IS DISTINCT FROM ${table === 'events' ? "s.row_data-'updated_at_server'" : 's.row_data'} LIMIT 1`,
        [manifest.recovery_id, table],
      );
      if (mismatch)
        recoveryError(422, 'materialization_mismatch', {
          entity: table,
          key: mismatch.row_key,
        });
      const [expected] = await m.query(
        'SELECT count(*)::text AS n FROM recovery_rows WHERE recovery_id=$1 AND entity=$2',
        [manifest.recovery_id, table],
      );
      if (expected.n !== r.count)
        recoveryError(422, 'materialization_count', { entity: table });
      const hash = createHash('sha256');
      let key = '';
      for (;;) {
        const rows = await m.query(
          'SELECT row_key,row_data FROM recovery_rows WHERE recovery_id=$1 AND entity=$2 AND row_key>$3 ORDER BY row_key LIMIT 500',
          [manifest.recovery_id, table, key],
        );
        if (!rows.length) break;
        for (const row of rows) {
          hash.update(canonical(row.row_data) + '\n');
          key = row.row_key;
        }
      }
      rowDigests[table] = hash.digest('hex');
      summary[table] = r.count;
    }
    for (const entity of [
      'event_provenance',
      'sale_presentation_metadata',
      ...Object.keys(RECOVERY_SIDECAR_COLUMNS),
    ]) {
      const hash = createHash('sha256');
      let key = '',
        count = 0;
      for (;;) {
        const page = await m.query(
          'SELECT row_key,row_data FROM recovery_rows WHERE recovery_id=$1 AND entity=$2 AND row_key>$3 ORDER BY row_key LIMIT 200',
          [manifest.recovery_id, entity, key],
        );
        if (!page.length) break;
        for (const r of page) {
          key = r.row_key;
          hash.update(canonical(r.row_data) + '\n');
          count++;
        }
      }
      summary[entity] = String(count);
      rowDigests[entity] = hash.digest('hex');
    }
    summary.row_digests = rowDigests;
    return summary;
  }
}
