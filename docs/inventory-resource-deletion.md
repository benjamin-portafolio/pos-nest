# Baja lógica de recursos de inventario

`recurso_inventario_eliminado` usa `aggregate_type = inventory_item` y payload
`{base_event_id}`. Exige `base_version >= 1` y acepta la secuencia oficial base
conocida o null, con las mismas comprobaciones causales de las mutaciones actuales.
No acepta opciones para forzar borrado ni modificar saldo.

El handler bloquea primero el recurso y luego su balance. Comprueba saldo en mano
y disponible iguales a cero, ausencia de vínculo directo y receta (incluidas
variantes inactivas) y de borradores que necesitan el recurso. Rechaza bases
obsoletas y recursos inactivos mediante conflicto funcional, sin modificar la
proyección. Los manejadores de producto bloquean el recurso al validar nuevas
relaciones; movimientos y ventas usan el mismo orden recurso → balance.

Aceptar escribe evento/refs, `active = false`, versión y metadatos dentro de la
transacción de sync. Conserva balance, movimientos, procedencia, memoria de
variantes y ventas. El transporte existente distribuye la baja por push/pull y
reconoce reenvíos duplicados. Un recurso inactivo rechaza nuevas ediciones y
movimientos manuales; las ventas y ajustes históricos conservan sus identidades.
Las ventas confirmadas son historial, no borradores pendientes de consumo.

`recurso_inventario_descartado` sigue rechazado: corresponde a otra operación,
el descarte físico automático local. No se convierte historial standalone en
pendiente de sincronización.

No hay migraciones. Actualizar servidor y clientes antes de utilizar la función
entre dispositivos, pues clientes anteriores desconocen el nuevo evento.

Verificación: contrato tipado, suite general Jest y
`inventory-event.handler.postgres.spec.ts` con `RUN_POSTGRES_INTEGRATION=1`.
Esta última crea y elimina solo su esquema temporal, sin tocar tablas del negocio.
Incluye aceptación, bloqueos, duplicado, distribución por pull y conservación.
