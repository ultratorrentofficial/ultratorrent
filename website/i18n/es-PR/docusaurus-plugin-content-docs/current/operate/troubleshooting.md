---
id: troubleshooting
title: Resolución de Problemas
sidebar_position: 2
description: Manual de resolución de problemas de UltraTorrent organizado por síntoma — fallas reales de producción ya diagnosticadas, con los comandos de diagnóstico exactos, causas raíz, soluciones y pasos de verificación.
keywords:
  - resolución de problemas
  - troubleshooting
  - depuración
  - no funciona
  - roto
  - error
  - arreglar
  - solución
  - crash
  - bucle de reinicios
  - restart loop
  - atascado
  - colgado
  - congelado
  - falló
  - la descarga no inicia
  - rtorrent crash
  - priority_queue_insert
  - internal_error
  - P3009
  - P1000
  - P1001
  - prisma migration failed
  - 429
  - Cloudflare
  - FlareSolverr
  - SSRF
  - blocked internal address
  - magnet failed
  - compartiendo para siempre
  - escaneo atascado
  - episodios faltantes
  - lento
  - logs
  - diagnóstico
---

# Resolución de Problemas {#troubleshooting}

Esta es la página insignia de operaciones. Casi todas las entradas de abajo son una **falla
real que fue diagnosticada en un host de UltraTorrent en vivo** — los números, las líneas de
log y las causas raíz son las de verdad, no ejemplos inventados. Las entradas que describen
una falla plausible pero no confirmada están marcadas explícitamente.

Cada entrada sigue la misma forma:

> **Síntoma** → **Cómo diagnosticar** (comandos exactos) → **Causa raíz** → **Solución** →
> **Verifica**

## Cómo usar esta página {#how-to-use-this-page}

Trabaja **empezando por el síntoma**. No empieces adivinando cuál subsistema es; empieza
observando cuál caja se está portando mal, y de ahí salta a esa sección.

```mermaid
flowchart TD
    A["Algo anda mal"] --> B{"docker compose ps<br/>— ¿está arriba el backend?"}
    B -->|"reiniciando / salió"| C["Arranque e inicio"]
    B -->|"arriba"| D{"¿Carga la interfaz?"}
    D -->|"no"| E["Red y proxy inverso"]
    D -->|"sí"| F{"¿Qué está fallando?"}
    F -->|"las descargas no inician"| G["Descargas"]
    F -->|"motor sin conexión"| H["Motores y rTorrent"]
    F -->|"las búsquedas no devuelven nada"| I["Indexadores"]
    F -->|"las series no reportan episodios faltantes"| J["Identificación de medios"]
    F -->|"un escaneo nunca termina"| K["Escaneos y trabajos"]
    F -->|"todo está simplemente lento"| L["Rendimiento"]
    F -->|"errores de BD en el log"| M["Base de datos"]

    click C "#startup-and-boot"
    click E "#networking-and-reverse-proxy"
    click G "#downloads"
    click H "#engines-and-rtorrent"
    click I "#indexers"
    click J "#media-identification"
    click K "#scans-and-jobs"
    click L "#performance"
    click M "#database"
```

### El árbol de decisión que los operadores de verdad necesitan: "mi descarga no inicia" {#the-decision-tree-operators-actually-need-my-download-isnt-starting}

Este es el síntoma más reportado, y tiene por lo menos seis causas distintas.
Sigue el árbol en vez de adivinar.

```mermaid
flowchart TD
    S["Una descarga no inicia"] --> A{"¿Hay un motor registrado<br/>y en línea?<br/>GET /api/engines/health"}
    A -->|"online: false"| A1["Motor inalcanzable →<br/>entrada de motor sin conexión"]
    A -->|"online: true"| B{"¿El torrent llegó a<br/>AGREGARSE al motor siquiera?"}

    B -->|"nunca apareció"| C{"¿Fue capturado<br/>automáticamente (RSS /<br/>Descarga Inteligente / barrido)?"}
    C -->|"sí"| C1{"¿El log dice 'resolves to a<br/>blocked internal address'?"}
    C1 -->|"sí"| C2["La guardia SSRF bloqueó el<br/>enlace .torrent del indexador →<br/>SSRF_ALLOW_HOSTS"]
    C1 -->|"no"| C3["El indexador no devolvió nada →<br/>sección de Indexadores"]
    C -->|"no, lo agregué a mano"| C4["Revisa el error al agregar en<br/>el registro de auditoría"]

    B -->|"está en el motor"| D{"¿En qué estado está?"}
    D -->|"en cola"| D1["Ranuras de cola agotadas →<br/>torrents muertos bloqueando la cabecera<br/>de línea. Entrada de cola de estacionamiento"]
    D -->|"metaDL / estancado,<br/>0 seeders"| D2["Torrent muerto — sin seeders.<br/>No hay nada que descargar.<br/>Entrada de cola de estacionamiento"]
    D -->|"descargando, 0 B/s"| D3["Sin pares / problema de tracker →<br/>revisa trackers + seeders"]
    D -->|"marcado como fallido, pero<br/>llegan datos"| D4["Entrada de falsa falla de la<br/>ventana de confirmación de magnet"]
```

---

## Arranque e inicio {#startup-and-boot}

### El backend sale de inmediato con "insecure secret configuration" {#the-backend-exits-immediately-with-insecure-secret-configuration}

**Síntoma.** El container `backend` sale a los segundos de arrancar, en bucle. El
log termina con una queja sobre secretos inseguros. No sirve nada.

**Cómo diagnosticar.**

```bash
docker compose logs --tail 40 backend
docker compose ps          # backend muestra Restarting / Exited
```

**Causa raíz.** Esto es una **función de seguridad deliberada, no un bug**. Cuando
`NODE_ENV=production`, UltraTorrent se niega a arrancar si `JWT_ACCESS_SECRET` o
`ENCRYPTION_KEY` está:

- sin definir, o
- es un valor por defecto conocido (`dev-*`, `change-me`), o
- tiene menos de 32 caracteres, o
- es **idéntico al otro**.

El hueco que cierra es real y serio: un secreto olvidado significa una llave de firma
de JWT predecible, lo que significa que cualquiera puede falsificar un token de `SUPER_ADMIN`.

**Solución.** Genera valores genuinamente aleatorios y *distintos*, y ponlos en `.env`:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 48   # ENCRYPTION_KEY  (tiene que SER DISTINTO de JWT_ACCESS_SECRET)
```

```bash
docker compose up -d --force-recreate backend
```

:::danger Cambiar `ENCRYPTION_KEY` no sale gratis
`ENCRYPTION_KEY` cifra los secretos TOTP, las claves API de los indexadores, la clave de
Prowlarr y las contraseñas de los motores en reposo. Rotarla **los invalida todos** — los
usuarios tienen que volver a inscribir el 2FA y tú tienes que volver a ingresar las claves
API. Configúrala una vez, bien, y haz backup de ella.
Consulta [Seguridad → Rotar secretos](/operate/security#rotating-secrets).
:::

**Verifica.** `docker compose ps` muestra `backend` como `Up`, y
`wget -qO- http://127.0.0.1:4000/api/system/live` dentro del container tiene éxito.

---

### El backend entra en bucle de reinicios tras una actualización — Prisma `P3009` {#the-backend-restart-loops-after-an-upgrade--prisma-p3009}

**Síntoma.** Después de bajar una versión nueva y reconstruir, el backend no arranca
del todo. Entra en bucle de reinicios. El log muestra un **`P3009`** de Prisma: *migrate found
failed migrations in the target database*.

:::info Esta es una caída real y documentada
Esto pasó en **ambos** hosts de producción simultáneamente. No es algo
hipotético — y la solución de abajo es la que de verdad se usó.
:::

**Cómo diagnosticar.**

```bash
docker compose logs --tail 60 backend | grep -A5 P3009

# ¿Cuál migración está marcada como fallida?
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "SELECT migration_name, started_at, finished_at, applied_steps_count
      FROM _prisma_migrations
      WHERE finished_at IS NULL
      ORDER BY started_at DESC;"
```

Una fila con `finished_at = NULL` es una migración que empezó y nunca completó.

**Causa raíz.** El backend corre `prisma migrate deploy` en cada arranque. Una
migración que contiene un **`CREATE INDEX` de larga duración** contra una tabla grande
(el catálogo de IMDb completamente importado, de 8.9M filas) toma minutos y mantiene un
bloqueo. Si esa construcción se interrumpe — un timeout del despliegue, un container que
se mata, un `Ctrl-C` impaciente — Prisma marca la migración como **fallida**, y de ahí en
adelante *se niega a correr cualquier migración*, así que el backend nunca arranca.

Hay una lección más profunda horneada en el código actual: `CREATE INDEX CONCURRENTLY`
**no puede correr dentro de una transacción**, así que de todos modos jamás puede vivir en
una migración de Prisma. Por eso UltraTorrent ahora construye esos índices de trigramas en
**tiempo de ejecución**, en segundo plano, vía `ImdbTrigramIndexService` — la migración en sí
solo hace un `CREATE EXTENSION IF NOT EXISTS pg_trgm`, que es barato. Una instalación nueva
los construye al instante (catálogo vacío); una existente los rellena sin tiempo fuera de servicio.

**Solución.** Dile a Prisma que la migración sí está aplicada — y luego deja que el backend arranque.

```bash
# 1. Confirma que los cambios de esquema de la migración de verdad están presentes (ver abajo).
# 2. Márcala como aplicada:
docker compose exec backend npx prisma migrate resolve \
  --applied 20260711060000_imdb_trigram_indexes

# 3. Arranca:
docker compose up -d --force-recreate backend
```

Sustituye el nombre de la migración que devolvió tu consulta a `_prisma_migrations`.

:::caution Solo hagas `resolve --applied` si el cambio de verdad se aplicó
`migrate resolve --applied` no corre ningún SQL — solo *registra* la migración como hecha.
Si los cambios de la migración están genuinamente ausentes, usa `--rolled-back` en su lugar
y déjala correr de nuevo. Para el caso de los trigramas, el cuerpo de la migración es solo
`CREATE EXTENSION IF NOT EXISTS pg_trgm`, que es idempotente y casi instantáneo, así que
`--applied` es seguro una vez que la extensión existe:

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';"
```
:::

**Verifica.**

```bash
docker compose logs --tail 30 backend      # sin P3009; "Nest application successfully started"
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;"   # 0
```

Luego confirma que los índices que se suponía que creara se están construyendo en
segundo plano y terminan **válidos** — consulta
[un índice INVÁLIDO](#queries-are-slow-again-and-an-index-exists-but-is-ignored).

---

### El backend falla con `Cannot find module '...'` al arrancar {#the-backend-crashes-with-cannot-find-module--at-boot}

**Síntoma.** El container arranca, y luego muere con un error de resolución de módulos de Node.

**Cómo diagnosticar.**

```bash
docker compose logs --tail 20 backend | grep "Cannot find module"
```

**Causa raíz.** A la imagen le falta una dependencia anidada del workspace. npm no
siempre eleva las dependencias al `node_modules` raíz, así que una etapa de ejecución que
copia solo el árbol raíz puede dejar fuera `apps/backend/node_modules`.

**Solución.** Reconstruye con los Dockerfiles actuales, sin modificar:

```bash
docker compose up -d --build
```

Si personalizaste el Dockerfile del backend, asegúrate de que la etapa de ejecución copie
`apps/backend/node_modules` además del raíz.

**Verifica.** `docker compose logs backend` llega al banner de arranque de Nest.

---

## Docker {#docker}

### Compose se niega a arrancar: "POSTGRES_PASSWORD is required" {#compose-refuses-to-start-postgres_password-is-required}

**Síntoma.** `docker compose up` falla al instante, antes de que arranque ningún container.

**Causa raíz.** El stack viene con **cero valores por defecto inseguros**. `POSTGRES_PASSWORD`
y `ADMIN_PASSWORD` están declaradas con la sintaxis de variable requerida `:?` de Compose, así
que Compose mismo se niega a renderizar el archivo sin ellas.

**Solución.** Define ambas en `.env`. Usa un `POSTGRES_PASSWORD` **alfanumérico** — el
`DATABASE_URL` se deriva de él, y los caracteres especiales de URL (`@ : / ?`) necesitarían
codificación por porcentaje y de lo contrario romperían la cadena de conexión en silencio.

**Verifica.** `docker compose config` renderiza sin error.

---

### El backend entra en bucle de fallos con Prisma `P1000: Authentication failed` {#the-backend-crash-loops-with-prisma-p1000-authentication-failed}

**Síntoma.** Postgres está arriba y saludable, pero el backend no puede autenticarse
contra él — aunque la contraseña en `.env` es obviamente la correcta.

**Cómo diagnosticar.**

```bash
docker compose logs --tail 20 backend | grep P1000
docker volume ls | grep postgres_data     # el volumen ya existe
```

**Causa raíz.** Esta es clásica y bien confusa. **Postgres solo aplica
`POSTGRES_PASSWORD` en la primera inicialización de su directorio de datos.** Si el
volumen `postgres_data` se creó originalmente con una contraseña *distinta*, los cambios
posteriores a `.env` **no tienen ningún efecto** sobre el volumen existente — la contraseña
vieja sigue siendo la de verdad.

**Solución.** Si la base de datos no tiene datos que te importen, reiníciala:

```bash
docker compose down -v          # DESTRUYE el volumen de la base de datos
docker compose up -d --build
```

Si *sí* tiene datos, no la destruyas — cambia la contraseña dentro de Postgres
para que coincida con `.env`:

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "ALTER USER ultratorrent WITH PASSWORD 'your-new-alphanumeric-password';"
docker compose up -d --force-recreate backend
```

**Verifica.** `docker compose logs backend` ya no muestra `P1000`, y la app sirve.

---

### El puerto de la interfaz web ya está en uso (común en un NAS) {#the-web-ui-port-is-already-in-use-common-on-a-nas}

**Síntoma.** `docker compose up` falla al enlazar el `8080`, o la interfaz la sirve
otra cosa completamente distinta (un panel de administración del NAS).

**Solución.** Define un puerto libre en `.env` y vuelve a levantar:

```dotenv
FRONTEND_PORT=8123
```

```bash
docker compose up -d
```

:::warning No trates de remapear el puerto con un archivo de override de Compose
Compose **añade** las entradas de `ports` en vez de reemplazarlas, así que el mapeo
original del `8080` sobrevive junto al nuevo y sigue en conflicto. Usa
`FRONTEND_PORT`.
:::

**Verifica.** `docker compose ps` muestra el puerto nuevo del host; la interfaz carga en él.

---

### Las descargas quedan como propiedad de root, o la app no puede escribir en una ruta {#downloads-are-owned-by-root-or-the-app-cannot-write-to-a-path}

**Síntoma.** *"El proceso de la app no puede escribir en esta ruta"* al configurar la
Ruta Raíz Predeterminada; o los archivos descargados terminan como propiedad de `root` y tu
servidor de medios no los puede leer.

**Cómo diagnosticar.**

```bash
docker compose exec rtorrent id            # ¿como quién está corriendo rtorrent de verdad?
ls -ln /path/to/downloads                  # dueño numérico del árbol
```

**Causa raíz.** El entrypoint del rTorrent incluido arranca como root, hace chown del
volumen de descargas, y luego **baja a `PUID:PGID` vía gosu**. Ese descenso necesita las
capacidades `SETUID`/`SETGID`. Algunos hosts — **notablemente Synology DSM** — se las quitan
al conjunto de capacidades por defecto del container, el descenso falla con
*"operation not permitted"*, y el entrypoint cae de vuelta a correr como **root**.
Por eso `docker-compose.yml` las vuelve a añadir explícitamente:

```yaml
cap_add: ["SETUID", "SETGID"]
```

**Solución.**

- Asegúrate de que tu archivo de Compose todavía lleve ese `cap_add` (está en el que se publica).
- Define `PUID`/`PGID` con el usuario que debe ser dueño de los medios. Si la carpeta le
  pertenece a otra app (p. ej. Plex), **no le hagas `chown`** — define `PUID`/`PGID` con *ese*
  usuario (`id plex`), para que rTorrent escriba como él.

```dotenv
PUID=1000
PGID=1000
```

```bash
docker compose --profile rtorrent up -d --force-recreate rtorrent
```

**Verifica.** `docker compose exec rtorrent id` reporta tu `PUID`, y los archivos recién
descargados llevan ese dueño.

---

## Base de datos {#database}

### Una consulta va lenta y `pg_stat_activity` muestra consultas `active` largas {#a-query-is-slow-and-pg_stat_activity-shows-long-active-queries}

Esta es la técnica de diagnóstico detrás del peor incidente de rendimiento en la
historia de UltraTorrent, así que vale la pena aprenderla bien. Consulta
[un escaneo de biblioteca se congela](#a-library-scan-freezes-at-a-percentage-and-never-completes)
para ver el incidente mismo.

**Cómo diagnosticar.** La destreza crucial es distinguir entre **hambriento** y **atascado**:

```bash
# Consultas de larga duración, las más recientes primero. Mira `state` y `wait_event_type`.
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT pid, now() - query_start AS duration, state, wait_event_type, wait_event,
       left(query, 90) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND query_start IS NOT NULL
ORDER BY duration DESC
LIMIT 15;"

# Margen de conexiones — ¿está siquiera lleno el pool?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) AS used, current_setting('max_connections') AS max
FROM pg_stat_activity;"

# Contención real de bloqueos (normalmente NO es el problema)
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT pid, relation::regclass, mode, granted
FROM pg_locks WHERE NOT granted;"
```

**Cómo leerlo.**

| Observación | Significa |
|-------------|-----------|
| `state = active`, duración larga, `wait_event_type` es nulo/`CPU` | **Hambriento, no atascado.** La base de datos está *trabajando* — la consulta es genuinamente costosa. Arregla la consulta o el índice. |
| `state = active`, `wait_event_type = Lock` | Contención de bloqueos genuina. Busca a quien bloquea. |
| `pg_locks` tiene filas no concedidas | Contención de bloqueos. |
| Conexiones muy por debajo de `max_connections` | El pool **no** está agotado — no te faltan conexiones. |

En el incidente real los números fueron: consultas `active` largas, **cero** contención
de bloqueos, y solo **13 de 100** conexiones en uso. Esa combinación es la firma de
*"una consulta es tan costosa que se está comiendo el servidor"*, y te apunta directo a
un índice faltante en vez de a la concurrencia.

---

### Las consultas vuelven a ir lentas, y un índice "existe" pero se ignora {#queries-are-slow-again-and-an-index-exists-but-is-ignored}

**Síntoma.** Creaste los índices de trigramas, pero las búsquedas siguen lentas. `\di`
muestra el índice por nombre — y sin embargo `EXPLAIN` nunca lo usa.

**Cómo diagnosticar.**

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT c.relname AS index_name, i.indisvalid, i.indisready
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname LIKE '%trgm%';"
```

**Causa raíz.** Un `CREATE INDEX CONCURRENTLY` interrumpido deja el índice
atrás en estado **INVÁLIDO** (`indisvalid = false`). El planificador ignora por completo
un índice inválido — pero el *nombre* existe, así que un `CREATE INDEX ... IF NOT EXISTS`
ingenuo lo ve y se salta la reconstrucción **para siempre**. Te queda un índice
permanentemente presente y permanentemente inútil.

El `ImdbTrigramIndexService` de UltraTorrent maneja esto explícitamente: detecta un
índice inválido, **lo elimina**, y lo reconstruye. Pero si construiste un índice a mano
y lo interrumpiste, la limpieza es tuya.

**Solución.**

```sql
DROP INDEX CONCURRENTLY IF EXISTS <the_invalid_index_name>;
-- luego deja que el servicio lo reconstruya en el próximo arranque, o reconstrúyelo a mano:
CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_titles_primary_title_trgm
  ON imdb_titles USING gin ("primaryTitle" gin_trgm_ops);
```

**Verifica.** `indisvalid` es `true`, y `EXPLAIN` sobre una búsqueda de título muestra un
**Bitmap Index Scan** en vez de un Seq Scan.

---

### `P1001: Can't reach database server at postgres:5432` {#p1001-cant-reach-database-server-at-postgres5432}

**Síntoma.** Prisma no puede alcanzar la base de datos. Casi siempre es una **instalación
manual (sin Docker)**.

**Causa raíz.** `DATABASE_URL` todavía apunta al **nombre de servicio** de Docker
`postgres`, que no resuelve fuera de la red de Compose.

**Solución.** Para una instalación manual, apúntalo a `localhost`:

```dotenv
DATABASE_URL=postgresql://ultratorrent:PASSWORD@localhost:5432/ultratorrent?schema=public
```

Para Docker, déjalo quieto — el backend lo deriva de `POSTGRES_*`
automáticamente, así que no puede desincronizarse de la contraseña de la base de datos.

**Verifica.** `npx prisma migrate status` conecta.

---

## Red y proxy inverso {#networking-and-reverse-proxy}

### La interfaz carga pero la API da 404 / errores de CORS en la consola del navegador {#the-ui-loads-but-the-api-404s--cors-errors-in-the-browser-console}

**Cómo diagnosticar.** Abre la pestaña Network de las devtools del navegador y mira a dónde
van de verdad las peticiones `/api/...`, y qué devuelven.

```bash
# ¿Es alcanzable el backend desde el container del frontend?
docker compose exec frontend wget -qO- http://backend:4000/api/system/live
```

**Causa raíz.** Una de dos:

1. Tu proxy inverso no está reenviando `/api/` al backend.
2. `CORS_ORIGIN` no incluye el origen que el navegador está usando de verdad.
   CORS está restringido al origen configurado; el valor va separado por comas.

**Solución.** Define `CORS_ORIGIN` con el esquema+host+puerto exacto que usa el navegador:

```dotenv
CORS_ORIGIN=https://ultratorrent.example.com
```

Recrea el backend. Consulta [Proxy inverso](/install/reverse-proxy).

**Verifica.** La petición a `/api/system/live` tiene éxito desde el navegador sin ningún
error de CORS.

---

### El WebSocket nunca conecta (sin actualizaciones en vivo) {#the-websocket-never-connects-no-live-updates}

**Síntoma.** Las filas de torrents nunca se actualizan en tiempo real; tienes que refrescar a mano.

**Cómo diagnosticar.** En las devtools, busca la petición `/ws` fallando al hacer el upgrade
(HTTP 400/404 en vez de 101 Switching Protocols).

**Causa raíz.** O el JWT falta/expiró, o — mucho más común — tu
proxy inverso **no está pasando los headers de upgrade del WebSocket**. Un proxy pass HTTP
simple no basta; hay que reenviar `Upgrade` y `Connection`.

**Solución.** nginx:

```nginx
location /ws/ {
    proxy_pass http://backend:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Caddy maneja el upgrade automáticamente — el `deploy/Caddyfile` que se publica enruta
`/api/*` y `/ws/*` a `backend:4000` sin configuración adicional.

**Verifica.** La petición `/ws` devuelve **101**, y las barras de progreso de los torrents se
mueven sin refrescar.

:::note
La pasarela de WebSocket autentica el JWT **en el handshake** y une cada
socket solo a las salas que corresponden a los permisos de vista que tiene. Si un usuario
conecta pero no recibe eventos, revisa sus permisos — puede que simplemente le falte
`torrents.view`. Consulta [Permisos](/reference/permissions).
:::

---

## Motores y rTorrent {#engines-and-rtorrent}

### rTorrent se reinicia constantemente — `internal_error: priority_queue_insert` {#rtorrent-restarts-constantly--internal_error-priority_queue_insert}

:::danger Este es un bug del proyecto original sin arreglo. Lee esto antes de escalar.
:::

**Síntoma.** El container de rTorrent incluido se reinicia periódicamente — en el
incidente real, **43 reinicios en 4 días**. El log muestra:

```
internal_error: priority_queue_insert(...) called on an invalid item.
```

Las transferencias se pausan brevemente y todo vuelve a anunciarse, pero **no se pierde
ningún torrent**.

**Cómo diagnosticar.**

```bash
# ¿Cuántas veces se ha reiniciado?
docker inspect --format '{{.RestartCount}}' $(docker compose ps -q rtorrent)

# La prueba irrefutable
docker compose logs rtorrent | grep -c "internal_error"
docker compose logs rtorrent | grep "priority_queue_insert" | tail -3

# ¿Cuántos torrents está cargando? (este es el detonante)
docker compose ps rtorrent
```

**Causa raíz.** El motor incluido es rTorrent `0.9.8` (el binario estático mantenido
por jesec, `v0.9.8-r16` — ya es el lanzamiento más nuevo de ese linaje). Arrastra un
**bug del proyecto original** de larga data que se dispara durante la programación de
anuncios al tracker. **No tiene arreglo en el linaje 0.9.8** (ver
[rakshasa/rtorrent#939](https://github.com/rakshasa/rtorrent/issues/939)).

La propiedad crítica es que es **impulsado por la carga**. La evidencia medida en
dos hosts en vivo corriendo la build *idéntica*:

| Host | Torrents activos | Fallos |
|------|------------------|--------|
| A | **752** | **44** (~10/día) |
| B | **7** | **0** |

El fallo sale del proceso limpiamente (exit 0), el `restart: unless-stopped` de Docker
lo relanza, y la sesión guardada se recarga — de ahí lo de "no se pierden torrents".

**Solución.** **No hay arreglo dentro del motor.** Mitigaciones, en orden de impacto:

1. **Cámbiate a un motor más robusto.** La capa de motores de UltraTorrent es multi-motor.
   **qBittorrent maneja miles de torrents cómodamente** y es la respuesta duradera para una
   biblioteca grande:

   ```bash
   docker compose --profile qbittorrent up -d
   # Consigue la contraseña temporal del primer arranque:
   docker compose logs qbittorrent | grep -i password
   ```

   Luego regístralo en **Infraestructura → Motores** (tipo qBittorrent, URL base
   `http://qbittorrent:8080`). Consulta [Motores](/modules/engines).

2. **Mantén modesto el conteo de torrents activos.** Elimina o detén las semillas
   completadas. La tasa de fallos baja junto con el conteo de torrents.

3. **Ya aplicado por ti:** los anuncios UDP al tracker están deshabilitados en
   `deploy/rtorrent/rtorrent.rc` (`trackers.use_udp.set = no`), lo cual elimina una variante
   *secundaria* de fallo, `TrackerList::receive_failed`. Los trackers HTTP/HTTPS y PEX igual
   encuentran pares. DHT también está apagado por defecto (`RT_DHT=off`). Ojo que ninguna de
   estas arregla el fallo **dominante**, `priority_queue_insert`.

4. **Un healthcheck ahora saca a la luz el estado más raro de "proceso vivo pero SCGI trabado"**
   como `unhealthy` (revisa que el puerto SCGI esté escuchando vía `ss`). Un fallo ya sale del
   proceso, así que Docker recupera ese caso por su cuenta.

**Verifica.**

```bash
# Tras cambiar de motor o reducir torrents, el conteo de reinicios debe dejar de subir:
docker inspect --format '{{.RestartCount}}' $(docker compose ps -q rtorrent)
# ...espera un día...
docker inspect --format '{{.RestartCount}}' $(docker compose ps -q rtorrent)
```

---

### rTorrent entra en bucle de fallos: "Could not lock session directory … held by …" {#rtorrent-crash-loops-could-not-lock-session-directory--held-by-}

**Causa raíz.** Un fallo anterior de rTorrent dejó atrás un `rtorrent.lock` viejo.

**Solución.** Las imágenes actuales lo limpian automáticamente al arrancar — baja los
cambios y reconstruye:

```bash
git pull && docker compose --profile rtorrent up -d --build rtorrent
```

Para limpiarlo a mano:

```bash
sudo rm -f <downloads>/.session/rtorrent.lock
```

**Verifica.** rTorrent se mantiene arriba; `docker compose ps rtorrent` lo muestra saludable.

---

### rTorrent falla con `DhtServer::event_write … both write queues are empty` {#rtorrent-crashes-with-dhtserverevent_write--both-write-queues-are-empty}

**Causa raíz.** Un bug conocido de DHT en esta build de rTorrent. **DHT está apagado por
defecto exactamente por esta razón.**

**Solución.** Si lo habilitaste, vuelve a apagarlo:

```dotenv
RT_DHT=off
```

```bash
docker compose --profile rtorrent up -d --force-recreate rtorrent
```

Los trackers y PEX igual encuentran pares.

---

### Un motor muestra `online: false` / "No se pudieron cargar los torrents" {#an-engine-shows-online-false--could-not-load-torrents}

**Cómo diagnosticar.**

```bash
# La señal autoritativa:
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/engines/health

# ¿Está corriendo siquiera el container del motor?
docker compose ps rtorrent qbittorrent

# ¿Puede el backend alcanzarlo?
docker compose exec backend wget -qO- http://qbittorrent:8080/api/v2/app/version
```

**Causa raíz.** Normalmente una de estas:

1. **No hay ningún motor registrado.** Registra uno en **Infraestructura →
   Motores** y usa **Probar conexión**.
2. **El stack se levantó sin el perfil.** Los motores incluidos están detrás de perfiles
   de Compose y están **apagados por defecto**. `docker compose up -d` por sí solo no
   arranca *ningún* motor.
3. Detalles de conexión incorrectos. Para el rTorrent incluido: tipo `rtorrent`, modo
   `scgi-tcp`, host `rtorrent`, puerto `5000`. Para el qBittorrent incluido: URL base
   `http://qbittorrent:8080`.

**Solución.** Arranca el perfil que de verdad quieres:

```bash
docker compose --profile qbittorrent up -d
# o
docker compose --profile rtorrent up -d --build
```

**Verifica.** `/api/engines/health` reporta `online: true`.

---

### "Probar conexión" de qBittorrent falla con 401/unauthorized {#qbittorrent-test-connection-fails-with-401unauthorized}

**Síntoma.** Las credenciales están definitivamente bien, pero la prueba del motor falla.

**Causa raíz.** Dos trampas separadas y reales:

1. **Validación del header Host.** qBittorrent rechaza las peticiones cuyo header `Host`
   no reconoce. El backend conecta por el **nombre de servicio** de Docker
   (`qbittorrent`), en el cual qBittorrent no confía por defecto.
2. **El contrato de login cambió en qB 5.x.** Un `POST /api/v2/auth/login` exitoso
   ahora responde **`204 No Content`** (no `200 "Ok."`) y establece una cookie
   **`QBT_SID_<port>`** (no `SID`). Un cliente que tiene el contrato viejo cableado falla
   con un engañoso *"login failed (204)"*. El cliente de UltraTorrent se arregló para
   aceptar ambos — pero si ves esto contra una build vieja, esta es la razón.

**Solución.** En la interfaz web de qBittorrent: **Options → Web UI** → deshabilita **"Enable Host
header validation"** (o pon *Server domains* en `*`).

**Verifica.** **Probar conexión** se pone verde; los torrents se listan.

---

### Los torrents se comparten para siempre a pesar de una regla de "eliminar al completar" que funciona {#torrents-seed-forever-despite-a-working-delete-on-complete-rule}

:::info Una de verdad sutil — dos bugs independientes producían el mismo síntoma
:::

**Síntoma.** Tienes una regla de automatización de "eliminar al completar". Está habilitada. El
log de automatización hasta dice que corrió y **tuvo éxito**. Los torrents siguen ahí,
todavía compartiendo, para siempre.

**Cómo diagnosticar.**

```bash
# ¿El motor todavía tiene el torrent que la app cree que eliminó?
docker compose exec rtorrent sh -c \
  'echo "d.multicall2 ... d.is_open=" | true'   # (ver la nota abajo)

# Más fácil: compara lo que lista la app contra lo que lista el motor.
# En la interfaz, revisa el historial de la regla de automatización — ¿dice que tuvo éxito?
```

La señal es una regla que registra `delete=success` para un torrent que demostrablemente
**sigue cargado y compartiendo en el motor**.

**Causa raíz.** Dos causas, ambas reales, ambas ya arregladas — pero vale la pena
entenderlas porque explican el síntoma por completo:

1. **El `d.erase` de rTorrent no hace nada, en silencio.** rTorrent 0.9.8 intermitentemente
   *acepta* la llamada de borrado, **no devuelve error**, y aun así **deja la descarga
   cargada**. El proveedor disparaba `d.erase` una vez y confiaba en el valor de retorno. El
   `success` fantasma entonces envenenaba el libro mayor de automatización, que marcaba el
   torrent como hecho y **nunca reintentaba**. Se agravaba con *ráfagas* de borrados —
   exactamente lo que produce una regla de "eliminar al completar".

   *Solución:* la eliminación ahora se **verifica**. `eraseAndConfirm` borra, luego confirma que
   el torrent de verdad desapareció mediante una revisión barata de un solo campo con
   `d.multicall2`, y **reintenta** (5 intentos × 400 ms). Si el torrent sobrevive, **lanza una
   excepción** — así que la corrida registra un `failure` real y el reconciliador reintenta en
   el siguiente ciclo, en vez de cementar un éxito fantasma. La eliminación de datos ahora
   también confirma el borrado *antes* de eliminar archivos, así que nunca se borran datos
   mientras el torrent sigue cargado.

2. **El disparador de completado era un flanco de subida de una sola vez.** `torrent.completed`
   se disparaba solo en el sondeo exacto de 2 segundos en el que la instantánea de progreso
   *persistida* de un torrent cruzaba de `<1` a `≥1`. Las instantáneas viven en Postgres, así
   que **cualquier torrent que ya estaba al 100% cuando se le tomó la primera instantánea estaba
   permanentemente pasado del flanco** — la regla nunca corrió para él. Esto afectaba a los
   torrents que terminaron mientras la app no estaba sondeando, y a todo torrent que existía
   *antes* de que se creara la regla.

   *Solución:* una pasada de relleno (`reconcileCompleted`) ahora corre en cada ciclo de
   sincronización para los torrents completados que no subieron de flanco en ese tick, usando el
   log de automatización como libro mayor de idempotencia para que una regla corra a lo sumo una
   vez por torrent.

**Solución.** Actualiza a una build que contenga ambos arreglos (consulta [Actualizar](/install/upgrading)).

Luego revisa la **tercera** trampa, a nivel de configuración:

:::warning La trampa de "eliminar al completar" en qBittorrent
qBittorrent mapea los torrents completados/compartiendo al estado `SEEDING` y **nunca
emite `COMPLETED`**. Así que una regla con una condición como `state == 'completed'`
**nunca va a coincidir** en qBittorrent.

**Una regla de "eliminar al completar" debe tener las condiciones _vacías_** — el
disparador `torrent.completed` ya es la condición.
:::

**Verifica.** Completa un torrent (o espera al reconciliador en uno existente) y
confirma que desaparece **tanto** de la interfaz *como* del motor. Una eliminación fallida ahora
se muestra como un `failure` real en el log de automatización en vez de como un falso éxito.

---

### Los torrents muertos bloquean a todos los sanos (no se descarga nada) {#dead-torrents-block-every-healthy-one-nothing-downloads-at-all}

**Síntoma.** El motor tiene un montón de torrents y está moviendo
**0 bytes**. No lento — *cero*. Los torrents sanos se quedan en `queued` y nunca inician.

El incidente real: **1,137 torrents, 0.00 GB descargados en total.** DHT estaba saludable
(366 nodos), los trackers respondían — la red estaba bien.

**Cómo diagnosticar.**

```bash
# En el motor (ejemplo con qBittorrent), cuenta los torrents por estado:
#   ¿Cuántos están en metaDL / stalledDL / queuedDL?
# La firma: TODAS tus ranuras de max_active_downloads están ocupadas por
# torrents en metaDL o stalledDL, y todo lo sano está en queuedDL.
```

Revisa los seeders: en el caso real **1,114 de 1,137 torrents reportaban cero seeders**.

**Causa raíz.** Una preciosa pieza de bloqueo de cabecera de línea:

1. El barrido de episodios faltantes recorrió todo el catálogo viejo y capturó
   lo que fuera que devolvieran los indexadores. Dos de cuatro indexadores **no tenían
   `minSeeders` definido** — y el filtro de seeders por indexador *solo aplica cuando esa
   columna está definida* — así que **los lanzamientos con 0 seeders pasaron derechito**.
2. **Un magnet con 0 seeders jamás puede obtener sus metadatos — y aun así el motor lo cuenta
   como una descarga activa todo el tiempo que lo intenta.**
3. Con `max_active_downloads: 100`, exactamente **88 `metaDL` + 12 `stalledDL` = 100
   ranuras ocupadas permanentemente por torrents que nunca van a terminar**. Los otros 1,034
   torrents sanos se quedaron en `queuedDL` detrás de ellos, sin poder iniciar.

**Solución.**

1. **Define `minSeeders` en cada indexador.** Esta es la causa raíz y la
   prevención. Un indexador sin `minSeeders` te va a entregar cadáveres con mucho gusto. Consulta
   [Indexadores](/modules/indexers).
2. **Habilita la cola de estacionamiento.** UltraTorrent incluye un `TorrentParkingService`
   que corre cada 5 minutos: un torrent que está `DOWNLOADING`, por debajo de `minSeeders`,
   sin nadie conectado, sin bytes moviéndose, y pasado un período de gracia, se **pausa y
   se registra**. Un torrent pausado no ocupa ranura, así que el motor promueve uno en cola
   a la ranura liberada — **la cola drena su propio peso muerto**.

   También resuelve la trampa obvia: un torrent pausado nunca anuncia, así que su
   conteo de seeders nunca podría refrescarse y estacionarlo sería un viaje sin regreso. Por eso
   en cada tick **fuerza el arranque** de un lote de torrents estacionados, lee el resultado en el
   siguiente tick, y suelta de vuelta a la cola normal a los que hayan encontrado seeders. Los
   que siguen muertos persistentemente se van retirando exponencialmente.

   Nunca toca un torrent `QUEUED` (no cuesta ranura) ni uno `PAUSED` (alguien
   lo pausó a propósito).

   :::caution Viene deshabilitada por defecto
   La cola de estacionamiento está **apagada por defecto** — tienes que habilitarla. Es un
   pausador automático poderoso, y habilitarla es una decisión deliberada del operador.
   :::

3. Purga a mano los muertos que ya tienes (elimina en masa los torrents con 0 seeders).

**Verifica.** La ocupación de ranuras baja, `queuedDL` empieza a drenar, y los bytes empiezan
a moverse. Vuelve a revisar que ningún indexador se haya quedado sin `minSeeders`.

---

## Indexadores {#indexers}

### Un indexador siempre devuelve HTTP 429, y FlareSolverr no lo puede arreglar {#an-indexer-always-returns-http-429-and-flaresolverr-cannot-fix-it}

:::info Observado en la vida real
Esto se topó en un despliegue en vivo: **1337x** devolvía `429` a través de Prowlarr en
*cada* petición, indefinidamente. No una ráfaga — un bloqueo. FlareSolverr no hizo ninguna
diferencia, porque resuelve **retos de JavaScript/Cloudflare**, no un límite de tasa ni un
baneo a nivel de IP. La solución fue **deshabilitar ese indexador** y dejar que los
otros cargaran con las búsquedas; el barrido de adquisición siguió funcionando, porque un
indexador muerto no detiene a los demás.
:::

**Síntoma.** Un indexador — muchas veces 1337x — devuelve **HTTP 429 (Too Many Requests)**
en *cada* petición, para siempre. Todos los espejos se comportan igual. Bajar la tasa de
peticiones no cambia nada. Añadir FlareSolverr no ayuda.

**Cómo diagnosticar.**

```bash
# 1. Confirma que son TODAS las peticiones, no algo de tasa — espera una hora, intenta una vez:
docker compose logs --tail 100 prowlarr | grep -i "429\|too many"

# 2. Prueba el indexador desde la IP de salida del HOST, no desde un navegador
#    en otra red:
docker compose exec prowlarr curl -sS -o /dev/null -w "%{http_code}\n" https://1337x.to/

# 3. La prueba decisiva — pídele a FlareSolverr que lo resuelva:
docker compose exec prowlarr curl -sS -X POST http://flaresolverr:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://1337x.to/","maxTimeout":60000}'
```

**Causa raíz.** Si FlareSolverr responde con un mensaje en el sentido de *"tu IP
está baneada para este sitio"*, ahí tienes tu respuesta: la **dirección IP de salida del host
está baneada por Cloudflare para ese sitio**, en **todos** los espejos.

La idea crítica — y la razón por la que esto desperdicia tanto tiempo del operador — es:

> **FlareSolverr no puede resolver un reto para una IP baneada.** El trabajo de FlareSolverr es
> *resolver* un reto anti-bot. Un baneo no es un reto. No hay nada que
> resolver. Ninguna cantidad de FlareSolverr, de afinar reintentos, de limitar tasas, ni de
> saltar de espejo en espejo va a arreglar un baneo a nivel de IP.

Esto **no se arregla con configuración**.

**Solución.** Solo dos cosas funcionan de verdad:

1. **Consigue una IP de salida limpia** — una VPN, un enlace ascendente distinto, o un proxy
   cuya IP no esté baneada.
2. **Bota el indexador.** Deshabilítalo en Prowlarr/UltraTorrent y usa uno que sí te
   quiera hablar.

**No** pierdas tiempo afinando límites de tasa. El 429 no se trata de tu tasa.

**Verifica.** El `curl` directo desde el container devuelve 200 en vez de 429, y
una búsqueda de prueba devuelve resultados.

---

### La búsqueda de un indexador no devuelve nada (pero la prueba de conexión pasa) {#an-indexers-search-returns-nothing-but-the-connection-test-passes}

**Causa raíz.** La causa más común es que el filtro `minSeeders` o la
configuración de categorías está excluyendo todo. Una falla por indexador también está
**aislada** — un indexador roto no hace fallar la búsqueda entera, así que un indexador que
falla en silencio puede pasar desapercibido fácilmente.

**Cómo diagnosticar.** Revisa el log del backend durante una búsqueda en busca de errores por
indexador, y limpia temporalmente `minSeeders`/las categorías para ver si aparecen resultados.

**Solución.** Corrige las categorías y el umbral de seeders. Consulta [Indexadores](/modules/indexers)
y [Prowlarr](/modules/prowlarr).

---

### Un indexador protegido por Cloudflare falla con "blocked by Cloudflare Protection" {#a-cloudflare-protected-indexer-fails-with-blocked-by-cloudflare-protection}

**Causa raíz.** Algunos trackers (p. ej. **EZTV**) están detrás del reto anti-bot de
Cloudflare. Prowlarr no lo puede resolver solo. **Este sí lo arregla FlareSolverr de
verdad** — a diferencia del caso del baneo de IP de arriba.

**Solución.** Levanta FlareSolverr y conéctalo a Prowlarr:

```bash
docker compose --profile prowlarr --profile flaresolverr up -d
```

Luego, en **Prowlarr**:

1. **Settings → Indexers → Add Indexer Proxy → FlareSolverr.**
2. **Host:** `http://flaresolverr:8191`. Dale una **Tag** (p. ej. `cloudflare`). Guarda.
3. Abre el indexador protegido por Cloudflare y añádele la **misma tag**.
4. Vuelve a probar el indexador.

**Verifica.** La prueba del indexador pasa y las búsquedas devuelven resultados.

---

## Descargas {#downloads}

### Las descargas automáticas no hacen nada, en silencio — "resolves to a blocked internal address" {#auto-downloads-silently-do-nothing--resolves-to-a-blocked-internal-address}

:::info La trampa: la prueba de conexión de Prowlarr igual pasa
:::

**Síntoma.** Las reglas RSS, la Descarga Inteligente y el barrido de episodios faltantes
todos *capturan* lanzamientos — y después no se descarga nada. La **prueba de conexión** de
Prowlarr **está verde**.

**Cómo diagnosticar.**

```bash
docker compose logs backend | grep -i "blocked internal address"
```

**Causa raíz.** Las descargas automáticas buscan el enlace `.torrent` del indexador por HTTP. La
**guardia SSRF del backend bloquea cualquier URL que resuelva a una dirección privada/interna**
a menos que su host esté explícitamente en la lista de permitidos. Un indexador auto-hospedado —
incluyendo el **Prowlarr incluido** en `http://prowlarr:9696` — devuelve enlaces de proxy en una
**IP privada de Docker**, así que la guardia los bloquea.

La razón por la que esto confunde tanto: **la revisión de salud de Prowlarr y la búsqueda del
torrent son dos guardias distintas.** La revisión de salud confía en los hosts privados (por eso
pasa); la búsqueda del torrent es la más estricta (por eso bloquea). Una insignia verde prueba
que la API es alcanzable — **no** prueba que las capturas se vayan a descargar.

**Solución.** Pon el host del indexador en la lista de permitidos con `SSRF_ALLOW_HOSTS`:

```dotenv
# Por defecto es `prowlarr` para que el indexador incluido funcione desde el principio.
# ¡Mantén `prowlarr` en la lista si lo usas!
SSRF_ALLOW_HOSTS=prowlarr,indexer.lan,10.0.0.0/24
```

Las entradas son **nombres de host, IPs o CIDRs de IPv4** separados por comas. Recrea el backend:

```bash
docker compose up -d --force-recreate backend
```

La lista de permitidos de esquemas (solo `http(s)`), el rechazo de redirecciones y el tope de
20 MB de cuerpo **siguen aplicando** a los hosts permitidos — solo se levanta el bloqueo de
direcciones privadas, y solo para los hosts que nombres.

**Verifica.** Dispara una captura; el torrent aparece en el motor, y la línea de
"blocked internal address" deja de salir en el log.

---

### Un magnet se marca como "fallido" pero en realidad descarga bien {#a-magnet-is-marked-failed-but-actually-downloads-fine}

**Síntoma.** El registro de auditoría se llena de entradas
`media_acquisition.download.failed` que dicen que el torrent *"never registered within 6s"* —
mientras el torrent está demostrablemente **descargando perfectamente**.

Los números reales: **257 eventos de `download.failed` en 4 días, de los cuales 256
en realidad cargaron**, con una **mediana de ~53 segundos** después de la "falla".

**Cómo diagnosticar.**

```bash
docker compose logs backend | grep "never registered"
```

Luego revisa si esos info-hashes están, de hecho, en el motor. (Sí lo van a estar.)

**Causa raíz.** Después de una carga "dispara y olvida", el proveedor de rTorrent sondea la
lista de descargas para confirmar que el torrent se registró, durante **20 intentos × 300 ms ≈ 6
segundos**, y lanzaba una excepción si el info-hash nunca aparecía.

Esa ventana está **perfectamente bien para un archivo `.torrent`** — los metadatos ya están
presentes, así que se registra casi al instante. Está **completamente mal para un magnet**:
rTorrent no lista el hash de un magnet hasta que ha **obtenido los metadatos desde
DHT/pares**, lo cual rutinariamente toma mucho más de 6 segundos (mediana de ~53 s en
producción, y *todas* las capturas de adquisición son magnets).

La excepción hacía que el ejecutor marcara la acción como `failed` y escribiera una fila de
auditoría **mientras el magnet descargaba bien** — ruido en la auditoría, más un riesgo real
de agregado duplicado (el hash que aún estaba cargando podía volver a agregarse por un reintento).

**Solución.** Actualiza. El paso de confirmación ahora es consciente de los magnets: un magnet
que no se registró dentro de la ventana se trata como **aceptado/pendiente** (la sincronización
de torrents de 2 segundos lo reconcilia cuando se registra), mientras que un **archivo `.torrent`
sí sigue lanzando la excepción** — así que un archivo genuinamente roto o un motor caído se sigue
sacando a la luz.

**Verifica.** Los eventos de `download.failed` bajan a (casi) cero, mientras las descargas
siguen funcionando.

---

## Identificación de medios {#media-identification}

### Una serie nunca reporta episodios faltantes (escanea a 0/0/0) {#a-show-never-reports-any-missing-episodes-scans-to-000}

**Síntoma.** Una serie en la lista de seguimiento escanea a **0 episodios / 0 en biblioteca / 0
faltantes**, para siempre. Nunca encuentra nada que capturar.

**Cómo diagnosticar.** Revisa si la serie lleva siquiera un ID de IMDb, y si
ese ID es de verdad el de una **serie**:

```bash
# ¿El elemento de la lista de seguimiento tiene un ID de IMDb?
# (Interfaz: Adquisición de medios → Lista de seguimiento → el elemento → IDs externos)

# ¿El tconst guardado devuelve algún episodio en el catálogo?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) FROM imdb_episodes WHERE \"parentTconst\" = 'tt16091606';"
```

Un tconst guardado que devuelve **0 episodios del catálogo** es la señal.

**Causa raíz.** Todo lo que va después de una serie se apoya en su **ID de IMDb**. Hay
cuatro formas distintas en que ese ID sale mal — **las cuatro fueron reales, y las cuatro ahora
se autocorrigen**:

| Falla | Ejemplo real | Qué pasó |
|-------|--------------|----------|
| **Un ID de episodio en vez del ID de la serie** | *Silo* fijado a `tt16091606` (un episodio) en vez de `tt14688458` (la serie) | El tconst guardado devuelve **0 episodios**, así que el escaneo queda permanentemente en 0/0/0. |
| **Acentos** | `90 Day Fiancé` (IMDb) vs `90 Day Fiance` (biblioteca) | Los acentos se *eliminaban*, no se *plegaban*: la `é` desaparecía en vez de convertirse en `e`, así que las dos claves nunca coincidían. |
| **Puntuación** | `FBI: Most Wanted` (IMDb) vs `FBI Most Wanted` (regla RSS); `Chicago P.D.` vs `Chicago PD` | Los nombres que vienen de reglas RSS eliminan `:`/`&`/`.`/`'`, así que una búsqueda por título exacto fallaba. |
| **Ningún ID de IMDb** | Una serie identificada contra **TVDB** | Se leía como `monitorable: false` y era invisible para los escaneos de episodios faltantes. En un host, solo **74 de 8,986** elementos de TV tenían un ID de IMDb de serie. |

También había un bug del **parser** en la misma familia: la normalización de separadores convertía
los puntos *propios* de un título en espacios, destrozando los acrónimos — `L.A.'s Finest` se
volvía `L A 's Finest`, `Chicago P.D.` se volvía `Chicago P D`.

Y un bug del **escáner**: los elementos de medios nuevos se creaban con
`title = basename(file)` y **sin temporada/episodio**, así que una serie se fragmentaba en una
entrada falsa por episodio. En un host, **3,579 de 5,840** elementos de TV estaban en este
estado.

**Solución.** Actualiza — cada una de estas ahora se autocorrige:

- Un tconst que devuelve 0 episodios se **vuelve a resolver desde el título**, se corrige,
  se persiste y se audita.
- Las claves de título ahora pliegan los diacríticos (NFD + descartar marcas combinantes) **antes**
  de eliminar, así que `é → e` (esto también arregla `Pokémon` ↔ `Pokemon`).
- Una coincidencia insensible a la puntuación corre cuando la coincidencia exacta falla.
- Las series de la biblioteca sin ID de IMDb se resuelven contra el catálogo local por título
  (+ año) y el tconst se escribe en **cada** elemento de medios de la serie.

También puedes forzar la corrección explícitamente:

```
POST /media-acquisition/watchlist/library/resolve-imdb
```

Resultado en producción después de la corrección: un host pasó a **654/654** series monitoreables
(desde 599), otro a **211/212**.

**Verifica.** La serie ahora reporta un conteo real de episodios y un conteo real de faltantes.
Si una serie *aun así* no se resuelve, puede que genuinamente no esté en tu catálogo de
IMDb (o que esté catalogada solo bajo un título localizado) — pon el ID de IMDb a mano
en el elemento de la lista de seguimiento.

:::note Por qué la coincidencia por prefijo NO se usa a propósito
Es tentador emparejar `90 Day Fiancé: Pillow Talk` con `90 Day Fiancé` por
prefijo. Eso es exactamente lo que dejaría que un **spin-off secuestrara la serie madre**. El
emparejador se niega a adivinar: una serie catalogada solo bajo un título completo localizado
se queda sin resolver y hay que ponerla a mano. Esto es intencional.
:::

---

### Un episodio aparece en la lista de seguimiento como si fuera una serie {#an-episode-appears-on-the-watchlist-as-if-it-were-a-series}

**Síntoma.** La lista de Episodios faltantes muestra **episodios** donde deberían ir series
(p. ej. `90 Day Fiance - S12E09` listado como una serie).

**Causa raíz.** Un episodio descargado se agregó a la lista de seguimiento como una `series`,
porque la ruta de agregado usaba el título crudo del episodio en vez de colapsarlo al
nombre de la serie.

**Solución.** Actualiza. La lista de seguimiento ahora colapsa un título con formato de episodio al
nombre de la serie al agregarlo, el selector de agregar-desde-la-biblioteca agrupa por el título de
serie analizado, y el agregado en masa deduplica sobre el título colapsado para que dos episodios de
una misma serie no creen dos entradas. Los nombres limpios (`9-1-1`, `1923`) se dejan intactos a
propósito.

**Verifica.** La lista de seguimiento lista series, no episodios.

---

## Escaneos y trabajos {#scans-and-jobs}

### Un escaneo de biblioteca se congela en un porcentaje y nunca completa {#a-library-scan-freezes-at-a-percentage-and-never-completes}

:::danger El peor incidente de rendimiento en la historia de este proyecto
También es el más instructivo. Lee el método de diagnóstico — se generaliza.
:::

**Síntoma.** El escaneo de una biblioteca de películas se queda trabado en 8%, luego 41%, luego
74% — **indefinidamente**. Sin error. Sin caída. Simplemente nunca termina.

**Cómo diagnosticar.** Esta es la parte que vale la pena aprender.

```bash
# Consultas de larga duración — ¿están ACTIVE (trabajando) o WAITING (bloqueadas)?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT pid, now() - query_start AS duration, state, wait_event_type,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY duration DESC LIMIT 10;"

# ¿Es contención de bloqueos?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) FROM pg_locks WHERE NOT granted;"

# ¿Está agotado el pool de conexiones?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) FROM pg_stat_activity;"
```

**Lo que decía la evidencia** — y esta es la lección completa:

- `pg_stat_activity` mostraba **consultas `active` de larga duración**.
- **No** había contención de bloqueos.
- Solo **13 de 100 conexiones** estaban en uso.

Lee esa combinación con cuidado. Nada está *bloqueado*. Nada está *esperando*. El
pool no está ni cerca de lleno. La base de datos simplemente está **trabajando durísimo en una
sola consulta**. El escaneo no estaba **atascado** — estaba **hambriento**.

**Causa raíz.** Prisma renderiza `mode: 'insensitive'` como el SQL **`ILIKE`** — y
**`ILIKE` no puede usar un índice btree**.

Sobre el catálogo de IMDb de **8.9 millones de filas**, eso convertía cada búsqueda de título
insensible a mayúsculas en un **escaneo completo de la tabla**. Medido en un host en vivo:

> **47.8 segundos por búsqueda.**

El planificador recorría un índice btree existente *hacia atrás*, filtrando con `ILIKE` la tabla
entera según avanzaba. Y esas búsquedas se disparan **por cada elemento de medios** (calentamiento
del estado de la serie, identificación, autocorrección de episodios faltantes) — así que
**saturaban Postgres y dejaban hambrienta a toda otra consulta**, incluyendo la del propio escaneo.

**Solución.** Haz que `ILIKE` se respalde en índices con **índices GIN de pg_trgm**:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_titles_primary_title_trgm
  ON imdb_titles USING gin ("primaryTitle" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_titles_original_title_trgm
  ON imdb_titles USING gin ("originalTitle" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_akas_title_trgm
  ON imdb_akas USING gin (title gin_trgm_ops);
```

El resultado sobre la misma consulta, sobre las mismas 8.9M de filas:

| | Antes | Después |
|---|--------|-------|
| Plan | Seq scan / índice hacia atrás | **Bitmap Index Scan** |
| Tiempo | **47.8 s** | **180 ms** |
| Aceleración | — | **~265×** |

**No hizo falta ningún cambio en el código de la aplicación.** La consulta estaba bien; el índice
faltaba.

Las builds actuales hacen esto por ti: la migración solo habilita la extensión, y
`ImdbTrigramIndexService` construye los tres índices GIN **`CONCURRENTLY`, en segundo plano, en
tiempo de ejecución** — así que una instalación nueva los construye al instante y una existente
los rellena con **cero tiempo fuera de servicio**. (Construirlos *dentro* de la migración es lo que
causó la [caída por P3009](#the-backend-restart-loops-after-an-upgrade--prisma-p3009).)

**Verifica.**

```sql
EXPLAIN ANALYZE
SELECT * FROM imdb_titles WHERE "primaryTitle" ILIKE 'The Expanse';
-- Espera: Bitmap Index Scan, de un dígito a unos cientos bajos de ms.
```

Y confirma que los índices son **válidos**, no INVÁLIDOS — consulta
[un índice existe pero se ignora](#queries-are-slow-again-and-an-index-exists-but-is-ignored).

---

### Los trabajos se quedan "running" para siempre {#jobs-are-stuck-running-forever}

**Síntoma.** La lista de trabajos muestra filas de `metadata_fetch` / `subtitle_scan` congeladas en
**0%**, en `running`, por horas. Un host en vivo tenía **30** de esas filas, algunas de **5 horas**
de antigüedad.

**Cómo diagnosticar.**

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT id, type, status, progress, \"createdAt\"
FROM media_processing_jobs
WHERE status IN ('queued','running')
ORDER BY \"createdAt\";"
```

**Causa raíz.** Los cuerpos de los trabajos corren **dentro del proceso** — *no* son elementos de
trabajo durables que un worker aparte recoge y reanuda. Así que un **despliegue o reinicio mata el
trabajo pero deja la fila de la base de datos diciendo `running`**, para siempre. Nunca hubo nada
que la fuera a mover.

**Solución.** Actualiza. Ahora hay una reconciliación al arrancar: cualquier fila `queued` o
`running` que se encuentre al inicio necesariamente pertenece a un **proceso muerto**, así que se
marca como fallida con `Interrupted by a service restart`. Es de mejor esfuerzo y nunca bloquea el
arranque.

Para limpiar los huérfanos existentes a mano:

```sql
UPDATE media_processing_jobs
SET status = 'failed', error = 'Interrupted by a service restart'
WHERE status IN ('queued','running');
```

**Verifica.** Después de un reinicio, no queda ninguna fila de trabajo en `running` de un proceso
anterior.

:::tip Consecuencia operativa
Como los trabajos corren dentro del proceso, **un reinicio interrumpe el trabajo en curso**. No
reinicies el backend a mitad de una importación si lo puedes evitar — y después de cualquier
despliegue, vuelve a correr el escaneo o la importación que estuviera en vuelo.
:::

---

### Un barrido de episodios faltantes muere a mitad de camino {#a-missing-episode-sweep-dies-partway-through}

**Síntoma.** El barrido procesa un par de episodios y luego se detiene, perdiendo el
resto del lote.

**Causa raíz.** Un escaneo concurrente de biblioteca/lista de seguimiento **elimina y recrea** las
filas de `WantedEpisode`. El barrido actualizaba una fila por id, lo cual lanzaba el **`P2025`** de
Prisma ("Record to update not found") cuando la fila había desaparecido a mitad del barrido. Peor
aún, el *manejador de errores* por episodio también escribía estado — así que la excepción se
escapaba del bucle y rechazaba el **barrido entero**, perdiendo los otros ~48 episodios del lote. Se
observó en vivo: un re-escaneo manual que se solapó con un tick del barrido lo mató después de 2
episodios.

**Solución.** Actualiza. La escritura de estado ahora es una no-op para una fila que falta en vez de
una excepción, así que una fila desaparecida se salta y el tick completa.

**Verifica.** Corre un re-escaneo manual concurrentemente con un barrido; el barrido completa.

---

## Rendimiento {#performance}

El rendimiento tiene su propia página — consulta [**Rendimiento**](/operate/performance) para
afinamiento, el catálogo de IMDb, índices, rTorrent a escala y bibliotecas grandes.

Las dos fallas de rendimiento que más a menudo se presentan como *"está roto"* en vez de
*"está lento"* están documentadas arriba, porque así es como los operadores las
experimentan:

- [Un escaneo de biblioteca se congela y nunca completa](#a-library-scan-freezes-at-a-percentage-and-never-completes) — faltan índices de trigramas.
- [Los torrents muertos bloquean a todos los sanos](#dead-torrents-block-every-healthy-one-nothing-downloads-at-all) — bloqueo de cabecera de línea.

---

## Logs {#logs}

### Dónde están los logs {#where-the-logs-are}

```bash
# Todo, siguiendo la salida
docker compose logs -f

# Un solo servicio
docker compose logs -f backend
docker compose logs -f rtorrent
docker compose logs -f postgres

# Solo lo reciente (la forma más útil)
docker compose logs --since 15m --tail 200 backend

# Solo errores
docker compose logs --since 1h backend | grep -iE "error|fatal|refused|failed"
```

### Líneas de log que vale la pena reconocer a primera vista {#log-lines-worth-knowing-on-sight}

| Línea de log | Significa | Ve a |
|--------------|-----------|------|
| `insecure secret configuration` | Se activó la guardia de arranque de producción | [Secretos](#the-backend-exits-immediately-with-insecure-secret-configuration) |
| `P3009` | Una migración fallida bloquea el arranque | [P3009](#the-backend-restart-loops-after-an-upgrade--prisma-p3009) |
| `P1000: Authentication failed` | El volumen de Postgres tiene una contraseña más vieja | [P1000](#the-backend-crash-loops-with-prisma-p1000-authentication-failed) |
| `P1001: Can't reach database server` | Host de `DATABASE_URL` incorrecto | [P1001](#p1001-cant-reach-database-server-at-postgres5432) |
| `internal_error: priority_queue_insert` | Fallo del proyecto original de rTorrent 0.9.8 | [rTorrent](#rtorrent-restarts-constantly--internal_error-priority_queue_insert) |
| `Could not lock session directory` | Lock viejo de rTorrent | [Lock viejo](#rtorrent-crash-loops-could-not-lock-session-directory--held-by-) |
| `Torrent URL resolves to a blocked internal address` | La guardia SSRF bloqueó un enlace del indexador | [SSRF](#auto-downloads-silently-do-nothing--resolves-to-a-blocked-internal-address) |
| `never registered within 6s` | Falsa falla de la ventana de confirmación de magnet | [Magnets](#a-magnet-is-marked-failed-but-actually-downloads-fine) |
| `Interrupted by a service restart` | Un trabajo quedó huérfano por un reinicio (esto es la *solución* funcionando) | [Trabajos](#jobs-are-stuck-running-forever) |

### El registro de auditoría es una herramienta de diagnóstico {#the-audit-trail-is-a-diagnostic-tool}

No lo pases por alto. Las acciones destructivas y relevantes para la seguridad se registran con
el actor, la acción, el objeto, el resultado, la IP y el user agent — y el registro ahora *nombra*
el medio al que apuntaba una fila en vez de mostrar un id opaco. Cuando te estés preguntando
"¿qué cambió?", `GET /api/audit` (con el permiso `audit.view`) muchas veces es más
rápido que los logs. Consulta [Auditoría](/modules/audit).

---

## Consejos {#tips}

- **Diagnostica antes de arreglar.** La mitad de las entradas de esta página tienen un síntoma que
  parece otra cosa completamente distinta: un magnet "fallido" que está descargando, un borrado
  "exitoso" que no hizo nada, un escaneo que está hambriento en vez de atascado.
- **`state = active` sin contención de bloqueos significa hambriento, no atascado.** Esa sola
  lectura colapsa una clase entera de misterios de "se está colgando".
- **Una prueba de conexión verde no significa que la función funcione.** La revisión de salud de
  Prowlarr y la guardia SSRF de la búsqueda del torrent son guardias distintas con reglas
  distintas. Prueba la ruta *real*.
- **Los bugs impulsados por la carga se esconden a escala pequeña.** El fallo de rTorrent es
  invisible con 7 torrents y constante con 750. No concluyas "funciona bien" a partir de una prueba
  pequeña.
- **Revisa el `RestartCount`.** `docker inspect --format '{{.RestartCount}}'` revela un
  container que está fallando en bucle calladito detrás de una política `restart: unless-stopped`
  — se ve como "Up" en `docker compose ps`.

## Preguntas frecuentes {#faq}

**El motor se reinicia pero no pierdo torrents. ¿Está bien eso?**
Es sobrevivible, no está bien. Cada fallo de rTorrent sale limpiamente, Docker lo reinicia,
y la sesión guardada se recarga — así que no se pierde nada. Pero las transferencias se pausan y
todo vuelve a anunciarse. Si está pasando seguido, estás en la escala en la que
deberías [pasarte a qBittorrent](#rtorrent-restarts-constantly--internal_error-priority_queue_insert).

**¿Por qué mi regla de "eliminar al completar" no se dispara en qBittorrent?**
Porque qBittorrent reporta los torrents completados como `SEEDING` y nunca emite
`COMPLETED`, así que una **condición** `state == 'completed'` nunca coincide. Quita la
condición — el **disparador** `torrent.completed` ya es la condición.

**¿Puedo simplemente añadir yo mismo los índices que faltan en la base de datos?**
Sí, y el SQL está
[justo aquí](#a-library-scan-freezes-at-a-percentage-and-never-completes) — pero usa
`CREATE INDEX CONCURRENTLY`, y nunca lo pongas dentro de una migración. Las builds actuales
los crean por ti en tiempo de ejecución.

**FlareSolverr está corriendo pero el indexador sigue fallando. ¿Y ahora qué?**
Determina si te estás enfrentando a un **reto** (FlareSolverr lo arregla) o a un
**baneo** (no puede). Consulta
[la entrada del 429](#an-indexer-always-returns-http-429-and-flaresolverr-cannot-fix-it).

**¿Es seguro reiniciar el backend?**
Sí, pero **interrumpe los trabajos en vuelo** — se reconcilian (se marcan como fallidos) al
arrancar en vez de reanudarse. Vuelve a correr cualquier escaneo o importación que estuviera
corriendo.

## Lista de verificación: antes de reportar un bug {#checklist-before-you-file-a-bug-report}

- [ ] `docker compose ps` — ¿cuál container está realmente enfermo?
- [ ] `docker compose logs --since 30m backend` — ¿hay un stack trace?
- [ ] `docker inspect --format '{{.RestartCount}}' <container>` — ¿está fallando en bucle?
- [ ] `/api/system/version` — ¿qué versión y qué commit estás corriendo *de verdad*?
- [ ] `/api/engines/health` — ¿está el motor en línea?
- [ ] ¿Buscaste en esta página la cadena de error exacta?
- [ ] ¿La falla depende de la carga (funciona con 10 torrents, falla con 700)?

## Ver también {#see-also}

- [Resumen de Operar](/operate/) — el mapa de las piezas móviles
- [Rendimiento](/operate/performance) — el catálogo de IMDb, los índices, la escala
- [Seguridad](/operate/security) — secretos, rotación, exposición
- [Backup y Restauración](/operate/backup) — antes de intentar un arreglo arriesgado
- [Mantenimiento](/operate/maintenance) — la rutina que previene todo esto
- [Actualizar](/install/upgrading) · [Docker Compose](/install/docker-compose) · [Proxy inverso](/install/reverse-proxy)
- [Referencia de entorno](/reference/environment) · [API](/reference/api)
- [Motores](/modules/engines) · [Indexadores](/modules/indexers) · [Episodios Faltantes](/modules/missing-episodes)
- [Preguntas Frecuentes](/help/faq) · [Glosario](/help/glossary)
