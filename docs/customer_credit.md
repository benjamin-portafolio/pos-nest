# Créditos de clientes

Implementado el 2026-09-21 en Flutter y NestJS. Alcance: venta íntegra a crédito,
cliente opcional en efectivo y obligatorio en crédito, abonos en efectivo o
transferencia, anticipos, saldo y consulta de aplicaciones FIFO.

## Uso

1. En Cobrar, seleccionar cliente por nombre o teléfono. Desde el selector se
   puede abrir Gestión de clientes para darlo de alta y volver a elegirlo.
2. Elegir Crédito del cliente y confirmar. La venta queda confirmada y consume
   inventario exactamente una vez. No se crea un pago de efectivo ficticio.
3. En Gestión de clientes, tocar una fila para abrir la cuenta. Se muestran
   teléfono, identificador, saldo, deudas pendientes e historial completo.
4. Registrar abono permite efectivo o transferencia y referencia opcional.
   El importe se aplica a las ventas más antiguas; el excedente queda a favor.
5. Abrir un movimiento muestra su distribución, pendiente, usuario, dispositivo
   y estado de entrega. Ver venta y productos abre el recibo original.
6. Ver / compartir estado de cuenta permite revisar el texto y compartir un PNG.
   Incluye ventas pendientes y las liquidadas con el último abono registrado en
   esa pantalla. El historial completo sigue disponible en pantalla.

El saldo mostrado es abonos menos cargos: negativo = debe, cero = saldado,
positivo = a favor. Las ventas a crédito suman a VENTAS TOTALES. COBROS RECIBIDOS
suma efectivo aplicado a ventas y abonos/anticipos del período; no suma crédito
ni cambio entregado ni vuelve a contar un abono como venta.

## Datos

`sales.cliente_id` es nullable para efectivo y obligatorio por contrato cuando
`payment_method = credit`. Se conserva el nombre del cliente en el evento y el
recibo. El estado de venta sigue siendo `confirmada`, independiente de la deuda.

- `credit_sales`: id = sale_id; sale_id único, cliente_id, amount_minor original,
  occurred_at_ms y trazabilidad común. Moneda del alcance: MXN.
- `customer_payments`: UUID de captura, cliente_id, amount_minor, method
  (`cash`/`transfer`), reference, occurred_at_ms y trazabilidad común.
- `credit_allocations`: clave compuesta payment_id + credit_id y amount_minor.
  Es una proyección reconstruible, sin evento ni ciclo de vida independiente;
  por eso no hereda CommonFields / SyncProjectionEntity.
- `sale_payments` conserva exclusivamente el pago directo existente. Un abono
  se guarda una sola vez en customer_payments y se distribuye en aplicaciones.

Todos los importes son enteros en centavos, positivos para deudas/abonos, con
límite 9007199254740991. El saldo acumulado se calcula con BigInt. Las relaciones
impiden borrar clientes, ventas, créditos y abonos referenciados.

## Eventos y sincronización

`venta_confirmada` admite cash y credit, conservando lectura de los eventos de
efectivo anteriores. Crédito lleva payment_id=null, received_minor=0,
change_minor=0, cliente_id, cliente_event_id, cliente_nombre y occurred_at_ms.
La creación del cliente se agrega a dependency_event_ids. Los consumos y las
líneas conservan las mismas validaciones históricas de la confirmación existente.

`abono_cliente_registrado` usa aggregate_type=customer_payment y aggregate_id
igual al UUID de captura. Lleva cliente_id, cliente_event_id, amount_minor,
method, reference, currency=MXN y occurred_at_ms. Reintentar la misma captura no
crea otro abono; reutilizar su identidad con otros datos se rechaza localmente.

Ambos declaran referencias a cliente y a customer_account, además de venta,
crédito, pago, líneas y recursos cuando corresponden. Las referencias se
construyen y validan en ambos modos:

- standalone: eventos applied/not_required; event_refs permanece vacía; no se
  activan push, pull, preflight, health checks ni WebSocket.
- server_sync: eventos pending y referencias persistidas; push espera el alta
  del cliente. Preflight obtiene los movimientos de la cuenta y pull los aplica
  mediante los mismos handlers. Los ecos solo reconocen secuencias y no duplican
  ni dinero ni consumo de inventario.

Los abonos no dependen de ventas concretas: pueden llegar antes y funcionar como
anticipos. Tras cada cargo o abono se reconstruye FIFO, ordenando créditos y
abonos por occurred_at_ms e id. El importe y el titular de cada operación son
inmutables; sus aplicaciones son una proyección. El servidor serializa cambios
mediante un advisory lock por cuenta. Esto permite abonos concurrentes de varias
tablets sin sobreaplicar una deuda. Al recibir operaciones antes desconocidas,
las aplicaciones pueden cambiar y convergen cuando los dispositivos conocen el
mismo conjunto de eventos.

occurred_at_ms se conserva en el payload para evitar perder milisegundos al
persistir DateTime en SQLite. El UUID desempata fechas idénticas. El criterio
usa la fecha registrada por cada dispositivo: no corrige relojes desajustados.
server_sequence sigue siendo el cursor remoto y no se sustituye por esa fecha.

Una incidencia de entrega no elimina dinero, deuda ni inventario. Se conserva
la operación y se muestra Requiere atención. La limpieza de un alta de cliente
referenciada conserva su fila inactiva para consultar la cuenta; el selector
omite clientes inactivos. Las cuentas con incidencias requieren resolución
administrativa; sus importes locales pueden diferir del servidor hasta resolverla.

## Esquema y puesta en marcha

Flutter mantiene schemaVersion=7 por la política actual del proyecto. Una base
anterior sin tablas de crédito o sin sales.cliente_id se recrea al abrirla mediante
_resetDatabaseOnStartup. Esto elimina sus datos locales. Un respaldo antiguo
marcado como restaurado se rechaza explícitamente y no se borra.

PostgreSQL incluye AddCustomerCredit1790035200000, que agrega el cliente a sales,
las tres tablas, claves foráneas e índices de cuenta. No se ejecutó contra la base
de uso. AppModule registra entidades y handlers; conserva la configuración
existente synchronize=true. Desplegar app y servidor compatibles antes de usar
crédito: una versión anterior no conoce los nuevos contratos.

## Límites de esta entrega

- Se confirma la venta completa contra la cuenta; no se implementan pagos mixtos.
- No se convierte cambio retenido en saldo a favor ni se anulan/revierten abonos.
- Compartir el estado de cuenta genera la imagen con los datos visibles en ese
  momento. No se archivan snapshots inmutables para reimpresión histórica exacta.
- No se añade integración directa con impresoras; se usa compartir PNG, como en
  el recibo de venta existente.
- No se agregan intereses, límites de crédito, vencimientos ni cobranza automática.

## Verificación

- Drift regenerado con dart run build_runner build; dart analyze sin incidencias.
- Suite Flutter: 463 pruebas aprobadas; después se añadió y verificó la generación
  PNG con la suite específica de cuenta (4 pruebas aprobadas).
- Servidor: npm run build y ESLint de los archivos principales modificados.
- 28 suites / 193 pruebas con RUN_POSTGRES_INTEGRATION=1 y PostgreSQL real,
  usando esquemas aislados. La migración nueva también se prueba en transacción.
- Casos: ejemplo 20/10/50/5/10, anticipos, reintentos, doble toque, cliente
  obligatorio, rollback, reinicio, standalone sin refs, push dependiente,
  pull fuera de orden/eco, preflight por cuenta, concurrencia y cobros sin cambio.
