import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { ProductEntity } from '../entities/product.entity';
import { UnitEntity } from '../entities/unit.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { SaleMode } from '../enums/sale-mode.enum';
import type { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import {
  ProductoCreadoPayload,
  productVariantNameRefId,
  type ProductoCreadoDependencyValue,
  type ProductoCreadoInventoryDependencyValue,
} from './payloads/producto-creado.payload';
import { SyncConflictService } from './sync-conflict.service';

interface DependencyIssue {
  kind: 'rejected' | 'conflict';
  reason: string;
}

@Injectable()
export class ProductoEventHandler {
  constructor(private readonly syncConflictService: SyncConflictService) {}

  supports(eventType: string): boolean {
    return eventType === ProductoCreadoPayload.eventType;
  }

  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const identityError = this.validateEventIdentity(event);
    if (identityError) {
      return this.rejectedResult(event.event_id, identityError);
    }

    let payload: ProductoCreadoPayload;
    try {
      payload = ProductoCreadoPayload.fromJson(event.payload);
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }

    const envelopeError = this.validateCreationEnvelope(event);
    if (envelopeError) {
      return this.saveRejectedEvent(manager, event, envelopeError);
    }

    const existingProduct = await manager.findOne(ProductEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (existingProduct && existingProduct.createdEventId !== event.event_id) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un artículo con id ${event.aggregate_id}.`,
        'aggregate_id_conflict',
        'product',
        event.aggregate_id,
        existingProduct.createdEventId,
      );
    }

    const existingVariants: ProductVariantEntity[] = [];
    for (const variant of payload.variants) {
      const existingVariant = await manager.findOne(ProductVariantEntity, {
        where: { id: variant.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        existingVariant &&
        existingVariant.createdEventId !== event.event_id
      ) {
        return this.saveConflict(
          manager,
          event,
          payload,
          `Ya existe una variante con id ${variant.id}.`,
          'variant_id_conflict',
          'product_variant',
          variant.id,
          existingVariant.createdEventId,
        );
      }
      if (variant.inventoryItemId) {
        const existingByInventory = await manager.findOne(
          ProductVariantEntity,
          {
            where: { inventoryItemId: variant.inventoryItemId },
            lock: { mode: 'pessimistic_write' },
          },
        );
        if (
          existingByInventory &&
          existingByInventory.id !== variant.id &&
          existingByInventory.createdEventId !== event.event_id
        ) {
          return this.saveConflict(
            manager,
            event,
            payload,
            `El recurso ${variant.inventoryItemId} ya pertenece a otra variante.`,
            'variant_inventory_item_conflict',
            'inventory_item',
            variant.inventoryItemId,
            existingByInventory.createdEventId,
          );
        }
      }
      if (existingVariant) existingVariants.push(existingVariant);
    }

    if (
      existingProduct?.createdEventId === event.event_id &&
      existingVariants.length === payload.variants.length
    ) {
      const existingEvent = await manager.findOneBy(EventEntity, {
        eventId: event.event_id,
      });
      if (existingEvent) return this.toResult(existingEvent, 'accepted');
    }

    if (payload.categoryId) {
      const category = await manager.findOne(CategoryEntity, {
        where: { id: payload.categoryId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!category) {
        return this.saveConflict(
          manager,
          event,
          payload,
          `No existe la categoría ${payload.categoryId}.`,
          'missing_dependency',
          'category',
          payload.categoryId,
          null,
        );
      }
      const dependency = payload.categoryDependency;
      const dependencyIssue =
        dependency?.dependsOnEventId === null || dependency === null
          ? null
          : await this.validateCategoryDependency(manager, dependency);
      if (dependencyIssue?.kind === 'conflict') {
        return this.saveConflict(
          manager,
          event,
          payload,
          dependencyIssue.reason,
          'dependency_failed',
          'category',
          category.id,
          category.lastEventId ?? category.createdEventId,
        );
      }
      if (dependencyIssue) {
        return this.saveRejectedEvent(manager, event, dependencyIssue.reason);
      }
    }

    let saleUnit: UnitEntity | null = null;
    if (payload.saleConfiguration.mode === SaleMode.MEASURED) {
      saleUnit = await manager.findOne(UnitEntity, {
        where: { unitId: payload.saleConfiguration.saleUnitId },
        lock: { mode: 'pessimistic_read' },
      });
      const unitError = this.validateMeasuredUnit(payload, saleUnit);
      if (unitError) {
        return this.saveRejectedEvent(manager, event, unitError);
      }
    }

    const resourceIds = new Set<string>();
    for (const variant of payload.variants) {
      if (variant.inventoryItemId) resourceIds.add(variant.inventoryItemId);
    }
    const inventoryItems = new Map<string, InventoryItemEntity>();
    for (const inventoryItemId of [...resourceIds].sort()) {
      const item = await manager.findOne(InventoryItemEntity, {
        where: { id: inventoryItemId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!item || !item.active) {
        return this.saveConflict(
          manager,
          event,
          payload,
          `No existe el recurso de inventario activo ${inventoryItemId}.`,
          'missing_dependency',
          'inventory_item',
          inventoryItemId,
          item?.lastEventId ?? item?.createdEventId ?? null,
        );
      }
      inventoryItems.set(inventoryItemId, item);
      const dependency = payload.inventoryDependencies.find(
        (candidate) => candidate.refId === inventoryItemId,
      )!;
      if (dependency.dependsOnEventId) {
        const issue = await this.validateInventoryDependency(
          manager,
          dependency,
        );
        if (issue?.kind === 'conflict') {
          return this.saveConflict(
            manager,
            event,
            payload,
            issue.reason,
            'dependency_failed',
            'inventory_item',
            item.id,
            item.lastEventId ?? item.createdEventId,
          );
        }
        if (issue) {
          return this.saveRejectedEvent(manager, event, issue.reason);
        }
      }
      const inventoryUnit = await manager.findOne(UnitEntity, {
        where: { unitId: item.defaultUnitId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!inventoryUnit || !inventoryUnit.active) {
        return this.saveRejectedEvent(
          manager,
          event,
          'La unidad del recurso de inventario no existe o está inactiva.',
        );
      }
    }

    for (const variant of payload.variants) {
      if (!variant.inventoryItemId) continue;
      const item = inventoryItems.get(variant.inventoryItemId)!;
      const inventoryUnit = await manager.findOne(UnitEntity, {
        where: { unitId: item.defaultUnitId },
        lock: { mode: 'pessimistic_read' },
      });
      const trackingError = this.validateInventoryTrackingUnit(
        payload,
        inventoryUnit,
        saleUnit,
      );
      if (trackingError) {
        return this.saveRejectedEvent(manager, event, trackingError);
      }
    }

    const canonicalEvent: PushEventDto = {
      ...event,
      payload: payload.toJson({
        includeCategoryDependency: false,
        includeInventoryEventDependencies: false,
      }),
    };
    const savedEvent = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.SYNCED,
    );
    await this.saveEventRefs(
      manager,
      canonicalEvent,
      payload,
      savedEvent.serverSequence,
    );

    if (!existingProduct) {
      const product = await manager.save(
        manager.create(ProductEntity, {
          id: event.aggregate_id,
          name: payload.name,
          categoryId: payload.categoryId,
          saleMode: payload.saleConfiguration.mode,
          saleUnitId:
            payload.saleConfiguration.mode === SaleMode.MEASURED
              ? payload.saleConfiguration.saleUnitId
              : null,
          priceReferenceQuantityAtomic:
            payload.saleConfiguration.mode === SaleMode.MEASURED
              ? String(payload.saleConfiguration.priceReferenceQuantityAtomic)
              : null,
          active: true,
          version: 1,
          createdEventId: event.event_id,
          lastEventId: event.event_id,
          lastServerSequence: savedEvent.serverSequence,
        }),
      );
      await manager.save(
        payload.variants.map((variant) =>
          manager.create(ProductVariantEntity, {
            id: variant.id,
            productId: product.id,
            name: variant.name,
            nameKey: variant.nameKey,
            salePriceMinor: String(variant.salePriceMinor),
            standardCostMinor:
              variant.standardCostMinor === null
                ? null
                : String(variant.standardCostMinor),
            inventoryItemId: variant.inventoryItemId,
            isDefault: variant.isDefault,
            sortOrder: variant.sortOrder,
            active: true,
            version: 1,
            createdEventId: event.event_id,
            lastEventId: event.event_id,
            lastServerSequence: savedEvent.serverSequence,
          }),
        ),
      );
    }

    return this.toResult(savedEvent, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let payload: ProductoCreadoPayload;
    try {
      payload = ProductoCreadoPayload.fromJson(event.payload);
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }

    const existingProduct = await manager.findOneBy(ProductEntity, {
      id: event.aggregate_id,
    });
    if (existingProduct) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un artículo con id ${event.aggregate_id}.`,
        'aggregate_id_conflict',
        'product',
        event.aggregate_id,
        existingProduct.createdEventId,
      );
    }
    for (const variant of payload.variants) {
      const existingVariant = await manager.findOneBy(ProductVariantEntity, {
        id: variant.id,
      });
      if (existingVariant) {
        return this.saveConflict(
          manager,
          event,
          payload,
          `Ya existe una variante con id ${variant.id}.`,
          'variant_id_conflict',
          'product_variant',
          variant.id,
          existingVariant.createdEventId,
        );
      }
      if (variant.inventoryItemId) {
        const existingByInventory = await manager.findOneBy(
          ProductVariantEntity,
          { inventoryItemId: variant.inventoryItemId },
        );
        if (existingByInventory) {
          return this.saveConflict(
            manager,
            event,
            payload,
            `El recurso ${variant.inventoryItemId} ya pertenece a otra variante.`,
            'variant_inventory_item_conflict',
            'inventory_item',
            variant.inventoryItemId,
            existingByInventory.createdEventId,
          );
        }
      }
    }

    for (const variant of payload.variants) {
      if (variant.nameKey === null) continue;
      const existingByName = await manager.findOne(ProductVariantEntity, {
        where: {
          productId: event.aggregate_id,
          nameKey: variant.nameKey,
        },
      });
      if (existingByName) {
        const refId = productVariantNameRefId(
          event.aggregate_id,
          variant.nameKey,
        );
        return this.saveConflict(
          manager,
          event,
          payload,
          `Ya existe una variante con el nombre ${variant.name}.`,
          'variant_name_conflict',
          'product_variant_name',
          refId,
          existingByName.createdEventId,
        );
      }
    }

    const fallbackVariant = payload.variants[0];
    return this.saveConflict(
      manager,
      event,
      payload,
      'El evento chocó con una restricción única del servidor.',
      'variant_id_conflict',
      'product_variant',
      fallbackVariant.id,
      null,
    );
  }

  private validateCreationEnvelope(event: PushEventDto): string | null {
    if (event.aggregate_type !== ProductoCreadoPayload.aggregateType) {
      return 'producto_creado debe usar aggregate_type product.';
    }
    if (event.base_version !== 1) {
      return 'producto_creado requiere base_version = 1.';
    }
    if (
      event.base_server_sequence !== null &&
      event.base_server_sequence !== undefined
    ) {
      return 'producto_creado requiere base_server_sequence = null.';
    }
    return null;
  }

  private validateMeasuredUnit(
    payload: ProductoCreadoPayload,
    unit: UnitEntity | null,
  ): string | null {
    if (payload.saleConfiguration.mode !== SaleMode.MEASURED) return null;
    if (!unit) return 'No existe la unidad de venta seleccionada.';
    if (!unit.active) return 'La unidad de venta seleccionada no está activa.';
    if (unit.dimension !== 'mass' && unit.dimension !== 'volume') {
      return 'La venta por fracción requiere una unidad de masa o volumen.';
    }
    if (
      Number(unit.atomicFactor) !==
      payload.saleConfiguration.priceReferenceQuantityAtomic
    ) {
      return 'La referencia del precio debe coincidir con atomicFactor.';
    }
    return null;
  }

  private validateInventoryTrackingUnit(
    payload: ProductoCreadoPayload,
    inventoryUnit: UnitEntity | null,
    saleUnit: UnitEntity | null,
  ): string | null {
    if (!inventoryUnit || !inventoryUnit.active) {
      return 'La unidad del recurso de inventario no existe o está inactiva.';
    }
    if (payload.saleConfiguration.mode === SaleMode.UNIT) {
      if (
        inventoryUnit.dimension !== 'count' ||
        Number(inventoryUnit.atomicFactor) !== 1
      ) {
        return 'La venta por unidad requiere seguimiento de inventario en piezas.';
      }
      return null;
    }
    if (!saleUnit || saleUnit.dimension !== inventoryUnit.dimension) {
      return 'La unidad de inventario debe tener la misma dimensión que la venta.';
    }
    return null;
  }

  private validateEventIdentity(event: PushEventDto): string | null {
    if (!this.isUuidV4(event.event_id)) {
      return 'event_id de producto_creado debe ser un UUID v4.';
    }
    if (!this.isUuidV4(event.aggregate_id)) {
      return 'aggregate_id de producto_creado debe ser un UUID v4.';
    }
    return null;
  }

  private async validateCategoryDependency(
    manager: EntityManager,
    dependency: ProductoCreadoDependencyValue,
  ): Promise<DependencyIssue | null> {
    const baseEvent = await manager.findOneBy(EventEntity, {
      eventId: dependency.dependsOnEventId!,
    });
    if (!baseEvent) {
      return dependency.allowsMissingEvent
        ? null
        : {
            kind: 'conflict',
            reason:
              'No existe el evento de creación de la categoría seleccionada.',
          };
    }

    if (!dependency.isLegacy) {
      if (
        baseEvent.eventType !== 'categoria_creada' ||
        baseEvent.aggregateType !== 'category' ||
        baseEvent.aggregateId !== dependency.refId
      ) {
        return {
          kind: 'rejected',
          reason:
            'La dependencia no corresponde a la creación de la categoría seleccionada.',
        };
      }
    } else if (
      baseEvent.aggregateType !== 'category' ||
      baseEvent.aggregateId !== dependency.refId
    ) {
      const matchingRef = await manager.findOneBy(EventRefEntity, {
        eventId: baseEvent.eventId,
        refType: 'category',
        refId: dependency.refId,
        relationship: 'affects',
      });
      if (!matchingRef) {
        return {
          kind: 'rejected',
          reason: 'El evento base no afectó a la categoría seleccionada.',
        };
      }
    }
    if (baseEvent.syncStatus !== EventSyncStatus.SYNCED) {
      return {
        kind: 'conflict',
        reason: 'La creación de la categoría no fue aceptada por el servidor.',
      };
    }
    return null;
  }

  private async validateInventoryDependency(
    manager: EntityManager,
    dependency: ProductoCreadoInventoryDependencyValue,
  ): Promise<DependencyIssue | null> {
    const baseEvent = await manager.findOneBy(EventEntity, {
      eventId: dependency.dependsOnEventId!,
    });
    if (!baseEvent) {
      return {
        kind: 'conflict',
        reason:
          'No existe el evento de creación del recurso de inventario seleccionado.',
      };
    }
    if (
      baseEvent.eventType !== 'recurso_inventario_creado' ||
      baseEvent.aggregateType !== 'inventory_item' ||
      baseEvent.aggregateId !== dependency.refId
    ) {
      return {
        kind: 'rejected',
        reason:
          'La dependencia no corresponde a la creación del recurso de inventario seleccionado.',
      };
    }
    if (baseEvent.syncStatus !== EventSyncStatus.SYNCED) {
      return {
        kind: 'conflict',
        reason: 'La creación del recurso de inventario no fue aceptada.',
      };
    }
    return null;
  }

  private async saveRejectedEvent(
    manager: EntityManager,
    event: PushEventDto,
    reason: string,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.REJECTED,
      reason,
    );
    return this.toResult(saved, 'rejected', reason);
  }

  private async saveConflict(
    manager: EntityManager,
    event: PushEventDto,
    payload: ProductoCreadoPayload,
    reason: string,
    conflictType: string,
    refType: string,
    refId: string,
    defaultWinnerEventId: string | null,
  ): Promise<PushEventResultDto> {
    const canonicalEvent: PushEventDto = {
      ...event,
      payload: payload.toJson(),
    };
    const saved = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveEventRefs(
      manager,
      canonicalEvent,
      payload,
      saved.serverSequence,
    );
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType,
      refType,
      refId,
      reason,
      losingEvent: saved,
      defaultWinnerEventId,
    });
    return this.toResult(saved, 'conflict', reason, conflict.conflictId);
  }

  private saveEvent(
    manager: EntityManager,
    event: PushEventDto,
    syncStatus: EventSyncStatus,
    rejectionReason: string | null = null,
  ): Promise<EventEntity> {
    return manager.save(
      manager.create(EventEntity, {
        eventId: event.event_id,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        eventType: event.event_type,
        deviceId: event.device_id,
        userId: event.user_id,
        localSequence: event.local_sequence ?? null,
        baseServerSequence:
          event.base_server_sequence === null ||
          event.base_server_sequence === undefined
            ? null
            : String(event.base_server_sequence),
        baseVersion: event.base_version ?? null,
        createdAtLocal: new Date(event.created_at_local),
        payload: event.payload,
        syncStatus,
        rejectionReason,
      }),
    );
  }

  private async saveEventRefs(
    manager: EntityManager,
    event: PushEventDto,
    payload: ProductoCreadoPayload,
    serverSequence: string,
  ): Promise<void> {
    const rawValues = [
      {
        refType: 'product',
        refId: event.aggregate_id,
        relationship: 'affects',
      },
      ...payload.variants.flatMap((variant) => [
        {
          refType: 'product_variant',
          refId: variant.id,
          relationship: 'affects',
        },
        ...(variant.nameKey === null
          ? []
          : [
              {
                refType: 'product_variant_name',
                refId: productVariantNameRefId(
                  event.aggregate_id,
                  variant.nameKey,
                ),
                relationship: 'requires_unique',
              },
            ]),
      ]),
      ...payload.inventoryDependencies.map((dependency) => ({
        refType: 'inventory_item',
        refId: dependency.refId,
        relationship: 'uses',
      })),
      ...(payload.categoryId
        ? [
            {
              refType: 'category',
              refId: payload.categoryId,
              relationship: 'uses',
            },
          ]
        : []),
      ...(payload.saleConfiguration.mode === SaleMode.MEASURED
        ? [
            {
              refType: 'unit',
              refId: payload.saleConfiguration.saleUnitId,
              relationship: 'uses',
            },
          ]
        : []),
    ];
    const values = [
      ...new Map(
        rawValues.map((value) => [
          `${value.refType}\u0000${value.refId}\u0000${value.relationship}`,
          value,
        ]),
      ).values(),
    ];
    await manager.save(
      values.map((value) =>
        manager.create(EventRefEntity, {
          eventRefId: randomUUID(),
          eventId: event.event_id,
          ...value,
          serverSequence,
          source: 'server',
        }),
      ),
    );
  }

  private toResult(
    event: EventEntity,
    status: PushEventResultDto['status'],
    reason?: string,
    conflictId?: string,
  ): PushEventResultDto {
    return {
      event_id: event.eventId,
      status,
      server_sequence: Number(event.serverSequence),
      created_at_server: event.createdAtServer.toISOString(),
      ...(reason ? { reason } : {}),
      ...(conflictId ? { conflict_id: conflictId } : {}),
    };
  }

  private rejectedResult(
    eventId: string | undefined,
    reason: string,
  ): PushEventResultDto {
    return {
      event_id: eventId ?? '',
      status: 'rejected',
      server_sequence: null,
      created_at_server: null,
      reason,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'payload de producto_creado inválido.';
  }

  private isUuidV4(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
