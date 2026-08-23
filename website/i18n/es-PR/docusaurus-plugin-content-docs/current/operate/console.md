---
id: console
title: Consola de terminal (utconsole)
sidebar_position: 8
description: Una vista de solo lectura en la terminal de una instalación de UltraTorrent — un binario estático, nueve vistas, stream de eventos en vivo y el mismo RBAC que la app web.
keywords:
  - consola
  - utconsole
  - terminal
  - tui
  - cli
  - monitoreo
  - observabilidad
  - ssh
  - operaciones
---

# Consola de terminal (`utconsole`) {#terminal-console-utconsole}

Una vista de solo lectura, en la terminal, de una instalación de UltraTorrent en
marcha: un binario estático, sin runtime, sin más configuración que una URL de
servidor y una cuenta.

![La vista Overview: sistema, transferencias, almacenamiento, trabajo y atención](/img/screenshots/utconsole-overview.svg)

**Observa y nunca administra.** Cada petición que hace es un `GET` contra
`/api/operations`, autenticada como una cuenta cualquiera. Eso no es una promesa que
el binario hace sobre sí mismo — el servidor no tiene ninguna ruta de escritura en
esa superficie y rechaza todo lo demás, sin importar lo que pida un cliente. El ser
de solo lectura viene de la API y del rol de la cuenta; que la consola sea incapaz de
escribir es defensa en profundidad, no el mecanismo.

:::tip Por qué un cliente de terminal
La app web contesta "qué está pasando" muy bien, y necesita un navegador, una sesión
y una pantalla. Un operador conectado por SSH a un NAS a las 2am tiene una terminal.
La consola es para eso: los mismos hechos, los mismos permisos, sobre la misma API,
mostrados donde el operador ya está.
:::

## Instalación {#install}

El binario se construye desde `clients/console/` y no depende de nada en tiempo de
ejecución:

```bash
cd clients/console
./build.sh                                    # escribe dist/ para linux, darwin, windows
scp dist/utconsole-linux-amd64 host:/usr/local/bin/utconsole
ssh host chmod 755 /usr/local/bin/utconsole
```

`CGO_ENABLED=0` en todo, que es lo que permite que **un solo** binario corra tanto en
un Ubuntu actual como en un NAS cuya glibc tiene años. Una compilación enlazada
dinámicamente falla en el más viejo con un error de enlace que no dice nada sobre la
causa real.

## Primer uso {#first-run}

```bash
utconsole login --server https://tu-instalacion   # una vez; guarda un token rotativo
utconsole                                         # la consola
```

:::warning Apunta a la raíz de la aplicación, no al puerto del backend
El contenedor del backend normalmente no publica ningún puerto; el frontend hace
proxy de `/api` y `/ws/` hacia él. Usa la URL que abres en el navegador. Apuntar
directamente a `:4000` solo funciona donde ese puerto esté publicado de verdad.
:::

| Comando | Qué hace |
|---|---|
| `utconsole` | La consola interactiva |
| `utconsole login --server URL [--user NOMBRE] [--totp CÓDIGO]` | Autentica; guarda un refresh token rotativo |
| `utconsole logout` | Olvida la sesión guardada |
| `utconsole snapshot [--domains a,b]` | Imprime una lectura como JSON y sale |
| `utconsole version` | Versión del build y del contrato |

`snapshot` existe para que la consola sirva en un pipeline y en un reporte de bug, no
solo en pantalla — y porque es lo más pequeño que prueba que un despliegue funciona
de punta a punta.

### Teclas {#keys}

| Tecla | Acción |
|---|---|
| `tab` / `1`–`9` | Cambiar de vista |
| `r` | Refrescar ahora |
| `p` | Pausar el sondeo por completo |
| `f` | Rotar el filtro de categoría del stream |
| `L` | Cambiar de idioma (inglés ⇄ español) y recordarlo |
| `q` | Salir |

### Idioma {#language}

La consola habla **inglés (`en-US`)** y **español (`es-PR`)** — los mismos dos idiomas
que la app web — y carga los dos **dentro del binario**. No hay ningún directorio de
traducciones que copiar al lado, lo cual importa en un programa cuya instalación normal
es un `scp` a una máquina sin monitor.

Escoge uno al arrancar; gana la primera fuente que diga algo:

1. `--locale es-PR`
2. `UTCONSOLE_LOCALE=es-PR`
3. `"locale"` en el archivo de configuración
4. `LC_ALL`, luego `LC_MESSAGES`, luego `LANG`
5. Inglés

Se acepta cualquier forma de escribir la etiqueta — `es_PR.UTF-8`, `ES-pr`, `es` a
secas — y un locale en español sin catálogo propio (`es-MX`, `es-ES`) resuelve a
`es-PR` en vez de caer a inglés; exigir la etiqueta exacta dejaría en inglés a toda
instalación hispanohablante que no sea de Puerto Rico. `C` y `POSIX` significan "sin
preferencia", no "inglés". Una etiqueta desconocida se avisa en vez de ignorarse en
silencio: un error de tipeo que rinde inglés calladito se ve idéntico a una traducción
que falta.

:::tip Cámbialo en vivo
**`L`** cambia el idioma con la consola corriendo y recuerda la decisión. No se vuelve
a pedir nada al servidor — la lectura es data, y lo único que estaba en inglés eran sus
etiquetas.
:::

El vocabulario que le pertenece al **servidor** — estados de torrent, estados de
tarea, estados de ingesta, salud — se traduce donde la consola lo reconoce y se pasa
**tal cual** donde no: un estado que el servidor añada mañana aparece como llegó, en
vez de desaparecer. El texto de error del runtime de Go o del servidor se queda en
inglés a propósito: tiene que poder buscarse y citarse en un reporte de bug.

Las capturas de esta página están en inglés a propósito — la consola sí habla
español. Son capturas de una instalación real, así que un segundo juego en español
sería un segundo juego que mantener al día cada vez que cambie un panel, y una
captura desfasada es peor que una en el otro idioma. Lo que enseñan es la
distribución, que es idéntica en ambos idiomas.

## Qué necesita una cuenta {#what-an-account-needs}

El permiso **`console.view`**, que concede *acceso al cliente y nada más*. Cada panel
sigue estando protegido por el permiso de vista de su propio dominio, así que quien
usa la consola ve exactamente lo que esa misma cuenta ve en la app web — ni un dato
más. `READ_ONLY`, `USER` y `POWER_USER` lo tienen de fábrica; `ADMINISTRATOR` lo
hereda.

Deliberadamente no existe un `console.admin`. Un permiso que saltara por encima de
los permisos de dominio convertiría a la consola en el único cliente donde el RBAC no
aplica, que es justo lo contrario de la idea.

Una cuenta que tiene `console.view` y ningún permiso de dominio es rechazada al
arrancar, con un mensaje que lo dice, en vez de abrir nueve vistas vacías. Un panel
que la cuenta no puede leer lo dice en su propio marco, atenuado en vez de coloreado
como una falla — un límite de permisos no es un incidente, y pintarlo como si lo
fuera enseña al operador a ignorar el color que sí significa que algo anda mal.

## Las vistas {#the-views}

### Overview {#overview}

El host a la izquierda, el trabajo a la derecha, para que *"¿está enferma la máquina
o está enferma la carga?"* se conteste mirando un solo lado.

![Overview](/img/screenshots/utconsole-overview.svg)

La carga se muestra **por core**, porque un load average crudo no significa nada sin
saber entre cuántos cores está repartido — `6.0` es una emergencia en dos cores y una
tarde tranquila en sesenta y cuatro.

### Torrents {#torrents}

![Torrents: lo que necesita atención, transferencias activas y la cola del scheduler](/img/screenshots/utconsole-torrents.svg)

`Needs attention` va primero y contiene todo lo que está en error o estancado — un
torrent descargando sin peers y sin throughput. `Active` viene recortado por el
servidor, y la consola lo dice, en vez de dejar que una lista que se detiene en 25 se
lea como "esos son todos".

Las cifras de transferencia traen una edad **`observed`**: el servidor las lee de lo
último que vio su poller de engines en vez de volver a preguntarle a los engines por
tu cuenta, así que el dato tiene deliberadamente hasta dos segundos de viejo y lo
dice.

### Media {#media}

![Media: conteos de biblioteca, reproducción en vivo y el pipeline de ingesta](/img/screenshots/utconsole-media.svg)

### Jobs {#jobs}

![Jobs: conteos de trabajos de plataforma, trabajos recientes y corridas de automatización](/img/screenshots/utconsole-jobs.svg)

### Acquisition {#acquisition}

![Acquisition: feeds RSS y decisiones recientes sobre releases](/img/screenshots/utconsole-acquisition.svg)

El estado de un feed es **qué tan viejo está frente a su propio intervalo de
refresco**, no una columna de error. Los fallos de sondeo de RSS se registran en el
log y nunca se persisten, así que un campo de error solo podría estar vacío — y una
columna que está estructuralmente siempre vacía se lee como "ningún feed ha fallado
nunca", que es peor que no ofrecerla. Un feed queda `overdue` después del doble de su
intervalo; con una sola vez se marcaría cada sondeo que llega un momento tarde.

Los resultados usan el vocabulario que la plataforma realmente puede derivar:
`downloaded`, `skipped_duplicate`, `matched`, `no_match`. **`matched` se mantiene
aparte a propósito**: significa que una regla quería un release y no se tomó, que es
el estado que merece la atención del operador y el que un simple "rechazado"
enterraría.

### Infrastructure {#infrastructure}

![Infrastructure: engines, indexers y proveedores](/img/screenshots/utconsole-infrastructure.svg)

La salud se comunica con un **glifo además del color** (`●` saludable, `◐` degradado,
`✕` caído, `○` nunca alcanzado). El color por sí solo excluye a cualquiera con una
deficiencia en la visión de color y desaparece por completo a través de un pipe.

### Activity {#activity}

![Activity: el feed reciente de auditoría y la entrega de notificaciones](/img/screenshots/utconsole-activity.svg)

Una línea marcada `(N events)` es una ráfaga colapsada. La consola muestra el conteo
y no puede expandirlo — el snapshot trae un número, no los eventos que lo componen —
y fingir lo contrario sería mentir sobre lo que tiene.

### Alerts {#alerts}

![Alerts: la lista de atención, enmarcada en su peor severidad](/img/screenshots/utconsole-alerts.svg)

:::info Las alertas son una proyección, no una entidad
Se calculan a partir del estado de salud, trabajos, ingesta, almacenamiento y
proveedores cada vez que se construye un snapshot. No tienen identidad que sobreviva
un reinicio, no se pueden reconocer, y no hay tecla para descartarlas — la forma de
hacer que una desaparezca es arreglar lo que reporta. Una tecla de descartar
prometería algo que el servidor no puede cumplir.
:::

El panel se enmarca en la peor severidad que contiene, así que una alerta crítica se
ve antes de haber leído una sola palabra.

### Stream {#stream}

![Stream: el feed de eventos en vivo](/img/screenshots/utconsole-stream.svg)

Una narrativa en vivo sobre un websocket, no por sondeo. **No es historial**: guarda
los últimos 200 eventos que llegaron mientras esta consola estuvo abierta, no rellena
hacia atrás, y la vista lo dice cada vez que se dibuja. El registro de lo que pasó es
el [log de auditoría](/modules/audit).

`f` rota el filtro entre las categorías que de verdad están en el búfer, en vez de
una lista fija de todas las categorías que la plataforma puede emitir.

## Cómo trata al servidor {#how-it-treats-the-server}

A una consola la miran *las personas* y apunta *a una máquina* que puede estar
teniendo un mal día, así que es deliberadamente barata:

- **Cada vista pide solo los dominios que muestra**, nunca los dieciséis.
- **El intervalo de refresco se sube** hasta el piso que anuncia el servidor, así que
  una consola mal configurada no puede convertirse en carga.
- **`p` detiene el sondeo por completo** en vez de congelar una copia, así que una
  consola pausada no le cuesta nada al servidor.
- **Un refresco fallido deja en pantalla la última lectura buena**, con el fallo y su
  edad en la barra de estado. Una consola que se cierra cuando el servidor tiene un
  tropiezo es inútil justo cuando hace falta.
- **No mide nada localmente.** Sin muestreo de CPU, sin sondeo de disco, sin acceso
  directo a base de datos, Redis, engine, media server o sistema de archivos.

## Configuración {#configuration}

`~/.config/utconsole/config.json`, modo `0600`, con la URL del servidor, preferencias
de despliegue y un refresh token **rotativo**. **Nunca se guarda una contraseña.**
Cambia la ubicación con `UTCONSOLE_CONFIG`.

```json
{
  "serverUrl": "https://tu-instalacion",
  "refreshToken": "…",
  "username": "operador",
  "refreshSeconds": 5,
  "locale": "es-PR"
}
```

`locale` no aparece hasta que se escoge un idioma con `L` o se escribe a mano; que no
esté significa "seguir el entorno".

El token vive en un archivo y no en un llavero del sistema porque esto corre en
servidores sin monitor, donde no existe ningún demonio de llavero, y un llavero que
en silencio cae de vuelta a un archivo es peor que un archivo que lo dice de frente.
La consola avisa una vez si el archivo es legible por el grupo o por todos, pero no
se niega a arrancar.

## Color y terminales {#colour-and-terminals}

La paleta es ANSI-256 y no truecolor, porque esto corre sobre SSH hacia la terminal
que el operador tenga a mano, y un tema que asume color de 24 bits se ve como lodo en
una terminal básica. En una consola virtual de Linux la misma pantalla se dibuja con
los 16 colores ANSI.

:::caution `TERM` tiene que estar definido
Sin ningún `TERM`, la librería de dibujo concluye que no está hablando con una
terminal a color y dibuja en monocromo. Esto muerde al lanzar desde un contexto que
no hereda un entorno:

```bash
openvt -s -- /usr/local/bin/utconsole              # mal: sin TERM, se ve plano
openvt -s -- env TERM=linux /usr/local/bin/utconsole   # bien
```
:::

## Compatibilidad {#compatibility}

La consola revisa la versión del contrato de operaciones al arrancar:

| Contrato del servidor | Resultado |
|---|---|
| Mismo major | Compatible |
| Minor más nuevo | Compatible; se ignoran los campos que este build no conoce |
| Major distinto | Rechazado, nombrando **ambas** versiones |

Rechazar es mejor que dibujar disparates a partir de una forma que el cliente está
adivinando.

## Resolución de problemas {#troubleshooting}

Los mensajes salen en el idioma de la consola; aquí van en español.

| Síntoma | Causa |
|---|---|
| `No hay sesión iniciada, o la guardada expiró` | No hay token guardado, o fue rotado en otro lado. Corre `utconsole login` otra vez. |
| `Esta cuenta no puede usar la consola` | A la cuenta le falta `console.view`. |
| Los paneles dicen *"Tu cuenta no puede leer esto"* | Esperado: a la cuenta le falta el permiso de vista de ese dominio. |
| Todo se ve en monocromo | `TERM` no está definido — ver arriba. |
| `incompatible operations contract` | El servidor habla otro major del contrato; actualiza la mitad más vieja. |
| El stream muestra `✕ rechazado` | Se rechazó la identidad, no la red. Revisa que la cuenta exista y conserve sus permisos. |
| El stream muestra `✕ desconectado` | El socket se cayó. Se reconecta solo, con backoff. |
| Falta `console.view` tras una actualización | El permiso se crea al arrancar con la sincronización de permisos de módulos; busca en el log del backend `Added 1 permission(s): console.view`. |

## Para seguir leyendo {#further-reading}

- [`docs/UTCONSOLE.md`](https://github.com/damirabal/ultratorrent-core/blob/main/docs/UTCONSOLE.md) — lo mismo, con el detalle de compilación y pruebas
- [Referencia de la API REST](/reference/api) — los endpoints `/operations`
- [Referencia de permisos](/reference/permissions) — `console.view` y los permisos de dominio
- [Resolución de problemas](/operate/troubleshooting) — el manual de toda la plataforma
