---
id: environment
title: Variables de entorno
sidebar_position: 4
description: Cada variable de entorno que lee UltraTorrent, su valor por defecto y para qué sirve.
keywords: [environment, env, configuration, docker, compose, settings, secrets]
---

# Variables de entorno

:::info Generado automáticamente
Esta página se genera desde `.env.example` durante el build. **No la edites a mano** — cambia la fuente y reconstruye. Esto garantiza que la referencia siempre coincida con el código que se publica.
:::

UltraTorrent se configura con variables de entorno (típicamente vía `.env` junto a tu
`docker-compose.yml`). **38 variables** están reconocidas.

:::warning Secretos
Nunca hagas commit de un `.env` real. Rota `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` si se
filtran — hacerlo invalida cada token ya emitido. Ver [Seguridad](/operate/security).
:::

## Requeridas en producción

El backend **se niega a arrancar** en producción si estas están sin definir, quedan en un valor por defecto conocido, o son demasiado débiles.

| Variable | Notas |
| --- | --- |
| `POSTGRES_PASSWORD` | Base de datos (PostgreSQL) REQUERIDO: pon una contraseña fuerte y ALFANUMÉRICA (Compose no arranca sin ella). Para instalaciones con DOCKER este es el único valor de BD que necesitas — el backend deriva DATABASE_URL de POSTGRES_USER/PASSWORD/DB automáticamente. |
| `JWT_ACCESS_SECRET` | Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS. |
| `JWT_REFRESH_SECRET` | Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS. |
| `ENCRYPTION_KEY` | Cifra en reposo los secretos de 2FA (TOTP) — REQUERIDO, debe ser distinto de JWT_ACCESS_SECRET. Genera con: openssl rand -base64 48 Cambiarlo invalida los secretos TOTP guardados. |
| `ADMIN_PASSWORD` | Super admin inicial (usado por el script de seed) REQUERIDO: pon una contraseña fuerte (solo se usa para crear el admin en el primer seed). |

Genera secretos fuertes:

```bash
openssl rand -base64 48   # run once per secret — they must differ
```

## Todas las variables

| Variable | Por defecto | Definida por defecto | Descripción |
| --- | --- | :---: | --- |
| `PRODUCT_NAME` | `UltraTorrent` | ✅ | Producto |
| `PORT` | `4000` | ✅ | Backend |
| `NODE_ENV` | `production` | ✅ | Backend |
| `CORS_ORIGIN` | `http://localhost:5173` | ✅ | Backend |
| `FRONTEND_PORT` | `8080` | ✅ | Docker: el puerto del host en el que se publica la interfaz web (cámbialo si 8080 ya está en uso — común en equipos NAS). El backend no se publica al host. |
| `POSTGRES_USER` | `ultratorrent` | ✅ | Base de datos (PostgreSQL) REQUERIDO: pon una contraseña fuerte y ALFANUMÉRICA (Compose no arranca sin ella). Para instalaciones con DOCKER este es el único valor de BD que necesitas — el backend deriva DATABASE_URL de POSTGRES_USER/PASSWORD/DB automáticamente. |
| `POSTGRES_PASSWORD` | _(empty)_ | ✅ | Base de datos (PostgreSQL) REQUERIDO: pon una contraseña fuerte y ALFANUMÉRICA (Compose no arranca sin ella). Para instalaciones con DOCKER este es el único valor de BD que necesitas — el backend deriva DATABASE_URL de POSTGRES_USER/PASSWORD/DB automáticamente. |
| `POSTGRES_DB` | `ultratorrent` | ✅ | Base de datos (PostgreSQL) REQUERIDO: pon una contraseña fuerte y ALFANUMÉRICA (Compose no arranca sin ella). Para instalaciones con DOCKER este es el único valor de BD que necesitas — el backend deriva DATABASE_URL de POSTGRES_USER/PASSWORD/DB automáticamente. |
| `DATABASE_URL` | `postgresql://ultratorrent:REPLACE_WITH_PASSWORD@localhost:5432/ultratorrent?schema=public` | — | DATABASE_URL: solo hace falta para instalaciones MANUALES (sin Docker); apúntala a tu BD (el host suele ser localhost). El stack de Docker la ignora. |
| `REDIS_HOST` | `redis` | ✅ | Redis (caché / BullMQ) |
| `REDIS_PORT` | `6379` | ✅ | Redis (caché / BullMQ) |
| `JWT_ACCESS_SECRET` | _(empty)_ | ✅ | Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS. |
| `JWT_REFRESH_SECRET` | _(empty)_ | ✅ | Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS. |
| `JWT_ACCESS_TTL` | `15m` | ✅ | Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS. |
| `JWT_REFRESH_TTL_DAYS` | `30` | ✅ | Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS. |
| `ENCRYPTION_KEY` | _(empty)_ | ✅ | Cifra en reposo los secretos de 2FA (TOTP) — REQUERIDO, debe ser distinto de JWT_ACCESS_SECRET. Genera con: openssl rand -base64 48 Cambiarlo invalida los secretos TOTP guardados. |
| `ADMIN_USERNAME` | `admin` | ✅ | Super admin inicial (usado por el script de seed) REQUERIDO: pon una contraseña fuerte (solo se usa para crear el admin en el primer seed). |
| `ADMIN_EMAIL` | `admin@ultratorrent.local` | ✅ | Super admin inicial (usado por el script de seed) REQUERIDO: pon una contraseña fuerte (solo se usa para crear el admin en el primer seed). |
| `ADMIN_PASSWORD` | _(empty)_ | ✅ | Super admin inicial (usado por el script de seed) REQUERIDO: pon una contraseña fuerte (solo se usa para crear el admin en el primer seed). |
| `FILE_MANAGER_ROOTS` | `/downloads` | ✅ | Gestor de archivos — raíces absolutas separadas por comas a las que el navegador puede acceder |
| `TMDB_API_KEY` | _(empty)_ | — | Proveedores de metadatos de medios El proveedor de IMDb NO necesita variables de entorno: se configura por completo desde la interfaz (Medios > Configuración > IMDb) y funciona con datasets de IMDb provistos por el usuario y/o una API licenciada de IMDb opcional. UltraTorrent no hace scraping de las páginas web de IMDb. La URL base y la clave de la API de IMDb se guardan en Configuración (la clave se cifra con AES-GCM en reposo), nunca en este archivo. Las claves opcionales de abajo son SOLO respaldos para el enriquecimiento entre proveedores (TMDB /find y búsquedas de OMDb por id de IMDb). Solo se leen si el valor correspondiente en Configuración está sin definir. Déjalas en blanco para configurarlas en la interfaz. |
| `OMDB_API_KEY` | _(empty)_ | — | Proveedores de metadatos de medios El proveedor de IMDb NO necesita variables de entorno: se configura por completo desde la interfaz (Medios > Configuración > IMDb) y funciona con datasets de IMDb provistos por el usuario y/o una API licenciada de IMDb opcional. UltraTorrent no hace scraping de las páginas web de IMDb. La URL base y la clave de la API de IMDb se guardan en Configuración (la clave se cifra con AES-GCM en reposo), nunca en este archivo. Las claves opcionales de abajo son SOLO respaldos para el enriquecimiento entre proveedores (TMDB /find y búsquedas de OMDb por id de IMDb). Solo se leen si el valor correspondiente en Configuración está sin definir. Déjalas en blanco para configurarlas en la interfaz. |
| `VITE_API_URL` | `http://localhost:4000/api` | ✅ | Frontend (en tiempo de build) |
| `VITE_WS_URL` | `http://localhost:4000` | ✅ | Frontend (en tiempo de build) |
| `RTORRENT_SCGI_HOST` | `rtorrent` | ✅ | Motor rTorrent incluido opcional (ver docker-compose) |
| `RTORRENT_SCGI_PORT` | `5000` | ✅ | Motor rTorrent incluido opcional (ver docker-compose) |
| `PUID` | `1000` | — | Ejecuta el rtorrent incluido (y por tanto los archivos descargados) como este usuario/grupo. El valor por defecto 1000 coincide con la app. Si tu carpeta de descargas pertenece a otro usuario (por ejemplo Plex), pon aquí el id/gid de ese usuario — encuéntralos con `id plex` — para que las descargas se escriban como ese usuario sin cambiar el dueño de la carpeta. |
| `PGID` | `1000` | — | Ejecuta el rtorrent incluido (y por tanto los archivos descargados) como este usuario/grupo. El valor por defecto 1000 coincide con la app. Si tu carpeta de descargas pertenece a otro usuario (por ejemplo Plex), pon aquí el id/gid de ese usuario — encuéntralos con `id plex` — para que las descargas se escriban como ese usuario sin cambiar el dueño de la carpeta. |
| `RT_DHT` | `off` | — | Activa DHT en el rtorrent incluido (por defecto off — esta build puede caerse con un internal_error de DHT; los trackers + PEX igual encuentran peers). Ponlo en on para activarlo. |
| `QBITTORRENT_PORT` | `8081` | ✅ | Motor qBittorrent incluido opcional (perfil `qbittorrent`) — la alternativa más robusta a rTorrent para bibliotecas grandes. Actívalo con: docker compose --profile qbittorrent up -d Luego saca la contraseña temporal del primer arranque con `docker compose logs qbittorrent`, pon la tuya en la interfaz web, y registra el motor en UltraTorrent (Infraestructura → Motores → qBittorrent, URL base http://qbittorrent:8080). El puerto del host en el que se publica la interfaz web (el 8080 es el del frontend, así que este usa 8081 por defecto): |
| `TZ` | `Etc/UTC` | — | Zona horaria para los contenedores compañeros incluidos (por ejemplo Prowlarr). Cualquier nombre de la base de datos tz, por ejemplo America/New_York. Por defecto Etc/UTC. |
| `PROWLARR_PORT` | `9696` | ✅ | Compañero Prowlarr opcional (gestor de indexadores) — ver el perfil `prowlarr` de docker-compose y docs/PROWLARR.md. Prowlarr corre como un contenedor opcional SEPARADO; UltraTorrent solo enlaza con él. Actívalo con: docker compose --profile prowlarr up -d UltraTorrent arranca bien sin él. La clave API se introduce en la interfaz (Configuración → Integraciones → Prowlarr) y se guarda cifrada con AES-GCM — nunca aquí. El puerto del host en el que se publica la interfaz web de Prowlarr (cámbialo si el 9696 está ocupado). La URL interna que usa el backend para llegar a Prowlarr por la red de Docker. La URL pública que usa el navegador para el enlace "Abrir Prowlarr" / atajo de navegación. Solo un valor por defecto de conveniencia; el interruptor real vive en la configuración de UltraTorrent. |
| `PROWLARR_BASE_URL` | `http://prowlarr:9696` | ✅ | Compañero Prowlarr opcional (gestor de indexadores) — ver el perfil `prowlarr` de docker-compose y docs/PROWLARR.md. Prowlarr corre como un contenedor opcional SEPARADO; UltraTorrent solo enlaza con él. Actívalo con: docker compose --profile prowlarr up -d UltraTorrent arranca bien sin él. La clave API se introduce en la interfaz (Configuración → Integraciones → Prowlarr) y se guarda cifrada con AES-GCM — nunca aquí. El puerto del host en el que se publica la interfaz web de Prowlarr (cámbialo si el 9696 está ocupado). La URL interna que usa el backend para llegar a Prowlarr por la red de Docker. La URL pública que usa el navegador para el enlace "Abrir Prowlarr" / atajo de navegación. Solo un valor por defecto de conveniencia; el interruptor real vive en la configuración de UltraTorrent. |
| `PROWLARR_PUBLIC_URL` | `http://localhost:9696` | ✅ | Compañero Prowlarr opcional (gestor de indexadores) — ver el perfil `prowlarr` de docker-compose y docs/PROWLARR.md. Prowlarr corre como un contenedor opcional SEPARADO; UltraTorrent solo enlaza con él. Actívalo con: docker compose --profile prowlarr up -d UltraTorrent arranca bien sin él. La clave API se introduce en la interfaz (Configuración → Integraciones → Prowlarr) y se guarda cifrada con AES-GCM — nunca aquí. El puerto del host en el que se publica la interfaz web de Prowlarr (cámbialo si el 9696 está ocupado). La URL interna que usa el backend para llegar a Prowlarr por la red de Docker. La URL pública que usa el navegador para el enlace "Abrir Prowlarr" / atajo de navegación. Solo un valor por defecto de conveniencia; el interruptor real vive en la configuración de UltraTorrent. |
| `PROWLARR_ENABLED` | `false` | ✅ | Compañero Prowlarr opcional (gestor de indexadores) — ver el perfil `prowlarr` de docker-compose y docs/PROWLARR.md. Prowlarr corre como un contenedor opcional SEPARADO; UltraTorrent solo enlaza con él. Actívalo con: docker compose --profile prowlarr up -d UltraTorrent arranca bien sin él. La clave API se introduce en la interfaz (Configuración → Integraciones → Prowlarr) y se guarda cifrada con AES-GCM — nunca aquí. El puerto del host en el que se publica la interfaz web de Prowlarr (cámbialo si el 9696 está ocupado). La URL interna que usa el backend para llegar a Prowlarr por la red de Docker. La URL pública que usa el navegador para el enlace "Abrir Prowlarr" / atajo de navegación. Solo un valor por defecto de conveniencia; el interruptor real vive en la configuración de UltraTorrent. |
| `SSRF_ALLOW_HOSTS` | `prowlarr,indexer.lan,10.0.0.0/24` | — | Lista de permitidos SSRF para las descargas de torrents. Las descargas automáticas piden el enlace .torrent del indexador por HTTP; el guard SSRF bloquea cualquier URL que resuelva a una dirección privada/interna A MENOS que su host esté listado aquí (nombres de host, IPs o CIDRs IPv4 separados por comas). Esto es REQUERIDO para cualquier indexador autoalojado en una IP privada — SIN esto, las capturas fallan con "Torrent URL resolves to a blocked internal address" y las descargas automáticas no hacen nada en silencio. Por defecto es `prowlarr` (docker-compose.yml) para que el Prowlarr incluido funcione sin más. Añade el host de tu propio indexador y CONSERVA `prowlarr` si usas el incluido: Déjalo sin definir para el valor por defecto `prowlarr`; ponlo vacío para protección SSRF completa. |
| `SSRF_ALLOW_HOSTS` | `prowlarr` | — | Lista de permitidos SSRF para las descargas de torrents. Las descargas automáticas piden el enlace .torrent del indexador por HTTP; el guard SSRF bloquea cualquier URL que resuelva a una dirección privada/interna A MENOS que su host esté listado aquí (nombres de host, IPs o CIDRs IPv4 separados por comas). Esto es REQUERIDO para cualquier indexador autoalojado en una IP privada — SIN esto, las capturas fallan con "Torrent URL resolves to a blocked internal address" y las descargas automáticas no hacen nada en silencio. Por defecto es `prowlarr` (docker-compose.yml) para que el Prowlarr incluido funcione sin más. Añade el host de tu propio indexador y CONSERVA `prowlarr` si usas el incluido: Déjalo sin definir para el valor por defecto `prowlarr`; ponlo vacío para protección SSRF completa. |
| `FLARESOLVERR_LOG_LEVEL` | `info` | — | Compañero FlareSolverr opcional (proxy de indexadores) — ver el perfil `flaresolverr` de docker-compose y docs/PROWLARR.md. Resuelve los retos anti-bot de Cloudflare para los indexadores de Prowlarr (por ejemplo EZTV). Solo interno; Prowlarr lo alcanza en http://flaresolverr:8191. Actívalo con: docker compose --profile prowlarr --profile flaresolverr up -d |

Un **—** en _Definida por defecto_ significa que la variable está comentada en `.env.example`: es opcional, y solo hace falta para el caso que nombra su descripción (típicamente una instalación manual, sin Docker).

## Ver también

- [Instalación con Docker Compose](/install/docker-compose)
- [Perfiles de configuración](/operate/configuration-profiles) — hogar vs. biblioteca grande vs. empresa
