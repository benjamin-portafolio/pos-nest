export type CategoriaEliminadaResolutionType = 'none' | 'move' | 'uncategorize';

export class CategoriaEliminadaPayload {
  static readonly aggregateType = 'category';
  static readonly eventType = 'categoria_eliminada';

  private constructor(
    readonly baseEventId: string,
    readonly deletedCategory: CategoriaEliminadaSnapshot,
    readonly productResolution: CategoriaEliminadaProductResolution,
    readonly linkedProducts: CategoriaEliminadaLinkedProduct[],
    readonly shiftedCategories: CategoriaEliminadaShiftedCategory[],
  ) {}

  static fromJson(payload: Record<string, unknown>): CategoriaEliminadaPayload {
    const deleted = requiredRecord(
      payload.deleted_category,
      'deleted_category',
    );
    const resolution = parseResolution(
      requiredRecord(payload.product_resolution, 'product_resolution'),
    );
    if (!Array.isArray(payload.linked_products)) {
      throw new Error(
        'categoria_eliminada requiere linked_products como arreglo.',
      );
    }
    if (!Array.isArray(payload.shifted_categories)) {
      throw new Error(
        'categoria_eliminada requiere shifted_categories como arreglo.',
      );
    }

    const colorKey = requiredString(
      deleted.color_key,
      'deleted_category.color_key',
    );
    if (!CATEGORY_COLOR_KEYS.has(colorKey)) {
      throw new Error(
        'deleted_category.color_key no pertenece a la paleta permitida.',
      );
    }
    const snapshot: CategoriaEliminadaSnapshot = {
      name: requiredString(deleted.name, 'deleted_category.name'),
      colorKey,
      sortOrder: nonNegativeInteger(
        deleted.sort_order,
        'deleted_category.sort_order',
      ),
      active: requiredBoolean(deleted.active, 'deleted_category.active'),
      createdEventId: requiredString(
        deleted.created_event_id,
        'deleted_category.created_event_id',
      ),
    };

    const linked = payload.linked_products.map((value, index) => {
      const item = requiredRecord(value, `linked_products[${index}]`);
      const category = requiredRecord(
        item.category_id,
        `linked_products[${index}].category_id`,
      );
      if (!hasOwn(category, 'from') || !hasOwn(category, 'to')) {
        throw new Error(
          `linked_products[${index}].category_id requiere from y to.`,
        );
      }
      const to = category.to;
      if (to !== null && typeof to !== 'string') {
        throw new Error(
          `linked_products[${index}].category_id.to debe ser string o null.`,
        );
      }
      return {
        productId: requiredString(
          item.product_id,
          `linked_products[${index}].product_id`,
        ),
        baseEventId: requiredString(
          item.base_event_id,
          `linked_products[${index}].base_event_id`,
        ),
        baseVersion: positiveInteger(
          item.base_version,
          `linked_products[${index}].base_version`,
        ),
        baseServerSequence: nullableNonNegativeInteger(
          item.base_server_sequence,
          `linked_products[${index}].base_server_sequence`,
        ),
        fromCategoryId: requiredString(
          category.from,
          `linked_products[${index}].category_id.from`,
        ),
        toCategoryId:
          to === null
            ? null
            : requiredString(to, `linked_products[${index}].category_id.to`),
      };
    });
    validateLinkedProducts(resolution, linked);

    const ids = new Set<string>();
    const shifted = payload.shifted_categories.map((value, index) => {
      const item = requiredRecord(value, `shifted_categories[${index}]`);
      const order = requiredRecord(
        item.sort_order,
        `shifted_categories[${index}].sort_order`,
      );
      const from = nonNegativeInteger(
        order.from,
        `shifted_categories[${index}].sort_order.from`,
      );
      const to = nonNegativeInteger(
        order.to,
        `shifted_categories[${index}].sort_order.to`,
      );
      const categoryId = requiredString(
        item.category_id,
        `shifted_categories[${index}].category_id`,
      );
      if (!ids.add(categoryId)) {
        throw new Error('shifted_categories no puede repetir categorías.');
      }
      const expectedFrom = snapshot.sortOrder + index + 1;
      if (from !== expectedFrom || to !== from - 1) {
        throw new Error(
          'shifted_categories debe ser consecutivo y cumplir to = from - 1.',
        );
      }
      return {
        categoryId,
        baseEventId: requiredString(
          item.base_event_id,
          `shifted_categories[${index}].base_event_id`,
        ),
        baseVersion: positiveInteger(
          item.base_version,
          `shifted_categories[${index}].base_version`,
        ),
        baseServerSequence: nullableNonNegativeInteger(
          item.base_server_sequence,
          `shifted_categories[${index}].base_server_sequence`,
        ),
        fromOrder: from,
        toOrder: to,
      };
    });

    return new CategoriaEliminadaPayload(
      requiredString(payload.base_event_id, 'base_event_id'),
      snapshot,
      resolution,
      linked,
      shifted,
    );
  }

  validateForSourceCategory(sourceCategoryId: string): void {
    const source = requiredString(sourceCategoryId, 'source_category_id');
    if (
      this.productResolution.type === 'move' &&
      this.productResolution.destinationCategory.categoryId === source
    ) {
      throw new Error(
        'La categoría destino debe ser diferente de la categoría eliminada.',
      );
    }
    if (
      this.linkedProducts.some((product) => product.fromCategoryId !== source)
    ) {
      throw new Error(
        'linked_products.category_id.from debe ser la categoría eliminada.',
      );
    }
  }

  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      deleted_category: {
        name: this.deletedCategory.name,
        color_key: this.deletedCategory.colorKey,
        sort_order: this.deletedCategory.sortOrder,
        active: this.deletedCategory.active,
        created_event_id: this.deletedCategory.createdEventId,
      },
      product_resolution: resolutionToJson(this.productResolution),
      linked_products: this.linkedProducts.map((product) => ({
        product_id: product.productId,
        base_event_id: product.baseEventId,
        base_version: product.baseVersion,
        base_server_sequence: product.baseServerSequence,
        category_id: {
          from: product.fromCategoryId,
          to: product.toCategoryId,
        },
      })),
      shifted_categories: this.shiftedCategories.map((category) => ({
        category_id: category.categoryId,
        base_event_id: category.baseEventId,
        base_version: category.baseVersion,
        base_server_sequence: category.baseServerSequence,
        sort_order: {
          from: category.fromOrder,
          to: category.toOrder,
        },
      })),
    };
  }
}

export interface CategoriaEliminadaSnapshot {
  name: string;
  colorKey: string;
  sortOrder: number;
  active: boolean;
  createdEventId: string;
}

export interface CategoriaEliminadaDestinationCategory {
  categoryId: string;
  baseEventId: string;
  baseVersion: number;
  baseServerSequence: number | null;
}

export type CategoriaEliminadaProductResolution =
  | { type: 'none' }
  | {
      type: 'move';
      destinationCategory: CategoriaEliminadaDestinationCategory;
    }
  | { type: 'uncategorize' };

export interface CategoriaEliminadaLinkedProduct {
  productId: string;
  baseEventId: string;
  baseVersion: number;
  baseServerSequence: number | null;
  fromCategoryId: string;
  toCategoryId: string | null;
}

export interface CategoriaEliminadaShiftedCategory {
  categoryId: string;
  baseEventId: string;
  baseVersion: number;
  baseServerSequence: number | null;
  fromOrder: number;
  toOrder: number;
}

function parseResolution(
  value: Record<string, unknown>,
): CategoriaEliminadaProductResolution {
  if (typeof value.type !== 'string') {
    throw new Error('product_resolution.type debe ser string.');
  }
  switch (value.type) {
    case 'none':
      if (hasOwn(value, 'destination_category')) {
        throw new Error('La resolución none no admite destination_category.');
      }
      return { type: 'none' };
    case 'move': {
      if (!hasOwn(value, 'destination_category')) {
        throw new Error('La resolución move requiere destination_category.');
      }
      const destination = requiredRecord(
        value.destination_category,
        'product_resolution.destination_category',
      );
      return {
        type: 'move',
        destinationCategory: {
          categoryId: requiredString(
            destination.category_id,
            'destination_category.category_id',
          ),
          baseEventId: requiredString(
            destination.base_event_id,
            'destination_category.base_event_id',
          ),
          baseVersion: positiveInteger(
            destination.base_version,
            'destination_category.base_version',
          ),
          baseServerSequence: nullableNonNegativeInteger(
            destination.base_server_sequence,
            'destination_category.base_server_sequence',
          ),
        },
      };
    }
    case 'uncategorize':
      if (hasOwn(value, 'destination_category')) {
        throw new Error(
          'La resolución uncategorize no admite destination_category.',
        );
      }
      return { type: 'uncategorize' };
    default:
      throw new Error(
        'product_resolution.type debe ser none, move o uncategorize.',
      );
  }
}

function validateLinkedProducts(
  resolution: CategoriaEliminadaProductResolution,
  linked: CategoriaEliminadaLinkedProduct[],
): void {
  let previousId: string | null = null;
  for (const product of linked) {
    if (
      previousId !== null &&
      previousId.localeCompare(product.productId) >= 0
    ) {
      throw new Error(
        'linked_products debe estar ordenado por product_id y no repetir IDs.',
      );
    }
    previousId = product.productId;
  }

  if (resolution.type === 'none' && linked.length !== 0) {
    throw new Error('La resolución none requiere linked_products vacío.');
  }
  if (
    resolution.type === 'move' &&
    linked.some(
      (product) =>
        product.toCategoryId !== resolution.destinationCategory.categoryId,
    )
  ) {
    throw new Error(
      'Todos los productos movidos deben usar la categoría destino.',
    );
  }
  if (
    resolution.type === 'uncategorize' &&
    linked.some((product) => product.toCategoryId !== null)
  ) {
    throw new Error(
      'La resolución uncategorize requiere category_id.to = null.',
    );
  }
}

function resolutionToJson(
  resolution: CategoriaEliminadaProductResolution,
): Record<string, unknown> {
  if (resolution.type === 'move') {
    return {
      type: 'move',
      destination_category: {
        category_id: resolution.destinationCategory.categoryId,
        base_event_id: resolution.destinationCategory.baseEventId,
        base_version: resolution.destinationCategory.baseVersion,
        base_server_sequence: resolution.destinationCategory.baseServerSequence,
      },
    };
  }
  return { type: resolution.type };
}

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

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`categoria_eliminada requiere ${field} como objeto.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`categoria_eliminada requiere ${field}.`);
  }
  return value.trim();
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`categoria_eliminada requiere ${field} booleano.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`categoria_eliminada requiere ${field} entero >= 0.`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed < 1) {
    throw new Error(`categoria_eliminada requiere ${field} entero >= 1.`);
  }
  return parsed;
}

function nullableNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value, field);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Boolean(Object.prototype.hasOwnProperty.call(value, field));
}
