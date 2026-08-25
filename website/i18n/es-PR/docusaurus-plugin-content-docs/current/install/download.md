---
id: download
title: Obtener UltraTorrent
sidebar_position: 2
description: De dónde sale UltraTorrent realmente — el repositorio de código, cómo fijar una versión, la ruta del ZIP sin git, lo que deliberadamente no se publica, y cómo compilar los binarios del instalador y de la consola.
keywords:
  - descargar
  - obtener
  - obtener ultratorrent
  - código
  - código fuente
  - git clone
  - zip
  - lanzamiento
  - lanzamientos
  - versión
  - tag
  - imagen docker
  - registro
  - binario del instalador
  - compilar
---

# Obtener UltraTorrent

## Resumen

UltraTorrent se distribuye como **código fuente**. Clonas (o bajas) el repositorio en
la máquina que lo va a correr, y las imágenes de Docker se construyen ahí en el primer
arranque.

Esa es toda la historia, y vale la pena decirlo claro porque no es lo usual: no hay
`docker pull`, no hay entrada en la tienda de apps de tu NAS, y no hay instalador que
bajar. Todo lo de abajo sale de ahí.

:::info ¿Por qué no hay imágenes precompiladas?
Todavía no se publica ninguna imagen en un registro, así que el stack de Compose
**se construye desde el código**. Por eso tu host necesita Docker, el árbol de código,
y como **2 GB de RAM libre** para el primer build (unos 10–15 minutos; los arranques
posteriores son segundos). Las imágenes base son multi-arquitectura, así que sirven
tanto hosts x86-64 como ARM64.
:::

## Qué se publica y qué no

| | Estado | Dónde |
| --- | --- | --- |
| **Repositorio de código** | Publicado | [github.com/ultratorrentofficial/ultratorrent](https://github.com/ultratorrentofficial/ultratorrent) |
| **Tags de versión** (`vX.Y.Z`) | Publicados | Uno por lanzamiento, en el mismo repositorio |
| **ZIP del código** | Publicado | **Code → Download ZIP** en GitHub |
| **Esta documentación** | Publicada | [docs.ultratorrent.co](https://docs.ultratorrent.co), y sin conexión dentro de la app en `/docs/` |
| **Imágenes de Docker** | **No publicadas** | Se construyen en tu host con `docker compose --build` |
| **GitHub Releases con archivos adjuntos** | **No publicados** | Usa los tags |
| **Binario `ultratorrent-install`** | **No publicado** | [Compílalo](#opcional-los-binarios-de-cliente) desde el checkout |
| **Binario `utconsole`** | **No publicado** | [Compílalo](#opcional-los-binarios-de-cliente), o deja que el instalador lo coloque |
| **Paquete de tienda para Synology / QNAP / Unraid** | **No publicado** | Toda ruta de NAS es el mismo stack de Compose — ve [Plataformas](/install/platforms/linux) |

## Antes de empezar

En la máquina que va a correr UltraTorrent:

- **Docker Engine** con el **plugin de Compose v2** (`docker compose`, con espacio — no el viejo `docker-compose`).
- **`git`**, o un navegador y alguna forma de copiar una carpeta al host.
- **~2 GB de RAM libre** para el build, **2+ GB de disco** para las imágenes, más lo que necesiten tus descargas.

**No** necesitas Node.js, PostgreSQL ni Redis en el host — corren en containers.
(Una instalación de desarrollo desde código sí los necesita; ve
[Linux](/install/platforms/linux#manual-install-from-source).)

## Bajar el código

### Con git — recomendado

```bash
git clone https://github.com/ultratorrentofficial/ultratorrent.git
cd ultratorrent
```

**Resultado esperado:** una carpeta con `docker-compose.yml`, `.env.example`,
`apps/` y `docs/`.

```bash
ls docker-compose.yml .env.example
```

git es la ruta recomendada por una razón que importa después: **actualizar es
`git pull` + recompilar**. Un ZIP no tiene forma de actualizarse en sitio, ni forma
de decirte qué cambió.

### Fija un lanzamiento en vez de seguir `main`

`main` es la rama de desarrollo. Un tag de lanzamiento es la versión que este sitio
de documentación etiqueta, y con la que compara
[`GET /api/system/update`](/reference/api).

```bash
git clone https://github.com/ultratorrentofficial/ultratorrent.git
cd ultratorrent

git tag --list 'v*' --sort=-v:refname | head        # las más nuevas primero
git checkout v0.85.9                                 # o la que quieras
```

:::tip ¿Cuál debo correr?
Fija un tag si esta máquina te importa — así actualizas a propósito, después de leer el
[changelog](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md).
Sigue `main` si quieres lo más reciente y no te molesta que un build te encuentre una
migración de la que no habías leído.
:::

### Sin git — el ZIP

Útil en un NAS sin `git`, donde vas a copiar una carpeta por SMB.

1. Abre [el repositorio](https://github.com/ultratorrentofficial/ultratorrent) en un navegador.
2. **Code → Download ZIP** (para una versión específica: **Tags →** escoge una → **Code → Download ZIP**).
3. Descomprímelo y copia la carpeta al host — a `/volume1/docker/` en Synology,
   `/share/Container/` en QNAP, `/mnt/user/appdata/` en Unraid.
4. Renómbrala a `ultratorrent`. El ZIP de GitHub se descomprime como
   `ultratorrent-main`, y **Compose deriva el nombre del proyecto del directorio**, así
   que el nombre de la carpeta se convierte en el prefijo de cada container, imagen y
   volumen que cree esta instalación.

:::warning Un ZIP es un callejón sin salida para actualizar
Actualizar una instalación por ZIP significa bajar otro ZIP, copiarlo encima de la
carpeta vieja sin machacar tu `.env`, y recompilar — sin diff y sin reversión. Si puedes
instalar `git` en el host, hazlo.
:::

## Confirma lo que bajaste

```bash
cat VERSION                     # la versión canónica, p. ej. 0.85.9
git describe --tags --always    # exactamente en qué commit estás
git status --porcelain          # vacío = un checkout sin modificar
```

`VERSION`, `package.json` y `version.json` cargan el mismo número — el proyecto usa
changesets con [una sola versión canónica](https://github.com/ultratorrentofficial/ultratorrent/blob/main/docs/VERSIONING.md).
Cuando el stack esté corriendo, `GET /api/system/version` reporta lo mismo, y el diálogo
Acerca de lo muestra.

:::note Verificar autenticidad
Hoy no hay artefactos de lanzamiento firmados ni sumas de verificación publicadas contra
las cuales comparar, porque no hay artefactos de lanzamiento. Lo que sí puedes verificar
es el transporte y el historial: clona por HTTPS desde la URL de arriba, y revisa el
commit donde caíste con `git log -1`.
:::

## Qué acabas de bajar

| Ruta | Qué es |
| --- | --- |
| `docker-compose.yml` | El stack: PostgreSQL, Redis, backend, frontend, más los engines y companions con profile |
| `.env.example` | Todas las variables de entorno, comentadas — la plantilla de tu `.env` |
| `apps/backend` · `apps/frontend` | La API de NestJS y la interfaz web de React, que se compilan dentro de las imágenes |
| `packages/shared` | Los contratos que ambos comparten |
| `docs/` | La documentación completa en Markdown (este sitio, dentro del repositorio) |
| `website/` | El sitio de documentación en sí |
| `clients/installer` | El código de `ultratorrent-install`, el instalador guiado |
| `clients/console` | El código de `utconsole`, el cliente de terminal de solo lectura |
| `deploy/`, `ops/` | El Caddyfile incluido, la configuración de rTorrent, y los scripts operativos |

## Opcional: los binarios de cliente

Dos programas en Go se distribuyen **solo como código** — `dist/` está en `.gitignore`,
así que los binarios se compilan y nunca se suben al repositorio. Compilarlos requiere
[Go](https://go.dev/dl/) en la versión que nombra el `go.mod` de cada módulo; nada más.

```bash
cd clients/console   && ./build.sh    # utconsole            → dist/ (linux, darwin, windows)
cd ../installer      && ./build.sh    # ultratorrent-install → dist/ (linux amd64/arm64, windows amd64)
```

Cada uno escribe un `dist/SHA256SUMS` junto a los binarios. Compila la consola
**primero**: el instalador embebe la consola de la plataforma que corresponde, así que
una instalación termina con una consola funcional y sin una segunda descarga.

- **[`ultratorrent-install`](/install/installer)** — inspecciona el host, imprime el
  plan, genera la configuración y despliega el stack. Opcional: la
  [ruta de Docker Compose](/install/docker-compose) hace el mismo trabajo a mano.
- **[`utconsole`](/operate/console)** — una vista de terminal de solo lectura de una
  instalación corriendo. Opcional, y el instalador te la instala.

:::info ¿No hay Go en el host?
Ambos binarios son estáticos y se compilan de forma cruzada, así que compílalos en
cualquier máquina y copia el archivo — `CGO_ENABLED=0` es lo que permite que un solo
binario corra en un Debian actual y en un NAS cuya glibc tiene años.
:::

## Dónde ponerlo en el host

El lugar del checkout lo escoges tú, pero dos cosas dependen de eso:

- **Compose deriva el nombre del proyecto del nombre de la carpeta**, así que
  `ultratorrent/` te da `ultratorrent-backend-1`, `ultratorrent_postgres_data`, y así.
  Renombra antes de levantar el stack por primera vez, no después.
- **Tiene que estar en almacenamiento persistente.** En un NAS eso significa un share
  (`/volume1/...`, `/share/...`), nunca una ruta en un sistema de archivos raíz que corre
  desde RAM.

Tu [página de plataforma](/install/platforms/linux) nombra el directorio convencional
para tu host.

## Próximos pasos

1. **[Instalación con Docker Compose](/install/docker-compose)** — la instalación autoritativa, a mano.
2. O **[el instalador guiado](/install/installer)** — el mismo resultado, con un solo binario.
3. Luego **[Inicio rápido](/learn/quick-start)** y **[tu primera descarga](/learn/first-download)**.
4. Más adelante: **[Actualización](/install/upgrading)** — que es `git pull` y recompilar.

## Lista de verificación

- [ ] El código está en la máquina que lo va a correr, en almacenamiento persistente
- [ ] La carpeta se llama como quiero que se llame el proyecto de Compose
- [ ] `docker-compose.yml` y `.env.example` están ambos presentes
- [ ] Sé si estoy en `main` o en un tag fijado (`git describe --tags`)
- [ ] `cat VERSION` dice lo que espero
- [ ] Docker Engine y el plugin de Compose **v2** están instalados
- [ ] Hay ~2 GB de RAM libre para el primer build

## Preguntas frecuentes

**¿Hay una imagen en Docker Hub o GHCR?**
No. Cada instalación construye las imágenes localmente con `docker compose up -d --build`.

**¿Hay un instalador que pueda bajar y correr?**
El instalador existe, pero no se publica como archivo descargable — lo compilas desde el
checkout con `clients/installer/build.sh`. Ve [Instalador guiado](/install/installer).

**¿Por qué no hay GitHub Releases?**
Hoy los lanzamientos se cortan como **tags**. `git tag --list 'v*'` es la lista, y el
[changelog](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md)
son las notas de lanzamiento.

**¿Necesito el repositorio completo, o solo `docker-compose.yml`?**
El completo. Las imágenes se construyen desde `apps/`, así que un archivo de Compose
suelto no tiene contexto de build y no puede arrancar nada.

**¿Puedo clonarlo en otro lado y copiar solo las imágenes ya construidas?**
Sí — construye en una máquina capaz y envía las imágenes por un registro. Así se
despliegan los hosts limitados del propio proyecto; ve
[`docs/OPERATIONS.md`](https://github.com/ultratorrentofficial/ultratorrent/blob/main/docs/OPERATIONS.md).

**¿Cuánto pesa?**
El checkout es pequeño; el costo real son las imágenes construidas y su caché de build —
cuenta con un par de GB antes de cualquier media.

**¿Se actualiza solo?**
No. La app puede *decirte* que existe un tag más nuevo (`GET /api/system/update`), pero
nada se aplica solo: un container no puede reemplazar la imagen desde la que corre. Ve
[Actualización](/install/upgrading).

## Ver también

- [Escoge tu método de instalación](/install/) — qué ruta aplica a tu host
- [Instalación con Docker Compose](/install/docker-compose) — la guía autoritativa
- [Instalador guiado](/install/installer) — `ultratorrent-install`, de principio a fin
- [Actualización y reversión](/install/upgrading) — cómo avanza un checkout
- [Consola de terminal](/operate/console) — `utconsole`
