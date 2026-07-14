---
id: setup
title: Configuración local
sidebar_position: 2
description: Corre UltraTorrent desde el código fuente — instalación, generate/migrate/seed de Prisma, levantar el backend y el frontend, y los tropiezos que te van a morder.
keywords: [configuración, entorno de desarrollo, npm workspaces, prisma, seed, vite, nestjs, servidor de desarrollo]
---

# Configuración local

## Resumen

UltraTorrent es un monorepo de npm workspaces. `npm install` en la **raíz del repo** enlaza
los tres workspaces; luego generas el cliente de Prisma, migras, corres el seed y levantas el
backend (`:4000`) y el frontend (`:5173`) juntos.

## Propósito

Un ciclo de desarrollo que funcione: editar → hot reload → probar.

## Requisitos previos

| Requisito | Notas |
| --- | --- |
| **Node.js ≥ 20** | El `package.json` raíz declara `engines.node >= 20`. CI corre con Node 22. |
| **PostgreSQL** | El almacén. Lo más fácil es con Docker. |
| **Redis** | Caché / coordinación. También lo más fácil con Docker. |
| **Un motor de torrents** *(opcional)* | rTorrent o qBittorrent. La app corre bien sin ninguno — simplemente no tienes motor con quien hablar. |

La forma más rápida de tener Postgres + Redis es el stack de Compose de
[Instalación con Docker Compose](/install/docker-compose) — levanta la base de datos y el
caché, y luego corre la app desde el código fuente contra ellos.

## Paso a paso

### 1. Instalar

```bash
npm install                 # desde la RAÍZ del repo — enlaza todos los workspaces
```

Instala siempre desde la raíz. Instalar dentro de un workspace rompe los enlaces.

### 2. Configurar

Copia `.env.example` a `.env` y complétalo. Los valores que realmente necesitas para
desarrollo:

```bash
DATABASE_URL=postgresql://ultratorrent:PASSWORD@localhost:5432/ultratorrent?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379

# Existen valores por defecto de desarrollo para estos, y la app va a ADVERTIR
# (no fallar) si son débiles. En producción se niega a arrancar.
JWT_ACCESS_SECRET=
ENCRYPTION_KEY=

FILE_MANAGER_ROOTS=/path/to/your/downloads
```

La lista completa está en la [Referencia de entorno](/reference/environment).

### 3. Base de datos

```bash
npm run prisma:generate     # genera el cliente de Prisma
npm run prisma:migrate      # aplica las migraciones (prisma migrate deploy)
npm run prisma:seed         # permisos, roles, admin inicial, configuración
```

:::note `prisma:migrate` es `migrate deploy`
El script raíz `prisma:migrate` mapea a **`prisma migrate deploy`** — aplica las migraciones
existentes. Para *crear* una migración nueva durante el desarrollo, usa el script del
workspace:

```bash
npm run prisma:migrate:dev --workspace @ultratorrent/backend
```

Ver [Base de datos y Prisma](/develop/database).
:::

El seed es idempotente. Crea el super admin inicial a partir de
`ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` (por defecto: `admin` /
`admin@ultratorrent.local` / `changeme123!`) — y como cada escritura es un `upsert` con
`update: {}`, **volver a correr el seed no reinicia la contraseña de un admin existente**.

### 4. Correr

```bash
npm run dev                 # backend (4000) + frontend (5173) juntos
```

O por separado:

| Comando | Efecto |
| --- | --- |
| `npm run dev:backend` | `nest start --watch` |
| `npm run dev:frontend` | Servidor de desarrollo de Vite con `/api` + `/ws` proxeados a `:4000` |
| `npm run build` | construye `shared` → `backend` → `frontend`, en ese orden |
| `npm run lint` | ESLint en cada workspace que lo define (`--max-warnings 0`) |
| `npm run test` | Jest (backend) + Vitest (frontend) |

Luego:

- **App** — http://localhost:5173
- **API** — http://localhost:4000/api
- **Swagger** — http://localhost:4000/api/docs *(solo fuera de producción)*

## Cómo encaja el stack de desarrollo

```mermaid
flowchart LR
  DEV["Servidor de desarrollo de Vite<br/>:5173"] -->|"proxy /api"| API["NestJS<br/>:4000"]
  DEV -->|"proxy /ws (ws: true)"| API
  API --> PG[("PostgreSQL<br/>:5432")]
  API --> RD[("Redis<br/>:6379")]
  API -->|"SCGI / Web API"| ENG[("rTorrent /<br/>qBittorrent")]
  SH["packages/shared<br/>(construido o en watch)"] -.->|"tipos · permisos · eventos WS"| API
  SH -.-> DEV
```

## Tropiezos comunes

### El paquete shared tiene que estar construido

Este es el "¿por qué no aparece mi cambio?" más común de este repo. El backend y el frontend
consumen el paquete `@ultratorrent/shared` **construido o enlazado**. Cuando editas tipos,
permisos o nombres de eventos en shared, corre su build en modo watch:

```bash
npm run dev --workspace @ultratorrent/shared
```

…o reconstruye (`npm run build` desde la raíz) para que los otros dos recojan el cambio.

Fíjate en la asimetría: **las pruebas unitarias del backend no necesitan esto.** Jest mapea
`@ultratorrent/shared` directamente a `packages/shared/src/index.ts`, así que las pruebas ven
el código fuente vivo. Tu servidor de desarrollo corriendo, no.

### Que `tsc` pase limpio no significa que arranque

TypeScript y las pruebas unitarias **no** ejercitan la inyección de dependencias ni el
cableado de módulos de NestJS. Un provider faltante, un import circular o un manifest malo
solo fallan al arrancar. Antes de dar un cambio por terminado, **arranca un build limpio** —
un servidor de desarrollo corriendo desde un `dist/` viejo va a seguir sirviendo el código
anterior tan feliz.

### Un permiso nuevo necesita correr el seed otra vez

Añadir una clave a `packages/shared/src/permissions.ts` no crea la fila en la base de datos
que RBAC asigna. Vuelve a correr `npm run prisma:seed`. (Los permisos declarados en un
manifest *sí* se hacen upsert al arrancar mediante `ModulePermissionSyncService`, pero las
**concesiones a los roles** vienen del seed.)

### El gestor de archivos está confinado a sus raíces

`FILE_MANAGER_ROOTS` es una frontera dura. Cada ruta de archivo, torrent y medio se
canonicaliza (realpath) y se confina a ella — el path traversal, los escapes por enlaces
simbólicos y los directorios del sistema se rechazan. Si el escaneo de medios "no ve nada",
revisa esto primero.

### Indexadores auto-alojados en IPs privadas

El guard contra SSRF de la descarga de torrents bloquea cualquier URL `.torrent` que resuelva
a una dirección privada/interna. Un Prowlarr en la LAN devuelve exactamente ese tipo de
enlaces, así que las capturas fallan con *"Torrent URL resolves to a blocked internal
address"* — mientras que la **prueba de conexión sí pasa** (el health check confía en los
hosts privados; el guard de descarga es más estricto). Añade el host a `SSRF_ALLOW_HOSTS`.

## Solución de problemas

| Síntoma | Causa | Solución |
| --- | --- | --- |
| Advertencia al arrancar: `Insecure secrets (OK for dev, NOT production)` | `JWT_ACCESS_SECRET` / `ENCRYPTION_KEY` están sin definir, son débiles o son idénticos. | Está bien en desarrollo. Configúralos como corresponde antes de acercarte a producción. |
| `Refusing to start: insecure secret configuration` | Lo mismo, pero con `NODE_ENV=production`. | Define secretos fuertes y **distintos** de ≥32 caracteres. |
| Prisma: `P1001 Can't reach database server` | Postgres no está levantado, o `DATABASE_URL` está mal. | Revisa el contenedor/host y la URL. |
| Prisma: `P3009 migrate found failed migrations` | Una migración se interrumpió a medio camino. El backend va a quedar en bucle de reinicio. | Resuelve a mano la fila de la migración fallida. Y lee la regla de migraciones seguras en [Base de datos](/develop/database) — existe precisamente para prevenir esto. |
| `Cannot find module '@ultratorrent/shared'` | Instalaste dentro de un workspace en vez de en la raíz, o shared no está construido. | `npm install` en la raíz; construye shared. |
| El frontend carga pero cada llamada da 401 | No hay motor/base de datos, o el almacén de tokens está viejo. | Verifica que la API esté arriba; borra la clave `ultratorrent.auth` de localStorage. |
| El WS nunca conecta | El proxy de Vite necesita `ws: true` — ya lo tiene — pero el access token tiene que existir. | Inicia sesión primero; el socket conecta después de que `me()` resuelve. |
| El login siempre falla después de correr el seed | El seed **no** reinicia la contraseña de un admin existente. | Usa la contraseña original, o borra el usuario y corre el seed de nuevo. |

## Consejos

- **Swagger es tu campo de pruebas de la API.** `http://localhost:4000/api/docs` muestra cada
  ruta, la forma de cada DTO y el esquema bearer. Está deshabilitado en producción a
  propósito.
- **El bucle de sincronización de 2 segundos es hablador.** `TorrentSyncService` consulta cada
  motor cada 2s. Cuando estás depurando, eso es mucho ruido en los logs — y mucha evaluación
  de automatización.
- **Corre la prueba de paridad temprano.** Si tocas cadenas de la UI, `npm run test --workspace
  @ultratorrent/frontend` te dirá de inmediato si en-US y es-PR están de acuerdo.

## Preguntas frecuentes

**¿Puedo correr sin Redis?**
El stack lo espera para el caché y la coordinación. Levanta el servicio `redis` de Compose; es
un solo contenedor.

**¿Puedo correr sin un motor de torrents?**
Sí — simplemente no tienes ningún motor que añadir. Todo lo demás (medios, reglas de RSS,
usuarios, configuración) funciona. El feed de estado del motor reportará que está sin
conexión.

**¿De dónde saca el frontend la URL de la API?**
De `VITE_API_URL` (por defecto `http://localhost:4000/api`) y `VITE_WS_URL` (por defecto
`http://localhost:4000`). En desarrollo el proxy de Vite maneja ambas.

**¿Cómo reinicio todo?**
Bota la base de datos y vuelve a correr `prisma:migrate` + `prisma:seed`. No hay un script de
reinicio destructivo, deliberadamente.

## Lista de verificación

- [ ] Corriste `npm install` en la **raíz** del repo.
- [ ] `.env` tiene `DATABASE_URL`, el host/puerto de Redis y `FILE_MANAGER_ROOTS`.
- [ ] `prisma:generate` → `prisma:migrate` → `prisma:seed` corrieron sin errores.
- [ ] `npm run dev` sirve en :5173 y :4000.
- [ ] Puedes iniciar sesión como el admin inicial.
- [ ] Swagger se renderiza en `/api/docs`.

## Ver también

- [Referencia de entorno](/reference/environment) — todas las variables
- [Instalación con Docker Compose](/install/docker-compose)
- [Base de datos y Prisma](/develop/database)
- [Pruebas](/develop/testing)
- [Opera → Solución de problemas](/operate/troubleshooting)
