---
id: subtitle-intelligence
title: Inteligencia de Subtítulos
sidebar_position: 18
description: Encuentra, califica, valida, instala y sincroniza el mejor subtítulo para cada película y episodio — automáticamente.
keywords: [subtítulos, opensubtitles, subdl, ffsubsync, sincronización, srt, vtt, ass, hash de película, plex, jellyfin, emby, kodi, sdh, forzados]
---

# Inteligencia de Subtítulos

Inteligencia de Subtítulos es un módulo **core** (`subtitle_intelligence`). No es un
simple descargador: es un motor completo que encuentra el subtítulo con más
probabilidad de estar **perfectamente sincronizado** con cada archivo, lo valida, lo
instala donde tu servidor de medios lo espera, y mantiene tus bibliotecas sin
faltantes.

## Qué hace

- **Genera una huella** de cada archivo — el *hash de película* de OpenSubtitles
  (una coincidencia de la misma codificación, la clave de mayor confianza) más
  duración, resolución, códecs, grupo de lanzamiento e ids de IMDb/TMDB/TVDB
  (reutilizando lo que el [Gestor de Medios](/modules/media-manager) ya midió).
- **Busca** en varios proveedores con una estrategia progresivamente relajada, de
  mayor a menor confianza: **hash exacto → nombre del lanzamiento → id externo →
  título**. Una coincidencia solo por título nunca se instala automáticamente.
- **Califica** cada candidato en una escala **0–100** con un nivel de acción —
  *automático*, *descargar*, *revisar* o *rechazar*. Una coincidencia de hash exacta
  se acepta por sí sola.
- **Valida** antes de escribir — líneas mal formadas, tiempos negativos o
  invertidos, líneas desordenadas y (opcionalmente) un subtítulo que se extiende más
  allá de la duración del medio.
- **Instala** un sidecar correcto para el servidor de medios (`Movie.en.srt`,
  `Movie.en.forced.srt`, `Movie.en.sdh.srt`, `Show - S01E01.es-PR.srt`) para Plex /
  Jellyfin / Emby / Kodi — y **nunca sobrescribe** un original.
- **Sincroniza** con el audio usando **FFsubsync**, o mediante un desplazamiento
  manual cuando la herramienta no está instalada. El original siempre se conserva.
- **Monitorea** las bibliotecas: un escaneo en segundo plano encuentra elementos sin
  sus idiomas requeridos y (opcionalmente) los obtiene, según una **política de
  idiomas** por biblioteca.

## Proveedores

| Proveedor | Tipo | Necesita |
|-----------|------|----------|
| OpenSubtitles | API oficial | clave de API (+ inicio de sesión para descargas) |
| SubDL | API oficial | clave de API |
| Repositorio Local | sin conexión | una carpeta dentro de tus raíces de almacenamiento |
| Podnapisi | JSON no oficial | — |
| YIFY Subtitles | scraping (películas) | — |
| SubtitleCat | scraping (traducción automática) | — |
| Addic7ed · Subs4Free | preparado | — |

**YIFY y SubtitleCat se basan en scraping** (los sitios no tienen API), así que son
de mejor esfuerzo: fiables para el uso diario, pero un rediseño del sitio puede
deshabilitarlos sin afectar al resto del módulo.

## Herramientas opcionales (sincronización automática)

La sincronización automática por audio necesita `ffmpeg` + `ffsubsync`; la sonda
técnica usa `mediainfo`. Ninguna es obligatoria — sin ellas el módulo aún busca,
califica, valida, instala y ofrece sincronización por **desplazamiento manual**.
Instálalas con `ops/scripts/install-subtitle-tools.sh`, o en Docker con
`--build-arg INSTALL_SUBTITLE_SYNC=true`.

## Seguridad

Las credenciales de proveedor se cifran con AES-256-GCM y se ocultan en la UI; las
descargas están limitadas por lista de hosts (sin SSRF) y se validan antes de tocar
el disco; todo acceso al sistema de archivos se confina a tus raíces de
almacenamiento; y cada acción está protegida por permisos y auditada.
