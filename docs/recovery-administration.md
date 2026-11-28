# Administración de recuperación desde escritorio

Implementado el 2026-11-27. La app Flutter ofrece **Administración del servidor**
en el menú lateral de Windows, macOS y Linux en modo `server_sync`.
No aparece en móvil, web ni standalone. Esta restricción de interfaz no sustituye
la autorización de la API.

## Aprovisionamiento de acceso

El backend usa una contraseña administrativa independiente de los usuarios de
negocio; funciona incluso cuando el destino está vacío. El asistente se ejecuta
como paso de instalación o posteriormente para cambiarla:

```sh
npm install
npm run build
npm run admin:password
```

Si las dependencias y el build ya están actualizados, basta con el último comando.
Pide una contraseña de **15 a 128 caracteres** y su confirmación, sin mostrar lo que
escribes ni aceptar el secreto como argumento o por tubería. Permite espacios,
acentos y otros caracteres Unicode; los espacios iniciales/finales son parte de la
contraseña. Ctrl+C cancela antes de guardar. No imprime la contraseña ni su hash.

El asistente escribe automáticamente `POS_RECOVERY_ADMIN_PASSWORD_HASH` en el `.env`
de la raíz de este proyecto, incluso si ejecutas el archivo compilado desde otra
carpeta. El valor se guarda entre comillas simples: contiene Argon2id, versión,
parámetros y sal aleatoria. Usa 64 MiB, 3 iteraciones y paralelismo 1. La contraseña
original no se guarda. Conserva las demás variables/comentarios, retira asignaciones
activas de la clave SHA-256 anterior y elimina duplicados de la configuración
administrativa. Reemplaza el archivo de forma atómica con modo 0600 en sistemas
Unix, sin generar copias de respaldo del `.env`.

Para elegir otro archivo de configuración:

```sh
npm run admin:password -- --env-file /ruta/privada/servidor.env
```

Para ejecutar desde otra carpeta, usa `npm --prefix /ruta/a/pos-nest run admin:password`
o `node /ruta/a/pos-nest/dist/recovery/configure-recovery-admin.js`. El comando usa
el build compilado y funciona también con dependencias de producción (`ts-node`
no es necesario). No abre HTTP, conecta a PostgreSQL ni ejecuta migraciones.

Después de guardar, **reinicia NestJS** e ingresa la contraseña original en
**Administración del servidor → Contraseña administrativa** de Flutter. La app
solo la conserva mientras está abierta esa pantalla. La contraseña **no tiene
caducidad automática**; vuelve a ejecutar el mismo asistente para reemplazarla.
Si el servicio gestiona variables de entorno fuera del archivo, instala allí el
valor generado o ajusta su archivo configurado: las variables del proceso tienen
prioridad sobre `.env`, y `POS_IGNORE_ENV_FILE=1` impide cargarlo.

El asistente no sustituye el aprovisionamiento del resto del servidor y no se
lanza automáticamente en `npm install` o al arrancar NestJS: las instalaciones
no interactivas y los reinicios conservan la contraseña existente. Si el archivo
está bloqueado por otro asistente, no lo sobrescribe. No acepta enlaces simbólicos.
Tras una interrupción durante la escritura, verifica que no quede un asistente
activo antes de retirar manualmente un archivo `.recovery-admin.lock` residual.

### Compatibilidad con instalaciones anteriores

Sin `POS_RECOVERY_ADMIN_PASSWORD_HASH` se mantiene la credencial aleatoria anterior
mediante `POS_RECOVERY_ADMIN_TOKEN_SHA256`. El backend actualizado acepta el bearer
anterior y también Basic `admin:<secreto>` en UTF-8. Flutter conserva Bearer para
credenciales de 64 caracteres hexadecimales y usa Basic para otras contraseñas;
esto mantiene el acceso con la clave anterior antes de actualizar el backend.
Basic es transporte codificado, **no cifrado**; usar HTTPS fuera de loopback, con
la política HTTP local existente bajo `POS_ALLOW_LOCAL_HTTP=true` en compilación.

Si existe la variable nueva, es la única autoridad: nunca se prueba la credencial
SHA-256 antigua, aunque el hash Argon2 esté vacío o sea inválido. Configuración
incorrecta falla cerrada con 503. La migración a la contraseña elegida requiere el
backend y Flutter actualizados. Los tokens temporales de recuperación, pruebas de
conexión y bindings de sync conservan su formato y no se usan como contraseña
administrativa. Esta configuración no cambia permisos ni datos de negocio.

El esquema de negocio y las migraciones de recuperación deben estar instalados
antes de iniciar NestJS, con rol runtime sin propiedad ni DDL, como ya exige el
protocolo. Esta pantalla no aprovisiona PostgreSQL, aplica migraciones, cambia roles
ni elimina datos existentes. No requiere cambios de esquema.

## Recorrido

1. En computadora abrir el menú lateral → Administración del servidor.
2. Introducir la URL del destino y su contraseña administrativa; **Consultar estado**.
   La URL se inicializa desde la configuración de sync, pero editarla aquí no cambia
   el endpoint operativo de la app. Consultar no activa recuperación.
3. Comprobar identidad, generación y elegibilidad. **Habilitar recuperación** solo
   se permite para un destino vacío y compatible; confirmar el destino mostrado.
4. En el dispositivo origen `server_sync`, abrir Configuración → Recuperar servidor
   desde este dispositivo. Diagnosticar, preparar el paquete y comprobar el destino
   para crear su solicitud. Conservar las exclusiones y bloqueos del flujo actual.
5. En computadora volver a **Consultar estado**. Comparar dispositivo, paquete y
   SHA-256 con el origen y aprobar esa solicitud. Rechazar solo solicitudes que no
   deban continuar. Aprobar no transfiere ni publica datos desde la computadora.
6. En el origen volver a comprobar/continuar. Allí se transfiere, valida, confirma
   la publicación y se vincula el origen conforme al flujo existente.
7. Actualizar en computadora para ver la sesión, lotes recibidos y diagnóstico.
   Publicar cambia la generación; la siguiente consulta refleja los datos publicados
   y únicamente las solicitudes de la nueva generación. No mezclar intentos antiguos.

No se puede deshabilitar la recuperación ni cambiar la decisión de una solicitud
ya iniciada: finalizar o abortar desde el origen primero. Esto evita revocar el
acceso necesario para continuar/abortar una sesión activa. Deshabilitar antes del
inicio revoca autorizaciones pendientes y conserva las completadas según la política
existente. Rehabilitar no aprueba automáticamente las solicitudes pendientes.
El alta de otros dispositivos se administra por separado en **Administración del
servidor → Alta de dispositivos**. Consulta con la misma contraseña y activa el
interruptor; confirma el servidor mostrado. Requiere servidor activo, dataset
publicado y ninguna recuperación en curso. El alta permanece deshabilitada hasta
una acción explícita. En escritorio, el intento completado también ofrece
**Permitir conectar otros dispositivos**, que abre esta pantalla sin transferir
la contraseña. En móvil se administra desde la computadora.

Cada instalación vacía debe usar modo servidor y aplicar la URL desde Configuración
→ Sincronización (o configuración inicial). Descarga la base inicial y recibe los
cambios posteriores. Instalar una versión actualizada de Flutter y NestJS para este
recorrido. Bases con datos o vinculaciones anteriores conservan sus bloqueos.
Deshabilitar altas bloquea nuevos enrolamientos y, según el protocolo existente,
impide completar grants automáticos aún no vinculados; no revoca bindings ya emitidos.
No se modifica el esquema ni se ejecutan migraciones.

La recuperación conserva el corte de **un** origen; no garantiza contener datos que
solo estaban en otros equipos. No sustituye un dataset publicado ni fusiona equipos.
En standalone se conserva el diagnóstico local existente sin ninguna llamada remota.

## API y concurrencia

- `GET /recovery-admin/status`: estado, revisión, elegibilidad y hasta 100 solicitudes
  de la generación actual, con estado de sesión y número de lotes recibidos. Respuesta
  `Cache-Control: no-store`; nunca devuelve credenciales ni hashes de autorización.
- `POST /recovery-admin/actions`: `{action, expected_revision, request_id?}`.
  Acciones: `enable`, `disable`, `approve`, `reject`, `enrollment-enable`,
  `enrollment-disable`; UUID de solicitud requerido exclusivamente para `approve`
  y `reject`. El estado incluye `automatic_enrollment`.
- Ambos exigen la contraseña administrativa por Basic (usuario fijo `admin`, UTF-8)
  o el bearer compatible descrito arriba, además de `X-POS-Protocol: 1`,
  `X-POS-Server` y `X-POS-Generation`. La app descubre identidad por `/sync/health`
  sin enviar el secreto y comprueba la identidad de la respuesta administrativa.
- Los cambios toman `server_state FOR UPDATE`, cotejan generación/revisión,
  verifican elegibilidad/estado y escriben auditoría en la misma transacción.
  La auditoría identifica el canal `desktop-recovery-admin`; es una credencial
  operativa compartida, no autenticación nominativa por usuario.
- La revisión cambia después de cada acción. Ante concurrencia, conflicto o respuesta
  perdida, la app descarta los botones ligados al estado anterior y exige consulta
  nueva. No reintenta mutaciones ni sigue redirecciones automáticamente.
- 401: credencial inválida; 409: destino/revisión/estado cambió o acción inadmisible;
  503: configuración administrativa ausente. La API no depende del viewport/plataforma
  del cliente para autorizar: quien tenga la credencial puede invocarla.

## Verificación

`npm run build` y `npm test -- --runInBand`. La suite HTTP nueva usa NestJS real y
un adaptador de base simulado: verifica el guard, ámbito por generación, revisión,
validaciones, revocación y auditoría. No acredita una recuperación productiva ni
aplica migraciones. La suite PostgreSQL optativa existente conserva sus requisitos
explícitos y no se activa como efecto lateral de esta funcionalidad.

### Verificación del asistente

`npm run build`, `npm test -- --runInBand` y, en Unix,
`python3 test/support/recovery-admin-password-pty.py`. Este último usa una terminal
PTY y un `.env` de fixture temporal: entrada oculta, confirmación incorrecta/correcta,
acentos/espacios, lectura del hash con dotenv y verificación Argon2, revocación de la
configuración antigua y Ctrl+C sin cambios. Nunca usa el `.env` real.
