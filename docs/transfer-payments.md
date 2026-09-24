# Transferencias y reportes de cobros

Implementado 2026-09-23, sin despliegue.

`venta_confirmada` admite cash/transfer/credit. Transfer exige un payment_id,
received_minor = total_minor y change_minor = 0; mantiene cliente opcional.
`payment_reference` admite ausencia/null; aplica trim, vacío a null y límite 500.
`VentaEventHandler` persiste method/reference bajo la transacción y bloqueos ya
existentes. La unicidad de sale_id sigue impidiendo varios pagos directos.

## Esquema

Aplicar `src/migrations/1790208000000-AddTransferSales.ts` después de las
migraciones previas de ventas y créditos, por el proceso explícito del servidor.
Añade reference varchar(500) y ck_direct_payment_method (cash/transfer, MXN,
transferencia sin cambio), sin modificar importes o métodos históricos.
El downgrade bloquea pérdida de transferencias/referencias. La configuración
existente synchronize=true no sustituye planificar las migraciones de producción.
Respaldar y actualizar el servidor y todas las tablets antes de habilitar el uso.
La política Drift de desarrollo recrea bases antiguas y debe resolverse antes de
actualizar tablets con datos que deban preservarse.

## Reporte

`GET /reports/collections?from_ms=1790035200000&to_ms=1790121600000`

Intervalo UTC [from_ms, to_ms), ambos enteros seguros. Devuelve currency=MXN,
cash_minor, transfer_minor y total_minor como cadenas decimales en centavos y
movements con id, event_id, amount_minor (cadena), method, reference,
occurred_at_ms (cadena), origin (sale/customer_payment), sale_id, cliente_id,
cliente_nombre, user_id y device_id. Importes acumulados usan BigInt.

La consulta une sale_payments y customer_payments en un único snapshot y no
incluye credit_allocations: un abono se cuenta una vez, aunque se reparta o aplique
después. Fecha directa = events.created_at_local; abono = occurred_at_ms.
Cliente_nombre corresponde al nombre actual en la proyección de clientes.
El reporte central solo contiene cobros proyectados en servidor; la tablet sigue
calculando sus informes offline e incluye operaciones pendientes o con incidencia.
No hay pagos mixtos, estados de transferencia ni integración bancaria.

## Verificación

Build y ESLint correctos. Suite con PostgreSQL real aislado: 31 suites / 231
pruebas, incluidos contratos, restricciones, migración, rollback, concurrencia,
reintentos, pull y reportes con anticipos y períodos distintos. No se ejecutó
ninguna migración en una base de uso ni se desplegó el servidor.
