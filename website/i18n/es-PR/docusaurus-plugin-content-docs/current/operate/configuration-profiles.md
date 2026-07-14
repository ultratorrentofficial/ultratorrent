---
id: configuration-profiles
title: Perfiles de configuración
sidebar_position: 7
description: Configuraciones de UltraTorrent probadas y confiables para cada tamaño de despliegue — perfiles Predeterminado, Servidor doméstico pequeño, Biblioteca de medios grande, Alta disponibilidad, Empresarial, Rendimiento y Seguridad, con ajustes concretos.
keywords:
  - configuración
  - perfiles
  - ajustes
  - ajustes recomendados
  - servidor pequeño
  - biblioteca grande
  - alta disponibilidad
  - HA
  - empresarial
  - perfil de rendimiento
  - perfil de seguridad
  - Raspberry Pi
  - NAS
  - Synology
  - QNAP
  - dimensionamiento
  - arquitectura de referencia
  - configuración de ejemplo
  - .env example
---

# Perfiles de configuración {#configuration-profiles}

Siete configuraciones opinadas y probadas. Encuentra la que corresponde a tu
despliegue, aplícala y sigue adelante.

Cada perfil es un **punto de partida**, no una camisa de fuerza — pero cada uno está
construido a partir de lo que de verdad ha funcionado (y de lo que de verdad se ha
roto) en despliegues reales.

## Propósito {#purpose}

Ahorrarte el ensayo y error. La mayoría de las preguntas de ajuste tienen una
respuesta correcta una vez sabes qué tan grande es el despliegue y para qué sirve.

## Cómo elegir un perfil {#choosing-a-profile}

```mermaid
flowchart TD
    A{"¿Qué estás corriendo?"} --> B{"¿Cuántos torrents,<br/>y qué tan grande la biblioteca?"}
    B -->|"< 50 torrents<br/>< 500 elementos de medios"| SMALL["Servidor doméstico pequeño"]
    B -->|"cientos de torrents<br/>miles de elementos"| LARGE["Biblioteca de medios grande"]
    B -->|"solo lo estoy probando"| DEF["Predeterminado"]

    A --> C{"¿Requisito especial?"}
    C -->|"no puede caerse"| HA["Alta disponibilidad"]
    C -->|"multiusuario, auditado,<br/>menor privilegio"| ENT["Empresarial"]
    C -->|"funciona, pero va lento"| PERF["Rendimiento"]
    C -->|"expuesto a internet"| SEC["Seguridad"]

    style SMALL fill:#2e7d32,color:#fff
    style LARGE fill:#f9a825,color:#000
    style HA fill:#1565c0,color:#fff
    style ENT fill:#6a1b9a,color:#fff
    style SEC fill:#c62828,color:#fff
```

| Perfil | Para | Lo único que de verdad importa |
|---------|-----|----------------------------|
| [Predeterminado](#default) | Evaluar, primera instalación | Configurar bien los secretos |
| [Servidor doméstico pequeño](#small-home-server) | Un Pi, un NAS, una mini-PC | Mantenlo liviano; aquí rTorrent está bien |
| [Biblioteca de medios grande](#large-media-library) | Cientos de torrents, miles de elementos | **Usa qBittorrent, no rTorrent** |
| [Alta disponibilidad](#high-availability) | No puede caerse | Postgres externo + backups de verdad |
| [Empresarial](#enterprise) | Muchos usuarios, requisitos de auditoría | RBAC + 2FA + revisión de auditoría |
| [Rendimiento](#performance) | Funciona pero va lento | Índices trigram + ajuste de Postgres |
| [Seguridad](#security) | Expuesto a internet | No publiques nada que no tengas que publicar |

---

## Predeterminado {#default}

La configuración que viene de fábrica. Sensata, segura y sin opiniones fuertes —
esto es lo que obtienes de `cp .env.example .env`.

**Úsalo cuando:** estás instalando por primera vez o evaluando.

```dotenv
# --- Requerido. El stack SE NIEGA a arrancar sin esto. ---------------------
POSTGRES_PASSWORD=<strong ALPHANUMERIC password>
ADMIN_PASSWORD=<strong password>

# Genera cada uno por separado con: openssl rand -base64 48
JWT_ACCESS_SECRET=<48+ random chars>
JWT_REFRESH_SECRET=<48+ random chars>
ENCRYPTION_KEY=<48+ random chars — MUST DIFFER from JWT_ACCESS_SECRET>

# --- Valores predeterminados sensatos -------------------------------------
NODE_ENV=production
PORT=4000
FRONTEND_PORT=8080
CORS_ORIGIN=http://localhost:8080

POSTGRES_USER=ultratorrent
POSTGRES_DB=ultratorrent
REDIS_HOST=redis
REDIS_PORT=6379

JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=30

FILE_MANAGER_ROOTS=/downloads
SSRF_ALLOW_HOSTS=prowlarr

ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@ultratorrent.local

PUID=1000
PGID=1000
TZ=Etc/UTC
```

```bash
docker compose --profile qbittorrent up -d --build
docker compose exec backend npx prisma db seed
```

:::warning Las cuatro reglas que impiden que el backend arranque
1. `JWT_ACCESS_SECRET` y `ENCRYPTION_KEY` deben tener cada uno **32+ caracteres**.
2. Deben ser **diferentes entre sí**.
3. Ninguno puede ser un valor por defecto tipo `dev-*` / `change-me`.
4. `POSTGRES_PASSWORD` debe ser **alfanumérica** (va incrustada en una URL).

Esto se valida. Si el backend arranca en producción, es porque las cumpliste.
:::

**Lista de verificación**
- [ ] Los tres secretos generados con `openssl rand -base64 48`
- [ ] `ENCRYPTION_KEY` ≠ `JWT_ACCESS_SECRET`
- [ ] Contraseña del admin sembrado cambiada tras el primer inicio de sesión
- [ ] `.env` respaldado fuera del host

---

## Servidor doméstico pequeño {#small-home-server}

Una Raspberry Pi 4/5, un NAS Synology/QNAP, una laptop vieja, una mini-PC. CPU
modesto, 2–4 GB de RAM, un puñado de usuarios.

**Úsalo cuando:** tienes menos de ~50 torrents activos y una biblioteca de unos
cientos de elementos.

```dotenv
# Empieza desde Predeterminado, y luego:

# La UI de administración del NAS normalmente ocupa el 8080.
FRONTEND_PORT=8123
CORS_ORIGIN=http://nas.local:8123

# Sé dueño de los medios como el usuario que ya los posee (p. ej. Plex).
# Encuéntralo con: id plex
PUID=1000
PGID=1000
TZ=America/New_York

# Mantén ajustado el límite del gestor de archivos.
FILE_MANAGER_ROOTS=/downloads

# Sesiones más largas — es una LAN de confianza, y volver a iniciar sesión molesta.
JWT_ACCESS_TTL=30m
JWT_REFRESH_TTL_DAYS=60
```

**Motor: el rTorrent incluido funciona perfectamente bien a este tamaño.** Su bug de
fallos depende de la carga y es prácticamente invisible por debajo de ~100 torrents
(un host con 7 torrents tuvo **cero** fallos en el mismo periodo en que un host con
752 torrents falló 44 veces).

```bash
docker compose --profile rtorrent up -d --build
```

**Sáltate el catálogo de IMDb** a menos que necesites la detección de episodios
faltantes. Son 8.9 millones de filas y es opcional. Si *sí* lo importas, presupuesta
la RAM y deja que los índices trigram terminen de construirse antes de escanear.

:::tip Detalles del NAS que te costarán una hora
- **El puerto 8080 normalmente está ocupado.** Configura `FRONTEND_PORT`. **No**
  intentes reasignarlo con un override de Compose — Compose *añade* `ports`, así que
  el mapeo original sobrevive y sigue en conflicto.
- **Synology DSM elimina `SETUID`/`SETGID`** de las capacidades por defecto del
  container, lo que rompe la bajada de privilegios de rTorrent y hace que corra como
  **root** (así que las descargas quedan con dueño root). El archivo Compose incluido
  las vuelve a añadir con `cap_add: ["SETUID", "SETGID"]`. No borres esa línea.
- **¿Los medios son de otra app?** No les hagas `chown`. Configura `PUID`/`PGID` con
  *ese* usuario (`id plex`) para que las descargas se escriban como él.
:::

**Lista de verificación**
- [ ] `FRONTEND_PORT` configurado a un puerto libre
- [ ] `PUID`/`PGID` coinciden con quien debe ser dueño de los medios
- [ ] `cap_add: ["SETUID","SETGID"]` sigue presente (Synology)
- [ ] Perfil de rTorrent habilitado
- [ ] Catálogo de IMDb omitido, o importado a propósito

---

## Biblioteca de medios grande {#large-media-library}

De cientos a miles de torrents. Miles de elementos de medios. El catálogo de IMDb
importado. Aquí es donde viven las fallas interesantes.

**Úsalo cuando:** pasas de ~100 torrents activos, o de ~2,000 elementos de medios.

### La única decisión que importa: **no uses rTorrent** {#the-one-decision-that-matters-do-not-use-rtorrent}

```dotenv
# Empieza desde Predeterminado, y luego:
QBITTORRENT_PORT=8081
```

```bash
docker compose --profile qbittorrent up -d
docker compose logs qbittorrent | grep -i password   # contraseña temporal del primer arranque
```

Regístralo en **Infraestructura → Motores** (tipo qBittorrent, URL base
`http://qbittorrent:8080`).

:::danger rTorrent 0.9.8 tiene un bug de fallos, dependiente de la carga, que no tiene arreglo
`internal_error: priority_queue_insert(...)` se dispara durante la programación del
anuncio al tracker. **No tiene solución en la línea 0.9.8**, y escala con tu cantidad
de torrents. Mediciones reales de dos hosts corriendo el mismo build:

| Torrents | Fallos |
|----------|--------|
| **7** | **0** |
| **752** | **44 en 4 días** (~10/día) |

qBittorrent maneja miles de torrents sin problema. Múdate antes de sentirlo, no
después.
:::

Si la prueba de conexión de qBittorrent falla con 401: desactiva **Enable Host header
validation** en **Options → Web UI** (el backend se conecta por el nombre del servicio
`qbittorrent`, en el que qBittorrent no confía por defecto).

### La segunda decisión: **cada indexador necesita un `minSeeders`** {#the-second-decision-every-indexer-needs-a-minseeders}

Esto no es un lujo. El filtro de seeders por indexador **solo aplica cuando la columna
está configurada** — así que un indexador sin `minSeeders` te entrega lanzamientos con
0 seeders, y:

> **Un magnet con 0 seeders nunca puede obtener sus metadatos — y aun así el motor lo
> cuenta como una descarga activa todo el tiempo que lo intenta.**

El resultado real fue un motor sosteniendo **1,137 torrents y moviendo 0 bytes**:
**1,114 de ellos tenían cero seeders**, y con `max_active_downloads: 100`, exactamente
**88 `metaDL` + 12 `stalledDL` = 100 espacios** quedaron ocupados permanentemente por
torrents que nunca iban a terminar. Los 1,034 saludables quedaron en cola detrás de
ellos.

Configura `minSeeders` en **cada** indexador, y **habilita la cola de estacionamiento**
(viene deshabilitada — pausa los torrents muertos para que dejen de ocupar espacios, y
luego periódicamente los fuerza a arrancar para volver a revisar si aparecieron
seeders).

### La tercera decisión: **índices trigram** {#the-third-decision-trigram-indexes}

Con el catálogo de IMDb de 8.9 millones de filas, las búsquedas `ILIKE` sin índices GIN
trigram toman **47.8 segundos cada una** y **dejarán a Postgres sin recursos hasta que
los escaneos nunca terminen**. Con ellos: **180 ms**.

Los builds actuales los construyen automáticamente en tiempo de ejecución. **Verifica**
que sean válidos:

```sql
SELECT c.relname, i.indisvalid
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname LIKE '%trgm%';   -- todos deben ser `t`
```

Ver [Rendimiento](/operate/performance).

**Lista de verificación**
- [ ] **qBittorrent**, no rTorrent
- [ ] `minSeeders` configurado en **cada** indexador
- [ ] Cola de estacionamiento habilitada
- [ ] Los tres índices trigram existen **y son válidos**
- [ ] Postgres tiene 4 GB+ y `random_page_cost` reducido para SSD
- [ ] Los escaneos no corren en paralelo con la importación de IMDb

---

## Alta disponibilidad {#high-availability}

El tiempo fuera de servicio es inaceptable. Seamos honestos: UltraTorrent es una
**aplicación de instancia única** — el backend no está diseñado para escalar
horizontalmente detrás de un balanceador de carga (los cuerpos de las tareas corren
en proceso; una segunda instancia duplicaría el trabajo programado). Aquí, HA
significa **recuperación rápida y confiable**, no activo-activo.

**Úsalo cuando:** necesitas un objetivo de tiempo de recuperación estricto.

```dotenv
# Apunta a un Postgres EXTERNO, gestionado y replicado — el cambio de HA más
# valioso que puedes hacer.
DATABASE_URL=postgresql://ultratorrent:PASSWORD@postgres.internal:5432/ultratorrent?schema=public

# Redis también puede ser externo, pero no guarda estado durable — perderlo es barato.
REDIS_HOST=redis.internal
REDIS_PORT=6379
```

### La arquitectura de HA {#the-ha-architecture}

```mermaid
flowchart TD
    subgraph edge["Borde"]
        LB["Proxy inverso / TLS"]
    end
    subgraph app["Host de la app — REEMPLAZABLE"]
        BE["backend + frontend<br/>(instancia única)"]
    end
    subgraph state["Estado — REPLICADO"]
        PG[("PostgreSQL gestionado<br/>replicación en streaming<br/>PITR")]
        NAS[("Medios en NAS / RAID")]
    end
    subgraph backup["Fuera del host"]
        BK[("pg_dump nocturno<br/>+ .env en un almacén de secretos")]
    end

    LB --> BE
    BE --> PG
    BE --> NAS
    PG -.nocturno.-> BK

    style PG fill:#2e7d32,color:#fff
    style BK fill:#1565c0,color:#fff
```

El host de la app se vuelve **ganado**: si muere, lo reconstruyes desde el repositorio,
restauras el `.env`, lo apuntas a la misma base de datos, y ya estás de vuelta.

### Lo que de verdad te compra disponibilidad {#what-actually-buys-you-availability}

| Haz esto | Por qué |
|---------|-----|
| **Postgres externo y replicado** con recuperación a un punto en el tiempo | Es el *único* componente irreemplazable |
| **`.env` en un almacén de secretos** | Sin `ENCRYPTION_KEY`, restaurar la base de datos es media restauración |
| **Medios en un NAS/RAID**, no locales al container | Desacopla tus medios del host de la app |
| **`restart: unless-stopped`** en todo | Ya es el valor por defecto. Es lo que hace sobrevivibles los fallos de rTorrent |
| **Monitorea `/api/system/ready`**, no solo `/live` | `/live` dice que el proceso existe; `/ready` dice que sus dependencias son usables |
| **Un simulacro de restauración ensayado** | Tu RTO es una adivinanza hasta que lo hayas medido |
| **Alerta sobre `RestartCount`** | Detecta un bucle de fallos que `docker compose ps` esconde |

### Sondas de salud {#health-probes}

```bash
# Liveness — ¿el proceso está vivo? (esto es lo que usa el healthcheck del container)
curl -f http://localhost:8080/api/system/live || echo DOWN

# Readiness — ¿sus dependencias son usables?
curl -f http://localhost:8080/api/system/ready || echo NOT_READY
```

:::caution Aún sin verificar
Correr UltraTorrent detrás de un balanceador de carga con **múltiples réplicas del
backend** no ha sido validado, y el modelo de tareas en proceso significa que el
trabajo programado muy probablemente se **duplicaría** entre instancias. Trata las
múltiples réplicas como no soportadas hasta que se demuestre lo contrario.
:::

**Lista de verificación**
- [ ] Postgres es externo, replicado, con PITR
- [ ] El `.env` está en un almacén de secretos, no solo en el host
- [ ] Los medios viven en almacenamiento redundante
- [ ] `/api/system/ready` está monitoreado y alerta
- [ ] `RestartCount` está monitoreado
- [ ] El simulacro de restauración se ha corrido **y cronometrado** (ese es tu RTO real)
- [ ] Solo corre **una** instancia del backend

---

## Empresarial {#enterprise}

Muchos usuarios, roles de verdad, un requisito de auditoría.

**Úsalo cuando:** UltraTorrent se comparte más allá de un hogar.

```dotenv
# Empieza desde Predeterminado + Seguridad, y luego:

# Sesiones más cortas.
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=7

# El origen exacto de producción. Nunca `*`.
CORS_ORIGIN=https://ultratorrent.corp.example.com

# Estrecha el límite duro de archivos a exactamente lo que el motor escribe.
FILE_MANAGER_ROOTS=/downloads/media

# Confía solo en los indexadores que de verdad corres.
SSRF_ALLOW_HOSTS=prowlarr
```

### Roles, en la práctica {#roles-applied}

Asigna el **menor** rol que haga el trabajo:

| Persona | Rol | Cuidado con |
|--------|------|---------------|
| Tú | `SUPER_ADMIN` | El único rol que puede otorgar `SUPER_ADMIN`. Dáselo a la menor cantidad de gente posible. |
| Un coadministrador | `ADMINISTRATOR` | Todo **excepto** `system.manage`. |
| Alguien que administra sus propios medios | `POWER_USER` | ⚠️ Incluye **todos** los `files.*` — **eliminar, acciones en masa y limpieza incluidos**. |
| Un usuario común | `USER` | Archivos de solo lectura. Seguro. |
| Alguien que solo mira el panel | `READ_ONLY` | Solo ver. |

:::warning `POWER_USER` puede borrar tus archivos
Tiene todos los permisos `files.*`, incluyendo `files.delete` y `files.cleanup`. Si eso
no es lo que quieres, crea un rol personalizado. Nota también que
`torrents.delete_data` (elimina los datos **del disco**) es un permiso **aparte** de
`torrents.delete` — otórgalos por separado.
:::

La plataforma aplica por ti las protecciones contra escalación: solo un `SUPER_ADMIN`
puede otorgar `SUPER_ADMIN`, **ningún usuario puede editar sus propios roles**,
desactivar a un usuario **revoca sus refresh tokens de inmediato**, y las acciones en
masa requieren el **mismo permiso que su ruta dedicada** — así que quien solo puede ver
no puede colar una operación destructiva por `/torrents/bulk`.

### Prácticas obligatorias {#mandatory-practices}

- **2FA en cada cuenta de administrador.** La inscripción es *confirmada*, no a ciegas —
  un usuario debe probar que posee un código válido antes de que se active, así que nadie
  se queda fuera por accidente. Guarda los **10 códigos de recuperación de un solo uso**.
- **Revisa el registro de auditoría mensualmente.** Registra los inicios de sesión
  fallidos *con el nombre de usuario intentado*, cada acción destructiva, los cambios de
  rol y los cambios de configuración — y ahora **nombra el medio** al que apuntaba cada
  fila en lugar de mostrar un id opaco.
- **Claves API, no contraseñas compartidas**, para el acceso de máquinas.

**Lista de verificación**
- [ ] Cada usuario tiene el menor rol que funciona
- [ ] 2FA inscrito en **todas** las cuentas de administrador; códigos de recuperación guardados
- [ ] Otorgamientos de `POWER_USER` revisados (pueden borrar archivos)
- [ ] Registro de auditoría revisado con regularidad
- [ ] `CORS_ORIGIN` es el origen exacto de producción
- [ ] `FILE_MANAGER_ROOTS` es lo más estrecho posible

---

## Rendimiento {#performance}

Todo funciona — solo que va lento. Ver [Rendimiento](/operate/performance) para el
tratamiento completo; esto es la capa de configuración.

```yaml
# docker-compose.override.yml
services:
  postgres:
    command:
      - postgres
      - -c
      - shared_buffers=1GB
      - -c
      - work_mem=32MB
      - -c
      - maintenance_work_mem=512MB   # hace que la construcción de índices sea mucho más rápida
      - -c
      - effective_cache_size=3GB
      - -c
      - random_page_cost=1.1         # estás en SSD; el valor por defecto de 4.0 asume disco giratorio
```

Luego, en orden de impacto:

1. **Verifica que los índices trigram existen y tienen `indisvalid = true`.** Esto vale
   **~265×** en las búsquedas de títulos de IMDb (47.8 s → 180 ms). Un índice **INVALID**
   es *peor* que ninguno — el planificador lo ignora, pero su nombre existe, así que
   `IF NOT EXISTS` se salta la reconstrucción para siempre.
2. **`ANALYZE`** después de cualquier importación grande. Un plan viejo es un plan lento.
3. **`random_page_cost=1.1`** — la línea con más apalancamiento. El valor por defecto de
   `4.0` sesga al planificador *en contra* de los escaneos de índice, lo cual está mal en
   SSD.
4. **No corras un escaneo de biblioteca durante la importación de IMDb.** Se pelean.
5. **Múdate a qBittorrent** si tienes muchos torrents.

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
EXPLAIN ANALYZE SELECT * FROM imdb_titles WHERE \"primaryTitle\" ILIKE 'Silo';"
# Quieres: Bitmap Index Scan.   NO quieres: Seq Scan.
```

**Lista de verificación**
- [ ] Índices trigram presentes **y válidos**
- [ ] `EXPLAIN` muestra un Bitmap Index Scan
- [ ] `random_page_cost` reducido para SSD
- [ ] `ANALYZE` corrido recientemente
- [ ] Postgres tiene suficiente `shared_buffers`

---

## Seguridad {#security}

Expuesto a internet, o simplemente paranoico. Va de la mano con
[Seguridad](/operate/security).

```dotenv
NODE_ENV=production

# El origen EXACTO. No `*`. No localhost.
CORS_ORIGIN=https://ultratorrent.example.com

# Todo de vida corta.
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=7

# El límite duro más estrecho posible.
FILE_MANAGER_ROOTS=/downloads/media

# Protección SSRF completa: déjalo VACÍO si no usas ningún indexador con IP privada.
# Si usas el Prowlarr incluido, TIENES que mantenerlo en la lista.
SSRF_ALLOW_HOSTS=prowlarr
```

### No publiques nada que no tengas que publicar {#publish-nothing-you-do-not-have-to}

```yaml
# docker-compose.override.yml — deja de publicar los puertos de los acompañantes.
services:
  qbittorrent:
    ports: !reset []      # accede a él solo por la red interna
  prowlarr:
    ports: !reset []
```

:::danger La superficie de control del motor no tiene autenticación
La interfaz SCGI/XML-RPC de rTorrent da **control total del cliente**, incluyendo
**ejecución de comandos** (corre `rm` durante la eliminación con datos). El archivo
Compose incluido correctamente la mantiene en `expose` (solo interna) — **nunca** la
publiques. La misma precaución aplica a la Web API de qBittorrent: si publicaste su
puerto para obtener la contraseña del primer arranque, **deja de publicarlo después**.
:::

### TLS en el borde {#tls-at-the-edge}

```bash
docker compose --profile proxy up -d
```

Reemplaza la etiqueta de sitio `:80` en `deploy/Caddyfile` con tu dominio para tener
HTTPS automático con Let's Encrypt. Ver [TLS](/install/tls).

### La recomendación honesta {#the-honest-recommendation}

**Ponlo detrás de una VPN.** WireGuard o Tailscale te dan acceso remoto con una fracción
de la superficie de ataque. UltraTorrent mueve, elimina y ejecuta cosas sobre archivos.
Hay muy poca ventaja en exponerlo públicamente.

**Lista de verificación**
- [ ] TLS termina en un proxy inverso
- [ ] `CORS_ORIGIN` es el origen exacto de producción
- [ ] rTorrent / FlareSolverr **no** están publicados
- [ ] Puertos de qBittorrent / Prowlarr sin publicar (o tras un firewall)
- [ ] 2FA en cada cuenta que puede iniciar sesión
- [ ] `FILE_MANAGER_ROOTS` estrechado
- [ ] `SSRF_ALLOW_HOSTS` lista solo indexadores de confianza
- [ ] `chmod 600 .env`
- [ ] Registro de auditoría revisado con regularidad

---

## Comparación {#comparison}

| | Predeterminado | Pequeño | Grande | HA | Empresarial | Rendimiento | Seguridad |
|---|---|---|---|---|---|---|---|
| **Motor** | qBittorrent | rTorrent OK | **qBittorrent** | qBittorrent | qBittorrent | qBittorrent | qBittorrent |
| **Catálogo de IMDb** | opcional | omitir | sí | sí | sí | sí | opcional |
| **Índices trigram** | automáticos | n/a | **críticos** | críticos | críticos | **críticos** | automáticos |
| **Postgres** | incluido | incluido | incluido + ajustado | **externo** | incluido | **ajustado** | incluido |
| **`JWT_ACCESS_TTL`** | 15m | 30m | 15m | 15m | **15m** | 15m | **15m** |
| **`JWT_REFRESH_TTL_DAYS`** | 30 | 60 | 30 | 30 | **7** | 30 | **7** |
| **2FA** | recomendado | opcional | recomendado | requerido | **requerido** | — | **requerido** |
| **Puertos publicados** | 8080 | 8080 | 8080 + 8081 | vía LB | vía proxy | — | **solo 80/443** |
| **`minSeeders`** | configúralo | configúralo | **obligatorio** | obligatorio | obligatorio | obligatorio | configúralo |
| **Cola de estacionamiento** | apagada | apagada | **encendida** | encendida | encendida | encendida | apagada |

## Solución de problemas {#troubleshooting}

| Síntoma | Desajuste de perfil probable |
|---------|-------------------------|
| El motor se reinicia constantemente | Estás con ajustes de **Pequeño** a escala **Grande** → cámbiate a qBittorrent |
| Los escaneos nunca terminan | Faltan índices trigram → [Rendimiento](#performance) |
| Nada se descarga, todo en cola | Falta `minSeeders` → [Grande](#large-media-library) |
| El backend no arranca | Secretos → [Predeterminado](#default) |
| Descargas con dueño root | `PUID`/`PGID` o falta `cap_add` → [Pequeño](#small-home-server) |

Detalle completo en [Solución de problemas](/operate/troubleshooting).

## Consejos {#tips}

- **Los perfiles se combinan.** Grande + Seguridad es una combinación perfectamente
  normal.
- **Elige tu motor antes de crecer, no después.** Migrar de motor con 800 torrents es
  una faena; empezar con el correcto es gratis.
- **La regla de `minSeeders` es el seguro más barato de este documento.** Una sola
  columna sin configurar dejó a un host de 1,137 torrents a **cero bytes por segundo**.

## Preguntas frecuentes {#faq}

**¿Puedo cambiar de perfil después?**
Sí. Son solo ajustes. Cambiar de *motor* significa volver a agregar los torrents al
motor nuevo, así que hazlo temprano.

**¿Cuál perfil para una Raspberry Pi?**
[Servidor doméstico pequeño](#small-home-server). Sáltate el catálogo de IMDb.

**Tengo 300 torrents. ¿Pequeño o Grande?**
**Grande.** La tasa de fallos de rTorrent ya va subiendo con esa cantidad.

**¿Necesito Prowlarr?**
No. Es un acompañante opcional que administra las definiciones de indexadores Torznab
por ti. UltraTorrent arranca y funciona bien sin él. Ver [Prowlarr](/modules/prowlarr).

**¿Puedo correr múltiples instancias del backend?**
No está soportado. Los cuerpos de las tareas corren en proceso, así que una segunda
instancia duplicaría el trabajo programado. Ver
[Alta disponibilidad](#high-availability).

## Ver también {#see-also}

- [Rendimiento](/operate/performance) · [Seguridad](/operate/security) · [Backup](/operate/backup) · [Mantenimiento](/operate/maintenance)
- [Solución de problemas](/operate/troubleshooting)
- [Referencia de entorno](/reference/environment) — cada variable
- [Docker Compose](/install/docker-compose) · [Proxy inverso](/install/reverse-proxy) · [TLS](/install/tls)
- [Motores](/modules/engines) · [Indexadores](/modules/indexers) · [Usuarios](/modules/users)
