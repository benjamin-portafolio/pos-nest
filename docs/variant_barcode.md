# Código de barras en variantes

Implementado el 2026-09-29 en NestJS y Flutter. Alcance: código de barras
opcional por variante de producto, como texto de hasta 32 dígitos. No se agrega
captura en pantalla, lector de cámara, unicidad ni búsqueda por código.

## Uso

1. El código de barras es un dato de la variante, no del producto. Un producto
   puede tener N variantes y cada una lleva el suyo o ninguno.
2. Se captura como texto. El sistema no lo interpreta como número: un UPC-A
   conserva sus ceros a la izquierda (`012345678905`), y un GS1-128 cabe sin
   truncarse aunque exceda los 13 dígitos de un EAN-13. Ningún tipo numérico
   interviene.
3. Vacío o ausente equivale a `null`. Un valor no numérico se rechaza en el
   cliente, en el contrato de sincronización y en la base de datos. Solo se
   admiten dígitos: un GS1-128 se captura en su forma numérica con
   identificadores de aplicación, sin el separador FNC1 ni los paréntesis de la
   forma legible.

En esta entrega el valor todavía no tiene campo visible en la pantalla de
variantes: la formulario lo transporta y lo persiste, pero no lo captura. La
interfaz de captura queda para una sesión posterior.

## Datos

`product_variants.barcode` es `varchar(32)` nullable. El tipo es deliberadamente
texto: un entero perdería los ceros a la izquierda de un UPC-A y no podría
representar un GS1-128.

- `ck_product_variants_barcode_digits`: `barcode IS NULL OR barcode ~ '^[0-9]{1,32}$'`.
  Equivale al `^[0-9]{1,32}$` acordado y rechaza vacío, letras, guiones,
  espacios internos y cadenas de más de 32 dígitos.
- `barcode` no tiene valor por defecto, no se indexa y no es único. Dos variantes
  de productos distintos pueden compartir el mismo código.
- `sku` no se modifica. Sigue cerrado: el contrato lo emite siempre como `null`
  y el servidor rechaza cualquier otro valor.

La columna se declara en `ProductVariantEntity` junto al `@Check`, de modo que
`synchronize=true` y la migración convergen en la misma forma.

## Eventos y sincronización

`producto_creado` y `producto_actualizado` admiten `barcode` opcional en cada
variante. El contrato se amplía de cerrado a opcional: antes `barcode` debía ser
`null` y ahora se valida su contenido.

- `ProductoCreadoVariantValue.barcode` es `string | null`.
- `toJson` emite el valor real en lugar de una constante `null`. Cuando la
  variante no tiene código, emite `barcode: null`, de modo que la forma canónica
  del payload no cambia y los fixtures existentes siguen siendo válidos.
- `parseVariant` normaliza con `optionalDigits`: recorte de espacios, vacío a
  `null`, y `^[0-9]{1,32}$` obligatorio en el resto. Un valor ausente se trata
  como `null` mediante `hasOwnProperty`, para que eventos anteriores al cambio
  sigan siendo válidos.
- El campo es opcional también en el servidor: un dispositivo antiguo que no
  envíe `barcode` produce una variante sin código, no un error.

La concurrencia optimista del servidor compara la variante completa. `barcode`
participa en las dos mitades de esa comparación y cada una falla de forma
distinta si se omite:

- La cadena de `!==` que decide si la variante cambió: sin `barcode`, un
  `before` que declara un código distinto del persistido se acepta en lugar de
  rechazarse, y el `after` sobrescribe el valor guardado. Es el fallo silencioso:
  nada avisa de la pérdida.
- `oldValues`, el retrato de lo persistido: sin `barcode` ahí, la comparación ve
  `undefined` y no coincide con ningún valor. Toda actualización del producto se
  rechaza con "El estado anterior no coincide con la base del producto" y el
  artículo queda sin poder editarse.

Ambas rutas de `manager.create(ProductVariantEntity, ...)` —alta y
actualización— escriben `barcode`, igual que el resto de campos de la variante.

`validateVariants` no deduplica por código de barras y el contrato no declara
referencias de conflicto ni códigos `duplicate_barcode`.

## Esquema y puesta en marcha

`AddVariantBarcode1790683200000` agrega la columna con `IF NOT EXISTS` y el
`CHECK` con un bloque `DO` que verifica `pg_constraint` antes de crear el
constraint. Ambas piezas son idempotentes. El `down` quita el constraint y la
columna.

En Flutter, `product_variants.barcode` es `TEXT` con el equivalente de SQLite,
que no tiene operador `~`:

```sql
CHECK (barcode IS NULL OR (length(barcode) BETWEEN 1 AND 32 AND barcode NOT GLOB '*[^0-9]*'))
```

La base local mantiene `schemaVersion` sin cambios y `onUpgrade` sigue vacío.
Una base anterior a esta columna se detecta por detección de columnas en
`_resetDatabaseOnStartup` y se recrea al abrirla, lo que elimina sus datos
locales. No se implementa una migración en sitio.

El orden de despliegue importa en un solo sentido: el servidor debe aceptar
`barcode` antes de que una tablet lo envíe. Un servidor anterior rechaza el
valor. Por eso se despliega el servidor primero, después la app.

## Límites de esta entrega

- No hay unicidad. No hay índice único, ni referencia `product_variant_barcode`,
  ni código `duplicate_barcode`, ni deduplicación en `validateVariants`. La
  unicidad está diferida y no debe asumirse en ninguna revalidación de pendientes.
- No se agrega campo en pantalla, ni lector de cámara, ni dependencia de
  escaneo. `ArticuloFormVarianteResult.codigoBarras` y su `copyWith` no tienen
  entrada visible: el valor es `null` hasta que exista el campo.
- No se toca `sku`, ni el botón GENERAR, ni se inventan reglas de negocio sobre
  longitudes por tipo de código más allá del máximo de 32 dígitos.
- `schemaVersion` y `onUpgrade` quedan intactos; la recreación de la base local
  es la vía de actualización.

## Verificación

- Migración probada contra PostgreSQL real en esquema aislado: dígitos
  aceptados, `12-345` rechazado con `23514`, código duplicado aceptado, `down`
  quita columna y constraint.
- Pruebas de regresión del contrato: `barcode` ausente, `null`, vacío, con
  dígitos y con caracteres inválidos.
- Pruebas de regresión de concurrencia: quitar `barcode` de `oldValues` rompe la
  aceptación del cambio; quitarlo de la cadena `!==` rompe el rechazo. Ambas
  direcciones están cubiertas.
- `npx prettier --write` y `npm run build` sin incidencias.
- `npm test`: 222 pruebas aprobadas.
- Suite completa con PostgreSQL real: 308 aprobadas. Los 17 fallos de
  `cash-events.postgres.spec.ts` y `account-balance-baselines.postgres.spec.ts`
  son previos a este cambio y se reproducen idénticos sobre la base sin
  modificaciones: requieren la base `pos_cash_test_*`.
- Flutter: `dart run build_runner build` regenera `app_database.g.dart` y
  `dart analyze` no reporta incidencias. Suite completa: 797 pruebas
  aprobadas. El fallo de `movimiento_financiero_form_screen_test.dart` es previo
  a este cambio y se reproduce idéntico sobre la base sin modificaciones.
