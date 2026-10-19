# Existencia mínima por variante: contratos, receptor y sincronización (sesiones 1–3)

Implementado el 2026-10-19. Contratos, esquema y receptor están integrados y
verificados con PostgreSQL/HTTP aislados. La captura pública queda para sesión 4.

`ProductVariantEntity.minimumStockAtomic` mapea bigint nullable a string|null.
`minimum_stock_atomic` admite null y enteros 0..9007199254740991. Representa
átomos del recurso vinculado; no tiene unidad independiente ni modifica saldo.
No se exige borrarlo al desvincular inventario. El comentario y CHECK de la
entidad coinciden con la migración aditiva
`1792368000000-AddVariantMinimumStock.ts`, posterior a proveedores.

## Contratos y comparación

`ProductoCreadoVariantValue.minimumStockAtomic?: number | null`: undefined es
campo ausente legado; null es aviso desactivado conocido. Dart conserva esa
señal mediante `knowsMinimumStock`. Las llamadas anteriores que omiten el campo
siguen siendo legadas; no se introduce una intención de borrar por defecto.

Parser/serializador preservan presencia y valor y rechazan snapshots parciales
y before/after con conocimiento distinto. Los JSON nuevos no reescriben eventos
históricos. Los fixtures de `test/fixtures/minimum_stock_v1/contracts.json` son
copias literales de Flutter: legado, null, cero, positivo, máximo, medido,
inválidos, degradación, borrado y comparación con proveedores.

`withKnownMinimumStock()` permite promover una base legada a mínimos conocidos
null y conserva proveedores/recetas/dependencias. Las copias de proveedores
conservan el mínimo. `sameState` compara valores; ausencia y null son iguales en
negocio, por lo que normalizar presencia no exige por sí solo un evento.
`sameEditingBase` separa el conocimiento: base conocida rechaza before legado,
incluso para borrar. La promoción exige el resto del estado exacto y mantiene
la compatibilidad independiente de suppliers. No cambia evento, versión ni
secuencia del protocolo.

Validación numérica sin coerción: enteros seguros, incluidos 1.0, y null;
rechazo de strings, booleanos, fracciones no enteras, negativos, desbordamiento
y no finitos. Number no conserva la grafía JSON 1.0 frente a 1; no se añade un
parser de tokens. La conversión de unidad corresponde al codec de Flutter.

## Migración y aislamiento

AppModule registra la nueva MigrationInterface con `migrationsRun: false`;
conserva la configuración de desarrollo existente `synchronize: true`. No hay
migración automática nueva al arrancar. Registrar esta clase no ejecuta las
migraciones históricas, que antes tampoco estaban registradas en AppModule.
El despliegue y cualquier migración operativa requieren una sesión posterior.

Up añade columna nullable sin default ni UPDATE de historia y agrega el CHECK.
Es repetible. Down rechaza mínimos no nulos, incluido cero, para evitar pérdida
silenciosa; con todos null retira columna y CHECK. La suite
`src/migrations/1792368000000-AddVariantMinimumStock.postgres.spec.ts` usa un
esquema único, entidades reales y runMigrations/undoLastMigration sobre filas
previas de productos, variantes, inventario, saldos, movimientos y eventos.
Verifica conservación literal, rango, rollback y rechazo sin alterar valor.

La verificación usa PostgreSQL nativo temporal en 127.0.0.1, sin cargar .env.
`RUN_POSTGRES_INTEGRATION=1` habilita las pruebas; la regresión completa exige
DATABASE_NAME con prefijo pos_cash_test_ y DATABASE_PASSWORD no vacío incluso
si el cluster temporal usa trust. Los esquemas y la instancia son descartables.

## Receptor y sincronización (sesión 3)

`ProductoEventHandler` reconstruye el snapshot desde las filas y el evento
aceptado al que apunta `products.last_event_id`. No recorre intentos rechazados
ni deduce conocimiento de SQL null. Cualquier mínimo físico no null, también
cero o el de una variante retirada, protege al producto aunque la metadata sea
legada. Edición y borrado legados sobre base conocida se rechazan con
«Actualiza la app para editar o borrar este artículo».

La creación legada guarda SQL null y conserva JSON ausente. Una edición legada
sobre base aún legada se acepta; el cliente actual puede promover before a null
conocido y escribir valores en after. Si existe valor físico, before debe
coincidir con él: no puede fingir null. El resto del estado, evento, versión y
secuencia siguen siendo estrictos. Proveedores conserva su política independiente.

Altas y actualizaciones persisten bigint como string/null. La retirada y el
borrado lógico no eliminan mínimos históricos. El JSON canónico aceptado y el
pull conservan presencia/valor; los snapshots parciales se rechazan completos,
sin borrar el campo para hacerlos compatibles. La deduplicación compartida con
proveedores también exige identidad inmutable para eventos que solo declaran
mínimos; una reentrega idéntica conserva la aceptación, pero otro contenido con
el mismo event_id se rechaza.

`src/sync/product-suppliers.postgres.spec.ts` incorpora veinte casos de mínimo
sobre su DataSource/SyncService reales, además de la regresión de proveedores.
Flutter extiende ProductSupplierHarness/VariantTrackingHarness con siete
recorridos en `test/integration/minimum_stock_server_test.dart`: dos clientes
actuales y cliente vacío, cadenas pendientes, reapertura, preflight, rechazo,
reporte de conflictos, nueva edición desde base oficial y restauraciones tardías.
El recorrido de venta verifica SQL real de recursos, balances, movimientos,
ventas, líneas y pagos antes/después de cambiar solo el mínimo, además de la
clave de consumo local y una venta abierta que confirma después del cambio.

La regresión HTTP requiere targets aislados por suite si se corre en paralelo.
El arnés existente `test/support/variant-tracking-server.ts` se inicia cuatro
veces sobre la base temporal; cada proceso crea su propio schema. Flutter usa
POS_MINIMUM_SYNC_URL/POS_MINIMUM_PG_SCHEMA, POS_PHASE3_SYNC_URL,
POS_SUPPLIER_SYNC_URL/POS_SUPPLIER_PG_SCHEMA y POS_BULK_SYNC_URL/POS_BULK_PG_SCHEMA.
Todos los valores de esta ejecución están en el vault, evidencia de sesión 3.
No hay endpoints, tareas ni WebSocket específicos de alertas.

## Secuencia futura de despliegue

Desplegar primero el esquema/receptor compatible y verificarlo antes de habilitar
escritores nuevos. Un servidor antiguo no admite este contrato. Esta sesión no
despliega, no migra bases operativas y no habilita UI; el siguiente paso es
sesión 4. El estado de alerta se calcula localmente sobre catálogo/saldo recibidos.
