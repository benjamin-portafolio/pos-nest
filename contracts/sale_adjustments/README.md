# Contratos de ajustes de venta v1 — sesión 1, plan revisión 2

`v1.json` es el fixture común calculado a mano y consumido por Dart y TypeScript.
Las dos suites fijan el mismo SHA-256; mantener idénticos ambos archivos y la
copia `Fixtures/v1.json` de la documentación. No generar esperados desde las
reglas que se prueban.

Documentación canónica: `08 - Roadmap/Anulaciones y devoluciones/Contrato tecnico.md`
en el proyecto de análisis (su carpeta `analisis ` termina con un espacio).
Ahí están los campos, revisión/base efectiva, identidades, refs, cálculos,
liquidación, caja/FIFO y conciliación de evidencia física.

Son contratos y preparación pura, sin handlers, persistencia, transporte ni UI.
Los tipos de comandos, lectura y resultados se mantienen por petición explícita
para integrar sesiones posteriores. La preparación bloquea server_sync por
defecto hasta verificar sesiones 7–10; el flag de integración se usa solo en
pruebas contractuales aisladas ahora. Standalone prepara not_required con refs
validadas, que no deben persistirse. No promover historial standalone.

En Flutter ejecutar desde la raíz:

```sh
flutter test test/application/sync/payloads/sale_adjustment_contract_test.dart
dart analyze
```

En NestJS ejecutar desde la raíz:

```sh
npm test -- --runInBand sale-adjustment-contract.spec.ts
npm run build
```

54 escenarios de ajustes en ambos modos, seis vectores de redondeo, tres FIFO
y cinco conciliaciones, además de identidad, normalización y causalidad.
Los tests del contrato no certifican atomicidad SQLite/PostgreSQL, HTTP,
replay/ACK, cambios de modo, cortes reales ni hardware.
