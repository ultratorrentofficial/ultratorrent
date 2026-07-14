---
id: faq
title: Preguntas Frecuentes
sidebar_position: 1
description: Respuestas a las preguntas más comunes sobre UltraTorrent — instalación, configuración, descargas, RSS, medios, notificaciones, automatización, seguridad, Docker, rendimiento, API y desarrollo.
keywords:
  - FAQ
  - preguntas
  - respuestas
  - ayuda
  - problemas comunes
  - cómo hago
  - por qué
  - qué es
  - primeros pasos
  - soporte
  - instalación
  - configuración
  - descargas
  - RSS
  - medios
  - notificaciones
  - automatización
  - seguridad
  - Docker
  - rendimiento
  - API
  - desarrollador
---

# Preguntas Frecuentes {#frequently-asked-questions}

Respuestas a las preguntas que más surgen. Si tu problema es un *fallo* y no
una pregunta, ve a [Resolución de problemas](/operate/troubleshooting) — está
organizada por síntoma y cubre incidentes reales ya diagnosticados.

## General {#general}

### ¿Qué es UltraTorrent? {#what-is-ultratorrent}

Una **Plataforma de Adquisición y Gestión de Medios** autoalojada. Donde un cliente
de torrents tradicional se detiene en "descarga este archivo", UltraTorrent sigue:
identifica el lanzamiento, lo enriquece con metadatos, ilustraciones y subtítulos, lo renombra
y lo archiva en la biblioteca correcta, genera archivos NFO acompañantes, actualiza tu servidor
de medios y te notifica — todo gobernado por RBAC y observable en tiempo real.

Ver [Conceptos](/learn/concepts).

### ¿En qué se diferencia de simplemente correr qBittorrent? {#how-is-it-different-from-just-running-qbittorrent}

Un cliente convencional es una **herramienta de escritorio de un solo usuario** cuyo trabajo termina cuando la
descarga se completa. UltraTorrent es una **plataforma del lado del servidor** que se sitúa *delante
de* uno o más motores. El navegador nunca le habla directamente al motor — la API
traduce las peticiones al protocolo nativo de cada motor y devuelve datos normalizados,
independientes del motor.

Alrededor de eso añade capas de automatización RSS, identificación y organización de medios,
un motor de reglas de automatización, RBAC multiusuario, auditoría e integraciones con
servidores de medios.

### ¿Es gratis? ¿Hay un plan de pago? {#is-it-free-is-there-a-paid-tier}

Es **gratis y de código abierto** (AGPL-3.0-or-later). **No hay edición comercial,
ni niveles de licencia, ni funciones tras un muro de pago**. Cada función está en el único
repositorio. El acceso se controla **solo** por RBAC.

### ¿UltraTorrent descarga algo ilegal? {#does-ultratorrent-download-anything-illegal}

UltraTorrent es una **herramienta**. No aloja, indexa ni provee contenido — tú
suministras los indexadores y las fuentes. Lo que descargues con ella es tu
responsabilidad, y está sujeto a la ley del lugar donde vives.

### ¿Hace scraping de IMDb? {#does-it-scrape-imdb}

**No.** **No existe ninguna ruta de código que obtenga o analice el HTML de imdb.com.** El proveedor
de IMDb funciona únicamente con los **datasets de IMDb que tú provees** y/o una **API de IMDb
con licencia**. Está deshabilitado por defecto.

---

## Instalación {#installation}

### ¿Cuáles son los requisitos del sistema? {#what-are-the-system-requirements}

| | Mínimo | Cómodo |
|---|---------|-------------|
| RAM | 2 GB | 4–8 GB (más si importas el catálogo de IMDb) |
| Docker | Sí (ruta recomendada) | — |
| Node.js | 20+ (solo para una instalación manual) | — |
| Arquitectura | x86-64 o ARM | — |

El stack de Docker **construye desde el código fuente**, así que el host necesita un par de GB de
RAM libre para construir.

### ¿Qué método de instalación debo usar? {#which-install-method-should-i-use}

| Tienes… | Usa |
|-----------|-----|
| Un NAS (QNAP / Synology) | **Docker**, mediante la app de contenedores del NAS |
| Una PC Linux, y lo quieres simple | **Docker** — un comando levanta todo el stack |
| Una PC Linux, y quieres desarrollar | **Manual** (Node 20 + PostgreSQL + Redis) |

Ver [Docker Compose](/install/docker-compose).

### El backend no arranca y se queja de "insecure secret configuration" {#the-backend-wont-start-and-complains-about-insecure-secret-configuration}

Eso es una **medida de seguridad, no un bug**. En producción el backend se niega a arrancar
si `JWT_ACCESS_SECRET` o `ENCRYPTION_KEY` no están definidos, son un valor por defecto conocido, tienen menos
de 32 caracteres, o si **los dos son idénticos**.

```bash
openssl rand -base64 48   # hazlo tres veces
```

Ver [Resolución de problemas](/operate/troubleshooting#the-backend-exits-immediately-with-insecure-secret-configuration).

### Compose no arranca: "POSTGRES_PASSWORD is required" {#compose-wont-start-postgres_password-is-required}

El stack viene **sin valores por defecto inseguros** — Compose mismo se niega a renderizar
sin `POSTGRES_PASSWORD` y `ADMIN_PASSWORD`. Define ambos en `.env`.

Usa una contraseña **alfanumérica**: `DATABASE_URL` se deriva de ella, y los caracteres
especiales de URL (`@ : / ?`) rompen la cadena de conexión.

### "Invalid username or password" justo después de instalar {#invalid-username-or-password-right-after-installing}

Dos causas:

1. Inicia sesión con el **nombre de usuario** (`admin` por defecto), **no con el correo**.
2. Puede que no hayas corrido el seed:

   ```bash
   docker compose exec backend npx prisma db seed
   ```

### Olvidé la contraseña de admin {#i-forgot-the-admin-password}

El seed solo establece la contraseña cuando **crea por primera vez** al admin — no
sobrescribe un cambio posterior. Restablécela al valor actual de tu `.env`; el comando exacto
de recuperación está en la [resolución de problemas de instalación](/install/docker-compose).

### El puerto 8080 ya está en uso (NAS) {#port-8080-is-already-in-use-nas}

```dotenv
FRONTEND_PORT=8123
```

:::warning
**No** intentes remapear el puerto con un archivo override de Compose. Compose **añade**
las entradas de `ports` en vez de reemplazarlas, así que el mapeo original de `8080` sobrevive
y sigue en conflicto.
:::

### ¿Puedo correrlo sin Docker? {#can-i-run-it-without-docker}

Sí — una instalación manual necesita Node 20, PostgreSQL y Redis. Para una instalación manual
recuerda apuntar `DATABASE_URL` a `localhost`, no al nombre del servicio de Docker
`postgres` (eso produce `P1001: Can't reach database server`).

---

## Configuración {#configuration}

### ¿Dónde viven los ajustes — en `.env` o en la UI? {#where-do-settings-live--env-or-the-ui}

En ambos, deliberadamente:

- **`.env`** guarda los valores *controlados por operaciones*: secretos, base de datos, puertos y el
  límite duro del gestor de archivos. Se definen al desplegar y **nunca se amplían en
  tiempo de ejecución**.
- **La UI** guarda los valores *configurables por el operador*: motores, indexadores, fuentes RSS,
  reglas de automatización, bibliotecas, canales de notificación.

Las claves API que ingresas en la UI se **cifran en reposo con AES-256-GCM** y se redactan
(`••••••••`) en cada respuesta de la API — nunca se escriben en `.env`.

### ¿Qué es `FILE_MANAGER_ROOTS` y por qué importa? {#what-is-file_manager_roots-and-why-does-it-matter}

Es el **límite exterior duro, controlado por operaciones**, para el gestor de archivos
(rutas absolutas separadas por comas, `/downloads` por defecto). Nada en la UI puede
escapar de él — el traversal, el escape absoluto y el escape por symlink están todos bloqueados.

Encima de eso, un admin puede definir una **Ruta Raíz Predeterminada** para *estrechar* la navegación a un
subárbol. Solo puede estrechar, nunca ampliar. Mantén `FILE_MANAGER_ROOTS` lo más ajustado
posible y alineado con los directorios en los que tu motor realmente escribe.

### ¿Qué es `SSRF_ALLOW_HOSTS`? {#what-is-ssrf_allow_hosts}

La lista de permitidos para las descargas de torrents. La protección SSRF del backend **bloquea cualquier URL
`.torrent` que resuelva a una dirección privada/interna** a menos que su host esté listado aquí.

Esto importa porque un indexador autoalojado — **incluyendo el Prowlarr incluido** en
`http://prowlarr:9696` — devuelve enlaces proxy en una IP privada de Docker. Por defecto trae
`prowlarr` para que el indexador incluido funcione de una vez.

```dotenv
SSRF_ALLOW_HOSTS=prowlarr,indexer.lan,10.0.0.0/24
```

**Mantén `prowlarr` en la lista** si usas el que viene incluido.

### ¿Puedo cambiar `ENCRYPTION_KEY`? {#can-i-change-encryption_key}

Puedes, pero es **destructivo**. Es la llave AES-256-GCM de todo lo que está
cifrado en reposo, así que rotarla vuelve **permanentemente ilegible** todo esto:

- el **secreto TOTP** de cada usuario (todos los usuarios con 2FA tendrán que volver a inscribirse)
- las **claves API de los indexadores**
- la **clave API de Prowlarr**
- las **contraseñas de los motores**

Ver [Rotación de secretos](/operate/security#rotating-encryption_key-destructive--plan-it).

### ¿Qué son `PUID` / `PGID`? {#what-are-puid--pgid}

El usuario y el grupo con los que corre el motor incluido, para que las descargas queden con el dueño que quieras.
Si tu carpeta de descargas pertenece a otra app (p. ej. Plex), **no le hagas `chown`** —
define `PUID`/`PGID` a *ese* usuario (`id plex`) para que los archivos se escriban como él.

---

## Descargas {#downloads}

### Mi descarga no arranca. ¿Por dónde empiezo? {#my-download-isnt-starting-where-do-i-begin}

Sigue el árbol de decisión en
[Resolución de problemas](/operate/troubleshooting#the-decision-tree-operators-actually-need-my-download-isnt-starting).
Hay al menos seis causas distintas y adivinar es perder tiempo.

La más común: **el motor no está registrado o no está corriendo**. Los motores
incluidos están detrás de perfiles de Compose y están **apagados por defecto** — un simple
`docker compose up -d` no arranca *ningún* motor.

### Las descargas automáticas capturan cosas pero nunca se descarga nada {#auto-downloads-grab-things-but-nothing-ever-downloads}

Busca en el log:

```
Torrent URL resolves to a blocked internal address
```

Esa es la **protección SSRF** bloqueando el enlace `.torrent` de tu indexador porque
resuelve a una IP privada. Añade el host a `SSRF_ALLOW_HOSTS`.

:::warning La trampa
**La prueba de conexión de Prowlarr igual pasa.** El chequeo de salud confía en los hosts
privados; la *descarga* del torrent es una protección separada y más estricta. Un distintivo verde prueba que la
API es alcanzable — **no** prueba que las capturas se vayan a descargar.
:::

### Una descarga dice "failed" pero claramente está descargando {#a-download-says-failed-but-its-clearly-downloading}

Estás en un build antiguo. Los **magnets** se marcaban como fallidos si no se registraban
dentro de una ventana de confirmación de ~6 segundos — lo cual está bien para un archivo `.torrent` (sus
metadatos ya están presentes) pero es **completamente incorrecto para un magnet**, cuyos metadatos
hay que obtener primero desde DHT/pares.

En producción, **256 de 257 de esos "fallos" en realidad habían cargado**, con una mediana de
**~53 segundos**. [Actualiza](/install/upgrading) — los magnets ahora se tratan como
aceptados/pendientes, mientras que un archivo `.torrent` sigue fallando como debe.

### No se descarga nada — todo se queda en cola {#nothing-downloads-at-all--everything-sits-queued}

Casi con certeza son **torrents muertos ocupando todas las ranuras de la cola**. Un magnet con 0 seeders
**nunca puede obtener sus metadatos, y aun así el motor lo cuenta como una descarga activa todo el
tiempo que lo intenta**. Con `max_active_downloads: 100`, cien cadáveres ocupan cien
ranuras y cada torrent sano hace fila detrás de ellos.

El caso real: **1,137 torrents, 0 bytes moviéndose, 1,114 de ellos con cero seeders.**

**Solución:** define `minSeeders` en **cada** indexador (¡el filtro solo aplica cuando la
columna está definida!) y activa la cola de parking. Ver
[Resolución de problemas](/operate/troubleshooting#dead-torrents-block-every-healthy-one-nothing-downloads-at-all).

### Mi regla de "borrar al completar" dice que tuvo éxito, pero el torrent sigue compartiendo {#my-delete-on-complete-rule-says-it-succeeded-but-the-torrent-is-still-seeding}

Tres causas posibles, todas reales:

1. **El `d.erase` de rTorrent falla en silencio.** Acepta la llamada, no devuelve error,
   y deja la descarga cargada. La eliminación ahora se **verifica y se reintenta**.
2. **El disparador de completado era un flanco ascendente de una sola vez**, así que cualquier torrent que ya estuviera al
   100% al verlo por primera vez quedaba permanentemente fuera. Ahora hay una pasada de relleno.
3. **La trampa de la condición de qBittorrent** — ver abajo.

[Actualiza](/install/upgrading) para 1 y 2.

### Mi regla de borrar-al-completar nunca se dispara en qBittorrent {#my-delete-on-complete-rule-never-fires-on-qbittorrent}

Porque **qBittorrent mapea los torrents completados/compartiendo a `SEEDING` y nunca emite
`COMPLETED`**. Así que una regla con una condición como `state == 'completed'` **nunca
coincide**.

> **Una regla de "borrar al completar" debe tener las condiciones _vacías_.** El
> **disparador** `torrent.completed` ya es la condición.

### ¿Qué motor debo usar — rTorrent o qBittorrent? {#which-engine-should-i-use--rtorrent-or-qbittorrent}

**qBittorrent, a menos que tu biblioteca sea pequeña.**

El rTorrent incluido es `0.9.8`, que arrastra un **bug de caída del proyecto original imposible de arreglar**
(`internal_error: priority_queue_insert`) que **depende de la carga**. Mediciones reales
de dos hosts con el mismo build:

| Torrents | Caídas |
|----------|---------|
| **7** | **0** |
| **752** | **44 en 4 días** |

No se pierde ningún torrent (la sesión se recarga al reiniciar), pero las transferencias se pausan. Por debajo de
~100 torrents rTorrent está genuinamente bien. Por encima de eso, usa qBittorrent.

### La "Probar conexión" de qBittorrent falla con 401 {#qbittorrents-test-connection-fails-with-401}

Desactiva **Enable Host header validation** bajo **Options → Web UI** (o pon
*Server domains* en `*`). El backend se conecta por el nombre del servicio de Docker
`qbittorrent`, en el que qBittorrent no confía por defecto.

---

## RSS {#rss}

### ¿Cómo evita la descarga automática por RSS capturar lo mismo dos veces? {#how-does-rss-auto-download-avoid-grabbing-the-same-thing-twice}

Tres niveles de deduplicación, todos aplicados tanto en el sondeo como en el relleno:

1. **Por elemento de la fuente** — por fuente + GUID del elemento.
2. **Por torrent** — por el **info-hash** de BitTorrent, así que el mismo lanzamiento bajo un
   GUID rotado, una re-publicación, o una *segunda fuente* nunca se captura dos veces.
3. **Por título lógico** — de modo que una regla con lista de preferencias mantiene **solo un lanzamiento
   por película/episodio**. Captura el mejor disponible, **mejora** a un lanzamiento de prioridad
   estrictamente mayor cuando aparece (eliminando el torrent superado y sus
   datos), y omite los lanzamientos iguales o inferiores.

### ¿Qué es el Smart Match Builder? {#what-is-the-smart-match-builder}

El motor de preferencias de coincidencia con ranking para las reglas RSS: reglas de inclusión/exclusión más una
lista de preferencias ordenada, para que puedas expresar "prefiero 1080p WEB-DL, pero acepto 720p si
es lo único que hay — y mejora luego si aparece el mejor".

Ver [RSS](/modules/rss) y [Descarga inteligente](/modules/smart-download).

### ¿Puede una regla descargar un episodio dos veces desde dos fuentes distintas? {#can-a-rule-download-an-episode-twice-from-two-different-feeds}

No — la deduplicación es por **info-hash**, no por fuente. El mismo lanzamiento en dos fuentes se
captura una sola vez.

---

## Medios {#media}

### Una serie reporta 0 episodios faltantes y nunca encuentra nada {#a-show-reports-0-missing-episodes-and-never-finds-anything}

Su **id de IMDb** está mal o falta. Todo lo que viene después depende de él. Hay
cuatro maneras distintas en que falla — **las cuatro ahora se autocorrigen**:

| Problema | Ejemplo real |
|---------|--------------|
| El id es de un **episodio**, no de la serie | *Silo* fijado a `tt16091606` (episodio) en vez de `tt14688458` (serie) → arroja **0 episodios** → escanea a 0/0/0 para siempre |
| **Acentos** | `90 Day Fiancé` vs `90 Day Fiance` — los acentos se *eliminaban* en vez de *plegarse*, así que las claves nunca coincidían |
| **Puntuación** | `FBI: Most Wanted` vs `FBI Most Wanted`; `Chicago P.D.` vs `Chicago PD` |
| **Ningún id de IMDb** | Una serie identificada contra TVDB. En un host, solo **74 de 8,986** elementos de TV tenían uno |

[Actualiza](/install/upgrading), y luego vuelve a escanear. También puedes forzarlo:
`POST /media-acquisition/watchlist/library/resolve-imdb`.

Si una serie *aún* no se resuelve, puede que genuinamente no esté en tu catálogo (o
esté listada solo bajo un título localizado) — pon el id a mano.

### ¿Por qué no empareja `90 Day Fiancé: Pillow Talk` con `90 Day Fiancé` por prefijo? {#why-doesnt-it-just-match-90-day-fiancé-pillow-talk-to-90-day-fiancé-by-prefix}

Porque así es **exactamente** como un spin-off secuestra a su serie madre. El emparejador
deliberadamente **se niega a adivinar**. Una serie catalogada solo bajo un título completo
localizado queda sin resolver y hay que ponerla a mano. Esto es intencional, no una carencia.

### Mi biblioteca muestra episodios como si fueran series separadas {#my-library-shows-episodes-as-if-they-were-separate-shows}

Un bug antiguo: los nuevos elementos de medios se creaban con `title = basename(file)` y **sin
temporada/episodio**, así que una serie se fragmentaba en una entrada falsa por episodio. En un host
**3,579 de 5,840** elementos de TV estaban en ese estado.

Ya está arreglado, y **se autocorrige al volver a escanear**. Actualiza y vuelve a escanear.

### ¿Necesito el catálogo de IMDb? {#do-i-need-the-imdb-catalogue}

No — es **opcional y está apagado por defecto**. Te da una resolución de títulos mucho mejor
y mejor detección de episodios faltantes. También son **8.9 millones de filas**, así que si lo importas
*tienes* que tener los índices de trigramas (los builds actuales los crean por ti). Ver
[Rendimiento](/operate/performance#the-imdb-catalogue).

### Un escaneo de biblioteca se congela en 74% y nunca termina {#a-library-scan-freezes-at-74-and-never-finishes}

El síntoma clásico de **índices pg_trgm faltantes**. Prisma renderiza
`mode: 'insensitive'` como `ILIKE`, que **no puede usar un índice btree** — así que sobre el
catálogo de 8.9M de filas cada búsqueda de título se volvía un escaneo completo de tabla de **47.8 segundos
cada uno**, saturando Postgres y matando de hambre al escaneo mismo.

Con índices GIN de trigramas: **180 ms** — una aceleración de **~265×**.

Ver [Resolución de problemas](/operate/troubleshooting#a-library-scan-freezes-at-a-percentage-and-never-completes).

---

## Notificaciones {#notifications}

### ¿Qué canales están soportados? {#what-channels-are-supported}

En la app, webhook, **Discord**, **Slack** y **Telegram**, con envío en paralelo a múltiples
canales. Ver [Centro de Notificaciones](/modules/notification-center).

### ¿Qué servidores de medios puede actualizar? {#which-media-servers-can-it-refresh}

**Plex, Jellyfin, Emby y Kodi.** Después de que una descarga se organiza, UltraTorrent puede
disparar una actualización de biblioteca para que el elemento aparezca sin que toques el servidor de medios.

### Mi feed de actividad del panel es puro ruido de fondo {#my-dashboard-activity-feed-is-nothing-but-background-noise}

Arreglado. Los barridos de enriquecimiento de metadatos/ilustraciones/IMDb escriben una fila de auditoría por elemento
de medios, así que un solo barrido de ~16 elementos producía ~48 filas y llenaba el feed. Los eventos
**generados por el sistema** que llegan en ráfaga ahora se colapsan en una sola línea de "N eventos", mientras que
las acciones **atribuidas a un usuario** y los eventos que sí quieres ver individualmente
(renombrados, descargas) se mantienen separados.

---

## Automatización {#automation}

### ¿Qué pueden hacer las reglas de automatización? {#what-can-automation-rules-do}

Son **reglas de condición/acción dirigidas por eventos**. Un disparador (p. ej.
`torrent.completed`) se activa, se evalúan las condiciones, y las acciones corren — renombrar,
mover, borrar, notificar, actualizar un servidor de medios, y así. Ver
[Automatización](/modules/automation).

### ¿Se auditan las ejecuciones de automatización? {#are-automation-runs-audited}

Sí. Cada ejecución de regla se refleja en el registro de auditoría con el nombre de la regla, las
acciones, el resultado y el torrent — visible tanto en la página de Auditoría como en la
Actividad reciente del panel.

### ¿Por qué mi regla corrió una vez y nunca más? {#why-did-my-rule-run-once-and-never-again}

Las reglas usan un **libro mayor de idempotencia** para que una regla corra a lo sumo una vez por torrent, sin
importar cuántas veces el bucle de sondeo la evalúe. Importante: una ejecución **fallida** *no* se
registra como hecha — así que una regla bloqueada por un error transitorio (motor sin conexión) se
reintentará en el siguiente ciclo en vez de ser omitida en silencio para siempre.

---

## Seguridad {#security}

### ¿Es seguro exponer UltraTorrent a internet? {#is-it-safe-to-expose-ultratorrent-to-the-internet}

*Puede* serlo — detrás de TLS, con 2FA, contraseñas fuertes, y sin puertos de motor publicados.
Pero **un VPN es una mejor respuesta para casi todo el mundo**. UltraTorrent mueve, borra y
ejecuta contra archivos.

Ver [Seguridad](/operate/security#exposing-ultratorrent-to-the-internet).

### ¿Qué protege mi inicio de sesión? {#what-is-protecting-my-login}

- Hashing de contraseñas con **Argon2id** (memory-hard, resistente a GPU/ASIC).
- **Login endurecido contra ataques de tiempo** — un nombre de usuario desconocido igual corre una verificación contra un
  hash falso, así que el tiempo de respuesta no revela si una cuenta existe.
- **Límite de tasa**: `POST /api/auth/login` está limitado a **5 peticiones / 60 s**.
  Como el paso de 2FA hace POST al mismo endpoint, ese límite **también acota los intentos de adivinar
  el TOTP**.
- **JWTs de vida corta** (15 m) más **refresh tokens rotativos con detección de reutilización** —
  presentar un refresh token ya revocado **quema toda la familia de tokens**.

### ¿Soporta 2FA? {#does-it-support-2fa}

Sí — **TOTP** (RFC 6238), compatible con cualquier app autenticadora estándar.
La inscripción es **confirmada, no a ciegas**: el 2FA no se activa hasta que pruebas
posesión enviando un código válido, así que no puedes dejarte fuera por escanear un
código QR y marcharte. Recibes **10 códigos de recuperación de un solo uso**, mostrados una vez.

### ¿Puede un usuario regular borrar mis medios? {#can-a-regular-user-delete-my-media}

Depende del rol:

- **`USER`** — archivos de solo lectura. **No.**
- **`POWER_USER`** — tiene **todos** los `files.*`, **incluyendo borrar, acciones en masa y
  limpieza**. **Sí.** Otórgalo con intención.

Nota que `torrents.delete_data` (elimina los datos **del disco**) es un **permiso
separado** de `torrents.delete`.

### ¿Puede alguien con `users.manage` ascenderse a sí mismo a admin? {#can-someone-with-usersmanage-promote-themselves-to-admin}

**No.** Solo un `SUPER_ADMIN` puede otorgar `SUPER_ADMIN`, y **ningún usuario puede editar sus
propios roles**. Desactivar a un usuario revoca de inmediato sus refresh tokens.

### ¿Los archivos borrados se van de verdad? {#are-deleted-files-really-gone}

**No — los borrados son suaves por defecto.** Los elementos se mueven a un directorio
`.ultratorrent-trash` dentro de su propia raíz de almacenamiento y se pueden restaurar o purgar. Se requiere
`permanent: true` para borrar de forma irreversible. El Asistente de Limpieza **nunca borra
automáticamente** — su vista previa es de solo lectura y elimina únicamente las rutas que selecciones
explícitamente.

### ¿Cómo reporto una vulnerabilidad de seguridad? {#how-do-i-report-a-security-vulnerability}

**En privado.** No abras un issue público en GitHub. Usa la función de aviso privado de seguridad
de GitHub para el repositorio, con una descripción, las versiones afectadas,
los pasos para reproducirla y el impacto.

---

## Docker {#docker}

### ¿Qué hacen los perfiles de Compose? {#what-do-the-compose-profiles-do}

Los servicios opcionales están **apagados por defecto**:

```bash
docker compose --profile rtorrent up -d --build       # motor rTorrent incluido
docker compose --profile qbittorrent up -d            # motor qBittorrent incluido
docker compose --profile prowlarr up -d               # gestor de indexadores
docker compose --profile flaresolverr up -d           # solucionador de Cloudflare para Prowlarr
docker compose --profile proxy up -d                  # proxy de borde Caddy + TLS automático

# Varios a la vez
docker compose --profile qbittorrent --profile prowlarr up -d
```

Un simple `docker compose up -d` no arranca **ningún motor**. Esto sorprende a la gente.

### ¿Qué nunca debo correr? {#what-must-i-never-run}

```bash
docker compose down -v          # ← el -v DESTRUYE el volumen de tu base de datos
docker system prune --volumes   # ← también lo puede destruir
```

`docker system prune -f` (sin `--volumes`) es seguro.

### ¿Dónde están mis datos? {#where-is-my-data}

| Volumen | Contenido | ¿Respaldar? |
|--------|----------|----------|
| `postgres_data` | **Todo lo duradero** | **Sí — crítico** |
| `downloads` | Medios + la sesión de rTorrent (`/downloads/.session`) | Sí |
| `prowlarr_config` / `qbittorrent_config` | Ajustes de los acompañantes | Recomendado |
| `redis_data` | Caché / colas | **No** — sin estado duradero |
| `caddy_data` | Certificados TLS | Opcional |

**Y respalda `.env`** — tiene `ENCRYPTION_KEY`, que **no está en el dump de tu base de
datos**.

### ¿Por qué el puerto del backend no está publicado? {#why-is-the-backend-port-not-published}

Por diseño. El nginx del frontend hace de proxy de `/api/` y `/ws/` hacia el backend por la
red interna, así que el navegador solo habla con un puerto. Publica el `4000` solo si
estás integrando un cliente de API externo.

### Las descargas son propiedad de root {#downloads-are-owned-by-root}

El entrypoint del rTorrent incluido arranca como root y luego **baja a `PUID:PGID` con
gosu** — lo cual necesita las capacidades `SETUID`/`SETGID`. **Synology DSM las quita**,
la bajada falla, y cae de vuelta a root. Por eso el archivo de Compose lleva:

```yaml
cap_add: ["SETUID", "SETGID"]
```

Mantén esa línea, y define `PUID`/`PGID`.

---

## Rendimiento {#performance}

### ¿Cuál es el mayor problema de rendimiento? {#what-is-the-single-biggest-performance-issue}

El **catálogo de IMDb sin índices de trigramas**. `ILIKE` no puede usar un índice btree, así que
sobre 8.9M de filas cada búsqueda de título era un escaneo completo de tabla de **47.8 s**. Con índices
GIN `pg_trgm`: **180 ms**.

### ¿Cómo sé si mis índices realmente están funcionando? {#how-do-i-know-if-my-indexes-are-actually-working}

Un índice **INVALID** es peor que ningún índice — el planificador lo ignora, pero el *nombre*
existe, así que `CREATE INDEX ... IF NOT EXISTS` se salta la reconstrucción **para siempre**.

```sql
SELECT c.relname, i.indisvalid
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname LIKE '%trgm%';   -- todos deben ser `t`
```

Luego confirma que el planificador los usa:

```sql
EXPLAIN ANALYZE SELECT * FROM imdb_titles WHERE "primaryTitle" ILIKE 'Silo';
-- Quieres: Bitmap Index Scan.  NO quieres: Seq Scan.
```

### Algo está "colgado". ¿Cómo distingo atascado de lento? {#something-is-hanging-how-do-i-tell-stuck-from-slow}

El diagnóstico más útil de toda esta documentación:

```sql
SELECT pid, now() - query_start AS duration, state, wait_event_type,
       left(query, 80) FROM pg_stat_activity
WHERE state <> 'idle' ORDER BY duration DESC LIMIT 10;
```

- **`state = active`, sin contención de bloqueos, conexiones lejos del límite** →
  **muerto de hambre, no atascado.** Una consulta es tan cara que se está comiendo el servidor. Busca
  un índice faltante.
- **`wait_event_type = Lock`** → contención genuina.

En el incidente real: consultas `active` largas, **sin bloqueos**, y solo **13 de 100**
conexiones en uso. Esa combinación apunta directo a un índice faltante.

### Mis trabajos se quedan en 0% para siempre {#my-jobs-are-stuck-at-0-forever}

Los cuerpos de los trabajos corren **en proceso** — no son unidades de trabajo duraderas que un worker reanude. Un
despliegue o un reinicio **mata el trabajo pero deja la fila diciendo `running`**. Un host tenía
**30** filas así, algunas de 5 horas de antigüedad.

Los builds actuales las reconcilian al arranque (marcándolas como fallidas con `Interrupted by a
service restart`). La consecuencia operativa: **no reinicies a mitad de un escaneo**, y
vuelve a correr lo que estuviera en vuelo después de una actualización.

---

## API {#api}

### ¿Hay una API? {#is-there-an-api}

Sí — UltraTorrent es **API-first**. Cada capacidad es un endpoint REST documentado
(OpenAPI/Swagger); la UI web es solo un cliente más de esa API. También hay una
puerta de enlace WebSocket en tiempo real. Ver [Referencia de la API](/reference/api).

### ¿Cómo me autentico? {#how-do-i-authenticate}

Con un token de acceso JWT (TTL por defecto **15 minutos**) obtenido de `POST /api/auth/login`,
más un refresh token rotativo. Para acceso de máquina, prefiere una **clave API** en vez de una
contraseña compartida.

### ¿Por qué mi WebSocket conecta pero no recibe eventos? {#why-does-my-websocket-connect-but-receive-no-events}

La puerta de enlace autentica el JWT **en el handshake** y une cada socket únicamente a las
salas que corresponden a los **permisos de vista que tiene**. Un usuario sin `torrents.view`
conecta con éxito y no recibe nada — por diseño, para que un usuario nunca pueda obtener
datos en tiempo real que no podría leer por REST.

Si no conecta *para nada*, tu proxy inverso probablemente no está reenviando las
cabeceras `Upgrade`/`Connection`.

### ¿Endpoints útiles para monitoreo? {#useful-endpoints-for-monitoring}

| Endpoint | Auth | Uso |
|----------|------|-----|
| `GET /api/system/live` | ninguna | Vitalidad |
| `GET /api/system/ready` | ninguna | Disponibilidad (dependencias usables) |
| `GET /api/system/version` | ninguna | Versión **y el commit de git horneado en la imagen** |
| `GET /api/system/health` | `system.view` | Salud detallada |
| `GET /api/engines/health` | autenticada | Alcanzabilidad por motor |

`/api/system/version` es como **pruebas que un despliegue realmente aterrizó** — si el commit
no cambió después de reconstruir, tu imagen no se reconstruyó.

---

## Desarrollador {#developer}

### ¿Con qué está construido? {#what-is-it-built-with}

Un monorepo de TypeScript: backend **NestJS** (Prisma → PostgreSQL, Redis), frontend SPA de
**React**, Socket.IO para tiempo real. Sigue **Clean Architecture** — el dominio
no sabe nada de HTTP, de Prisma, ni de ningún motor específico.

### ¿Cómo añado un nuevo motor de torrents? {#how-do-i-add-a-new-torrent-engine}

Implementa la interfaz **`TorrentEngineProvider`** — la única costura que todo motor
implementa (añadir/quitar/iniciar/detener/reverificar/mover, prioridades de archivos, trackers, límites
de velocidad, estadísticas). **No hacen falta cambios de UI ni de lógica de negocio.** De eso se trata
precisamente la costura.

### ¿Cómo añado una fuente de metadatos / servidor de medios / notificador? {#how-do-i-add-a-metadata-source--media-server--notifier}

El mismo patrón. **Los proveedores son el mecanismo principal de extensibilidad**, y la regla es
explícita:

> Las integraciones futuras DEBEN añadirse como **nuevos proveedores** (nuevas implementaciones de una
> interfaz de proveedor, cableadas mediante una factoría/registro), **no** modificando módulos
> centrales.

Una nueva fuente de metadatos debería requerir **cero cambios** en los servicios que la consumen.

Ver [Referencia de módulos](/reference/modules).

### ¿Puedo autoalojar la documentación? {#can-i-self-host-the-docs}

Sí — el sitio es Docusaurus con un **índice de búsqueda local generado al construir** (sin Algolia,
sin clave API), así que funciona completamente **sin conexión / en redes aisladas**.

---

## ¿Sigues atascado? {#still-stuck}

1. Busca en esta página y en el [Glosario](/help/glossary).
2. Trabaja con [Resolución de problemas](/operate/troubleshooting) — está organizada por síntoma y
   construida a partir de incidentes reales.
3. Antes de abrir un issue, reúne:
   - `docker compose ps`
   - `docker compose logs --since 30m backend`
   - `docker inspect --format '{{.RestartCount}}' <container>`
   - `GET /api/system/version` (lo que **realmente** estás corriendo)
   - `GET /api/engines/health`
   - Si el fallo **depende de la carga** (bien con 10 torrents, roto con 700)

## Ver también {#see-also}

- [Resolución de problemas](/operate/troubleshooting) · [Glosario](/help/glossary)
- [Inicio rápido](/learn/quick-start) · [Conceptos](/learn/concepts) · [Primera descarga](/learn/first-download)
- [Seguridad](/operate/security) · [Rendimiento](/operate/performance) · [Respaldo](/operate/backup)
- [Perfiles de configuración](/operate/configuration-profiles)
- [API](/reference/api) · [Entorno](/reference/environment) · [Permisos](/reference/permissions)
