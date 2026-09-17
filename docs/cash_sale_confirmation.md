# Confirmación de venta completa en efectivo

Actualizado: 2026-09-16. Alcance implementado en Flutter y NestJS; sin despliegue.

## Decisiones aprobadas

- El cobro directo confirma la venta y consume inventario. Capturar el borrador no consume.
- Se permiten saldos negativos, locales y centrales.
- Efectivo vacío equivale al total exacto. Efectivo insuficiente impide confirmar.
- Pago aplicado = total; recibido y cambio son importes separados. Moneda actual: MXN.
- Los precios y costos estándar capturados no cambian al editar el catálogo.
- El consumo se resuelve y congela al cobrar. Un cambio de receta o vínculo ya conocido
  respecto de la captura exige revisar el borrador; no lo elimina ni recalcula su precio.
- Una desactivación remota posterior a las condiciones conocidas no invalida un cobro
  offline histórico. Una desactivación ya conocida en la tablet impide nuevas ventas.
- Una devolución de dinero no implica una devolución física. No se implementaron
  cancelaciones, reembolsos, comandas ni valuación real.

## Flujo implementado

`Caja -> PaymentMethodScreen -> CashPaymentScreen -> VentaCommandService.confirmar`
transporta saleId, último evento del borrador y total mostrado. El botón se bloquea
mientras se procesa. El comando relee usuario, dispositivo, estado, revisión y líneas
bajo la misma transacción SQLite que registra el evento y sus proyecciones.

La transacción guarda `venta_confirmada`, `sales`, `sale_items`, `sale_payments`,
`inventory_movements` y `inventory_balances`. Cualquier error revierte todo. Sólo el
commit permite abrir el recibo. El recibo y la lista «Ventas cobradas» observan el
repositorio y siguen disponibles después de reiniciar, incluso con incidencias.
Una nueva captura usa otro borrador y conserva la venta confirmada.

El estado de negocio es `confirmada`; la entrega se mantiene en el evento. La UI
muestra «Cobrada, pendiente de sincronizar», «Sincronizada» o «Requiere atención» y
el motivo disponible. En standalone muestra «Cobrada (registro local)».

## Contrato y trazabilidad

`VentaConfirmadaPayload` es autocontenido. El sobre aporta event_id, sale_id,
usuario, dispositivo y fecha local; el servidor aporta fecha y secuencia oficiales.
El payload contiene payment_id, moneda, total, recibido, cambio y líneas con:

- sale_item_id, product_id, variant_id y configuration_event_id;
- snapshots de nombres, cantidad, modo, unidad, precio y costo estándar;
- consumption_mode (`none`, `direct`, `recipe`);
- componentes históricos y cantidad atómica por componente;
- delta ya calculado y movement_id estable por línea/recurso.

`dependency_event_ids` incluye la configuración del producto y las altas de recursos
conocidas. Las referencias `LocalEventRef` se declaran y validan en ambos modos.
`server_sync` las persiste y usa el monitor, preflight, push, pull y reintentos
existentes. Standalone usa `not_required`, no persiste refs ni arranca el monitor,
health checks o WebSocket. Los eventos de agregar/limpiar borrador siguen locales.
No se promociona historial standalone a pendientes.

La confirmación tiene `base_version = 1`, sin `base_server_sequence`: crea la venta
oficial. La versión de edición del borrador no se presenta como versión del servidor.

## Aritmética y consumo

Todo importe y cantidad transportados deben ser enteros seguros, con magnitud máxima
9 007 199 254 740 991. Los productos y sumas intermedias usan BigInt. Para positivos:

`halfUp(n / d) = floor((2*n + d) / (2*d))`.

| Configuración | Magnitud del consumo por línea/recurso |
|---|---|
| Sin seguimiento | Sin componentes ni movimientos |
| Directo por pieza | Cantidad de piezas |
| Directo medido | Cantidad atómica vendida |
| Receta por pieza | Componente atómico × piezas |
| Receta medida | halfUp(componente atómico × cantidad vendida / referencia del precio) |

Se redondea una sola vez al átomo sobre la cantidad completa de la línea, después de
multiplicar. Se niega la magnitud para producir el delta. Un resultado cero conserva
el componente histórico, usa movement_id null y no inserta movimiento ni cambia saldo.
El precio medido usa la misma regla sobre el total de la línea. El total de venta suma
los importes de líneas ya calculados. No se usa double para estos cálculos.

El tipo `sale_consumption` exige delta negativo y línea de venta. No se admite desde
el comando genérico de ajustes. `total_cost_minor` siempre permanece null: el costo
estándar es sólo una referencia histórica de la línea.

## Integridad, concurrencia y entrega

- event_id es único; un reintento reutiliza el evento persistido. Un duplicado devuelve
  su resultado original, incluso si fue conflicto o rechazo.
- Una venta confirmada no admite otra confirmación con distinto event_id.
- Un pago completo es único por sale_id. Los IDs de línea, pago y movimiento son únicos.
- El índice de consumo único por sale_item_id/inventory_item_id impide descontar una
  línea dos veces con distintos IDs de movimiento.
- Las relaciones venta/línea/variante/recurso usan restricciones referenciales.
- Push espera que las dependencias locales se entreguen en un lote anterior; cada
  evento se procesa en su propia transacción, sin asumir atomicidad de todo el push.
- Una dependencia rechazada, ausente o no sincronizable genera atención conservando
  el cobro y su consumo. La limpieza de creaciones conserva las referencias de cobros.
- El servidor valida totales, cambio, rangos, IDs, medidas y deltas. Compara la
  configuración de consumo con el evento histórico aceptado del producto. No recalcula
  usando la receta actual ni reemplaza el precio capturado por el precio vigente.
- PostgreSQL serializa el sale_id con un bloqueo transaccional y toma bloqueos de
  producto, variante, recurso y saldo en orden estable. Los saldos se modifican después
  de insertar movimientos nuevos. Las ventas no incrementan la versión de configuración
  del recurso ni exigen una versión del saldo: dos ventas distintas pueden consumirlo.
- Pull de un evento ya aplicado sólo reconoce entrega y secuencias. Otro dispositivo
  crea la venta completa sin necesitar los eventos del borrador.
- Producto y variantes eliminados se desactivan, conservando incluso identidades sin
  inventario: el servidor no puede saber qué ventas permanecen en tablets desconectadas.
  Esta regla sustituye el borrado físico anterior del catálogo. No habilita reactivación.

## Verificación automatizada

Los tests de comandos y widgets cubren efectivo vacío/exacto/insuficiente/cambio,
protección del botón, revisión obsoleta, vacío, doble confirmación, todas las formas
de inventario, redondeo a cero, rangos, saldos negativos, rollback, reinicio sobre un
archivo SQLite, dependencias, respuesta perdida/reintento, pull propio y otro
receptor, cambios conocidos de receta/precio/desactivación, preservación de cobros
rechazados y ausencia de refs/arranque sync en standalone.

La suite PostgreSQL usa una instancia temporal aislada. Prueba inserción atómica,
fallo inyectado tras escribir movimientos, confirmaciones concurrentes de una venta,
ventas distintas concurrentes sobre el mismo recurso, configuración histórica,
IDs reutilizados, resultados duplicados, dependencia ausente y migración.
La entrega incluye los resultados concretos de los comandos ejecutados; estas pruebas
no sustituyen una prueba manual en tablets físicas.

## Límites y paso de desarrollo a producción

- Drift mantiene schemaVersion 7. Conforme a AGENTS.md, `_resetDatabaseOnStartup`
  reconoce el nuevo esquema por `sale_payments` y recrea bases de desarrollo anteriores.
  No se abrió ni reseteó una base real durante este trabajo. Antes de producción hace
  falta una migración local que preserve datos, pruebe backups y trate los borradores
  antiguos sin clave de configuración. Un backup de esquema anterior se rechaza.
- PostgreSQL incluye `1789516800000-AddCashSales`, probada en una base desechable, no
  ejecutada sobre bases existentes. Falla ante referencias legadas huérfanas y bloquea
  el downgrade con cobros. La configuración actual del proyecto aún usa synchronize:
  true; el despliegue productivo necesita gestionar migraciones explícitamente.
- Todos los dispositivos que participen en sync deben entender `venta_confirmada`
  antes de habilitar el cobro: clientes antiguos no pueden aplicar este nuevo evento.
- Un producto ya borrado físicamente por versiones antiguas puede dejar una venta
  offline en atención por dependencia inexistente; no se inventan referencias ni
  se elimina el cobro para ocultar el problema.
- La incidencia se conserva y se muestra; la resolución administrativa o compensación
  posterior requiere su propio flujo. No hay reembolso, retorno físico ni conciliación
  automática de una venta rechazada.
- No se realizaron pruebas manuales en hardware, despliegues ni cambios de producción.

## Resultados ejecutados

- `dart run build_runner build`: esquema regenerado correctamente, sin elevar schemaVersion.
- `dart analyze`: sin incidencias.
- `flutter test`: 422 pruebas aprobadas.
- `npm run build`: compilación correcta.
- ESLint sobre todos los archivos TypeScript modificados/nuevos: sin incidencias tras
  corregir los hallazgos de la primera pasada.
- `RUN_POSTGRES_INTEGRATION=1 npm test -- --runInBand`: 25 suites, 160 pruebas aprobadas.
  Se ejecutó contra una instancia PostgreSQL temporal local dedicada, con esquemas
  desechables. Incluye las pruebas de handlers y migraciones del proyecto.
- Los tests de envío Flutter usan HTTP simulado para respuesta perdida y reintento;
  los tests PostgreSQL ejercitan SyncService y handlers contra PostgreSQL real.

También se corrigió el aislamiento `search_path` de una prueba previa de migración
PostgreSQL y su expectativa de código SQLSTATE RESTRICT; no se modificó esa migración.
