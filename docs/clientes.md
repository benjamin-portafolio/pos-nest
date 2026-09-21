# Alta de clientes

La tabla `clientes` contiene `cliente_id` UUID, `nombre` obligatorio y `telefono`
textual opcional, además de los campos de `SyncProjectionEntity`. Nombre y teléfono
pueden repetirse entre clientes distintos. El contrato `ClienteCreadoPayload`
normaliza espacios exteriores y convierte el teléfono vacío a `null`.

`cliente_creado` usa `aggregate_type = cliente`, `base_version = 1` y ninguna
`base_server_sequence`. `ClienteEventHandler` guarda evento, referencia
`cliente / <UUID> / affects` y proyección en la misma transacción. El servidor
serializa altas con igual identidad; los reintentos son idempotentes y una
identidad ocupada genera un conflicto con el evento ganador.

`SyncService` integra push, pull, preflight, notificación de eventos y reporte de
conflictos. Los dispositivos standalone conservan el alta local y no ejecutan
estos servicios.

La migración `CreateClientes1789646400000` crea únicamente esta tabla y rechaza
retirarla si contiene clientes. La entidad también está registrada en AppModule
para la configuración de desarrollo existente (`synchronize: true`). La tabla
se creó en la base configurada durante la implementación del 17 de septiembre de
2026, sin insertar clientes de prueba ni modificar catálogos existentes.

Pruebas de contrato: `src/sync/payloads/cliente-creado.payload.spec.ts`.
Pruebas PostgreSQL: `src/sync/cliente-event.handler.postgres.spec.ts`; requieren
`RUN_POSTGRES_INTEGRATION=1` y las variables `DATABASE_*`. Usan un esquema aislado,
ejercitan la migración, altas concurrentes, rechazos, duplicados, preflight,
pull, notificaciones y reporte de conflictos, y eliminan el esquema al terminar.
