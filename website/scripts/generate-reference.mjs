#!/usr/bin/env node
/**
 * Generate the Reference section from the SOURCE OF TRUTH — never by hand.
 *
 * Everything here is derived from code that actually ships:
 *   • Permissions + role matrix  ← packages/shared (compiled exports, not a regex)
 *   • Module catalogue           ← module-registry manifests (compiled exports)
 *   • REST API                   ← the Nest controllers' own decorators
 *   • Environment variables      ← .env.example (with its own comments as docs)
 *   • Database schema            ← prisma/schema.prisma → Mermaid ER diagrams
 *
 * That means the reference cannot drift from the product, and cannot be
 * fabricated. If a page here is wrong, the code is wrong.
 *
 * Run: npm run gen:reference  (also runs automatically before `build`/`start`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..'); // repo root
const OUT = path.resolve(HERE, '../docs/reference');

const rel = (...p) => path.join(ROOT, ...p);

/**
 * The reference pages are generated from the application's *real* exports rather
 * than from regex-scraped TypeScript — that is what makes them impossible to drift.
 *
 * `@ultratorrent/shared` must therefore be compiled: it is the source of PERMISSIONS
 * and ROLE_PERMISSIONS, and it is a dependency of everything else here.
 */
if (!fs.existsSync(rel('packages/shared/dist/cjs/index.js'))) {
  console.error(
    `\nCannot generate the reference docs — @ultratorrent/shared has not been compiled.\n\n` +
      `  missing: packages/shared/dist/cjs/index.js\n\n` +
      `Build it first, from the repository root:\n\n` +
      `  npm run build --workspace @ultratorrent/shared\n\n` +
      `(If a build is already running, wait for it to finish — dist/ is rebuilt in place.)\n`,
  );
  process.exit(1);
}

/**
 * Load a TypeScript module for its *values*, without requiring the whole backend to
 * have been compiled first.
 *
 * The obvious approach — require() the backend's dist/ — means the docs can only be
 * built after a full `nest build`, which is a heavy dependency to take on for one
 * data file, and it is what stopped the docs from being buildable inside the frontend
 * image. So: prefer dist/ when it happens to be there (free, already compiled), and
 * otherwise bundle the source on the fly with esbuild. Either way we end up importing
 * real exports, never parsing them out of text.
 */
function loadTsModule({ dist, src }) {
  if (fs.existsSync(rel(dist))) return require(rel(dist));

  const esbuild = require(rel('node_modules/esbuild'));
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ut-docs-')),
    'module.cjs',
  );
  esbuild.buildSync({
    entryPoints: [rel(src)],
    outfile: out,
    bundle: true, // pulls @ultratorrent/shared in via the workspace symlink
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const mod = require(out);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return mod;
}

// ---------------------------------------------------------------------------
// Localisation
//
// The reference is GENERATED, so a hand-translated copy would silently rot the
// moment an endpoint or a permission changed. Instead the Spanish edition is
// emitted from the same run: the page's prose (headings, intros, table headers)
// is translated here, and the DATA — endpoint paths, permission strings, env var
// names, Prisma model and field names — is deliberately left alone, because it is
// code, not language.
//
// Order matters: longer phrases first, so a short one cannot eat a long one. A partial
// phrase placed before the full sentence it lives in will fire first and leave the rest
// of that sentence stranded in English, so full sentences go above the fragments.
//
// An entry's key may be a RegExp, which is how the count lines ("**88 models**") keep
// their numbers: the number is captured and re-emitted rather than hard-coded, so it
// tracks the source instead of rotting the next time a model is added.
// ---------------------------------------------------------------------------
const ES_OUT = path.resolve(HERE, '../i18n/es-PR/docusaurus-plugin-content-docs/current/reference');

const ES = [
  // --- front matter -------------------------------------------------------
  ['title: Permissions Reference', 'title: Referencia de permisos'],
  ['title: Module Reference', 'title: Referencia de módulos'],
  ['title: REST API Reference', 'title: Referencia de la API REST'],
  ['title: Environment Variables', 'title: Variables de entorno'],
  ['title: Database Schema', 'title: Esquema de la base de datos'],
  [
    'description: Every RBAC permission in UltraTorrent and which built-in role holds it.',
    'description: Cada permiso RBAC de UltraTorrent y qué rol integrado lo tiene.',
  ],
  [
    'description: Every UltraTorrent module, its tier, dependencies, permissions and routes.',
    'description: Cada módulo de UltraTorrent, su tier, dependencias, permisos y rutas.',
  ],
  [
    'description: Every REST endpoint UltraTorrent exposes, with its verb, path and required permission.',
    'description: Cada endpoint REST que expone UltraTorrent, con su verbo, ruta y permiso requerido.',
  ],
  [
    'description: Every environment variable UltraTorrent reads, its default, and what it does.',
    'description: Cada variable de entorno que lee UltraTorrent, su valor por defecto y para qué sirve.',
  ],
  [
    'description: Every Prisma model, its columns and relations, as entity-relationship diagrams.',
    'description: Cada modelo de Prisma, sus columnas y relaciones, como diagramas entidad-relación.',
  ],

  // --- the auto-generated banner -----------------------------------------
  [':::info Auto-generated', ':::info Generado automáticamente'],
  [
    '**Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.',
    '**No la edites a mano** — cambia la fuente y reconstruye. Esto garantiza que la referencia siempre coincida con el código que se publica.',
  ],
  ['This page is generated from', 'Esta página se genera desde'],
  ['at build time.', 'durante el build.'],

  // --- headings -----------------------------------------------------------
  ['# Permissions Reference', '# Referencia de permisos'],
  ['# Module Reference', '# Referencia de módulos'],
  ['# REST API Reference', '# Referencia de la API REST'],
  ['# Environment Variables', '# Variables de entorno'],
  ['# Database Schema', '# Esquema de la base de datos'],
  ['## How to read this', '## Cómo leer esto'],
  ['## Role summary', '## Resumen de roles'],
  ['## Dependency graph', '## Grafo de dependencias'],
  ['## All modules', '## Todos los módulos'],
  ['## All variables', '## Todas las variables'],
  ['## Authentication', '## Autenticación'],
  ['## Authorization', '## Autorización'],
  ['## Common status codes', '## Códigos de estado comunes'],
  ['## Client examples', '## Ejemplos de cliente'],
  ['## See also', '## Ver también'],

  // --- table headers ------------------------------------------------------
  ['| Method | Path | Permission | Handler |', '| Método | Ruta | Permiso | Handler |'],
  [
    '| Module | Id | Tier | On by default | Depends on |',
    '| Módulo | Id | Tier | Activo por defecto | Depende de |',
  ],
  ['| Role | Permissions held |', '| Rol | Permisos que tiene |'],
  [
    '| Variable | Default | Set by default | Description |',
    '| Variable | Por defecto | Definida por defecto | Descripción |',
  ],
  ['| Variable | Notes |', '| Variable | Notas |'],
  ['| Permission | Constant |', '| Permiso | Constante |'],

  // --- prose: whole paragraphs -------------------------------------------
  // These come first, and they are matched with the newlines the emitters actually
  // wrap at. A fragment of any of them appearing earlier in this table would break it.
  [
    'UltraTorrent uses **granular, dot-namespaced permissions**',
    'UltraTorrent usa **permisos granulares con espacios de nombres por punto**',
  ],
  ['Roles are\njust named sets of them.', 'Los roles son\nsimplemente conjuntos con nombre de esos permisos.'],
  [
    'Both the backend route guards (`@RequirePermissions`) and the\nfrontend capability checks read this same catalogue, so what you see here is exactly what\nis enforced.',
    'Tanto los guards de ruta del backend (`@RequirePermissions`) como las comprobaciones\nde capacidades del frontend leen este mismo catálogo, así que lo que ves aquí es\nexactamente lo que se aplica.',
  ],
  ['A **✅** means the role holds that permission out of the box.', 'Un **✅** significa que el rol tiene ese permiso de fábrica.'],
  [
    "- Roles are cumulative in practice but **not** by inheritance — each role's set is explicit,\n  so you can always see precisely what it can do.",
    '- Los roles son acumulativos en la práctica pero **no** por herencia — el conjunto de cada rol\n  es explícito, así que siempre puedes ver con precisión lo que puede hacer.',
  ],
  [
    '- Custom roles are built from the same catalogue. See [Access Control](/develop/rbac).',
    '- Los roles personalizados se construyen a partir del mismo catálogo. Ver [Control de acceso](/develop/rbac).',
  ],

  [
    'Every endpoint below was read from the controllers themselves, including the **exact\npermission** its guard enforces.',
    'Cada endpoint de abajo se leyó de los controladores mismos, incluyendo el **permiso\nexacto** que exige su guard.',
  ],
  [
    'the @Controller / @Get / @RequirePermissions decorators in apps/backend/src',
    'los decoradores @Controller / @Get / @RequirePermissions en apps/backend/src',
  ],
  ['All endpoints except', 'Todos los endpoints excepto'],
  ['require a **Bearer token**.', 'requieren un **Bearer token**.'],
  [
    'Access tokens are short-lived; use the refresh token to rotate. See [Authentication](/develop/authentication).',
    'Los access tokens son de vida corta — usa el refresh token para rotarlos. Ver [Autenticación](/develop/authentication).',
  ],
  [
    "Each endpoint declares a permission (the **Permission** column below). A token whose role\nlacks that permission gets **`403 Forbidden`**. The full catalogue is in the\n[Permissions Reference](/reference/permissions).",
    'Cada endpoint declara un permiso (la columna **Permiso** de abajo). Un token cuyo rol no\ntenga ese permiso recibe **`403 Forbidden`**. El catálogo completo está en la\n[Referencia de permisos](/reference/permissions).',
  ],

  [
    'UltraTorrent is built as a **module registry**.',
    'UltraTorrent está construido como un **registro de módulos**.',
  ],
  [
    'Each module declares a manifest — its id,\ntier, dependencies, the permissions it introduces and the API routes it owns. The registry\nresolves the dependency graph at boot and refuses to start on an unknown or circular\ndependency, so a broken module can never half-load.',
    'Cada módulo declara un manifiesto — su id,\ntier, dependencias, los permisos que introduce y las rutas de API que le pertenecen. El\nregistro resuelve el grafo de dependencias al arrancar y se niega a iniciar ante una\ndependencia desconocida o circular, así que un módulo roto nunca puede quedar a medio cargar.',
  ],
  [
    '- **Core** modules are always on. **Community/optional** modules can be toggled.',
    '- Los módulos **core** siempre están activos. Los módulos **community/opcionales** se pueden activar o desactivar.',
  ],

  [
    'UltraTorrent stores everything in **PostgreSQL**, managed by **Prisma**.',
    'UltraTorrent guarda todo en **PostgreSQL**, gestionado por **Prisma**.',
  ],
  [
    'There are\n**88 models**. A single ER diagram of all of them would be unreadable, so they are\ngrouped by domain below.',
    'Hay\n**88 modelos**. Un solo diagrama ER de todos sería ilegible, así que están\nagrupados por dominio más abajo.',
  ],
  [':::tip Never hand-edit the database', ':::tip Nunca edites la base de datos a mano'],
  [
    'Schema changes go through a Prisma migration so every install converges on the same shape.\nSee [Database & Prisma](/develop/database).',
    'Los cambios de esquema pasan por una migración de Prisma para que cada instalación converja\nen la misma forma. Ver [Base de datos y Prisma](/develop/database).',
  ],

  [
    'UltraTorrent is configured with environment variables (typically via `.env` next to your\n`docker-compose.yml`).',
    'UltraTorrent se configura con variables de entorno (típicamente vía `.env` junto a tu\n`docker-compose.yml`).',
  ],
  [':::warning Secrets', ':::warning Secretos'],
  [
    'Never commit a real `.env`. Rotate `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` if they leak —\ndoing so invalidates every issued token. See [Security](/operate/security).',
    'Nunca hagas commit de un `.env` real. Rota `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` si se\nfiltran — hacerlo invalida cada token ya emitido. Ver [Seguridad](/operate/security).',
  ],
  [
    'The backend **refuses to boot** in production if these are unset, left at a known default, or too weak.',
    'El backend **se niega a arrancar** en producción si estas están sin definir, quedan en un valor por defecto conocido, o son demasiado débiles.',
  ],
  ['Generate strong secrets:', 'Genera secretos fuertes:'],
  [
    'A **—** in _Set by default_ means the variable is commented out in `.env.example`: it is optional, and only needed for the case its description names (typically a manual, non-Docker install).',
    'Un **—** en _Definida por defecto_ significa que la variable está comentada en `.env.example`: es opcional, y solo hace falta para el caso que nombra su descripción (típicamente una instalación manual, sin Docker).',
  ],

  // --- more headings ------------------------------------------------------
  ['## Required in production', '## Requeridas en producción'],
  ['## Access control (RBAC)', '## Control de acceso (RBAC)'],
  ['## Account & security', '## Cuenta y seguridad'],
  ['## Torrent engine', '## Motor de torrents'],
  ['## Categories & tags', '## Categorías y etiquetas'],
  ['## RSS automation', '## Automatización RSS'],
  ['## File manager', '## Gestor de archivos'],
  ['## Notification Center', '## Centro de Notificaciones'],
  ['## Notifications', '## Notificaciones'],
  ['## Module registry', '## Registro de módulos'],
  ['## Media Acquisition Intelligence', '## Inteligencia de Adquisición de Medios'],
  ['## Media acquisition (Smart Download)', '## Adquisición de medios (Smart Download)'],
  ['## Media Server Analytics', '## Analíticas del Servidor de Medios'],
  ['## Media server analytics', '## Analíticas del servidor de medios'],
  ['## Media Manager', '## Gestor de Medios'],
  ['## Release Scoring', '## Puntuación de Releases'],
  ['## System health', '## Salud del sistema'],
  ['## Identity & audit', '## Identidad y auditoría'],
  ['## IMDb catalogue', '## Catálogo de IMDb'],
  ['## Audit log', '## Registro de auditoría'],
  ['## API keys', '## Claves API'],
  ['## Dashboard', '## Panel'],
  ['## Automation', '## Automatización'],
  ['## Indexers', '## Indexadores'],
  ['## Platform', '## Plataforma'],
  ['## Settings', '## Configuración'],
  ['## Search', '## Búsqueda'],
  ['## Users', '## Usuarios'],

  // --- status codes -------------------------------------------------------
  ['| Code | Meaning |', '| Código | Significado |'],
  ['| `200` / `201` | Success |', '| `200` / `201` | Éxito |'],
  ['| `400` | Validation failed (bad body/query) |', '| `400` | Falló la validación (body/query inválido) |'],
  ['| `401` | Missing or expired token |', '| `401` | Token ausente o expirado |'],
  [
    '| `403` | Token valid, but the role lacks the required permission |',
    '| `403` | Token válido, pero el rol no tiene el permiso requerido |',
  ],
  ['| `404` | Resource does not exist |', '| `404` | El recurso no existe |'],
  [
    '| `500` | Server error — check [logs](/operate/troubleshooting) |',
    '| `500` | Error del servidor — revisa los [logs](/operate/troubleshooting) |',
  ],

  // --- module entry labels ------------------------------------------------
  ['· enabled by default', '· activo por defecto'],
  ['· disabled by default', '· inactivo por defecto'],
  ['**Depends on:**', '**Depende de:**'],
  ['**Introduces permissions:**', '**Introduce permisos:**'],
  ['**Owns routes:**', '**Rutas propias:**'],
  ['Table: ', 'Tabla: '],

  // --- module descriptions (source: manifests.ts) -------------------------
  // Data, but prose data — a Spanish reader should not hit a wall of English here.
  // If one of these is reworded upstream its entry stops matching, and the leak
  // report below turns that from a silent revert-to-English into a build warning.
  [
    'Scan, identify, enrich, and organise your media libraries: library scanning, filename identification, metadata/artwork/subtitles, duplicate detection, NFO generation, rename/move for media servers, and a health dashboard.',
    'Escanea, identifica, enriquece y organiza tus bibliotecas de medios: escaneo de bibliotecas, identificación por nombre de archivo, metadatos/carátulas/subtítulos, detección de duplicados, generación de NFO, renombrado/movimiento para servidores de medios, y un panel de salud.',
  ],
  [
    'The centralized, provider-driven messaging platform. Every module publishes events; configurable rules decide if/when/how/to-whom notifications are delivered across Email, SMS, Telegram, WhatsApp and future providers — with templates, recipients, groups, a delivery queue, retries, quiet hours, dedup, escalation, and full delivery history.',
    'La plataforma de mensajería centralizada, basada en proveedores. Cada módulo publica eventos; reglas configurables deciden si/cuándo/cómo/a quién se entregan las notificaciones por Email, SMS, Telegram, WhatsApp y futuros proveedores — con plantillas, destinatarios, grupos, una cola de entrega, reintentos, horas de silencio, deduplicación, escalado, e historial completo de entregas.',
  ],
  [
    'Decides what media to acquire from library gaps, release quality, duplicate risk, watchlists, acquisition profiles, and automation context — explainable decisions, never direct file operations.',
    'Decide qué medios adquirir a partir de huecos en la biblioteca, calidad del release, riesgo de duplicados, listas de seguimiento, perfiles de adquisición y contexto de automatización — decisiones explicables, nunca operaciones directas sobre archivos.',
  ],
  [
    'Media server monitoring, analytics, recently-added, watch history, live activity, user/library statistics, scheduled newsletters, and Tautulli analytics import — across Plex, Jellyfin, Emby, and Kodi.',
    'Monitoreo y analíticas del servidor de medios, añadidos recientemente, historial de reproducción, actividad en vivo, estadísticas de usuarios/bibliotecas, boletines programados, e importación de analíticas de Tautulli — en Plex, Jellyfin, Emby y Kodi.',
  ],
  [
    'Explainable 0–100 scoring of RSS releases with reasons, warnings, and a recommendation.',
    'Puntuación explicable de 0 a 100 de los releases de RSS, con razones, advertencias y una recomendación.',
  ],
  [
    'Feeds, ranked match candidates, and the Smart Match Builder.',
    'Feeds, candidatos de coincidencia rankeados, y el Constructor de Coincidencias Inteligentes.',
  ],
  ['Engine provider abstraction (rTorrent) + registry.', 'Abstracción del proveedor de motor (rTorrent) + registro.'],
  ['Torrent list, detail, lifecycle, bulk actions.', 'Lista de torrents, detalle, ciclo de vida, acciones masivas.'],
  ['Organise torrents with categories and tags.', 'Organiza los torrents con categorías y etiquetas.'],
  ['Append-only audit trail of sensitive actions.', 'Rastro de auditoría de solo-anexado de las acciones sensibles.'],
  ['Aggregated stats and recent activity.', 'Estadísticas agregadas y actividad reciente.'],
  ['Search persisted torrent snapshots.', 'Busca en las instantáneas de torrents guardadas.'],
  ['Login, sessions, refresh-token rotation.', 'Inicio de sesión, sesiones, rotación del refresh token.'],
  ['Roles, permissions, and route guards.', 'Roles, permisos y guards de ruta.'],
  ['Self-service profile, password, and 2FA.', 'Perfil de autoservicio, contraseña y 2FA.'],
  ['User management and role assignment.', 'Gestión de usuarios y asignación de roles.'],
  ['Trigger/condition/action rule engine.', 'Motor de reglas de disparador/condición/acción.'],
  ['Path-safe browsing and file operations.', 'Navegación segura por rutas y operaciones de archivos.'],
  ['In-app feed + multi-channel fan-out.', 'Feed dentro de la app + difusión multicanal.'],
  ['Personal API key issue/list/revoke.', 'Emisión/listado/revocación de claves API personales.'],
  ['Liveness/readiness probes and health reporting.', 'Sondas de liveness/readiness e informes de salud.'],
  ['Key/value application settings.', 'Configuración de la aplicación en pares clave/valor.'],
  ['Enable/disable optional modules.', 'Activa/desactiva módulos opcionales.'],

  // --- env var descriptions (source: .env.example comments) ---------------
  [
    "Database (PostgreSQL) REQUIRED: set a strong, ALPHANUMERIC password (Compose won't start without it). For DOCKER installs this is the only DB value you need — the backend derives DATABASE_URL from POSTGRES_USER/PASSWORD/DB automatically.",
    'Base de datos (PostgreSQL) REQUERIDO: pon una contraseña fuerte y ALFANUMÉRICA (Compose no arranca sin ella). Para instalaciones con DOCKER este es el único valor de BD que necesitas — el backend deriva DATABASE_URL de POSTGRES_USER/PASSWORD/DB automáticamente.',
  ],
  [
    'Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER.',
    'Secretos de autenticación — REQUERIDOS en producción; genera cada uno con: openssl rand -base64 48 El backend SE NIEGA a arrancar en producción si están sin definir, en un valor por defecto conocido, o si tienen menos de 32 caracteres. JWT_ACCESS_SECRET y ENCRYPTION_KEY deben SER DISTINTOS.',
  ],
  [
    'Encrypts 2FA (TOTP) secrets at rest — REQUIRED, must be different from JWT_ACCESS_SECRET. Generate with: openssl rand -base64 48 Changing it invalidates stored TOTP secrets.',
    'Cifra en reposo los secretos de 2FA (TOTP) — REQUERIDO, debe ser distinto de JWT_ACCESS_SECRET. Genera con: openssl rand -base64 48 Cambiarlo invalida los secretos TOTP guardados.',
  ],
  [
    'Bootstrap super admin (used by the seed script) REQUIRED: set a strong password (only used to create the admin on first seed).',
    'Super admin inicial (usado por el script de seed) REQUERIDO: pon una contraseña fuerte (solo se usa para crear el admin en el primer seed).',
  ],
  [
    'DATABASE_URL: only needed for MANUAL (non-Docker) installs; point at your DB (host is usually localhost). Ignored by the Docker stack.',
    'DATABASE_URL: solo hace falta para instalaciones MANUALES (sin Docker); apúntala a tu BD (el host suele ser localhost). El stack de Docker la ignora.',
  ],
  [
    'Docker: host port the web UI is published on (change if 8080 is already in use — common on NAS devices). The backend is not published to the host.',
    'Docker: el puerto del host en el que se publica la interfaz web (cámbialo si 8080 ya está en uso — común en equipos NAS). El backend no se publica al host.',
  ],
  [
    "Run the bundled rtorrent (and thus downloaded files) as this user/group. Default 1000 matches the app. If your downloads folder is owned by another user (e.g. Plex), set these to that user's id/gid — find them with `id plex` — so downloads are written as that user without changing the folder's owner.",
    'Ejecuta el rtorrent incluido (y por tanto los archivos descargados) como este usuario/grupo. El valor por defecto 1000 coincide con la app. Si tu carpeta de descargas pertenece a otro usuario (por ejemplo Plex), pon aquí el id/gid de ese usuario — encuéntralos con `id plex` — para que las descargas se escriban como ese usuario sin cambiar el dueño de la carpeta.',
  ],
  [
    'Enable DHT on the bundled rtorrent (default off — this build can crash on a DHT internal_error; trackers + PEX still find peers). Set to on to enable.',
    'Activa DHT en el rtorrent incluido (por defecto off — esta build puede caerse con un internal_error de DHT; los trackers + PEX igual encuentran peers). Ponlo en on para activarlo.',
  ],
  [
    "Optional bundled qBittorrent engine (profile `qbittorrent`) — the sturdier alternative to rTorrent for large libraries. Enable with: docker compose --profile qbittorrent up -d Then grab the first-run temporary password from `docker compose logs qbittorrent`, set your own in the Web UI, and register the engine in UltraTorrent (Infrastructure → Engines → qBittorrent, base URL http://qbittorrent:8080). Host port the Web UI is published on (8080 is the frontend's, so this defaults to 8081):",
    'Motor qBittorrent incluido opcional (perfil `qbittorrent`) — la alternativa más robusta a rTorrent para bibliotecas grandes. Actívalo con: docker compose --profile qbittorrent up -d Luego saca la contraseña temporal del primer arranque con `docker compose logs qbittorrent`, pon la tuya en la interfaz web, y registra el motor en UltraTorrent (Infraestructura → Motores → qBittorrent, URL base http://qbittorrent:8080). El puerto del host en el que se publica la interfaz web (el 8080 es el del frontend, así que este usa 8081 por defecto):',
  ],
  [
    'Optional Prowlarr companion (indexer manager) — see docker-compose profile `prowlarr` and docs/PROWLARR.md. Prowlarr runs as a SEPARATE optional container; UltraTorrent only links to it. Enable with: docker compose --profile prowlarr up -d UltraTorrent boots fine without it. The API key is entered in the UI (Settings → Integrations → Prowlarr) and stored AES-GCM encrypted — never here. Host port the Prowlarr web UI is published on (change if 9696 is taken). Internal URL the backend uses to reach Prowlarr over the Docker network. Public URL the browser uses for the "Open Prowlarr" link / nav shortcut. Convenience default only; the real toggle lives in UltraTorrent settings.',
    'Compañero Prowlarr opcional (gestor de indexadores) — ver el perfil `prowlarr` de docker-compose y docs/PROWLARR.md. Prowlarr corre como un contenedor opcional SEPARADO; UltraTorrent solo enlaza con él. Actívalo con: docker compose --profile prowlarr up -d UltraTorrent arranca bien sin él. La clave API se introduce en la interfaz (Configuración → Integraciones → Prowlarr) y se guarda cifrada con AES-GCM — nunca aquí. El puerto del host en el que se publica la interfaz web de Prowlarr (cámbialo si el 9696 está ocupado). La URL interna que usa el backend para llegar a Prowlarr por la red de Docker. La URL pública que usa el navegador para el enlace "Abrir Prowlarr" / atajo de navegación. Solo un valor por defecto de conveniencia; el interruptor real vive en la configuración de UltraTorrent.',
  ],
  [
    'Optional FlareSolverr companion (indexer proxy) — see docker-compose profile `flaresolverr` and docs/PROWLARR.md. Solves Cloudflare anti-bot challenges for Prowlarr indexers (e.g. EZTV). Internal-only; Prowlarr reaches it at http://flaresolverr:8191. Enable with: docker compose --profile prowlarr --profile flaresolverr up -d',
    'Compañero FlareSolverr opcional (proxy de indexadores) — ver el perfil `flaresolverr` de docker-compose y docs/PROWLARR.md. Resuelve los retos anti-bot de Cloudflare para los indexadores de Prowlarr (por ejemplo EZTV). Solo interno; Prowlarr lo alcanza en http://flaresolverr:8191. Actívalo con: docker compose --profile prowlarr --profile flaresolverr up -d',
  ],
  [
    'SSRF allow-list for torrent fetches. Auto-downloads fetch the indexer\'s .torrent link over HTTP; the SSRF guard blocks any URL resolving to a private/internal address UNLESS its host is listed here (comma-separated hostnames, IPs, or IPv4 CIDRs). This is REQUIRED for any self-hosted indexer on a private IP — WITHOUT it, grabs fail with "Torrent URL resolves to a blocked internal address" and auto-downloads silently do nothing. Defaults to `prowlarr` (docker-compose.yml) so the bundled Prowlarr just works. Add your own indexer host and KEEP `prowlarr` if you use the bundled one: Leave unset for the `prowlarr` default; set empty for full SSRF protection.',
    'Lista de permitidos SSRF para las descargas de torrents. Las descargas automáticas piden el enlace .torrent del indexador por HTTP; el guard SSRF bloquea cualquier URL que resuelva a una dirección privada/interna A MENOS que su host esté listado aquí (nombres de host, IPs o CIDRs IPv4 separados por comas). Esto es REQUERIDO para cualquier indexador autoalojado en una IP privada — SIN esto, las capturas fallan con "Torrent URL resolves to a blocked internal address" y las descargas automáticas no hacen nada en silencio. Por defecto es `prowlarr` (docker-compose.yml) para que el Prowlarr incluido funcione sin más. Añade el host de tu propio indexador y CONSERVA `prowlarr` si usas el incluido: Déjalo sin definir para el valor por defecto `prowlarr`; ponlo vacío para protección SSRF completa.',
  ],
  [
    'Media metadata providers The IMDb provider needs NO environment variables: it is configured entirely from the UI (Media > Settings > IMDb) and works from user-provided IMDb datasets and/or an optional licensed IMDb API. UltraTorrent does not scrape IMDb web pages. The IMDb API base URL and key are stored in Settings (the key is AES-GCM encrypted at rest), never in this file. The optional keys below are ONLY fallbacks for cross-provider enrichment (TMDB /find and OMDb lookups by IMDb id). They are read only if the matching Settings value is unset. Leave blank to configure them in the UI instead.',
    'Proveedores de metadatos de medios El proveedor de IMDb NO necesita variables de entorno: se configura por completo desde la interfaz (Medios > Configuración > IMDb) y funciona con datasets de IMDb provistos por el usuario y/o una API licenciada de IMDb opcional. UltraTorrent no hace scraping de las páginas web de IMDb. La URL base y la clave de la API de IMDb se guardan en Configuración (la clave se cifra con AES-GCM en reposo), nunca en este archivo. Las claves opcionales de abajo son SOLO respaldos para el enriquecimiento entre proveedores (TMDB /find y búsquedas de OMDb por id de IMDb). Solo se leen si el valor correspondiente en Configuración está sin definir. Déjalas en blanco para configurarlas en la interfaz.',
  ],
  [
    'Timezone for bundled companion containers (e.g. Prowlarr). Any tz database name, e.g. America/New_York. Defaults to Etc/UTC.',
    'Zona horaria para los contenedores compañeros incluidos (por ejemplo Prowlarr). Cualquier nombre de la base de datos tz, por ejemplo America/New_York. Por defecto Etc/UTC.',
  ],
  [
    'File manager — comma-separated absolute roots the browser may access',
    'Gestor de archivos — raíces absolutas separadas por comas a las que el navegador puede acceder',
  ],
  ['Optional bundled rTorrent engine (see docker-compose)', 'Motor rTorrent incluido opcional (ver docker-compose)'],
  ['Redis (cache / BullMQ)', 'Redis (caché / BullMQ)'],
  ['Frontend (build-time)', 'Frontend (en tiempo de build)'],
  ['| Backend |', '| Backend |'],
  ['| Product |', '| Producto |'],

  // --- see also -----------------------------------------------------------
  ['- [Permissions Reference](/reference/permissions) — what each guard requires', '- [Referencia de permisos](/reference/permissions) — qué exige cada guard'],
  ['- [API Keys](/modules/api-keys) — non-interactive access', '- [Claves API](/modules/api-keys) — acceso no interactivo'],
  [
    '- [WebSocket events](/develop/websockets) — live updates instead of polling',
    '- [Eventos WebSocket](/develop/websockets) — actualizaciones en vivo en vez de sondeo',
  ],
  [
    '- [Access Control (RBAC) for developers](/develop/rbac) — how guards consume these',
    '- [Control de acceso (RBAC) para desarrolladores](/develop/rbac) — cómo los guards los consumen',
  ],
  ['- [Users & Roles](/modules/users) — assigning roles in the UI', '- [Usuarios y Roles](/modules/users) — asignar roles en la interfaz'],
  ['- [Security hardening](/operate/security)', '- [Endurecimiento de seguridad](/operate/security)'],
  ['- [Writing a module](/develop/creating-modules)', '- [Escribir un módulo](/develop/creating-modules)'],
  [
    '- [Backup & restore](/operate/backup) — dump and restore this database safely',
    '- [Copias de seguridad y restauración](/operate/backup) — vuelca y restaura esta base de datos de forma segura',
  ],
  ['- [Database & Prisma for developers](/develop/database)', '- [Base de datos y Prisma para desarrolladores](/develop/database)'],
  ['- [Docker Compose install](/install/docker-compose)', '- [Instalación con Docker Compose](/install/docker-compose)'],
  [
    '- [Configuration profiles](/operate/configuration-profiles) — home vs. large library vs. enterprise',
    '- [Perfiles de configuración](/operate/configuration-profiles) — hogar vs. biblioteca grande vs. empresa',
  ],
  ['[Permissions Reference](/reference/permissions)', '[Referencia de permisos](/reference/permissions)'],
  ['[REST API Reference](/reference/api)', '[Referencia de la API REST](/reference/api)'],

  // --- counts: keep the number, translate around it -----------------------
  [/\*\*(\d+) endpoints\*\* across \*\*(\d+) controllers\*\*/g, '**$1 endpoints** en **$2 controladores**'],
  [/\*\*(\d+) modules\*\* across tiers:/g, '**$1 módulos** en los tiers:'],
  [/\*\*(\d+) variables\*\* are recognised\./g, '**$1 variables** están reconocidas.'],
  [/^_1 model\._$/gm, '_1 modelo._'],
  [/^_(\d+) models\._$/gm, '_$1 modelos._'],
  ['Base URL:', 'URL base:'],
  ['# 1. Log in to get an access token', '# 1. Inicia sesión para obtener un access token'],
  ['# 2. Use it', '# 2. Úsalo'],

  // --- fragments: these must stay last ------------------------------------
  ['permissions** across', 'permisos** en'],
  ['built-in roles**', 'roles integrados**'],
  ['domains**', 'dominios**'],
];

// ---------------------------------------------------------------------------
// The leak report
//
// The table above is keyed by exact English strings, which makes it brittle in one
// specific direction: reword a module description in `manifests.ts` or add a variable
// to `.env.example`, and that entry simply stops matching — the line reverts to English
// and nothing says a word. So after translating, we read the Spanish page back and
// report anything that still parses as English prose. Silent rot becomes a loud build
// warning; DOCS_I18N_STRICT=1 makes it an error instead.
// ---------------------------------------------------------------------------
const EN_MARKERS =
  /\b(the|this|is|are|was|and|with|that|which|each|every|from|its|it|you|your|can|will|must|does|not|of|on|by|to|as|if|when|there|has|have|holds|reads|uses|built|change|check|see|never|always|only|both|across|lacks|requires|means)\b/gi;
const ES_MARKERS =
  /\b(el|la|los|las|un|una|de|del|que|para|con|sin|cada|todos|todas|desde|su|sus|puede|debe|hace|no|en|por|si|cuando|hay|tiene|usa|cambia|revisa|ver|nunca|siempre|solo|ambos|más|está|están|son|es|qué|cómo)\b/gi;

/** Descriptions that came verbatim from source, and so are the likeliest to rot. */
const SOURCE_PROSE = {
  'modules.md': (md) =>
    [...md.matchAll(/^`[a-z_]+` · tier `[a-z]+` · [^\n]*\n\n([^\n]+)$/gm)].map((m) => m[1]),
  'environment.md': (md) =>
    [...md.matchAll(/^\| `[A-Z0-9_]+` \|.*?\| ([^|]+?) \|$/gm)].map((m) => m[1].trim()),
};

function reportLeaks(file, english, spanish) {
  const leaks = [];

  // 1. Exact: a source-derived description that survived translation untouched.
  for (const d of SOURCE_PROSE[file]?.(english) ?? []) {
    if (d.length > 12 && spanish.includes(d)) leaks.push(`(untranslated source string) ${d}`);
  }

  // 2. Heuristic: any remaining line that reads more like English than Spanish.
  let fenced = false;
  spanish.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith('```')) return void (fenced = !fenced);
    if (fenced || !s) return;
    if (s.startsWith('import ') || /^(id|sidebar_position|keywords|slug):/.test(s)) return;
    if (/^\|[\s|:-]+\|$/.test(s)) return;
    const en = (s.match(EN_MARKERS) ?? []).length;
    const es = (s.match(ES_MARKERS) ?? []).length;
    if (en >= 2 && en > es) leaks.push(`${file}:${i + 1}  ${s.slice(0, 96)}`);
  });

  if (!leaks.length) return 0;
  console.warn(`  ⚠ ${file}: ${leaks.length} line(s) still in English — add them to the ES table:`);
  for (const l of [...new Set(leaks)]) console.warn(`      ${l}`);
  return leaks.length;
}

let esLeaks = 0;

/** Apply the table, then report anything that still reads as English prose. */
function toSpanish(file, md) {
  let out = md;
  for (const [en, es] of ES) {
    out = en instanceof RegExp ? out.replace(en, es) : out.split(en).join(es);
  }
  esLeaks += reportLeaks(file, md, out);
  return out;
}

const write = (file, body) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), body);
  console.log(`  ✓ reference/${file}  (${body.split('\n').length} lines)`);

  fs.mkdirSync(ES_OUT, { recursive: true });
  fs.writeFileSync(path.join(ES_OUT, file), toSpanish(file, body));
};

const BANNER = (source) =>
  `:::info Auto-generated\nThis page is generated from \`${source}\` at build time. **Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.\n:::\n`;

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

/** `media_manager` → `media_manager["media_manager"]`, safe for a Mermaid graph. */
const mermaidNode = (id) =>
  `${String(id).replace(/[^A-Za-z0-9_]/g, '_')}["${String(id).replace(/"/g, '')}"]`;

// ---------------------------------------------------------------------------
// 1. Permissions + role matrix
// ---------------------------------------------------------------------------
function genPermissions() {
  const shared = require(rel('packages/shared/dist/cjs/index.js'));
  const { PERMISSIONS, ROLE_PERMISSIONS } = shared;
  const roles = Object.keys(ROLE_PERMISSIONS);
  const perms = Object.entries(PERMISSIONS); // [CONST, 'dotted.value']

  // Group by domain (the bit before the first dot) so the table is navigable.
  const byDomain = new Map();
  for (const [constName, value] of perms) {
    const domain = String(value).split('.')[0];
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ constName, value });
  }

  const has = (role, value) => (ROLE_PERMISSIONS[role] ?? []).includes(value);

  let md = `---
id: permissions
title: Permissions Reference
sidebar_position: 2
description: Every RBAC permission in UltraTorrent and which built-in role holds it.
keywords: [permissions, rbac, roles, access control, authorization, security]
---

# Permissions Reference

${BANNER('packages/shared/src/permissions.ts')}
UltraTorrent uses **granular, dot-namespaced permissions** (\`domain.action\`). Roles are
just named sets of them. Both the backend route guards (\`@RequirePermissions\`) and the
frontend capability checks read this same catalogue, so what you see here is exactly what
is enforced.

- **${perms.length} permissions** across **${byDomain.size} domains**
- **${roles.length} built-in roles**

## How to read this

- A **✅** means the role holds that permission out of the box.
- Roles are cumulative in practice but **not** by inheritance — each role's set is explicit,
  so you can always see precisely what it can do.
- Custom roles are built from the same catalogue. See [Access Control](/develop/rbac).

## Role summary

| Role | Permissions held |
| --- | --- |
${roles.map((r) => `| \`${r}\` | ${(ROLE_PERMISSIONS[r] ?? []).length} of ${perms.length} |`).join('\n')}

`;

  for (const [domain, list] of [...byDomain.entries()].sort()) {
    md += `## \`${domain}\`\n\n| Permission | Constant | ${roles.map((r) => r.replace(/_/g, ' ')).join(' | ')} |\n| --- | --- | ${roles.map(() => ':---:').join(' | ')} |\n`;
    for (const { constName, value } of list) {
      md += `| \`${esc(value)}\` | \`${constName}\` | ${roles.map((r) => (has(r, value) ? '✅' : '—')).join(' | ')} |\n`;
    }
    md += '\n';
  }

  md += `## See also

- [Access Control (RBAC) for developers](/develop/rbac) — how guards consume these
- [Users & Roles](/modules/users) — assigning roles in the UI
- [Security hardening](/operate/security)
`;
  write('permissions.md', md);
  return { count: perms.length, roles: roles.length };
}

// ---------------------------------------------------------------------------
// 2. Module catalogue
// ---------------------------------------------------------------------------
function genModules() {
  const m = loadTsModule({
    dist: 'apps/backend/dist/modules/module-registry/manifests.js',
    src: 'apps/backend/src/modules/module-registry/manifests.ts',
  });
  const manifests = [
    ...(m.CORE_MANIFESTS ?? []),
    ...(m.COMMUNITY_MANIFESTS ?? []),
    ...(m.OPTIONAL_MANIFESTS ?? []),
  ];

  const tiers = [...new Set(manifests.map((x) => x.tier))];

  let md = `---
id: modules
title: Module Reference
sidebar_position: 3
description: Every UltraTorrent module, its tier, dependencies, permissions and routes.
keywords: [modules, registry, manifest, dependencies, core, community]
---

# Module Reference

${BANNER('apps/backend/src/modules/module-registry/manifests.ts')}
UltraTorrent is built as a **module registry**. Each module declares a manifest — its id,
tier, dependencies, the permissions it introduces and the API routes it owns. The registry
resolves the dependency graph at boot and refuses to start on an unknown or circular
dependency, so a broken module can never half-load.

- **${manifests.length} modules** across tiers: ${tiers.map((t) => `\`${t}\``).join(', ')}
- **Core** modules are always on. **Community/optional** modules can be toggled.

## Dependency graph

\`\`\`mermaid
graph LR
${manifests
  .flatMap((x) =>
    // A module id is not necessarily a valid Mermaid node id (dots, dashes), and a
    // *quoted* bare id is a syntax error — so declare a sanitised node with the real
    // id as its label.
    (x.dependencies ?? []).map((d) => `  ${mermaidNode(d)} --> ${mermaidNode(x.id)}`),
  )
  .join('\n') || '  none[No declared dependencies]'}
\`\`\`

## All modules

| Module | Id | Tier | On by default | Depends on |
| --- | --- | --- | :---: | --- |
${manifests
  .map(
    (x) =>
      `| **${esc(x.name)}** | \`${esc(x.id)}\` | ${esc(x.tier)} | ${x.enabledByDefault ? '✅' : '—'} | ${(x.dependencies ?? []).map((d) => `\`${d}\``).join(', ') || '—'} |`,
  )
  .join('\n')}

`;

  for (const x of manifests) {
    md += `## ${esc(x.name)}\n\n\`${esc(x.id)}\` · tier \`${esc(x.tier)}\`${x.enabledByDefault ? ' · enabled by default' : ' · optional'}\n\n${esc(x.description ?? '')}\n\n`;
    if (x.dependencies?.length)
      md += `**Depends on:** ${x.dependencies.map((d) => `\`${d}\``).join(', ')}\n\n`;
    if (x.permissions?.length)
      md += `**Introduces permissions:** ${x.permissions.map((p) => `\`${p}\``).join(', ')}\n\n`;
    if (x.routes?.length) md += `**Owns routes:** ${x.routes.map((r) => `\`${r}\``).join(', ')}\n\n`;
  }

  md += `## See also

- [Permissions Reference](/reference/permissions)
- [REST API Reference](/reference/api)
- [Writing a module](/develop/creating-modules)
`;
  write('modules.md', md);
  return { count: manifests.length };
}

// ---------------------------------------------------------------------------
// 3. REST API — parsed from the controllers' own decorators
// ---------------------------------------------------------------------------
const HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

function parseController(file) {
  const src = fs.readFileSync(file, 'utf8');
  const base = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/.exec(src)?.[1] ?? '';
  const className = /export class (\w+)/.exec(src)?.[1] ?? path.basename(file);
  const classPerm = /@RequirePermissions\(([^)]*)\)[\s\S]{0,200}?export class/.exec(src)?.[1];

  const endpoints = [];
  const methodRe = new RegExp(`@(${HTTP.join('|')})\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`, 'g');
  let m;
  while ((m = methodRe.exec(src))) {
    const verb = m[1].toUpperCase();
    const sub = m[2] ?? '';
    // Look ahead a little for @RequirePermissions and the handler name.
    const after = src.slice(m.index, m.index + 600);
    const perms = [...after.matchAll(/@RequirePermissions\(([^)]*)\)/g)]
      .slice(0, 1)
      .flatMap((p) =>
        p[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    const handler = /\n\s*(?:async\s+)?(\w+)\s*\(/.exec(after.replace(/@[\w]+\([^)]*\)/g, ''))?.[1];
    // JSDoc directly above the decorator, if any.
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const doc = /\/\*\*([\s\S]*?)\*\/\s*(?:@[\s\S]*)?$/.exec(before)?.[1];
    const summary = doc
      ? doc
          .split('\n')
          .map((l) => l.replace(/^\s*\*ings?\s?/, '').replace(/^\s*\*\s?/, '').trim())
          .filter((l) => l && !l.startsWith('@'))
          .join(' ')
          .trim()
      : '';

    const full = ['/api', base, sub].filter(Boolean).join('/').replace(/\/+/g, '/');
    endpoints.push({ verb, path: full, perms, handler, summary });
  }
  return { className, base, classPerm, endpoints };
}

function genApi() {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.controller.ts')) files.push(p);
    }
  })(rel('apps/backend/src'));

  const controllers = files.map(parseController).sort((a, b) => a.base.localeCompare(b.base));
  const total = controllers.reduce((n, c) => n + c.endpoints.length, 0);

  let md = `---
id: api
title: REST API Reference
sidebar_position: 1
description: Every REST endpoint UltraTorrent exposes, with its verb, path and required permission.
keywords: [api, rest, endpoints, curl, javascript, python, powershell, authentication, bearer]
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# REST API Reference

${BANNER('the @Controller / @Get / @RequirePermissions decorators in apps/backend/src')}
Every endpoint below was read from the controllers themselves, including the **exact
permission** its guard enforces.

- **${total} endpoints** across **${controllers.length} controllers**
- Base URL: \`http://<host>:<port>/api\`

## Authentication

All endpoints except \`/api/auth/login\` require a **Bearer token**.

\`\`\`bash
# 1. Log in to get an access token
curl -s -X POST http://localhost:8080/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"admin","password":"<password>"}'
# → { "accessToken": "eyJ...", "refreshToken": "..." }

# 2. Use it
curl -s http://localhost:8080/api/torrents \\
  -H 'Authorization: Bearer eyJ...'
\`\`\`

Access tokens are short-lived; use the refresh token to rotate. See [Authentication](/develop/authentication).

## Authorization

Each endpoint declares a permission (the **Permission** column below). A token whose role
lacks that permission gets **\`403 Forbidden\`**. The full catalogue is in the
[Permissions Reference](/reference/permissions).

## Common status codes

| Code | Meaning |
| --- | --- |
| \`200\` / \`201\` | Success |
| \`400\` | Validation failed (bad body/query) |
| \`401\` | Missing or expired token |
| \`403\` | Token valid, but the role lacks the required permission |
| \`404\` | Resource does not exist |
| \`500\` | Server error — check [logs](/operate/troubleshooting) |

## Client examples

<Tabs>
<TabItem value="curl" label="cURL">

\`\`\`bash
curl -s http://localhost:8080/api/torrents -H "Authorization: Bearer $TOKEN"
\`\`\`

</TabItem>
<TabItem value="ts" label="TypeScript">

\`\`\`ts
const res = await fetch('http://localhost:8080/api/torrents', {
  headers: { Authorization: \`Bearer \${token}\` },
});
if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`);
const torrents = await res.json();
\`\`\`

</TabItem>
<TabItem value="py" label="Python">

\`\`\`python
import requests
r = requests.get(
    "http://localhost:8080/api/torrents",
    headers={"Authorization": f"Bearer {token}"},
    timeout=30,
)
r.raise_for_status()
torrents = r.json()
\`\`\`

</TabItem>
<TabItem value="ps" label="PowerShell">

\`\`\`powershell
$headers = @{ Authorization = "Bearer $Token" }
Invoke-RestMethod -Uri "http://localhost:8080/api/torrents" -Headers $headers
\`\`\`

</TabItem>
</Tabs>

`;

  for (const c of controllers) {
    if (!c.endpoints.length) continue;
    md += `## \`/${c.base}\`\n\nFrom \`${c.className}\`.\n\n| Method | Path | Permission | Handler |\n| --- | --- | --- | --- |\n`;
    for (const e of c.endpoints) {
      const perms = e.perms.length
        ? e.perms.map((p) => `\`${esc(p.replace(/^P(ERMISSIONS)?\./, ''))}\``).join(', ')
        : '—';
      md += `| \`${e.verb}\` | \`${esc(e.path)}\` | ${perms} | \`${esc(e.handler ?? '')}\` |\n`;
    }
    md += '\n';
  }

  md += `## See also

- [Permissions Reference](/reference/permissions) — what each guard requires
- [API Keys](/modules/api-keys) — non-interactive access
- [WebSocket events](/develop/websockets) — live updates instead of polling
`;
  write('api.md', md);
  return { total, controllers: controllers.length };
}

// ---------------------------------------------------------------------------
// 4. Environment variables (comments in .env.example become the docs)
// ---------------------------------------------------------------------------
function genEnv() {
  const src = fs.readFileSync(rel('.env.example'), 'utf8');

  // `.env.example` is written as blank-line-delimited BLOCKS: a comment block
  // documents the variables that follow it. A `# KEY=value` line is a variable
  // that is deliberately left unset (optional / manual installs only). Parsing it
  // any other way conflates a section heading with a variable's description.
  const blocks = src
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trimEnd()).filter(Boolean))
    .filter((b) => b.length);

  const vars = [];
  for (const block of blocks) {
    if (block.every((l) => /^#\s*-{5,}/.test(l) || /^#/.test(l)) && !block.some((l) => /^#\s*[A-Z0-9_]+=/.test(l))) {
      continue; // pure banner/divider block with no variables
    }
    const doc = block
      .filter((l) => l.startsWith('#') && !/^#\s*-{5,}/.test(l) && !/^#\s*[A-Z0-9_]+=/.test(l))
      .map((l) => l.replace(/^#\s?/, '').trim())
      .join(' ')
      .trim();

    for (const l of block) {
      const set = /^([A-Z0-9_]+)=(.*)$/.exec(l);
      const unset = /^#\s*([A-Z0-9_]+)=(.*)$/.exec(l);
      if (set) vars.push({ key: set[1], val: set[2], doc, optional: false });
      else if (unset) vars.push({ key: unset[1], val: unset[2], doc, optional: true });
    }
  }

  // A block's comment applies to every variable in it, so "REQUIRED" alone would
  // over-flag (e.g. JWT_ACCESS_TTL=15m sits under the auth-secrets comment but
  // ships a working default). A variable is only truly required if its block says
  // so AND it has no default you can fall back on.
  const required = (v) => /\bREQUIRED\b/i.test(v.doc) && !v.val && !v.optional;
  const total = vars.length;

  let md = `---
id: environment
title: Environment Variables
sidebar_position: 4
description: Every environment variable UltraTorrent reads, its default, and what it does.
keywords: [environment, env, configuration, docker, compose, settings, secrets]
---

# Environment Variables

${BANNER('.env.example')}
UltraTorrent is configured with environment variables (typically via \`.env\` next to your
\`docker-compose.yml\`). **${total} variables** are recognised.

:::warning Secrets
Never commit a real \`.env\`. Rotate \`JWT_ACCESS_SECRET\` / \`JWT_REFRESH_SECRET\` if they leak —
doing so invalidates every issued token. See [Security](/operate/security).
:::

`;

  const req = vars.filter(required);
  if (req.length) {
    md += `## Required in production\n\nThe backend **refuses to boot** in production if these are unset, left at a known default, or too weak.\n\n| Variable | Notes |\n| --- | --- |\n`;
    for (const v of req) md += `| \`${esc(v.key)}\` | ${esc(v.doc)} |\n`;
    md += `\nGenerate strong secrets:\n\n\`\`\`bash\nopenssl rand -base64 48   # run once per secret — they must differ\n\`\`\`\n\n`;
  }

  md += `## All variables\n\n| Variable | Default | Set by default | Description |\n| --- | --- | :---: | --- |\n`;
  for (const v of vars) {
    md += `| \`${esc(v.key)}\` | ${v.val ? `\`${esc(v.val)}\`` : '_(empty)_'} | ${v.optional ? '—' : '✅'} | ${esc(v.doc) || '—'} |\n`;
  }
  md += `\nA **—** in _Set by default_ means the variable is commented out in \`.env.example\`: it is optional, and only needed for the case its description names (typically a manual, non-Docker install).\n\n`;

  md += `## See also

- [Docker Compose install](/install/docker-compose)
- [Configuration profiles](/operate/configuration-profiles) — home vs. large library vs. enterprise
`;
  write('environment.md', md);
  return { total };
}

// ---------------------------------------------------------------------------
// 5. Database schema → Mermaid ER
// ---------------------------------------------------------------------------
function genSchema() {
  const src = fs.readFileSync(rel('apps/backend/prisma/schema.prisma'), 'utf8');
  const models = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    const map = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const fields = [];
    const relations = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const f = /^(\w+)\s+(\S+)/.exec(t);
      if (!f) continue;
      const [, fname, ftypeRaw] = f;
      const ftype = ftypeRaw.replace(/[?[\]]/g, '');
      const isRel = /^[A-Z]/.test(ftype) && !['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt'].includes(ftype);
      if (isRel) relations.push({ to: ftype, field: fname, many: ftypeRaw.includes('[]') });
      else fields.push({ name: fname, type: ftypeRaw });
    }
    models.push({ name, map, fields, relations });
  }

  // The full 88-model ER diagram is unreadable in one image, so group by domain.
  const domain = (n) => {
    if (/^IMDb/.test(n)) return 'IMDb catalogue';
    if (/^Media(Server|Provider)/.test(n)) return 'Media server analytics';
    if (/^MediaAcquisition|^Wanted/.test(n)) return 'Media acquisition (Smart Download)';
    if (/^Media/.test(n)) return 'Media Manager';
    if (/^Rss|^TvShowStatus/.test(n)) return 'RSS';
    if (/^Notification/.test(n)) return 'Notification Center';
    if (/^Torrent|^Tracker|^Peer/.test(n)) return 'Torrents';
    if (/^User|^Role|^Session|^ApiKey|^Audit|^TwoFactor/.test(n)) return 'Identity & audit';
    if (/^Automation/.test(n)) return 'Automation';
    if (/^Indexer/.test(n)) return 'Indexers';
    return 'Platform';
  };
  const byDomain = new Map();
  for (const mo of models) {
    const d = domain(mo.name);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(mo);
  }

  let md = `---
id: database-schema
title: Database Schema
sidebar_position: 5
description: Every Prisma model, its columns and relations, as entity-relationship diagrams.
keywords: [database, schema, prisma, postgres, models, er diagram, migrations]
---

# Database Schema

${BANNER('apps/backend/prisma/schema.prisma')}
UltraTorrent stores everything in **PostgreSQL**, managed by **Prisma**. There are
**${models.length} models**. A single ER diagram of all of them would be unreadable, so they are
grouped by domain below.

:::tip Never hand-edit the database
Schema changes go through a Prisma migration so every install converges on the same shape.
See [Database & Prisma](/develop/database).
:::

`;

  for (const [d, list] of [...byDomain.entries()].sort()) {
    md += `## ${d}\n\n_${list.length} model${list.length === 1 ? '' : 's'}._\n\n\`\`\`mermaid\nerDiagram\n`;
    const names = new Set(list.map((x) => x.name));
    for (const mo of list) {
      for (const r of mo.relations) {
        if (!names.has(r.to)) continue; // keep the diagram inside the domain
        md += `  ${mo.name} ${r.many ? '||--o{' : '}o--||'} ${r.to} : "${r.field}"\n`;
      }
    }
    md += '\`\`\`\n\n';
    for (const mo of list) {
      md += `### \`${mo.name}\`\n\nTable: \`${mo.map}\`\n\n| Column | Type |\n| --- | --- |\n`;
      for (const f of mo.fields.slice(0, 40)) md += `| \`${esc(f.name)}\` | \`${esc(f.type)}\` |\n`;
      md += '\n';
    }
  }

  md += `## See also

- [Backup & restore](/operate/backup) — dump and restore this database safely
- [Database & Prisma for developers](/develop/database)
`;
  write('database-schema.md', md);
  return { models: models.length };
}

// ---------------------------------------------------------------------------
console.log('Generating reference docs from source…');
const p = genPermissions();
const mo = genModules();
const a = genApi();
const e = genEnv();
const s = genSchema();
console.log(
  `\nDone: ${a.total} endpoints · ${p.count} permissions × ${p.roles} roles · ${mo.count} modules · ${e.total} env vars · ${s.models} DB models`,
);
