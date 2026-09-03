import { SaleMode } from '../../enums/sale-mode.enum';

const MAX_SAFE_MINOR_AMOUNT = Number.MAX_SAFE_INTEGER;

export type ProductoSaleConfigurationValue =
  | { mode: SaleMode.UNIT }
  | {
      mode: SaleMode.MEASURED;
      saleUnitId: string;
      priceReferenceQuantityAtomic: number;
    };

export interface ProductoCreadoVariantValue {
  id: string;
  name: string | null;
  nameKey: string | null;
  salePriceMinor: number;
  standardCostMinor: number | null;
  inventoryItemId: string | null;
  recipeComponents: readonly ProductoCreadoRecipeComponentValue[];
  isDefault: boolean;
  sortOrder: number;
}

export interface ProductoCreadoRecipeComponentValue {
  inventoryItemId: string;
  quantityAtomic: number;
}

export interface ProductoCreadoInventoryDependencyValue {
  refId: string;
  dependsOnEventId: string | null;
}

export interface ProductoCreadoDependencyValue {
  refId: string;
  dependsOnEventId: string | null;
  isLegacy: boolean;
  allowsMissingEvent: boolean;
}

export class ProductoCreadoPayload {
  static readonly aggregateType = 'product';
  static readonly eventType = 'producto_creado';

  constructor(
    readonly name: string,
    readonly categoryId: string | null,
    readonly saleConfiguration: ProductoSaleConfigurationValue,
    readonly variants: readonly ProductoCreadoVariantValue[],
    readonly categoryDependency: ProductoCreadoDependencyValue | null,
    readonly inventoryDependencies: readonly ProductoCreadoInventoryDependencyValue[],
  ) {}

  static fromJson(payload: Record<string, unknown>): ProductoCreadoPayload {
    const product = requiredRecord(payload.product, 'product');
    const name = normalizeProductName(product.name);
    const categoryId = optionalId(product.category_id, 'product.category_id');
    const saleConfiguration = Object.prototype.hasOwnProperty.call(
      product,
      'sale_configuration',
    )
      ? parseSaleConfiguration(product.sale_configuration)
      : { mode: SaleMode.UNIT as const };

    if (!Array.isArray(payload.variants) || payload.variants.length === 0) {
      throw new Error('producto_creado requiere una o más variantes.');
    }
    const variants = payload.variants.map((value, index) =>
      parseVariant(value, index),
    );
    validateVariants(variants);

    if (!Array.isArray(payload.dependencies)) {
      throw new Error('producto_creado requiere dependencies como arreglo.');
    }
    let categoryDependency: ProductoCreadoDependencyValue | null = null;
    let categoryDependencySeen = false;
    let saleUnitDependencyId: string | null = null;
    const inventoryDependencies: ProductoCreadoInventoryDependencyValue[] = [];
    for (let index = 0; index < payload.dependencies.length; index += 1) {
      const dependency = requiredRecord(
        payload.dependencies[index],
        `dependencies[${index}]`,
      );
      if (dependency.ref_type === 'category') {
        if (categoryDependencySeen) {
          throw new Error(
            'producto_creado no admite dependencias category duplicadas.',
          );
        }
        categoryDependencySeen = true;
        categoryDependency = parseCategoryDependency(dependency, index);
        if (categoryDependency.refId !== categoryId) {
          throw new Error(
            'La dependencia de categoria no coincide con product.category_id.',
          );
        }
        continue;
      }
      if (dependency.ref_type === 'unit') {
        if (saleUnitDependencyId !== null) {
          throw new Error(
            'producto_creado no admite dependencias unit duplicadas.',
          );
        }
        if (
          Object.keys(dependency).some(
            (key) => key !== 'ref_type' && key !== 'ref_id',
          )
        ) {
          throw new Error('La dependencia unit solo admite ref_type y ref_id.');
        }
        saleUnitDependencyId = requiredId(
          dependency.ref_id,
          `dependencies[${index}].ref_id`,
        );
        continue;
      }
      if (dependency.ref_type === 'inventory_item') {
        inventoryDependencies.push(parseInventoryDependency(dependency, index));
        continue;
      }
      throw new Error(
        'producto_creado solo admite dependencias category, unit e inventory_item.',
      );
    }
    if (categoryId === null && categoryDependencySeen) {
      throw new Error(
        'La dependencia de categoria no coincide con product.category_id.',
      );
    }
    if (saleConfiguration.mode === SaleMode.UNIT) {
      if (saleUnitDependencyId !== null) {
        throw new Error(
          'La venta por unidad no puede declarar dependencia unit.',
        );
      }
    } else if (saleUnitDependencyId !== saleConfiguration.saleUnitId) {
      throw new Error('La dependencia unit no coincide con sale_unit_id.');
    }
    validateInventoryDependencies(variants, inventoryDependencies);
    inventoryDependencies.sort((left, right) =>
      left.refId.localeCompare(right.refId),
    );
    return new ProductoCreadoPayload(
      name,
      categoryId,
      saleConfiguration,
      variants,
      categoryDependency,
      inventoryDependencies,
    );
  }

  toJson(
    options: {
      includeCategoryDependency?: boolean;
      includeInventoryEventDependencies?: boolean;
    } = {},
  ): Record<string, unknown> {
    const includeCategoryDependency = options.includeCategoryDependency ?? true;
    const includeInventoryEventDependencies =
      options.includeInventoryEventDependencies ?? true;
    return {
      product: {
        name: this.name,
        category_id: this.categoryId,
        sale_configuration:
          this.saleConfiguration.mode === SaleMode.UNIT
            ? { mode: SaleMode.UNIT }
            : {
                mode: SaleMode.MEASURED,
                sale_unit_id: this.saleConfiguration.saleUnitId,
                price_reference_quantity_atomic:
                  this.saleConfiguration.priceReferenceQuantityAtomic,
              },
      },
      variants: this.variants.map((variant) => ({
        variant_id: variant.id,
        name: variant.name,
        sku: null,
        barcode: null,
        sale_price_minor: variant.salePriceMinor,
        standard_cost_minor: variant.standardCostMinor,
        ...(variant.inventoryItemId === null
          ? {}
          : { inventory_item_id: variant.inventoryItemId }),
        ...(variant.recipeComponents.length === 0
          ? {}
          : {
              inventory_configuration: {
                enabled: true,
                components: variant.recipeComponents.map((component) => ({
                  inventory_item_id: component.inventoryItemId,
                  quantity_atomic: component.quantityAtomic,
                })),
              },
            }),
        is_default: variant.isDefault,
        sort_order: variant.sortOrder,
      })),
      dependencies: [
        ...(includeCategoryDependency &&
        this.categoryDependency?.dependsOnEventId !== null &&
        this.categoryDependency?.dependsOnEventId !== undefined
          ? [
              {
                ref_type: 'category',
                ref_id: this.categoryDependency.refId,
                depends_on_event_id: this.categoryDependency.dependsOnEventId,
              },
            ]
          : []),
        ...(this.saleConfiguration.mode === SaleMode.MEASURED
          ? [
              {
                ref_type: 'unit',
                ref_id: this.saleConfiguration.saleUnitId,
              },
            ]
          : []),
        ...this.inventoryDependencies.map((dependency) => ({
          ref_type: 'inventory_item',
          ref_id: dependency.refId,
          ...(includeInventoryEventDependencies &&
          dependency.dependsOnEventId !== null
            ? { depends_on_event_id: dependency.dependsOnEventId }
            : {}),
        })),
      ],
    };
  }
}

function parseVariant(
  value: unknown,
  index: number,
): ProductoCreadoVariantValue {
  const fieldName = `variants[${index}]`;
  const variant = requiredRecord(value, fieldName);
  if (variant.sku !== null && variant.sku !== undefined) {
    throw new Error(`${fieldName}.sku debe ser null.`);
  }
  if (variant.barcode !== null && variant.barcode !== undefined) {
    throw new Error(`${fieldName}.barcode debe ser null.`);
  }
  if (typeof variant.is_default !== 'boolean') {
    throw new Error(`${fieldName}.is_default debe ser booleano.`);
  }
  const normalizedName = normalizeVariantName(variant.name);
  const inventoryItemId = optionalId(
    variant.inventory_item_id,
    `${fieldName}.inventory_item_id`,
  );
  const recipeComponents = parseRecipeComponents(
    variant.inventory_configuration,
    `${fieldName}.inventory_configuration`,
  );
  if (inventoryItemId !== null && recipeComponents.length !== 0) {
    throw new Error(
      `${fieldName} no puede usar vínculo directo y receta simultáneamente.`,
    );
  }
  return {
    id: requiredId(variant.variant_id, `${fieldName}.variant_id`),
    name: normalizedName.name,
    nameKey: normalizedName.nameKey,
    salePriceMinor: positiveSafeInteger(
      variant.sale_price_minor,
      `${fieldName}.sale_price_minor`,
    ),
    standardCostMinor: Object.prototype.hasOwnProperty.call(
      variant,
      'standard_cost_minor',
    )
      ? nullableNonNegativeSafeInteger(
          variant.standard_cost_minor,
          `${fieldName}.standard_cost_minor`,
        )
      : null,
    inventoryItemId,
    recipeComponents,
    isDefault: variant.is_default,
    sortOrder: nonNegativeSafeInteger(
      variant.sort_order,
      `${fieldName}.sort_order`,
    ),
  };
}

function validateVariants(variants: ProductoCreadoVariantValue[]): void {
  const ids = new Set<string>();
  const nameKeys = new Set<string>();
  const inventoryItemIds = new Set<string>();
  let defaultCount = 0;
  variants.forEach((variant, index) => {
    if (ids.has(variant.id)) {
      throw new Error('Los IDs de variantes no pueden repetirse.');
    }
    ids.add(variant.id);
    if (variant.nameKey !== null) {
      if (nameKeys.has(variant.nameKey)) {
        throw new Error('Los nombres de variantes no pueden repetirse.');
      }
      nameKeys.add(variant.nameKey);
    }
    if (
      variant.inventoryItemId !== null &&
      inventoryItemIds.has(variant.inventoryItemId)
    ) {
      throw new Error(
        'Los recursos de inventario de variantes no pueden repetirse.',
      );
    }
    if (variant.inventoryItemId !== null) {
      inventoryItemIds.add(variant.inventoryItemId);
    }
    if (variant.sortOrder !== index) {
      throw new Error('sort_order debe ser consecutivo desde cero.');
    }
    if (variant.isDefault) defaultCount += 1;
    if (variant.isDefault !== (index === 0)) {
      throw new Error('La primera variante debe ser la única predeterminada.');
    }
  });
  if (defaultCount !== 1) {
    throw new Error(
      'producto_creado requiere exactamente una variante predeterminada.',
    );
  }
}

function parseInventoryDependency(
  value: Record<string, unknown>,
  index: number,
): ProductoCreadoInventoryDependencyValue {
  if (
    Object.keys(value).some(
      (key) =>
        key !== 'ref_type' && key !== 'ref_id' && key !== 'depends_on_event_id',
    )
  ) {
    throw new Error(
      'La dependencia inventory_item solo admite ref_type, ref_id y depends_on_event_id.',
    );
  }
  return {
    refId: requiredId(value.ref_id, `dependencies[${index}].ref_id`),
    dependsOnEventId: optionalId(
      value.depends_on_event_id,
      `dependencies[${index}].depends_on_event_id`,
    ),
  };
}

function validateInventoryDependencies(
  variants: readonly ProductoCreadoVariantValue[],
  dependencies: readonly ProductoCreadoInventoryDependencyValue[],
): void {
  const trackedItemIds = new Set<string>();
  for (const variant of variants) {
    if (variant.inventoryItemId !== null) {
      trackedItemIds.add(variant.inventoryItemId);
    }
    for (const component of variant.recipeComponents) {
      trackedItemIds.add(component.inventoryItemId);
    }
  }
  const dependencyIds = new Set<string>();
  for (const dependency of dependencies) {
    if (dependencyIds.has(dependency.refId)) {
      throw new Error(
        'producto_creado no admite dependencias inventory_item duplicadas.',
      );
    }
    dependencyIds.add(dependency.refId);
  }
  if (
    trackedItemIds.size !== dependencyIds.size ||
    [...trackedItemIds].some((id) => !dependencyIds.has(id))
  ) {
    throw new Error(
      'Las dependencias inventory_item deben coincidir con los recursos directos y componentes de receta.',
    );
  }
}

function parseRecipeComponents(
  value: unknown,
  fieldName: string,
): readonly ProductoCreadoRecipeComponentValue[] {
  if (value === null || value === undefined) return [];
  const configuration = requiredRecord(value, fieldName);
  if (typeof configuration.enabled !== 'boolean') {
    throw new Error(`${fieldName}.enabled debe ser booleano.`);
  }
  if (!configuration.enabled) {
    if (
      configuration.components !== null &&
      configuration.components !== undefined
    ) {
      throw new Error(
        `${fieldName} deshabilitada no puede declarar componentes.`,
      );
    }
    return [];
  }
  if (
    !Array.isArray(configuration.components) ||
    configuration.components.length === 0
  ) {
    throw new Error(
      `${fieldName} habilitada como receta requiere componentes.`,
    );
  }

  const ids = new Set<string>();
  const components = configuration.components.map((value, index) => {
    const componentField = `${fieldName}.components[${index}]`;
    const component = requiredRecord(value, componentField);
    const inventoryItemId = requiredId(
      component.inventory_item_id,
      `${componentField}.inventory_item_id`,
    );
    if (ids.has(inventoryItemId)) {
      throw new Error(
        'Un recurso de inventario no puede repetirse en la misma receta.',
      );
    }
    ids.add(inventoryItemId);
    return {
      inventoryItemId,
      quantityAtomic: positiveSafeInteger(
        component.quantity_atomic,
        `${componentField}.quantity_atomic`,
      ),
    };
  });
  components.sort((left, right) =>
    left.inventoryItemId.localeCompare(right.inventoryItemId),
  );
  return components;
}

function parseSaleConfiguration(
  value: unknown,
): ProductoSaleConfigurationValue {
  const configuration = requiredRecord(value, 'product.sale_configuration');
  if (configuration.mode === SaleMode.UNIT) {
    if (
      Object.prototype.hasOwnProperty.call(configuration, 'sale_unit_id') ||
      Object.prototype.hasOwnProperty.call(
        configuration,
        'price_reference_quantity_atomic',
      )
    ) {
      throw new Error('La venta por unidad no admite campos medidos.');
    }
    return { mode: SaleMode.UNIT };
  }
  if (configuration.mode === SaleMode.MEASURED) {
    return {
      mode: SaleMode.MEASURED,
      saleUnitId: requiredId(
        configuration.sale_unit_id,
        'product.sale_configuration.sale_unit_id',
      ),
      priceReferenceQuantityAtomic: positiveSafeInteger(
        configuration.price_reference_quantity_atomic,
        'product.sale_configuration.price_reference_quantity_atomic',
      ),
    };
  }
  throw new Error('product.sale_configuration.mode no es válido.');
}

function parseCategoryDependency(
  value: Record<string, unknown>,
  index: number,
): ProductoCreadoDependencyValue {
  const refId = requiredId(value.ref_id, `dependencies[${index}].ref_id`);
  if (Object.prototype.hasOwnProperty.call(value, 'depends_on_event_id')) {
    return {
      refId,
      dependsOnEventId: requiredId(
        value.depends_on_event_id,
        `dependencies[${index}].depends_on_event_id`,
      ),
      isLegacy: false,
      allowsMissingEvent: false,
    };
  }

  const baseEventId = optionalId(
    value.base_event_id,
    `dependencies[${index}].base_event_id`,
  );
  positiveSafeInteger(
    value.base_version,
    `dependencies[${index}].base_version`,
  );
  const baseServerSequence = optionalNonNegativeSafeInteger(
    value.base_server_sequence,
    `dependencies[${index}].base_server_sequence`,
  );
  if (baseEventId === null && baseServerSequence === null) {
    throw new Error(
      'La dependencia requiere base_event_id o base_server_sequence.',
    );
  }
  return {
    refId,
    dependsOnEventId: baseEventId,
    isLegacy: true,
    allowsMissingEvent: baseEventId !== null && baseServerSequence !== null,
  };
}

function normalizeProductName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('producto_creado requiere product.name.');
  }
  const normalized = value.normalize('NFKC').trim();
  const length = [...normalized].length;
  if (length < 1 || length > 160) {
    throw new Error('product.name debe tener entre 1 y 160 caracteres.');
  }
  return normalized;
}

export function normalizeVariantName(value: unknown): {
  name: string | null;
  nameKey: string | null;
} {
  if (value === null || value === undefined) {
    return { name: null, nameKey: null };
  }
  if (typeof value !== 'string') {
    throw new Error('El nombre de variante debe ser string o null.');
  }
  const normalized = value.normalize('NFKC').trim();
  if (normalized === '') return { name: null, nameKey: null };
  if ([...normalized].length > 160) {
    throw new Error('El nombre de variante no puede exceder 160 caracteres.');
  }
  return { name: normalized, nameKey: normalized.toLowerCase() };
}

export function productVariantNameRefId(
  productId: string,
  nameKey: string,
): string {
  return `${productId}:${Buffer.from(nameKey, 'utf8').toString('base64url')}`;
}

function requiredRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`producto_creado requiere ${fieldName} como objeto.`);
  }
  return value as Record<string, unknown>;
}

function requiredId(value: unknown, fieldName: string): string {
  const id = optionalId(value, fieldName);
  if (id === null) {
    throw new Error(`producto_creado requiere ${fieldName}.`);
  }
  return id;
}

function optionalId(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} debe ser string o null.`);
  }
  const normalized = value.trim();
  if (normalized === '') return null;
  if (!isUuidV4(normalized)) {
    throw new Error(`${fieldName} debe ser un UUID v4.`);
  }
  return normalized;
}

function positiveSafeInteger(value: unknown, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SAFE_MINOR_AMOUNT
  ) {
    throw new Error(`${fieldName} debe ser un entero positivo seguro.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_MINOR_AMOUNT
  ) {
    throw new Error(`${fieldName} debe ser un entero >= 0.`);
  }
  return value;
}

function nullableNonNegativeSafeInteger(
  value: unknown,
  fieldName: string,
): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeSafeInteger(value, fieldName);
}

function optionalNonNegativeSafeInteger(
  value: unknown,
  fieldName: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    value === ''
  ) {
    throw new Error(`${fieldName} debe ser un entero >= 0 o null.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} debe ser un entero >= 0 o null.`);
  }
  return parsed;
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
