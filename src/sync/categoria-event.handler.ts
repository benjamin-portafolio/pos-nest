import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { ProductEntity } from '../entities/product.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import type { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { SyncConflictService } from './sync-conflict.service';
import { CategoriaEliminadaPayload } from './payloads/categoria-eliminada.payload';

interface CategoriaCreadaPayload {
  name: string;
  colorKey: string;
  sortOrder: number;
}

type CategoriaMutableField = 'name' | 'color_key';

interface CategoriaFieldChange<T> {
  from: T;
  to: T;
}

interface CategoriaActualizadaPayload {
  baseEventId: string;
  changedFields: CategoriaMutableField[];
  name: CategoriaFieldChange<string> | null;
  colorKey: CategoriaFieldChange<string> | null;
}

interface CategoriaMovidaPayload {
  baseEventId: string;
  fromOrder: number;
  toOrder: number;
  displacedCategoryId: string;
  displacedBaseEventId: string;
  displacedBaseVersion: number;
  displacedBaseServerSequence: number | null;
  displacedFromOrder: number;
  displacedToOrder: number;
}

const CATEGORIA_CREADA = 'categoria_creada';
const CATEGORIA_ACTUALIZADA = 'categoria_actualizada';
const CATEGORIA_MOVIDA = 'categoria_movida';
const CATEGORY_SORT_ORDER_FIELD = 'sort_order';
const CATEGORY_MUTABLE_FIELDS = new Set<CategoriaMutableField>([
  'name',
  'color_key',
]);

const CATEGORY_COLOR_KEYS = new Set([
  'neutral',
  'amber',
  'blue',
  'blue_grey',
  'brown',
  'cyan',
  'deep_orange',
  'deep_purple',
  'green',
  'grey',
  'indigo',
  'light_blue',
  'light_green',
  'lime',
  'orange',
  'pink',
  'purple',
  'red',
  'teal',
  'yellow',
]);

@Injectable()
export class CategoriaEventHandler {
  constructor(private readonly syncConflictService: SyncConflictService) {}

  supports(eventType: string): boolean {
    return (
      eventType === CATEGORIA_CREADA ||
      eventType === CATEGORIA_ACTUALIZADA ||
      eventType === CATEGORIA_MOVIDA ||
      eventType === CategoriaEliminadaPayload.eventType
    );
  }

  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    if (event.event_type === CATEGORIA_CREADA) {
      return this.applyCategoriaCreada(manager, event);
    }
    if (event.event_type === CATEGORIA_ACTUALIZADA) {
      return this.applyCategoriaActualizada(manager, event);
    }
    if (event.event_type === CATEGORIA_MOVIDA) {
      return this.applyCategoriaMovida(manager, event);
    }
    if (event.event_type === CategoriaEliminadaPayload.eventType) {
      return this.applyCategoriaEliminada(manager, event);
    }

    return this.saveRejectedEvent(
      manager,
      event,
      `Evento de categoría no soportado: ${event.event_type}.`,
    );
  }

  private async applyCategoriaCreada(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const payload = this.parseCategoriaCreadaPayload(event.payload);
    if ('error' in payload) {
      return this.saveRejectedEvent(manager, event, payload.error);
    }

    await this.lockCategoryOrder(manager);
    const existing = await manager.findOne(CategoryEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing && existing.createdEventId !== event.event_id) {
      return this.saveAggregateConflict(manager, event, existing);
    }

    const sortOrder = await this.nextSortOrder(manager);
    const canonicalEvent = {
      ...event,
      payload: {
        name: payload.name,
        color_key: payload.colorKey,
        sort_order: sortOrder,
      },
    };
    const savedEvent = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.SYNCED,
    );
    await this.saveEventRef(manager, canonicalEvent, savedEvent.serverSequence);

    if (!existing) {
      await manager.save(
        manager.create(CategoryEntity, {
          id: event.aggregate_id,
          name: payload.name,
          colorKey: payload.colorKey,
          sortOrder,
          active: true,
          version: event.base_version ?? 1,
          createdEventId: event.event_id,
          lastEventId: event.event_id,
          lastServerSequence: savedEvent.serverSequence,
        }),
      );
    }

    return this.toResult(savedEvent, 'accepted');
  }

  private async applyCategoriaActualizada(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const payload = this.parseCategoriaActualizadaPayload(event.payload);
    if ('error' in payload) {
      return this.saveRejectedEvent(manager, event, payload.error);
    }
    if (event.base_version === null || event.base_version === undefined) {
      if (
        event.base_server_sequence === null ||
        event.base_server_sequence === undefined
      ) {
        return this.saveRejectedEvent(
          manager,
          event,
          'categoria_actualizada requiere base_version o base_server_sequence.',
        );
      }
    }

    const existing = await manager.findOne(CategoryEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!existing) {
      return this.saveUpdateConflict(
        manager,
        event,
        null,
        'No existe la categoría que se intenta actualizar.',
        'missing_aggregate',
      );
    }

    const invalidBase = this.validateUpdateBase(event, existing);
    if (invalidBase) {
      return this.saveRejectedEvent(manager, event, invalidBase);
    }

    const conflictingFields = await this.findConflictingFields(
      manager,
      event,
      payload,
      existing,
    );
    if (conflictingFields.length > 0) {
      return this.saveUpdateConflict(
        manager,
        event,
        existing,
        `La categoría cambió en los campos: ${conflictingFields.join(', ')}.`,
        'concurrent_field_update',
      );
    }

    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.SYNCED,
    );
    await this.saveEventRef(manager, event, savedEvent.serverSequence);

    if (payload.name) existing.name = payload.name.to;
    if (payload.colorKey) existing.colorKey = payload.colorKey.to;
    existing.version += 1;
    existing.lastEventId = event.event_id;
    existing.lastServerSequence = savedEvent.serverSequence;
    await manager.save(existing);

    return this.toResult(savedEvent, 'accepted');
  }

  private async applyCategoriaMovida(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const payload = this.parseCategoriaMovidaPayload(event.payload);
    if ('error' in payload) {
      return this.saveRejectedEvent(manager, event, payload.error);
    }
    if (payload.displacedCategoryId === event.aggregate_id) {
      return this.saveRejectedEvent(
        manager,
        event,
        'categoria_movida requiere dos categorías diferentes.',
      );
    }
    if (
      event.base_version === null ||
      event.base_version === undefined ||
      !Number.isSafeInteger(event.base_version) ||
      event.base_version < 1
    ) {
      return this.saveRejectedEvent(
        manager,
        event,
        'categoria_movida requiere base_version entero >= 1.',
      );
    }
    const baseServerSequence = this.toNullableNumber(
      event.base_server_sequence,
    );
    if (
      event.base_server_sequence !== null &&
      event.base_server_sequence !== undefined &&
      (baseServerSequence === null || baseServerSequence < 0)
    ) {
      return this.saveRejectedEvent(
        manager,
        event,
        'base_server_sequence debe ser un entero >= 0.',
      );
    }

    await this.lockCategoryOrder(manager);
    const ids = [event.aggregate_id, payload.displacedCategoryId].sort();
    const locked = new Map<string, CategoryEntity>();
    for (const id of ids) {
      const category = await manager.findOne(CategoryEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (category) locked.set(id, category);
    }

    const moved = locked.get(event.aggregate_id) ?? null;
    const displaced = locked.get(payload.displacedCategoryId) ?? null;
    if (!moved || !displaced) {
      return this.saveMoveConflict(
        manager,
        event,
        payload,
        moved,
        displaced,
        'No existe una categoría involucrada en el movimiento.',
        'missing_aggregate',
      );
    }

    const invalidBase = this.validateMoveBase(event, payload, moved, displaced);
    if (invalidBase) {
      return this.saveMoveConflict(
        manager,
        event,
        payload,
        moved,
        displaced,
        invalidBase,
        'stale_category_move_base',
      );
    }

    if (
      moved.sortOrder !== payload.fromOrder ||
      displaced.sortOrder !== payload.displacedFromOrder
    ) {
      return this.saveMoveConflict(
        manager,
        event,
        payload,
        moved,
        displaced,
        'El orden oficial cambió para una categoría involucrada.',
        'concurrent_category_move',
      );
    }

    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.SYNCED,
    );
    await this.saveMoveEventRefs(
      manager,
      event,
      payload,
      savedEvent.serverSequence,
    );

    moved.sortOrder = payload.toOrder;
    moved.version += 1;
    moved.lastEventId = event.event_id;
    moved.lastServerSequence = savedEvent.serverSequence;
    displaced.sortOrder = payload.displacedToOrder;
    displaced.version += 1;
    displaced.lastEventId = event.event_id;
    displaced.lastServerSequence = savedEvent.serverSequence;
    await manager.save([moved, displaced]);

    return this.toResult(savedEvent, 'accepted');
  }

  private async applyCategoriaEliminada(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let payload: CategoriaEliminadaPayload;
    try {
      payload = CategoriaEliminadaPayload.fromJson(event.payload);
      payload.validateForSourceCategory(event.aggregate_id);
    } catch (error) {
      return this.saveRejectedEvent(
        manager,
        event,
        error instanceof Error ? error.message : 'Payload inválido.',
      );
    }
    if (
      !Number.isSafeInteger(event.base_version) ||
      Number(event.base_version) < 1
    ) {
      return this.saveRejectedEvent(
        manager,
        event,
        'categoria_eliminada requiere base_version entero >= 1.',
      );
    }
    if (
      payload.shiftedCategories.some(
        (category) => category.categoryId === event.aggregate_id,
      )
    ) {
      return this.saveRejectedEvent(
        manager,
        event,
        'shifted_categories no puede incluir la categoría eliminada.',
      );
    }
    const baseServerSequence = this.toNullableNumber(
      event.base_server_sequence,
    );
    if (
      event.base_server_sequence !== null &&
      event.base_server_sequence !== undefined &&
      (baseServerSequence === null || baseServerSequence < 0)
    ) {
      return this.saveRejectedEvent(
        manager,
        event,
        'base_server_sequence debe ser un entero >= 0 o null.',
      );
    }

    await this.lockCategoryOrder(manager);
    const categoryIds = (await manager.find(CategoryEntity))
      .map((category) => category.id)
      .sort();
    const lockedCategories: CategoryEntity[] = [];
    for (const categoryId of categoryIds) {
      const category = await manager.findOne(CategoryEntity, {
        where: { id: categoryId },
        lock: { mode: 'pessimistic_write' },
      });
      if (category) lockedCategories.push(category);
    }
    const ordered = lockedCategories.sort(
      (left, right) => left.sortOrder - right.sortOrder,
    );
    const existing =
      ordered.find((category) => category.id === event.aggregate_id) ?? null;
    if (!existing) {
      return this.saveDeleteConflict(
        manager,
        event,
        payload,
        null,
        'No existe la categoría que se intenta eliminar.',
        'missing_aggregate',
      );
    }

    const productResolution = payload.productResolution;
    const destination =
      productResolution.type === 'move'
        ? (ordered.find(
            (category) =>
              category.id === productResolution.destinationCategory.categoryId,
          ) ?? null)
        : null;
    if (productResolution.type === 'move' && !destination) {
      return this.saveDeleteConflict(
        manager,
        event,
        payload,
        existing,
        'No existe la categoría destino.',
        'missing_aggregate',
      );
    }
    if (
      productResolution.type === 'move' &&
      destination &&
      (!destination.active ||
        destination.version !==
          productResolution.destinationCategory.baseVersion ||
        (destination.lastEventId ?? destination.createdEventId) !==
          productResolution.destinationCategory.baseEventId ||
        (productResolution.destinationCategory.baseServerSequence !== null &&
          (destination.lastServerSequence === null ||
            Number(destination.lastServerSequence) !==
              productResolution.destinationCategory.baseServerSequence)))
    ) {
      return this.saveDeleteConflict(
        manager,
        event,
        payload,
        existing,
        'La categoría destino cambió oficialmente.',
        'concurrent_category_delete',
      );
    }

    const declaredProducts = [...payload.linkedProducts].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    );
    const lockedDeclaredProducts: ProductEntity[] = [];
    for (const declared of declaredProducts) {
      const product = await manager.findOne(ProductEntity, {
        where: { id: declared.productId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!product) {
        return this.saveDeleteConflict(
          manager,
          event,
          payload,
          existing,
          `No existe el artículo confirmado ${declared.productId}.`,
          'missing_aggregate',
        );
      }
      const baseMatches =
        product.categoryId === event.aggregate_id &&
        (product.lastEventId ?? product.createdEventId) ===
          declared.baseEventId &&
        product.version === declared.baseVersion &&
        (declared.baseServerSequence === null ||
          (product.lastServerSequence !== null &&
            Number(product.lastServerSequence) ===
              declared.baseServerSequence));
      if (!baseMatches) {
        return this.saveDeleteConflict(
          manager,
          event,
          payload,
          existing,
          `Cambió la categoría o la base del artículo ${declared.productId}.`,
          'concurrent_product_category_update',
        );
      }
      lockedDeclaredProducts.push(product);
    }

    const officialLinkedProducts = await manager.find(ProductEntity, {
      where: { categoryId: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    const officialLinkedIds = officialLinkedProducts
      .map((product) => product.id)
      .sort();
    const declaredIds = declaredProducts.map((product) => product.productId);
    if (
      officialLinkedIds.length !== declaredIds.length ||
      officialLinkedIds.some((id, index) => id !== declaredIds[index])
    ) {
      return this.saveDeleteConflict(
        manager,
        event,
        payload,
        existing,
        'El conjunto de artículos vinculados cambió oficialmente.',
        'category_linked_products_changed',
      );
    }

    const orderIsConsecutive = ordered.every(
      (category, index) => category.sortOrder === index,
    );
    const expectedShifted = ordered.filter(
      (category) => category.sortOrder > existing.sortOrder,
    );
    const snapshot = payload.deletedCategory;
    const baseMatches =
      orderIsConsecutive &&
      event.base_version === existing.version &&
      payload.baseEventId ===
        (existing.lastEventId ?? existing.createdEventId) &&
      (baseServerSequence === null ||
        (existing.lastServerSequence !== null &&
          baseServerSequence === Number(existing.lastServerSequence))) &&
      snapshot.name === existing.name &&
      snapshot.colorKey === existing.colorKey &&
      snapshot.sortOrder === existing.sortOrder &&
      snapshot.active === existing.active &&
      snapshot.createdEventId === existing.createdEventId &&
      expectedShifted.length === payload.shiftedCategories.length &&
      expectedShifted.every((category, index) => {
        const declared = payload.shiftedCategories[index];
        return (
          declared.categoryId === category.id &&
          declared.baseEventId ===
            (category.lastEventId ?? category.createdEventId) &&
          declared.baseVersion === category.version &&
          (declared.baseServerSequence === null ||
            (category.lastServerSequence !== null &&
              declared.baseServerSequence ===
                Number(category.lastServerSequence))) &&
          declared.fromOrder === category.sortOrder &&
          declared.toOrder === category.sortOrder - 1
        );
      });
    if (!baseMatches) {
      return this.saveDeleteConflict(
        manager,
        event,
        payload,
        existing,
        'La categoría, su base o el orden cambiaron oficialmente.',
        'concurrent_category_delete',
      );
    }

    const canonicalEvent = { ...event, payload: payload.toJson() };
    const savedEvent = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.SYNCED,
    );
    await this.saveDeleteEventRefs(
      manager,
      canonicalEvent,
      payload,
      savedEvent.serverSequence,
    );
    for (let index = 0; index < lockedDeclaredProducts.length; index++) {
      const product = lockedDeclaredProducts[index];
      const declared = declaredProducts[index];
      product.categoryId = declared.toCategoryId;
      product.version += 1;
      product.lastEventId = event.event_id;
      product.lastServerSequence = savedEvent.serverSequence;
    }
    if (lockedDeclaredProducts.length > 0) {
      await manager.save(lockedDeclaredProducts);
    }
    await manager.remove(existing);
    for (const category of expectedShifted) {
      category.sortOrder -= 1;
      category.version += 1;
      category.lastEventId = event.event_id;
      category.lastServerSequence = savedEvent.serverSequence;
    }
    if (expectedShifted.length > 0) await manager.save(expectedShifted);

    return this.toResult(savedEvent, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const payload = this.parseCategoriaCreadaPayload(event.payload);
    if ('error' in payload) {
      return this.saveRejectedEvent(manager, event, payload.error);
    }

    const existing = await manager.findOneBy(CategoryEntity, {
      id: event.aggregate_id,
    });
    return this.saveAggregateConflict(manager, event, existing);
  }

  private parseCategoriaCreadaPayload(
    payload: Record<string, unknown>,
  ): CategoriaCreadaPayload | { error: string } {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') {
      return { error: 'payload.name es obligatorio.' };
    }

    if (
      typeof payload.color_key !== 'string' ||
      !CATEGORY_COLOR_KEYS.has(payload.color_key)
    ) {
      return { error: 'payload.color_key no pertenece a la paleta permitida.' };
    }

    const sortOrder = this.readNonNegativeInteger(payload.sort_order);
    if (sortOrder === null) {
      return { error: 'payload.sort_order debe ser un entero >= 0.' };
    }

    return {
      name: payload.name.trim(),
      colorKey: payload.color_key,
      sortOrder,
    };
  }

  private parseCategoriaMovidaPayload(
    payload: Record<string, unknown>,
  ): CategoriaMovidaPayload | { error: string } {
    if (
      typeof payload.base_event_id !== 'string' ||
      payload.base_event_id.trim() === ''
    ) {
      return { error: 'payload.base_event_id es obligatorio.' };
    }
    if (
      !Array.isArray(payload.changed_fields) ||
      payload.changed_fields.length !== 1 ||
      payload.changed_fields[0] !== CATEGORY_SORT_ORDER_FIELD
    ) {
      return {
        error: 'categoria_movida requiere changed_fields = [sort_order].',
      };
    }
    if (!this.isRecord(payload.changes)) {
      return { error: 'payload.changes es obligatorio.' };
    }
    const orderChange = this.readIntegerChange(
      payload.changes,
      CATEGORY_SORT_ORDER_FIELD,
    );
    if ('error' in orderChange) return orderChange;

    if (!this.isRecord(payload.displaced_category)) {
      return { error: 'payload.displaced_category es obligatorio.' };
    }
    const displaced = payload.displaced_category;
    if (
      typeof displaced.category_id !== 'string' ||
      displaced.category_id.trim() === ''
    ) {
      return {
        error: 'displaced_category.category_id es obligatorio.',
      };
    }
    if (
      typeof displaced.base_event_id !== 'string' ||
      displaced.base_event_id.trim() === ''
    ) {
      return {
        error: 'displaced_category.base_event_id es obligatorio.',
      };
    }
    const displacedBaseVersion = this.readPositiveInteger(
      displaced.base_version,
    );
    if (displacedBaseVersion === null) {
      return {
        error: 'displaced_category.base_version debe ser un entero >= 1.',
      };
    }
    const displacedBaseServerSequence = this.toNullableNumber(
      displaced.base_server_sequence as string | number | null | undefined,
    );
    if (
      displaced.base_server_sequence !== null &&
      displaced.base_server_sequence !== undefined &&
      (displacedBaseServerSequence === null || displacedBaseServerSequence < 0)
    ) {
      return {
        error:
          'displaced_category.base_server_sequence debe ser un entero >= 0 o null.',
      };
    }
    const displacedOrderChange = this.readIntegerChange(
      displaced,
      CATEGORY_SORT_ORDER_FIELD,
    );
    if ('error' in displacedOrderChange) return displacedOrderChange;

    if (
      Math.abs(orderChange.from - displacedOrderChange.from) !== 1 ||
      orderChange.to !== displacedOrderChange.from ||
      displacedOrderChange.to !== orderChange.from
    ) {
      return {
        error: 'categoria_movida debe intercambiar posiciones consecutivas.',
      };
    }

    return {
      baseEventId: payload.base_event_id.trim(),
      fromOrder: orderChange.from,
      toOrder: orderChange.to,
      displacedCategoryId: displaced.category_id.trim(),
      displacedBaseEventId: displaced.base_event_id.trim(),
      displacedBaseVersion,
      displacedBaseServerSequence,
      displacedFromOrder: displacedOrderChange.from,
      displacedToOrder: displacedOrderChange.to,
    };
  }

  private parseCategoriaActualizadaPayload(
    payload: Record<string, unknown>,
  ): CategoriaActualizadaPayload | { error: string } {
    if (
      typeof payload.base_event_id !== 'string' ||
      payload.base_event_id.trim() === ''
    ) {
      return { error: 'payload.base_event_id es obligatorio.' };
    }
    if (
      !Array.isArray(payload.changed_fields) ||
      payload.changed_fields.length === 0
    ) {
      return { error: 'payload.changed_fields es obligatorio.' };
    }

    const changedFields: CategoriaMutableField[] = [];
    for (const field of payload.changed_fields) {
      if (
        typeof field !== 'string' ||
        !CATEGORY_MUTABLE_FIELDS.has(field as CategoriaMutableField) ||
        changedFields.includes(field as CategoriaMutableField)
      ) {
        return { error: 'payload.changed_fields contiene campos inválidos.' };
      }
      changedFields.push(field as CategoriaMutableField);
    }

    if (!this.isRecord(payload.changes)) {
      return { error: 'payload.changes es obligatorio.' };
    }

    let name: CategoriaFieldChange<string> | null = null;
    let colorKey: CategoriaFieldChange<string> | null = null;

    if (changedFields.includes('name')) {
      const change = this.readStringChange(payload.changes, 'name');
      if ('error' in change) return change;
      const from = change.from.trim();
      const to = change.to.trim();
      if (!from || !to) {
        return { error: 'changes.name.from y to son obligatorios.' };
      }
      if (from === to) {
        return { error: 'changes.name debe modificar el valor.' };
      }
      name = { from, to };
    }

    if (changedFields.includes('color_key')) {
      const change = this.readStringChange(payload.changes, 'color_key');
      if ('error' in change) return change;
      if (
        !CATEGORY_COLOR_KEYS.has(change.from) ||
        !CATEGORY_COLOR_KEYS.has(change.to)
      ) {
        return {
          error:
            'changes.color_key.from y to deben pertenecer a la paleta permitida.',
        };
      }
      if (change.from === change.to) {
        return { error: 'changes.color_key debe modificar el valor.' };
      }
      colorKey = change;
    }

    return {
      baseEventId: payload.base_event_id.trim(),
      changedFields,
      name,
      colorKey,
    };
  }

  private readStringChange(
    changes: Record<string, unknown>,
    field: CategoriaMutableField,
  ): CategoriaFieldChange<string> | { error: string } {
    const change = changes[field];
    if (
      !this.isRecord(change) ||
      typeof change.from !== 'string' ||
      typeof change.to !== 'string'
    ) {
      return { error: `changes.${field}.from y to son obligatorios.` };
    }
    return { from: change.from, to: change.to };
  }

  private readIntegerChange(
    source: Record<string, unknown>,
    field: string,
  ): CategoriaFieldChange<number> | { error: string } {
    const change = source[field];
    if (!this.isRecord(change)) {
      return { error: `${field}.from y to son obligatorios.` };
    }
    const from = this.readNonNegativeInteger(change.from);
    const to = this.readNonNegativeInteger(change.to);
    if (from === null || to === null || from === to) {
      return {
        error: `${field}.from y to deben ser enteros >= 0 diferentes.`,
      };
    }
    return { from, to };
  }

  private readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  }

  private readPositiveInteger(value: unknown): number | null {
    const parsed = this.readNonNegativeInteger(value);
    return parsed !== null && parsed >= 1 ? parsed : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private validateUpdateBase(
    event: PushEventDto,
    existing: CategoryEntity,
  ): string | null {
    const baseVersion = event.base_version;
    if (
      baseVersion !== null &&
      baseVersion !== undefined &&
      (!Number.isInteger(baseVersion) ||
        baseVersion < 1 ||
        baseVersion > existing.version)
    ) {
      return 'base_version no es válida para la categoría actual.';
    }

    const baseServerSequence = this.toNullableNumber(
      event.base_server_sequence,
    );
    if (
      event.base_server_sequence !== null &&
      event.base_server_sequence !== undefined &&
      (baseServerSequence === null || baseServerSequence < 0)
    ) {
      return 'base_server_sequence debe ser un entero >= 0.';
    }
    const currentServerSequence = this.toNullableNumber(
      existing.lastServerSequence,
    );
    if (
      baseServerSequence !== null &&
      currentServerSequence !== null &&
      baseServerSequence > currentServerSequence
    ) {
      return 'base_server_sequence es posterior al estado de la categoría.';
    }

    return null;
  }

  private validateMoveBase(
    event: PushEventDto,
    payload: CategoriaMovidaPayload,
    moved: CategoryEntity,
    displaced: CategoryEntity,
  ): string | null {
    const movedBaseError = this.validateUpdateBase(event, moved);
    if (movedBaseError) return movedBaseError;

    if (payload.displacedBaseVersion > displaced.version) {
      return 'displaced_category.base_version es posterior a la categoría.';
    }
    const displacedCurrentServerSequence = this.toNullableNumber(
      displaced.lastServerSequence,
    );
    if (
      payload.displacedBaseServerSequence !== null &&
      displacedCurrentServerSequence !== null &&
      payload.displacedBaseServerSequence > displacedCurrentServerSequence
    ) {
      return 'displaced_category.base_server_sequence es posterior al estado oficial.';
    }
    return null;
  }

  private async findConflictingFields(
    manager: EntityManager,
    event: PushEventDto,
    payload: CategoriaActualizadaPayload,
    existing: CategoryEntity,
  ): Promise<CategoriaMutableField[]> {
    const conflicts = new Set<CategoriaMutableField>();
    const baseVersion = event.base_version;
    const baseServerSequence = this.toNullableNumber(
      event.base_server_sequence,
    );

    if (
      baseVersion !== null &&
      baseVersion !== undefined &&
      baseVersion !== existing.version &&
      baseServerSequence === null
    ) {
      payload.changedFields.forEach((field) => conflicts.add(field));
    }

    if (baseServerSequence !== null) {
      const intervening = await manager
        .getRepository(EventEntity)
        .createQueryBuilder('event')
        .where('event.aggregate_type = :aggregateType', {
          aggregateType: 'category',
        })
        .andWhere('event.aggregate_id = :aggregateId', {
          aggregateId: event.aggregate_id,
        })
        .andWhere('event.sync_status = :syncStatus', {
          syncStatus: EventSyncStatus.SYNCED,
        })
        .andWhere('event.server_sequence > :baseServerSequence', {
          baseServerSequence,
        })
        .orderBy('event.server_sequence', 'ASC')
        .getMany();

      for (const acceptedEvent of intervening) {
        const fields = acceptedEvent.payload['changed_fields'];
        if (!Array.isArray(fields)) continue;
        for (const field of fields) {
          if (
            typeof field === 'string' &&
            payload.changedFields.includes(field as CategoriaMutableField)
          ) {
            conflicts.add(field as CategoriaMutableField);
          }
        }
      }
    }

    if (payload.name && existing.name !== payload.name.from) {
      conflicts.add('name');
    }
    if (payload.colorKey && existing.colorKey !== payload.colorKey.from) {
      conflicts.add('color_key');
    }

    return payload.changedFields.filter((field) => conflicts.has(field));
  }

  private async saveRejectedEvent(
    manager: EntityManager,
    event: PushEventDto,
    reason: string,
  ): Promise<PushEventResultDto> {
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.REJECTED,
      reason,
    );
    return this.toResult(savedEvent, 'rejected', reason);
  }

  private async saveAggregateConflict(
    manager: EntityManager,
    event: PushEventDto,
    existing: CategoryEntity | null,
  ): Promise<PushEventResultDto> {
    const reason = `Ya existe una categoría con id ${event.aggregate_id}.`;
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveEventRef(manager, event, savedEvent.serverSequence);
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType: 'aggregate_id_conflict',
      refType: 'category',
      refId: event.aggregate_id,
      reason,
      losingEvent: savedEvent,
      defaultWinnerEventId: existing?.createdEventId ?? null,
    });

    return this.toResult(savedEvent, 'conflict', reason, conflict.conflictId);
  }

  private async saveUpdateConflict(
    manager: EntityManager,
    event: PushEventDto,
    existing: CategoryEntity | null,
    reason: string,
    conflictType: string,
  ): Promise<PushEventResultDto> {
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveEventRef(manager, event, savedEvent.serverSequence);
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType,
      refType: 'category',
      refId: event.aggregate_id,
      reason,
      losingEvent: savedEvent,
      defaultWinnerEventId:
        existing?.lastEventId ?? existing?.createdEventId ?? null,
    });

    return this.toResult(savedEvent, 'conflict', reason, conflict.conflictId);
  }

  private async saveMoveConflict(
    manager: EntityManager,
    event: PushEventDto,
    payload: CategoriaMovidaPayload,
    moved: CategoryEntity | null,
    displaced: CategoryEntity | null,
    reason: string,
    conflictType: string,
  ): Promise<PushEventResultDto> {
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveMoveEventRefs(
      manager,
      event,
      payload,
      savedEvent.serverSequence,
    );
    const winner = [moved, displaced]
      .filter((value): value is CategoryEntity => value !== null)
      .sort(
        (left, right) =>
          Number(right.lastServerSequence ?? -1) -
          Number(left.lastServerSequence ?? -1),
      )[0];
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType,
      refType: 'category',
      refId: event.aggregate_id,
      reason,
      losingEvent: savedEvent,
      defaultWinnerEventId:
        winner?.lastEventId ?? winner?.createdEventId ?? null,
    });

    return this.toResult(savedEvent, 'conflict', reason, conflict.conflictId);
  }

  private async saveDeleteConflict(
    manager: EntityManager,
    event: PushEventDto,
    payload: CategoriaEliminadaPayload,
    existing: CategoryEntity | null,
    reason: string,
    conflictType: string,
  ): Promise<PushEventResultDto> {
    const canonicalEvent = { ...event, payload: payload.toJson() };
    const savedEvent = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveDeleteEventRefs(
      manager,
      canonicalEvent,
      payload,
      savedEvent.serverSequence,
    );
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType,
      refType: 'category',
      refId: event.aggregate_id,
      reason,
      losingEvent: savedEvent,
      defaultWinnerEventId:
        existing?.lastEventId ?? existing?.createdEventId ?? null,
    });
    return this.toResult(savedEvent, 'conflict', reason, conflict.conflictId);
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

  private async saveEventRef(
    manager: EntityManager,
    event: PushEventDto,
    serverSequence: string,
  ): Promise<void> {
    await manager.save(
      manager.create(EventRefEntity, {
        eventRefId: randomUUID(),
        eventId: event.event_id,
        refType: 'category',
        refId: event.aggregate_id,
        relationship: 'affects',
        serverSequence,
        source: 'server',
      }),
    );
  }

  private async saveMoveEventRefs(
    manager: EntityManager,
    event: PushEventDto,
    payload: CategoriaMovidaPayload,
    serverSequence: string,
  ): Promise<void> {
    await manager.save(
      [event.aggregate_id, payload.displacedCategoryId].map((categoryId) =>
        manager.create(EventRefEntity, {
          eventRefId: randomUUID(),
          eventId: event.event_id,
          refType: 'category',
          refId: categoryId,
          relationship: 'affects',
          serverSequence,
          source: 'server',
        }),
      ),
    );
  }

  private async saveDeleteEventRefs(
    manager: EntityManager,
    event: PushEventDto,
    payload: CategoriaEliminadaPayload,
    serverSequence: string,
  ): Promise<void> {
    const refs: Array<{
      refType: string;
      refId: string;
      relationship: string;
    }> = [
      {
        refType: 'category',
        refId: event.aggregate_id,
        relationship: 'affects',
      },
      ...payload.shiftedCategories.map((category) => ({
        refType: 'category',
        refId: category.categoryId,
        relationship: 'affects',
      })),
      ...payload.linkedProducts.map((product) => ({
        refType: 'product',
        refId: product.productId,
        relationship: 'affects',
      })),
    ];
    if (payload.productResolution.type === 'move') {
      refs.push({
        refType: 'category',
        refId: payload.productResolution.destinationCategory.categoryId,
        relationship: 'uses',
      });
    }
    await manager.save(
      refs.map((ref) =>
        manager.create(EventRefEntity, {
          eventRefId: randomUUID(),
          eventId: event.event_id,
          ...ref,
          serverSequence,
          source: 'server',
        }),
      ),
    );
  }

  private async lockCategoryOrder(manager: EntityManager): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'pos.category_order',
    ]);
  }

  private async nextSortOrder(manager: EntityManager): Promise<number> {
    const categories = await manager.find(CategoryEntity);
    if (categories.length === 0) return 0;
    return Math.max(...categories.map((category) => category.sortOrder)) + 1;
  }

  private toNullableNumber(
    value: string | number | null | undefined,
  ): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
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
}
