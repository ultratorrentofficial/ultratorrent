---
id: glossary
title: Glosario
sidebar_position: 2
description: Cada término usado en UltraTorrent y BitTorrent — seeding, ratio, magnet, DHT, indexador, tracker, Torznab, FlareSolverr, hardlink, tconst, RBAC, SCGI, pg_trgm y más.
keywords:
  - glosario
  - terminología
  - definiciones
  - qué es
  - jerga
  - seeding
  - ratio
  - magnet
  - DHT
  - PEX
  - indexador
  - tracker
  - Torznab
  - Newznab
  - FlareSolverr
  - hardlink
  - tconst
  - IMDb
  - RBAC
  - TOTP
  - SCGI
  - XML-RPC
  - info-hash
  - pg_trgm
  - scene release
---

# Glosario {#glossary}

Cada término que encontrarás en UltraTorrent, en lenguaje llano. BitTorrent tiene mucha
jerga y buena parte de ella se usa a la ligera en otros lados — las definiciones de aquí son las
que esta documentación quiere decir.

## Fundamentos de BitTorrent {#bittorrent-fundamentals}

**Announce**
El acto de un cliente diciéndole a un tracker "aquí estoy, y esto es lo que tengo". Se hace
periódicamente. Notablemente, el bug de caída de rTorrent 0.9.8 se dispara **durante la
programación del announce** — que es la única razón por la que el comportamiento del announce aparece en la
documentación operativa.

**BitTorrent**
El protocolo de compartición de archivos entre pares que UltraTorrent administra. Los archivos se dividen en
piezas; los pares intercambian piezas directamente entre sí en vez de descargarlas todas de
un solo servidor.

**Client / Engine** (cliente / motor)
El programa que realmente habla BitTorrent — **rTorrent** o **qBittorrent** en
el caso de UltraTorrent. UltraTorrent *no* es un cliente; es una capa de gestión **por
delante de** uno. En la app aparecen como **Motores** (*Engines*). Ver *Engine seam*.

**DHT (Distributed Hash Table)**
Una manera descentralizada de encontrar pares **sin un tracker**. Es la razón por la que un enlace magnet
puede funcionar. En el rTorrent incluido de UltraTorrent, **DHT está apagado por defecto** —
ese build puede caerse con un `internal_error` de DHT. Los trackers y PEX igual encuentran pares.
Actívalo con `RT_DHT=on` si aceptas el riesgo.

**Info-hash (btih)**
La **huella única de un torrent** — un hash de sus metadatos. Dos torrents con
el mismo info-hash son el mismo torrent, sin importar cómo lo haya llamado el archivo o la fuente.
UltraTorrent deduplica las descargas automáticas **por info-hash**, y por eso
el mismo lanzamiento bajo un GUID rotado, una re-publicación, o una segunda fuente nunca se captura
dos veces.

**Leech / Leecher**
Un par que está descargando y todavía no tiene el archivo completo. No es peyorativo —
todo el mundo empieza como leecher. La app los muestra como **Pares incompletos** en la pestaña de trackers.

**Magnet link** (enlace magnet)
Un enlace que identifica un torrent por su **info-hash** en vez de contener los
metadatos del torrent. El cliente debe **obtener los metadatos desde DHT o los pares** antes de
poder empezar. En la UI es el campo **Enlace magnet**.

:::info Por qué los magnets son operativamente distintos de los archivos `.torrent`
Un archivo `.torrent` ya **contiene** los metadatos, así que el motor lo registra
casi al instante. Un magnet no — los metadatos hay que encontrarlos primero, lo que en
producción tomó una **mediana de ~53 segundos**.

Esta distinción causó un bug real: una ventana de confirmación de ~6 segundos del tipo "¿se registró?"
estaba bien para un archivo `.torrent` y era demasiado corta para un magnet, produciendo una
avalancha de falsos fallos — **256 de 257 magnets "fallidos" en realidad se habían descargado
bien**. Ahora los magnets se tratan como *aceptados/pendientes* en vez de fallidos.
:::

**Metadata (metadatos del torrent)**
La descripción de lo que contiene un torrent — nombres de archivos, tamaños, hashes de las piezas. Están presentes
en un archivo `.torrent`; para un magnet hay que obtenerlos del swarm.

**`metaDL`**
Un estado del motor que significa *"obteniendo los metadatos del torrent"* (un magnet que aún no se ha
resuelto). Operativamente crítico: **un torrent en `metaDL` ocupa una ranura de descarga
activa**. Un **magnet con 0 seeders nunca puede salir de `metaDL`** — y retendrá esa ranura
indefinidamente. Ver *Parking queue*.

**Peer** (par)
Cualquier otro cliente en el swarm — seed o leecher. La app los muestra como **Pares**.

**PEX (Peer Exchange)**
Pares contándose unos a otros sobre otros pares. Funciona junto a los trackers y DHT. Sigue
activo en el rTorrent incluido de UltraTorrent incluso con DHT y los trackers UDP deshabilitados,
por lo que el descubrimiento de pares sigue funcionando.

**Piece** (pieza)
Un trozo de tamaño fijo de un torrent. Se descarga y se verifica de forma independiente, que es lo que
te permite descargar de muchos pares a la vez.

**Ratio**
Subido ÷ descargado. Los trackers privados normalmente exigen que mantengas un ratio
mínimo. Un ratio de `1.0` significa que has devuelto exactamente lo que tomaste.

**Recheck** (reverificar)
Volver a verificar las piezas descargadas contra sus hashes. Úsalo cuando los datos puedan estar corruptos
o cuando hayas movido archivos a espaldas del motor. En la app es **Reverificar**.

**Scene release**
Un lanzamiento nombrado con una convención estricta, p. ej.
`Show.Name.S01E01.1080p.WEB-DL.x264-GROUP`. El parser de UltraTorrent lee título, año,
temporada y episodio de estos nombres.

:::note La trampa de las siglas
La normalización de separadores convierte `.` en un espacio (porque los scene releases usan puntos como
separadores de palabras) — lo que antes **destrozaba los títulos cuyos puntos son parte del nombre**:
`L.A.'s Finest` se volvía `L A 's Finest`, y `Chicago P.D.` se volvía `Chicago P D`.
Arreglado: una secuencia de letra-sola-más-punto ahora se reconoce como sigla y se preserva,
mientras que `A.Quiet.Place` sigue analizándose correctamente como `A Quiet Place`.
:::

**Seed / Seeding / Seeder**
Un par que tiene el archivo **completo** y lo está subiendo. **Los seeders son la señal de salud
más importante de un torrent**: un torrent con **cero seeders nunca se va a
completar**, no importa cuánto esperes. En la app el estado es **Compartiendo** y la columna es **Semillas**.

**Session** (sesión)
El registro propio del motor de qué torrents tiene cargados. Para el rTorrent incluido
vive en `/downloads/.session` — **dentro del volumen de descargas, no en Postgres**.
Por eso restaurar solo la base de datos te devuelve tus reglas y bibliotecas pero con un
**motor vacío**.

**Stalled (`stalledDL`)**
Descargando, pero sin datos moviéndose — normalmente porque no hay pares. Igual que `metaDL`, un torrent
estancado **sigue reteniendo una ranura de descarga activa**.

**Swarm**
Todos los pares que comparten un torrent dado — seeds y leechers juntos.

**Torrent file (`.torrent`)**
Un archivo que **contiene** los metadatos del torrent. Contrasta con un *enlace magnet*, que
solo contiene el info-hash.

**Tracker**
Un servidor que coordina un swarm: los clientes le hacen announce, y él devuelve una lista de
pares. Un tracker **público** es abierto; un tracker **privado** requiere una cuenta y
normalmente exige un ratio. La app los muestra como **Rastreadores**.

**UDP tracker**
Un tracker alcanzado por UDP en vez de HTTP. **Deshabilitado por defecto** en el rTorrent
incluido de UltraTorrent (`trackers.use_udp.set = no`) porque dispara una variante secundaria de la
caída. Los trackers HTTP/HTTPS siguen funcionando.

---

## Indexadores y búsqueda {#indexers-and-search}

**Cloudflare challenge**
Un chequeo antibots detrás del cual se sitúan algunos trackers. Prowlarr no puede resolverlo solo — para
eso es **FlareSolverr**.

**FlareSolverr**
Un proxy de navegador headless que **resuelve los desafíos antibots de Cloudflare** y le devuelve las
cookies resultantes a Prowlarr. Corre como un acompañante opcional y **solo de red interna**
en `http://flaresolverr:8191`.

:::warning FlareSolverr resuelve desafíos. No puede resolver un *baneo*.
Si la IP de salida de tu host ha sido **baneada** por un sitio, no hay desafío que
resolver — FlareSolverr simplemente reportará que la IP está baneada. Ningún ajuste de reintentos,
límite de tasa o salto de espejos arregla un baneo a nivel de IP. Las únicas soluciones son una
**IP de salida limpia** o **dejar de usar ese indexador**.
:::

**Indexer** (indexador)
Un **catálogo de torrents con búsqueda** — un sitio o servicio que consultas para encontrar lanzamientos.
Distinto de un *tracker*: un indexador te ayuda a **encontrar** un torrent; un tracker te ayuda
a **descargarlo**. Muchos sitios son ambas cosas. En la app: **Indexadores**.

**`minSeeders`**
Un filtro por indexador que rechaza los lanzamientos con menos de N seeders. En la UI es **Seeders mín.**

:::danger El ajuste de mayor consecuencia en este glosario
**El filtro solo aplica cuando la columna está realmente definida.** Un indexador sin
`minSeeders` te entregará tan campante lanzamientos con 0 seeders — que nunca podrán descargarse, y aun así
**siguen consumiendo ranuras de descarga activa**. En producción esto llevó a un motor con
**1,137 torrents a literalmente cero bytes por segundo**. Define `minSeeders` en **cada**
indexador.
:::

**Newznab**
El equivalente de Torznab para Usenet. La misma forma de API.

**Prowlarr**
Un **gestor de indexadores**: agrega cientos de definiciones de trackers y expone cada una
como un endpoint **Torznab**, encargándose por ti de las definiciones, el límite de tasa y la re-autenticación.
En UltraTorrent es un **contenedor acompañante opcional** — la integración es
deliberadamente **solo de enlace** (guardar la conexión, verificar la salud, ofrecer un atajo de
"Abrir Prowlarr"). **No** hace de proxy de endpoints arbitrarios de Prowlarr.

**Torznab**
El **protocolo de API estándar** para consultar un indexador de torrents — el protocolo que
habla el subsistema de indexadores de UltraTorrent. Prowlarr expone cada indexador que administra como
un endpoint Torznab.

---

## Medios y metadatos {#media-and-metadata}

**Artwork** (ilustraciones)
Pósters, fanart, logos y otras imágenes adjuntas a un elemento de medios. En la app: **Ilustraciones**.

**Hardlink** (enlace fijo)
Una segunda entrada de directorio que apunta a los **mismos datos en el disco**. Copiar cuesta espacio
en disco; hacer un hardlink no cuesta (casi) nada. Esto permite que un archivo exista tanto en tu directorio
de torrents (para que sigas compartiendo) **como** en tu biblioteca organizada (para que tu servidor de medios
lo vea) **sin almacenarlo dos veces**. Los hardlinks solo funcionan **dentro del mismo
sistema de archivos**. En la app el modo se llama **Enlace fijo (sigue compartiendo)**.

**IMDb dataset**
Archivos de datos descargables que IMDb publica. El proveedor de IMDb de UltraTorrent funciona a partir de estos
(y/o de una API de IMDb con licencia). **No hace scraping de las páginas web de IMDb — no existe ninguna ruta
de código que obtenga o analice el HTML de imdb.com.**

**Library** (biblioteca)
Un árbol de directorios configurado que UltraTorrent escanea y administra — p. ej. tu carpeta de
Películas o tu carpeta de Series. En la app: **Bibliotecas**.

**Media item** (elemento de medios)
Una sola fila en la biblioteca de UltraTorrent: una película, o un episodio. En la app: **Elementos de Medios**.

**Media server** (servidor de medios)
Plex, Jellyfin, Emby o Kodi. UltraTorrent puede disparar una **actualización de biblioteca** en cualquiera de
ellos después de organizar una descarga.

**NFO**
Un archivo XML acompañante al estilo de Kodi que describe un elemento de medios. Los servidores de medios los leen.

**Sidecar** (archivo acompañante)
Un archivo que se sitúa **junto a** un archivo de medios y lo describe — un `.nfo`, un subtítulo,
un póster.

**tconst**
**El identificador único de IMDb para un título** — el número `tt`, p. ej. `tt14688458`.

:::danger La causa más común de "esta serie nunca encuentra episodios"
Todo lo que viene después depende del tconst, y hay cuatro maneras distintas en que sale
mal:

1. **Es el tconst de un episodio, no el de la serie.** *Silo* fijado a `tt16091606` (un
   episodio) en vez de `tt14688458` (la serie). El id guardado entonces arroja **cero
   episodios del catálogo**, así que la serie escanea a 0/0/0 **para siempre**.
2. **Acentos.** `90 Day Fiancé` vs `90 Day Fiance` — los acentos se *eliminaban* en vez
   de *plegarse*, así que las claves nunca coincidían.
3. **Puntuación.** `FBI: Most Wanted` vs `FBI Most Wanted`.
4. **Ningún tconst** — p. ej. una serie identificada contra TVDB.

Las cuatro ahora **se autocorrigen**.
:::

**TMDB / TVDB**
The Movie Database / The TV Database — proveedores de metadatos alternativos. Una serie
identificada contra TVDB no lleva **ningún tconst**, que es el modo de fallo 4 de arriba.

---

## Arquitectura de UltraTorrent {#ultratorrent-architecture}

**Audit log** (registro de auditoría)
El registro de las acciones destructivas y relevantes para la seguridad: actor, acción, objeto,
resultado, dirección IP y user agent. Ahora **nombra el medio** al que apuntaba una fila en vez de
mostrar un id opaco. Consultable con el permiso `audit.view`. En la app: **Registro de Auditoría**.

**Automation rule** (regla de automatización)
Una regla de **condición/acción** dirigida por eventos. Un disparador se activa, se revisan las condiciones,
y las acciones corren. En la app: **Reglas de Automatización**.

**Engine seam** (costura del motor)
La interfaz `TorrentEngineProvider` — el **único contrato que todo motor de torrents
implementa**. Añadir un motor nuevo significa implementar esta interfaz; **no hacen falta cambios de UI
ni de lógica de negocio**.

**Idempotency ledger** (libro mayor de idempotencia)
El mecanismo que asegura que una regla de automatización corra **a lo sumo una vez por torrent**, sin
importar cuántas veces el bucle de sondeo la evalúe. Crucialmente, una ejecución **fallida** *no* se
registra como hecha — así que una regla bloqueada por un error transitorio se reintenta en el siguiente ciclo en vez
de ser omitida en silencio para siempre.

**Parking queue** (cola de parking)
Un servicio en segundo plano que resuelve el **bloqueo de cabeza de línea por torrents muertos**. Cada 5
minutos **pausa** los torrents que están descargando, por debajo de `minSeeders`, sin nadie
conectado y sin bytes moviéndose. **Un torrent pausado no retiene ninguna ranura**, así que el motor
promueve un torrent en cola a la ranura liberada.

También resuelve la trampa obvia: **un torrent pausado nunca hace announce, así que su conteo de
seeders nunca puede refrescarse** — el parking sería un viaje de ida. Por eso en cada tick
**fuerza el arranque** de un lote de torrents parqueados, lee el resultado en el siguiente tick, y libera
los que hayan encontrado seeders. Los que están persistentemente muertos retroceden exponencialmente. Nunca
toca un torrent `QUEUED` (no cuesta ranura) ni uno `PAUSED` (un humano lo pausó
deliberadamente). **Viene deshabilitado por defecto.**

**Provider** (proveedor)
El **mecanismo principal de extensibilidad** de UltraTorrent — una interfaz en la capa de dominio
que aísla un servicio externo (un motor, una fuente de metadatos, un servidor de medios, un
notificador) de la lógica de negocio que lo usa. La regla es explícita: las integraciones nuevas
se añaden como **nuevos proveedores**, nunca modificando los módulos centrales.

**Release identity** (identidad del lanzamiento)
La identidad lógica analizada de un lanzamiento — `movie:<title>:<year>` o
`ep:<title>:<season>:<episode>` — usada para mantener **solo un lanzamiento por película/episodio**
y para *mejorar* cuando aparece uno estrictamente mejor.

**RSS rule** (regla RSS)
Una regla de inclusión/exclusión con una **lista de preferencias ordenada**, aplicada a una fuente RSS para
decidir qué capturar. Ver *Smart Match Builder*.

**Smart Match Builder**
El motor de preferencias de coincidencia con ranking: captura el **mejor lanzamiento disponible**, **mejora**
a uno de prioridad estrictamente mayor cuando aparece después (eliminando el torrent superado
y sus datos), y omite los lanzamientos iguales o inferiores.

**Watchlist** (lista de seguimiento)
La lista de series que UltraTorrent monitorea buscando **episodios faltantes**. En la app: **Lista de seguimiento**.

---

## Seguridad {#security}

**AES-256-GCM**
El cifrado autenticado que se usa para los secretos **en reposo** — secretos TOTP, claves API de
indexadores, la clave de Prowlarr, contraseñas de motores. Con llave derivada de `ENCRYPTION_KEY`.

**Argon2id**
El algoritmo de hashing de contraseñas **memory-hard** que UltraTorrent usa. Resistente al crackeo por
GPU/ASIC.

**`ENCRYPTION_KEY`**
La llave AES-256-GCM de todo lo cifrado en reposo.

:::danger No está en tu respaldo de la base de datos
`ENCRYPTION_KEY` vive en `.env`. Un dump de Postgres **sin** ella restaura tus
columnas cifradas como **texto cifrado indescifrable** — recuperarías tus usuarios y
bibliotecas, y ningún 2FA ni clave API funcionando. **Respalda `.env` por separado.**
Rotar esta llave **invalida cada secreto TOTP y cada clave API**.
:::

**JWT (JSON Web Token)**
El token de acceso firmado que prueba quién eres. TTL por defecto: **15 minutos**.

**RBAC (Role-Based Access Control)**
El **único** mecanismo de control de acceso en UltraTorrent — no hay licencias, ediciones,
ni funciones bajo llave. Cada ruta protegida declara el/los permiso(s) que necesita; un guard
verifica que el principal los tenga **todos**.

**Recovery code** (código de recuperación)
Un código de un solo uso que sustituye a un código TOTP cuando has perdido tu
autenticador. Recibes **10**, se muestran **una sola vez**, se guardan solo como hashes, y se **consumen**
al usarse.

**Refresh token**
Un token opaco de larga vida usado para obtener nuevos tokens de acceso. Guardado **solo como un
hash SHA-256**. **Rotativo**: cada uso revoca el viejo y emite uno nuevo.
**Con detección de reutilización**: presentar un token ya revocado — la señal inequívoca de un robo —
**quema toda la familia de tokens**.

**Roles**

| Rol | Resumen |
|------|---------|
| `SUPER_ADMIN` | Todos los permisos; se salta los chequeos granulares. El **único** rol que puede otorgar `SUPER_ADMIN`. |
| `ADMINISTRATOR` | Todos los permisos **excepto** `system.manage`. |
| `POWER_USER` | Todas las acciones de torrents, RSS, automatización, y ⚠️ **todos los `files.*` — incluyendo borrar, en masa y limpieza**. |
| `USER` | Ver/añadir torrents, cambios básicos de estado, archivos de **solo lectura**. |
| `READ_ONLY` | Solo ver. |

**SSRF (Server-Side Request Forgery)**
Un ataque en el que engañas a un servidor para que obtenga una URL interna. La protección SSRF de
UltraTorrent bloquea las descargas de URLs de torrent que resuelven a direcciones privadas/loopback/link-local/CGNAT o
de **metadatos de la nube**, permite solo `http(s)`, rechaza redirecciones, y limita el
cuerpo a 20 MB.

**`SSRF_ALLOW_HOSTS`**
La lista de permitidos que levanta *solo* el bloqueo de direcciones privadas, y *solo* para los hosts que
nombres. **Requerida** para cualquier indexador autoalojado en una IP privada — incluyendo el
Prowlarr incluido (de ahí su valor por defecto, `prowlarr`).

:::note La trampa que vale la pena memorizar
Sin ella, las capturas fallan con *"Torrent URL resolves to a blocked internal address"* —
**mientras que la prueba de conexión de Prowlarr igual pasa.** El chequeo de salud confía en los hosts
privados; la *descarga* del torrent es una protección separada y más estricta.
:::

**TOTP (Time-based One-Time Password)**
El código rotativo de 6 dígitos de una app autenticadora. RFC 6238. Paso de 30 segundos, tolerancia de
±1 paso para el desfase de reloj.

---

## Infraestructura {#infrastructure}

**BullMQ**
La librería de trabajos/colas respaldada por Redis.

**`CREATE INDEX CONCURRENTLY`**
Construye un índice de Postgres **sin retener un bloqueo de escritura** — así la app se mantiene arriba.

:::warning No puede correr dentro de una transacción
Lo que significa que **nunca** puede vivir en una migración de Prisma. Poner un `CREATE INDEX` grande y
normal en una migración causó en cambio una **caída real**: la construcción se mató
a mitad de vuelo, Prisma marcó la migración como **fallida (P3009)**, y el backend se negó a
arrancar en **dos hosts a la vez**. Los índices grandes hay que construirlos en **tiempo de ejecución**.
:::

**GIN index** (índice GIN)
Un tipo de índice de Postgres adecuado para valores compuestos — y, con `gin_trgm_ops`, para la
**búsqueda por similitud de texto**. Esto es lo que hace que `ILIKE` sea rápido.

**`ILIKE`**
El `LIKE` insensible a mayúsculas de SQL. Prisma renderiza `mode: 'insensitive'` como `ILIKE`.

:::danger `ILIKE` no puede usar un índice btree
Esta es la causa raíz del peor incidente de rendimiento en la historia de UltraTorrent. Sobre
el catálogo de IMDb de 8.9M de filas, cada búsqueda de título insensible a mayúsculas se volvía un **escaneo
completo de tabla de 47.8 segundos**, que mataba de hambre a Postgres hasta que los escaneos de biblioteca **nunca terminaban**.
Con índices **GIN pg_trgm**: **180 ms** — una aceleración de **~265×**, sin ningún cambio en el código
de la aplicación.
:::

**INVALID index** (índice INVALID)
Un índice que quedó roto por un `CREATE INDEX CONCURRENTLY` **interrumpido**. El planificador
lo **ignora** — pero su **nombre existe**, así que `CREATE INDEX ... IF NOT EXISTS` lo ve
y **se salta la reconstrucción para siempre**. Hay que **eliminarlo y reconstruirlo**. Revísalo con
`indisvalid` en `pg_index`.

**P1000 / P1001 / P2025 / P3009**
Códigos de error de Prisma que realmente vas a encontrar:

| Código | Significado | Causa habitual |
|------|---------|-------------|
| **P1000** | Falló la autenticación | El volumen `postgres_data` fue **inicializado por primera vez con otra contraseña**. Postgres solo aplica `POSTGRES_PASSWORD` en la **primera inicialización** — los cambios posteriores en `.env` no tienen efecto sobre un volumen existente. |
| **P1001** | No se puede alcanzar la base de datos | `DATABASE_URL` apunta al nombre del servicio de Docker `postgres` en una instalación **manual**. Usa `localhost`. |
| **P2025** | No se encontró el registro a actualizar | Una fila se esfumó a mitad de la operación (p. ej. un re-escaneo concurrente la borró). |
| **P3009** | Una migración fallida bloquea el arranque | Una migración interrumpida. Recupérate con `prisma migrate resolve --applied <name>`. |

**`pg_stat_activity`**
La vista de Postgres que muestra qué está haciendo cada conexión. **El diagnóstico más importante
de esta documentación.**

:::tip Muerto de hambre vs atascado — la lectura que resuelve toda una clase de misterios
- **`state = active`**, larga duración, **sin contención de bloqueos**, conexiones **lejísimos**
  del límite → **muerto de hambre, no atascado**. La base de datos está *trabajando*; una consulta es tan
  cara que se está comiendo el servidor. Busca un **índice faltante**.
- **`wait_event_type = Lock`** → contención genuina.

En el incidente real la evidencia fue: consultas `active` largas, **cero** contención de bloqueos,
y solo **13 de 100** conexiones en uso.
:::

**`pg_trgm`**
La extensión de **trigramas** de Postgres. Parte el texto en secuencias de tres caracteres para que
`LIKE`/`ILIKE` puedan **apoyarse en un índice** GIN. La solución para el catálogo de IMDb.

**Prisma**
La herramienta de ORM/migraciones entre el backend y PostgreSQL.

**SCGI**
El protocolo que el backend de UltraTorrent usa para hablar con **rTorrent** (XML-RPC sobre SCGI).

:::danger La superficie de control SCGI no está autenticada
Da **control total del cliente**, incluyendo la capacidad de **ejecutar comandos**
(rTorrent corre `rm` durante el borrado con datos). **Nunca la expongas a la red.** El
archivo de Compose que se distribuye correctamente la mantiene solo interna (`expose`, no `ports`).
:::

**Trigram** (trigrama)
Una secuencia de tres caracteres. `Silo` → `sil`, `ilo`. Comparar conjuntos de trigramas es como
`pg_trgm` mide la similitud de texto — y como un índice puede servir un `ILIKE`.

**XML-RPC**
El formato RPC que rTorrent habla, transportado sobre SCGI.

---

## Ver también {#see-also}

- [FAQ](/help/faq) — las preguntas detrás de estos términos
- [Resolución de problemas](/operate/troubleshooting) — los incidentes de los que vienen estos términos
- [Conceptos](/learn/concepts) — la introducción conceptual
- [Rendimiento](/operate/performance) · [Seguridad](/operate/security)
- [Permisos](/reference/permissions) · [Entorno](/reference/environment)
