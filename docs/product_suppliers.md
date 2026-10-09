# Proveedores de productos: servidor, contrato revisión 1

Servidor de fase 6 e integración Flutter de fase 7 implementados el 2026-10-08.
El servidor entiende supplier y los conjuntos de precios de product. Flutter
puede crear/editar offline en server_sync y entrega por dependencias. Standalone
mantiene not_required, sin refs persistidas y sin transporte. El cierre y la
evidencia entre runtimes están en el informe de fase 7 del repositorio de análisis.
Las secciones de fase 6 conservan su evidencia histórica; la política de
compatibilidad y health vigente se completa al final.

## Esquema y migración

`SupplierEntity` utiliza `SyncProjectionEntity`: supplier_id UUID, name requerido,
phone/notes opcionales, active, version, created_event_id, last_event_id,
last_server_sequence y timestamps del servidor. Active es estructural; los
únicos eventos del catálogo son alta y edición. El nombre no es una clave única.

`VariantSupplierEntity` es hijo reemplazable del producto, como recipe_components.
Su PK es (variant_id, supplier_id); no tiene active, versión ni eventos propios.
La FK a variante es CASCADE y la FK a proveedor RESTRICT. No se añade un índice
por proveedor sin una lectura que lo requiera.

| Campo | Tipo PostgreSQL / contrato JSON |
|---|---|
| quoted_price_minor | bigint / entero seguro entre 0 y 9007199254740991 |
| quoted_at_ms | bigint / entero seguro entre 1 y 9007199254740991 |

El handler valida `Number.isSafeInteger` antes de `String(...)` para persistir.
Lee bigint como texto y conserva el instante completo; nunca pasa quoted_at_ms
por Date. Cero es un precio informado, no una ausencia. Estos precios no cambian
venta, costo estándar, existencias, movimientos, compras o gastos.

La migración `src/migrations/1791417600000-CreateProductSuppliers.ts` sigue el
mecanismo existente `MigrationInterface.up/down`. Es aditiva: crea dos tablas
vacías, sin tocar productos, variantes, recetas, inventario ni eventos previos.
Es repetible; down rechaza un catálogo o relaciones poblados. AppModule registra
las entidades con la configuración de desarrollo existente synchronize=true.
No se cambió el mecanismo de arranque ni se ejecutó una migración en una base
del usuario. La suite prueba también el registro/ejecución con runMigrations y
undoLastMigration en un esquema aislado anterior con filas de control.

## JSON y contratos tipados

Los archivos proveedor-creado.payload.ts y proveedor-actualizado.payload.ts
reproducen ProveedorCreadoPayload/ProveedorActualizadoPayload de Dart. Se recortan
textos, opcionales vacíos a null; se conserva teléfono como texto, sin NFKC ni
unicidad de nombre. La edición lleva base_event_id UUID y before/after completos.
Los campos futuros desconocidos se ignoran en los contratos nuevos.

ProductoProveedorPrecio y ProductoProveedorDependencia normalizan UUID v4 a
minúsculas, ordenan por ID y rechazan duplicados. Las listas se copian y congelan.
Cada snapshot declara exactamente una dependencia supplier por ID presente en
la unión de sus variantes; el proveedor compartido no duplica la dependencia.
El alta pendiente puede declarar depends_on_event_id; un proveedor confirmado
puede omitirlo. Si se declara, debe ser el evento proveedor_creado aceptado que
coincide con supplier.created_event_id. Una edición del proveedor no sustituye
esa dependencia. El alta original sigue siendo válida después de editarlo.

`dependencyEventIds` de una edición comprende su base y las dependencias de
after; un borrado solo requiere la base. Antes de reemplazar relaciones se
comprueba la existencia de los proveedores de after. Las dependencias causales
de before son historia; no exigen entregar una alta para retirar una relación.

Los siete JSON en test/fixtures/suppliers_v1 son copias literales de los archivos
Dart existentes. La evidencia contiene sus hashes y las corridas de ambos
lenguajes. Los fixtures se usan sin adaptar precios, fechas, dependencias ni
representación legada. JavaScript representa los números JSON con Number: una
vez decodificados, no distingue la grafía 1.0 de 1. La validación exige valor
entero seguro, sin convertir strings, fracciones ni valores fuera de rango;
no se introdujo un parser de tokens numéricos en los endpoints existentes.

## Compatibilidad legada y protección de precios

| Entrada por variante | Significado |
|---|---|
| suppliers omitido | Desconocimiento legado; se conserva la omisión en el evento |
| suppliers: [] | Conjunto conocido explícitamente vacío |
| suppliers: [...] | Conjunto completo conocido |
| suppliers: null, tipo inválido o snapshot parcial | Rechazo |

Todas las variantes de un snapshot tienen el mismo nivel de conocimiento.
Una edición no puede mezclar before conocido y after legado o viceversa.
`sameState` compara los campos de negocio y las relaciones, incluidos precio,
fecha y presencia, independientemente del orden de los proveedores/recetas.
Ausencia y vacío son estados distintos.

Bajo el bloqueo de producto, el handler reconstruye la base desde las filas
actuales y obtiene el conocimiento del último evento aceptado (after en una
edición). Esto preserva el conocimiento aunque ya no existan filas de precios.
No reconstruye before únicamente desde el evento histórico ni interpreta
omisión como retirada. También trata relaciones persistidas como conocimiento
para impedir su pérdida si los metadatos históricos son legados.

`sameEditingBase` permite solo la transición Dart: proyección legada sin precios
→ before completo con todos los conjuntos []. Los demás campos deben coincidir.
Después puede aplicarse un after completo, vacío o con precios. No se admite
inventar precios en before ni regresar a omisión después de conocer el conjunto.
El replay histórico anterior a la transición mantiene el formato omitido.

Un parser antiguo que elimina suppliers/dependencias de sus snapshots enviará
una edición legada. Si el producto conoce proveedores, incluso [], el servidor
la rechaza y conserva el estado oficial. No se presupone que ese parser retenga
campos adicionales. Las bases/eventos/versiones desactualizados compiten con la
infraestructura actual de conflictos; un before falseado se rechaza.

Pull conserva su contrato: distribuye todos los eventos aceptados, incluidos
los nuevos tipos. No hay negociación de capacidades ni filtrado por versión de
cliente. El despliegue coordinado de clientes compatibles, su interpretación de
estos eventos y la habilitación remota quedan para fase 7.

## Atomicidad, idempotencia y referencias

SyncService utiliza la transacción existente por evento. Los handlers serializan
por event_id y por identidad de supplier/product con advisory locks de transacción;
producto conserva además sus bloqueos de filas y lee proveedores en orden de ID.
La edición valida agregado, evento base aceptado, versión, secuencia oficial y
before. Un cursor suministrado debe coincidir con la secuencia de la base; null
permite una base causal aún no confirmada cuando se originó offline, siempre
que el servidor ya tenga aceptado ese evento al aplicarla.

Proveedor/evento/refs y producto/variantes/recetas/precios/memoria/refs se guardan
en la misma transacción. Un fallo revierte el conjunto. Conflictos/rechazos se
registran con la infraestructura existente sin modificar la proyección. La
respuesta push y los controladores no cambian. Un reintento se deduplica aun
si hubo una edición posterior o un borrado físico. Reutilizar event_id con otro
contenido del contrato nuevo se rechaza. Colisionar device_id/local_sequence
revierte el intento y devuelve rechazo, sin intentar insertar otra fila con la
misma clave única.

| Evento | Referencias nuevas |
|---|---|
| proveedor_creado / proveedor_actualizado | supplier / aggregate_id / affects |
| producto_creado | variant_suppliers / variant_id / affects para cada conjunto explícito; supplier / supplier_id / uses |
| producto_actualizado | variant_suppliers / variant_id / affects y supplier / supplier_id / uses para la unión before/after, incluidos retirados |

Las refs se deduplican y conviven con product, product_variant, nombres,
category, unit, inventory_item y recipe del flujo actual. La retirada de una
variante la desactiva y conserva sus precios históricos, como las recetas.
El borrado lógico de producto conserva también los precios y referencia las
variantes históricas inactivas. El borrado físico aplica CASCADE a relaciones;
el proveedor del catálogo sobrevive. No hay fusión por proveedor ni ganador
según quoted_at_ms: dos ediciones distintas compiten por el producto completo.

## Verificación y límites

La evidencia de fase 6 del repositorio de análisis registra comandos, resultados,
hashes, cambios y corridas intermedias. Las pruebas incluyen los fixtures Dart,
PK/FK/límites, migración conservadora, creación/edición/reintento, rollback,
varios proveedores y variantes, dependencias, retirada, clientes legados,
preflight/push/pull y regresiones completas con PostgreSQL temporal.

Se corrigió una consulta preexistente en AccountBalanceBaselineEventHandler:
TypeORM exige `where` para findOne. Se añadió `where: {}` manteniendo la selección
global más antigua; los ocho casos PostgreSQL de saldos bancarios verifican el
flujo. Los seeds de seguimiento ahora acreditan las secuencias 41/42 ya reservadas
por sus fixtures, además del evento aceptado y su metadato de proyección.

No se ejecutaron despliegues, migraciones en datos del usuario, pruebas físicas,
transporte Flutter contra este servidor ni dos terminales. No se importó ni
promovió historial standalone y no se modificó código funcional de Flutter.
La siguiente fase es 7.


## Integración Flutter: fase 7

El único cambio funcional adicional del servidor es el anuncio de
capabilities: ["product_suppliers_v1"] en GET /sync/health, manteniendo status,
latest_server_sequence y server_time. SyncHealthResponseDto y su prueba se
actualizan. No cambia push, pull, preflight, handlers, tablas ni migraciones
respecto al servidor de fase 6. El arnés HTTP existente registra además
ProveedorEventHandler y el EventsGateway real para probar avisos/reconexión.

Flutter comprueba esta capability antes de enviar cualquier lote con eventos
de proveedor o snapshots que conocen suppliers. Un servidor anterior sin el
anuncio deja el lote pendiente; no recibe los nuevos campos. Guardar sigue
siendo local y offline. La ausencia del anuncio no se interpreta como soporte
implícito, y no se asume preservación de campos desconocidos.

**Despliegue coordinado:** actualizar servidor y todas las terminales antes de
usar proveedores/precios. Mantener clientes antiguos fuera del servicio durante
la actualización: el servidor distribuye todos los tipos por pull, incluidos
proveedor_creado y proveedor_actualizado, sin negociación/filtro por versión.
La capability anuncia soporte de este servidor; no comprueba la versión de otros
clientes. Los parsers antiguos no tienen garantizada una lectura segura. Sus
escrituras legadas contra conjuntos conocidos se rechazan sin pérdida de datos.

Las altas originales pendientes preceden a los productos que las usan;
ediciones causales esperan su base. base_server_sequence=null conserva las
bases aún pendientes en el momento de origen. before retirado no exige entrega
de dependencias históricas. Rechazos/conflictos restauran las cadenas inversas
por los mecanismos existentes; solo secuencias delivered acreditan bases al
restaurar. La concurrencia permanece en el producto completo.

Verificación con NestJS/PostgreSQL aislado, transporte HTTP/WebSocket real y
SQLite independientes; resultados finales en Verificacion remota - fase 7.md.
La prueba negativa de evento futuro inyecta exclusivamente una fila sintética
aceptada en el esquema del arnés: pull falla sin avanzar cursor ni proyectar la
página; el fixture se elimina en finally y se reintenta. No es un tipo aceptado
por el servidor actual ni un cambio a su política de despacho.
No hubo despliegue, pruebas físicas, acceso a bases del usuario o importación de
historial standalone. La actualización real de terminales es un requisito de
operación; no se afirma haberla realizado.

Resultado final: npm run build aprobado; npm test 314 aprobadas (193 PostgreSQL
omitidas solo aquí); RUN_POSTGRES_INTEGRATION=1 ejecuta 48 suites / 507 pruebas,
cero fallos/omisiones. Flutter: 1578 aprobadas, sin omisiones, con ambos runtimes
y transporte real. Typecheck del arnés y git diff --check aprobados.
