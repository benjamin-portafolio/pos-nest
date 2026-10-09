import { supplierFixture } from '../../testing/supplier-contract-fixtures';
import { ProveedorCreadoPayload } from './proveedor-creado.payload';
import { ProveedorActualizadoPayload } from './proveedor-actualizado.payload';
import { ProductoCreadoPayload } from './producto-creado.payload';
import { ProductoActualizadoPayload } from './producto-actualizado.payload';
import { ProductoProveedorPrecio } from './producto-proveedor-precio';
import { ProductoProveedorDependencia } from './producto-proveedor-dependencia';

const baseId = '00000000-0000-4000-8000-000000000005';
describe('Contrato suppliers_v1: mismos fixtures canónicos de Dart', () => {
  for (const name of [
    'producto_creado',
    'producto_legado',
    'producto_medido_con_receta',
    'producto_sin_proveedores',
  ])
    it(`roundtrip ${name}`, () => {
      const json = supplierFixture(name);
      expect(ProductoCreadoPayload.fromJson(json).toJson()).toEqual(json);
    });
  it('roundtrip proveedor y edición', () => {
    const created = supplierFixture('proveedor_creado'),
      updated = supplierFixture('proveedor_actualizado');
    expect(ProveedorCreadoPayload.fromJson(created).toJson()).toEqual(created);
    const parsed = ProveedorActualizadoPayload.fromJson(updated);
    expect(parsed.toJson()).toEqual(updated);
    expect(parsed.before.toJson()).toEqual(created);
    expect(
      ProveedorActualizadoPayload.sameState(parsed.before, parsed.after),
    ).toBe(false);
  });
  it('recorta sin NFKC, conserva teléfono y normaliza vacíos, ignorando extras', () => {
    expect(
      ProveedorCreadoPayload.fromJson({
        name: '  Ｎorte\u0085',
        phone: ' 00123 ',
        notes: '\n\t',
        future: true,
      }).toJson(),
    ).toEqual({ name: 'Ｎorte', phone: '00123', notes: null });
    expect(ProveedorCreadoPayload.fromJson({ name: 'Norte' }).toJson()).toEqual(
      { name: 'Norte', phone: null, notes: null },
    );
  });
  for (const field of ['name', 'phone', 'notes'])
    for (const value of [1, true, [], {}])
      it(`rechaza texto ${field}=${JSON.stringify(value)}`, () => {
        const json = supplierFixture('proveedor_creado');
        json[field] = value;
        expect(() => ProveedorCreadoPayload.fromJson(json)).toThrow();
      });
  for (const name of [null, '', ' ', '\n\t'])
    it(`nombre obligatorio ${JSON.stringify(name)}`, () =>
      expect(() => ProveedorCreadoPayload.fromJson({ name })).toThrow());
  for (const field of ['base_event_id', 'before', 'after'])
    it(`edición requiere ${field}`, () => {
      const json = supplierFixture('proveedor_actualizado');
      delete json[field];
      expect(() => ProveedorActualizadoPayload.fromJson(json)).toThrow();
    });
  it('base UUID canónica', () => {
    const json = supplierFixture('proveedor_actualizado');
    json.base_event_id = ' AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ';
    expect(ProveedorActualizadoPayload.fromJson(json).baseEventId).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    json.base_event_id = 'bad';
    expect(() => ProveedorActualizadoPayload.fromJson(json)).toThrow();
  });
  for (const field of ['quoted_price_minor', 'quoted_at_ms'])
    for (const value of [
      null,
      '',
      '0',
      -1,
      1.5,
      true,
      Number.MAX_SAFE_INTEGER + 1,
      ...(field === 'quoted_at_ms' ? [0] : []),
    ])
      it(`rechaza entero JSON ${field}=${JSON.stringify(value)}`, () => {
        const json = supplierFixture('producto_creado');
        json.variants[0].suppliers[0][field] = value;
        expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
      });
  for (const field of ['supplier_id', 'quoted_price_minor', 'quoted_at_ms'])
    it(`requiere ${field}`, () => {
      const json = supplierFixture('producto_creado');
      delete json.variants[0].suppliers[0][field];
      expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
    });
  for (const value of [null, '', 'bad', 1, true])
    it(`rechaza supplier_id ${JSON.stringify(value)}`, () => {
      const json = supplierFixture('producto_creado');
      json.variants[0].suppliers[0].supplier_id = value;
      expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
    });
  for (const value of [null, {}, '', 0, [null]])
    it(`suppliers explícito inválido ${JSON.stringify(value)}`, () => {
      const json = supplierFixture('producto_creado');
      json.variants[0].suppliers = value;
      expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
    });
  it('límite seguro completo, fecha sin Date, normalización y listas inmutables', () => {
    const p = new ProductoProveedorPrecio(
      ' AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ',
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    expect(p.toJson()).toEqual({
      supplier_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quoted_price_minor: Number.MAX_SAFE_INTEGER,
      quoted_at_ms: Number.MAX_SAFE_INTEGER,
    });
    expect(Number.isNaN(new Date(p.quotedAtMs).getTime())).toBe(true);
    const json = supplierFixture('producto_creado');
    json.variants[0].suppliers.reverse();
    json.dependencies.reverse();
    const parsed = ProductoCreadoPayload.fromJson(json);
    expect(parsed.toJson()).toEqual(supplierFixture('producto_creado'));
    expect(Object.isFrozen(parsed.variants[0].suppliers)).toBe(true);
    expect(Object.isFrozen(parsed.supplierDependencies)).toBe(true);
  });
  it('duplica proveedor aun normalizando mayúsculas y campos futuros ignorados', () => {
    const json = supplierFixture('producto_creado');
    const first = json.variants[0].suppliers[0];
    first.future = true;
    expect(ProductoCreadoPayload.fromJson(json).toJson()).toEqual(
      supplierFixture('producto_creado'),
    );
    json.variants[0].suppliers.push({
      ...first,
      supplier_id: first.supplier_id.toUpperCase(),
      quoted_price_minor: 42,
    });
    expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
  });
  for (const change of [
    'missing',
    'extra',
    'duplicate',
    'invalid-id',
    'invalid-event',
  ])
    it(`dependencias supplier ${change}`, () => {
      const json = supplierFixture('producto_creado'),
        deps = json.dependencies;
      if (change === 'missing') deps.pop();
      if (change === 'extra')
        deps.push({
          ref_type: 'supplier',
          ref_id: '00000000-0000-4000-8000-000000000099',
        });
      if (change === 'duplicate') deps.push(deps[0]);
      if (change === 'invalid-id') deps[0].ref_id = 'bad';
      if (change === 'invalid-event') deps[0].depends_on_event_id = '';
      expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
    });
  it('varias variantes comparten proveedor y no admite snapshots parciales', () => {
    const json = supplierFixture('producto_creado');
    json.variants.push({
      ...json.variants[0],
      variant_id: '00000000-0000-4000-8000-000000000099',
      sort_order: 1,
    });
    expect(ProductoCreadoPayload.fromJson(json).supplierIds.size).toBe(2);
    delete json.variants[1].suppliers;
    expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
  });
  it('retirada conserva before, after vacío y solo requiere la base', () => {
    const json = supplierFixture('producto_retirada_explicita'),
      parsed = ProductoActualizadoPayload.fromJson(json);
    expect(parsed.toJson()).toEqual(json);
    expect(parsed.dependencyEventIds).toEqual(new Set([parsed.baseEventId]));
  });
  it('sameState compara dinero, fecha y presencia independientemente del orden', () => {
    const original = ProductoCreadoPayload.fromJson(
      supplierFixture('producto_creado'),
    );
    for (const field of ['quoted_price_minor', 'quoted_at_ms']) {
      const json = supplierFixture('producto_creado');
      json.variants[0].suppliers[0][field]++;
      expect(
        ProductoActualizadoPayload.sameState(
          original,
          ProductoCreadoPayload.fromJson(json),
        ),
      ).toBe(false);
    }
    const json = supplierFixture('producto_creado');
    json.variants[0].suppliers.reverse();
    expect(
      ProductoActualizadoPayload.sameState(
        original,
        ProductoCreadoPayload.fromJson(json),
      ),
    ).toBe(true);
    expect(
      new ProductoActualizadoPayload(baseId, original, original)
        .dependencyEventIds,
    ).toContain('00000000-0000-4000-8000-000000000004');
  });
  it('sameEditingBase permite solo promover la base legada vacía', () => {
    const legacy = ProductoCreadoPayload.fromJson(
      supplierFixture('producto_legado'),
    );
    const empty = ProductoCreadoPayload.fromJson(
      supplierFixture('producto_sin_proveedores'),
    );
    const known = ProductoCreadoPayload.fromJson(
      supplierFixture('producto_creado'),
    );
    expect(ProductoActualizadoPayload.sameState(legacy, empty)).toBe(false);
    expect(ProductoActualizadoPayload.sameEditingBase(legacy, empty)).toBe(
      true,
    );
    expect(ProductoActualizadoPayload.sameEditingBase(empty, legacy)).toBe(
      false,
    );
    expect(ProductoActualizadoPayload.sameEditingBase(legacy, known)).toBe(
      false,
    );
    for (const [before, after] of [
      [legacy, empty],
      [empty, legacy],
    ])
      expect(() =>
        ProductoActualizadoPayload.fromJson({
          base_event_id: baseId,
          before: before.toJson(),
          after: after.toJson(),
        }),
      ).toThrow();
  });
  it('constructores de precio y dependencia aplican invariantes', () => {
    expect(() => new ProductoProveedorPrecio(baseId, -1, 1)).toThrow();
    expect(() => new ProductoProveedorDependencia('bad')).toThrow();
  });
  it('constructores completos no evaden conocimiento, duplicados ni dependencias', () => {
    const known = ProductoCreadoPayload.fromJson(
      supplierFixture('producto_creado'),
    );
    const legacy = ProductoCreadoPayload.fromJson(
      supplierFixture('producto_legado'),
    );
    expect(
      () => new ProductoActualizadoPayload(baseId, legacy, known),
    ).toThrow();
    expect(
      () =>
        new ProductoCreadoPayload(
          known.name,
          known.categoryId,
          known.saleConfiguration,
          known.variants,
          null,
          [],
        ),
    ).toThrow();
    const variant = known.variants[0];
    expect(
      () =>
        new ProductoCreadoPayload(
          known.name,
          null,
          known.saleConfiguration,
          [
            {
              ...variant,
              suppliers: [...variant.suppliers!, variant.suppliers![0]],
            },
          ],
          null,
          [],
          known.supplierDependencies,
        ),
    ).toThrow();
  });
});
