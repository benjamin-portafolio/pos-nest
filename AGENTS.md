# Guia para Codex en este proyecto

Este proyecto contiene el servidor NestJS del POS. Usar este repositorio como
referencia cuando se hable de API, sync server, PostgreSQL, backend o NestJS.

El analisis general del sistema se encuentra en:

- `/Users/benjamin/Library/CloudStorage/GoogleDrive-benjamin94833@gmail.com/My Drive/Projects/POS/analisis `

Nota: el nombre del directorio `analisis ` incluye un espacio final.

## Diagrama ER obligatorio con cambios de base de datos

- Al cambiar entidades, tablas, columnas, tipos, nulabilidad, PK/FK, restricciones,
  indices, triggers relevantes o migraciones, actualizar en la misma tarea el
  archivo `05 - Datos/Diagrama ER actual.md` del vault indicado arriba.
- Seguir `tools/er/README.md` de ese vault: consultar metadatos con
  `tools/er/postgresql.sql`, renovar la captura, actualizar notas, regenerar el ER
  y ejecutar su comprobacion `--check`.
- Revisar entidades y migraciones ademas del catalogo. Distinguir cambios de
  codigo pendientes de lo instalado. Si no hay conexion, conservar la captura
  acreditada y documentar el cambio pendiente; no ejecutar migraciones solo para
  generar documentacion. Respetar las diferencias con SQLite y las reglas por modo.
- No cerrar un cambio de esquema sin actualizar el ER. Cambios de filas sin
  cambios estructurales no requieren actualizarlo.

## Comunicacion con el usuario

- Cuando existan dudas, decisiones pendientes o solicitudes de confirmacion,
  presentarlas siempre como una lista numerada.

## Organizacion de clases por archivo

- Usar una clase principal por archivo como regla base.
- En NestJS, mantener separados controladores, servicios, entidades, gateways,
  enums y DTOs cuando representen responsabilidades propias.
- Se pueden agrupar clases pequenas en un archivo solo cuando sean auxiliares,
  no se reutilicen fuera del modulo y cambien siempre por la misma razon.
- Los DTOs relacionados pueden compartir archivo cuando sean simples y formen
  parte del mismo contrato inmediato; separarlos cuando crezcan, se reutilicen
  o necesiten pruebas o validaciones propias.
- Separar una clase a su propio archivo cuando se importe desde varios lugares,
  se testee por separado, represente una responsabilidad importante o pertenezca
  a otra capa.
- Si una clase merece ser buscada, importada, testeada o entendida por
  separado, debe tener su propio archivo.
