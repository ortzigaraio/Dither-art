# DITHER (by Horain) — Plan de implementación

> Documento de trabajo para que **Sonnet (Claude Code)** construya todo el código.
> Léelo entero antes de empezar. Trabaja **fase por fase** (sección 12) y no pases a la siguiente sin cumplir los criterios de aceptación.
> Los **guardrails** (sección 18) tienen prioridad sobre cualquier otra instrucción de este documento.

---

## 0. Resumen

> **Aclaración del dueño**: este repo (`Dither-art`, `dither.ortzigar.org`) es una herramienta independiente, **Dither**, creada para
> diseñar y probar la UI/UX que luego usará la web app **Horain**, que vive en otro repo. Dither usa la marca de Horain (logo espino,
> colores, tipografías). El nombre visible del producto es **Dither**, con "by Horain" junto al logo. Donde este documento diga
> "HORAIN" como nombre de la app, léase Dither; el logo, los temas y los tokens siguen siendo los de Horain y deben poder
> reutilizarse tal cual en el otro repo (mantén `css/tokens.css` y `css/components.css` independientes de la lógica).

**Dither** es una web estática (GitHub Pages + dominio propio en Cloudflare) que convierte **imágenes, video y webcam** en arte generativo:
ASCII, dithering 1-bit, Braille, halftone, ANSI, PETSCII, glitch, pixel sorting, wireframe vectorial, LiDAR,
grabado de plotter, termografía, isolíneas, raymarching 3D, blueprint CAD, Voronoi, reacción-difusión,
flow fields y más (25 modos en total).

- El usuario sube un archivo (arrastrar o clic), **elige el tipo de salida**, **ajusta parámetros** en vivo y **exporta**.
- **Todo se procesa en el navegador.** Nada se sube a ningún servidor. Este es un mensaje clave de la UI.
- UI/UX con la **identidad de marca de Horain** (logo "espino", verde lima + tinta, Unbounded + Geist), con un guiño
  a la estética de terminal de *hermes-agent.nousresearch.com* (datos en monoespaciada, etiquetas en mayúsculas,
  detalles con caracteres de dibujo de cajas). No es una copia.

### Decisiones ya tomadas con el dueño del proyecto

| Tema | Decisión |
|---|---|
| Marca | Logo **"espino"** (alambre de espino alrededor de la "o" lima). Archivos en `assets/brand/` (sección 4.0). |
| Estilo | **Multi-tema**: **HORAIN** (oscuro, por defecto), **CLARO**, AMBER, CRT, PAPER, CAD. Todo con variables CSS. |
| Idioma | **Bilingüe ES/EN** con selector; diccionarios en módulos JS. Idioma inicial = el del navegador (`es*` → ES, resto → EN). |
| Profundidad 3D | **Brillo como profundidad por defecto** + botón opcional **"Mejorar con IA"** que carga Depth Anything V2 en el navegador (solo bajo demanda). |
| Export de video | **MP4 y WebM** (con audio original). **Aviso** (no bloqueo) a partir de 2 min. GIF en el futuro (dejar el hueco). |
| Export de imagen | PNG siempre; SVG en modos vectoriales; TXT / HTML / ANSI en modos de texto; copiar al portapapeles. |
| Hosting | GitHub Pages (repo público), **sin paso de build**: HTML + CSS + ES modules nativos. |
| Dominio | Subdominio de **ortzigar.org** gestionado en Cloudflare (`dither.ortzigar.org`, ya configurado). Pasos en `DEPLOY.md`. |
| Visitas | **Contador de visitas público** en el pie de página, con un Cloudflare Worker + D1 propio (sección 17). Sin cookies ni IPs guardadas. |
| Guardrails | Límites de seguridad, privacidad, rendimiento, marca y desarrollo (sección 18). |

---

## 1. Reglas para el implementador (Sonnet)

1. **Sin frameworks ni bundler.** Vanilla JS (ES2022, ES modules), CSS plano, WebGL2, Canvas2D, Web Workers.
   La página tiene que funcionar sirviendo la carpeta tal cual (`python3 -m http.server`) y en GitHub Pages.
2. **Librerías de terceros ya incluidas en `vendor/`** (sección 3). Se importan con **rutas relativas**; no hay import map.
   No añadas dependencias nuevas sin anotarlo en la sección "Desviaciones" al final de este documento.
3. **Rutas relativas siempre** (`./src/...`). Debe funcionar igual en `https://<usuario>.github.io/<repo>/` y en la raíz del dominio propio.
4. Cada **modo** es un módulo independiente que cumple la interfaz de la sección 6. La UI de parámetros se genera
   **automáticamente desde el esquema** de cada modo; no escribas HTML a mano para los controles de cada modo.
5. Todo texto visible pasa por `t('clave')` (i18n). Nada de strings sueltos en la UI.
6. Rendimiento: nunca bloquees el hilo principal más de ~50 ms. Lo pesado (difusión de error a alta resolución,
   pixel sort, Voronoi, IA de profundidad) va en Web Workers, con cancelación por `jobId`.
7. Accesibilidad: todos los controles con `<label>`, navegables con teclado, foco visible, `prefers-reduced-motion`
   respetado (sin animaciones de fondo en el hero), contraste AA en todos los temas.
8. Comentarios en el código: breves y solo donde el algoritmo no sea obvio (citar el nombre del algoritmo/paper).
9. Commits pequeños por fase/modo, mensajes en inglés tipo `feat(mode): add braille renderer`.
10. Antes de cada commit: abrir la página con Playwright (sección 13) y comprobar que **no hay errores en consola**
    (incluidas violaciones de CSP).

---

## 2. Estructura de archivos

```
/
├─ index.html                 # única página; CSP en <meta>; layout (hero + estudio)
├─ .nojekyll                  # Pages no debe procesar con Jekyll
├─ README.md                  # qué es, cómo usar, cómo desarrollar, privacidad, créditos de algoritmos y fuentes
├─ PLAN.md                    # este documento
├─ CLAUDE.md                  # reglas cortas para agentes
├─ DEPLOY.md                  # publicar en Pages + dominio en Cloudflare + desplegar el contador (pasos manuales del dueño)
├─ assets/
│  ├─ brand/                  # YA EXISTE — logos oficiales (no modificar, ver 4.0)
│  ├─ fonts/                  # YA EXISTE — fuentes autoalojadas + fonts.css + licencias OFL
│  └─ og-image.png            # se genera en la fase 7 con la propia app
├─ vendor/                    # YA EXISTE — mediabunny, d3-delaunay (+ deps). Ver vendor/README.md
├─ worker/counter/            # YA EXISTE — Cloudflare Worker del contador de visitas (sección 17)
├─ css/
│  ├─ tokens.css              # temas (variables), tipografías, radios, escalas
│  ├─ base.css                # reset, tipografía, utilidades
│  ├─ layout.css              # hero, estudio (3 columnas), responsive
│  └─ components.css          # botones, sliders, selects, toggles, dropzone, toasts, modal, contador
├─ src/
│  ├─ config.js               # URL del contador, URL del sitio, límites (sección 18) — un solo sitio para ajustes
│  ├─ main.js                 # arranque: fuentes, i18n, tema, estado, UI, loop, manejadores globales de error
│  ├─ state.js                # store global con pub/sub, persistencia localStorage, hash compartible (validado)
│  ├─ scheduler.js            # bucle rAF: render solo si "dirty" / frame de video nuevo / modo animado
│  ├─ i18n/
│  │  ├─ i18n.js              # t(), setLang(), aplica data-i18n al DOM
│  │  ├─ es.js                # export default { 'drop.title': '...', ... }
│  │  └─ en.js
│  ├─ ui/
│  │  ├─ header.js            # logo, selector de tema, ES|EN, enlace GitHub
│  │  ├─ hero.js              # demo animada + dropzone + galería de modos
│  │  ├─ dropzone.js          # drag&drop, clic, pegar (Ctrl+V), webcam, demo — con validación (18.1)
│  │  ├─ modeList.js          # lista de modos agrupados por categoría con badges
│  │  ├─ controls.js          # esquema de parámetros → DOM (slider, select, color, toggle, text, button)
│  │  ├─ viewer.js            # canvas de salida, zoom/pan, split antes/después, fullscreen, stats
│  │  ├─ transport.js         # play/pausa, scrubber, loop, velocidad, mute (video)
│  │  ├─ exportPanel.js       # botones de exportación según capacidades del modo + diálogo de video
│  │  ├─ presets.js           # guardar/cargar presets, aleatorio ("Sorpréndeme"), compartir URL
│  │  ├─ visitCounter.js      # contador de visitas del pie (sección 17)
│  │  ├─ shortcuts.js         # atajos de teclado
│  │  └─ toast.js             # notificaciones y errores
│  ├─ io/
│  │  ├─ sources.js           # ImageSource, VideoSource, WebcamSource, DemoSource (procedural)
│  │  ├─ validate.js          # tipo real por "magic bytes", tamaños y dimensiones máximas (18.1)
│  │  ├─ exportImage.js       # PNG (escala 1x/2x/4x/ancho custom), copiar imagen
│  │  ├─ exportText.js        # TXT, HTML coloreado (escapado), ANSI (24-bit / 256 / 16), .ans CP437
│  │  ├─ exportSVG.js         # helpers de SVG (paths, capas, unidades mm para plotter), texto escapado
│  │  ├─ exportVideo.js       # MP4/WebM con Mediabunny (offline, frame a frame) + fallback MediaRecorder
│  │  └─ download.js          # descarga de Blob con nombre "horain-<modo>-<fecha>.<ext>"
│  ├─ engine/
│  │  ├─ pipeline.js          # fuente → preprocesado → análisis → modo → post-FX → superficie
│  │  ├─ preprocess.js        # filtros de color (semántica CSS), nitidez, bordes, umbral
│  │  ├─ analysis.js          # buffers cacheados: rgba, luma, sobel (mag/ángulo), depth
│  │  ├─ dither.js            # difusión de error (todas las matrices) + Bayer + ruido azul
│  │  ├─ palettes.js          # paletas retro y LUTs térmicas (incluye paleta "Horain")
│  │  ├─ color.js             # modos de color de salida, mezcla, conversión rgb/hsl/lab
│  │  ├─ glyphs.js            # charsets, medición de densidad de glifos, atlas de glifos
│  │  ├─ noise.js             # Perlin/Simplex 2D/3D propios (sin dependencia)
│  │  ├─ geometry.js          # marching squares, Chaikin, clipping de líneas, orden de trazos
│  │  ├─ math3d.js            # vec3/mat4, perspectiva/ortográfica, cámara orbital
│  │  ├─ gl.js                # helpers WebGL2: programa, quad, texturas, FBO ping-pong, readPixels, context lost
│  │  ├─ depth.js             # profundidad por brillo + puente con depth.worker (IA)
│  │  └─ postfx.js            # CRT, scanlines, glow, aberración cromática, viñeta, grano (shader)
│  ├─ workers/
│  │  ├─ depth.worker.js      # transformers.js, Depth Anything V2 (solo si el usuario lo activa)
│  │  └─ heavy.worker.js      # dithering grande, pixel sort, Voronoi/Lloyd, PETSCII matching
│  └─ modes/
│     ├─ index.js             # registro y orden de modos
│     ├─ ascii.js  braille.js  ansi.js  petscii.js  matrix.js  typoportrait.js           # TEXTO
│     ├─ dither1bit.js  halftone.js  pixelart.js  led.js  thermal.js  glitch.js  pixelsort.js  # PÍXEL
│     ├─ crosshatch.js  contours.js  voronoi.js  flowfield.js  blueprint.js  vectrex.js  spiral.js  # VECTOR
│     ├─ lidar.js  hiddenwire.js  raymarch.js  volumetext.js                              # 3D
│     └─ reactiondiffusion.js                                                             # SIMULACIÓN
└─ tests/
   ├─ package.json            # solo devDependencies: @playwright/test (no afecta a Pages)
   ├─ smoke.spec.js
   └─ fixtures/               # imagen y video de prueba generados (ver 13)
```

Añade un `.gitignore` con `node_modules/`, `tests/test-results/`, `tests/playwright-report/` y `tests/screenshots/`.

---

## 3. Dependencias (ya incluidas en `vendor/`)

No hay CDN en tiempo de ejecución salvo la IA opcional: mejor privacidad, CSP estricta (`'self'`) y funciona en entornos
de pruebas sin acceso a CDNs. Detalle de versiones, licencias y cambios locales en `vendor/README.md`.

| Librería | Import | Uso |
|---|---|---|
| mediabunny 1.59.1 | `await import('../../vendor/mediabunny/1.59.1/mediabunny.min.mjs')` (relativo al módulo que importa) | Leer/escribir MP4 y WebM con WebCodecs. **Import diferido**, solo al exportar video. |
| d3-delaunay 6.0.4 | `import { Delaunay } from '../../vendor/d3-delaunay/6.0.4/index.js'` | Voronoi/Delaunay (stipple, celdas, low-poly). Funciona también dentro de workers. |
| @huggingface/transformers 4.3.0 | `import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm'` **solo en `depth.worker.js`** | Profundidad con IA, solo bajo demanda. Es la **única** excepción de CDN. |

- Ruido Perlin/Simplex, matrices de dithering, marching squares, matemáticas 3D: **implementación propia** (son pocas líneas).

**Fuentes** (autoalojadas, `<link rel="stylesheet" href="./assets/fonts/fonts.css">`, todas SIL OFL):

| Familia (`font-family`) | Uso |
|---|---|
| `Unbounded` (variable 200–900) | **Display de la marca**: titulares, nombres de modo grandes, números grandes del contador. Peso 600. |
| `Geist` (variable 100–900) | **Texto de UI**: etiquetas, botones, párrafos. Etiquetas de sección en mayúsculas 600 con `letter-spacing: .08em`. |
| `Geist Mono` (variable 100–900, incluye cajas y bloques U+2500–259F) | Valores numéricos, lecturas técnicas y **fuente por defecto del render ASCII**. |
| `JetBrains Mono`, `VT323`, `IBM Plex Mono`, `Space Mono` | Opciones extra del render ASCII. |

> Antes de medir glifos o dibujar texto en canvas: `await document.fonts.load('16px "Geist Mono"', caracteresDelSet)`.
> Pila de fuentes del render: `"<elegida>", "Geist Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace` (los símbolos
> matemáticos, flechas y katakana caerán en fuentes del sistema; centrar cada glifo en su celda).
> Braille, bloques, ANSI y PETSCII **no dependen de la fuente**: se dibujan proceduralmente en el canvas
> (puntos y rectángulos). Solo la exportación de texto usa los caracteres Unicode.

---

## 4. Identidad visual y UX

### 4.0 Marca Horain (fuente: `assets/brand/horain-design-system.pdf`)

| Archivo | Uso |
|---|---|
| `assets/brand/horain-espino.svg` | Logo principal (texto tinta `#15181E`) sobre fondos **claros**. |
| `assets/brand/horain-espino-on-dark.svg` | Logo (texto blanco) sobre fondos **oscuros**. |
| `assets/brand/horain-icon.svg` | Icono de app (cuadrado redondeado tinta + ojo lima + espino blanco) → **favicon**, `apple-touch-icon` (exportar PNG 180×180), icono del manifest. |
| `assets/brand/wire-valla.svg` | Línea de alambre "valla" → separadores de sección (como `mask-image` repetida en horizontal, color = `currentColor`). |

Paleta de marca (extraída del PDF):

| Token | Hex | Uso |
|---|---|---|
| `--horain-lime` | `#C4F169` | Acento principal: la "o" del logo, botones primarios, foco, valores activos. |
| `--horain-ink` | `#15181E` | Tinta / fondo oscuro. |
| `--horain-gray` | `#66696F` | Texto secundario en claro, etiquetas. |
| `--horain-paper` | `#F7F8FA` | Fondo claro. |
| `--horain-mist` | `#EEF0F3` | Paneles claros. |
| `--horain-lime-pale` | `#EDFAD1` | Fondos suaves de acento en el tema claro. |

**Motivos de marca** (úsalos con moderación):
- **El ojo**: círculo lima con un punto tinta desplazado (la "o" del logo). Es el **thumb de los sliders** (14 px), el indicador
  del modo activo y el **indicador de carga** (el punto "mira" alrededor dentro del círculo).
- **El espino**: anillo de alambre girando despacio alrededor del ojo = estado "procesando / exportando" (reutiliza el arte de `horain-icon.svg`).
- **La valla**: separador entre secciones de la landing y bajo el titular del hero.
- El logo **siempre** es el SVG (nunca se reescribe con una fuente). Ver guardrails de marca (18.4).

### 4.1 Temas (`css/tokens.css`)

Se aplican con `<html data-theme="horain|claro|amber|crt|paper|cad" data-tone="dark|light">`. `data-tone` decide qué logo se ve
(`horain-espino-on-dark.svg` en temas oscuros, `horain-espino.svg` en claros). Guardar elección en `localStorage` (con try/catch).
Por defecto: `horain`; si el sistema pide claro (`prefers-color-scheme: light`) y el usuario no eligió nada, `claro`.

| Token | HORAIN (defecto) | CLARO | AMBER | CRT | PAPER | CAD |
|---|---|---|---|---|---|---|
| `--bg` | `#15181E` | `#F7F8FA` | `#0B0B0A` | `#050A06` | `#EFECE4` | `#0D2A4A` |
| `--panel` | `#1B1F26` | `#FFFFFF` | `#141311` | `#0B140D` | `#E6E2D6` | `#10335A` |
| `--panel-2` | `#232830` | `#EEF0F3` | `#1C1A17` | `#102016` | `#DCD7C8` | `#163E6B` |
| `--fg` | `#F7F8FA` | `#15181E` | `#E8E4D8` | `#C8F7D2` | `#111111` | `#E6F0FF` |
| `--fg-2` (secundario) | `#A3A7AE` | `#5F636A` | `#8A8578` | `#5F8F6A` | `#5B5850` | `#8FB0D9` |
| `--accent` (rellenos) | `#C4F169` | `#C4F169` | `#FFB000` | `#39FF6A` | `#E5402A` | `#7FD4FF` |
| `--accent-text` (texto/líneas en acento) | `#C4F169` | `#4A7300` | `#FFB000` | `#39FF6A` | `#B3261E` | `#7FD4FF` |
| `--accent-ink` (texto sobre acento) | `#15181E` | `#15181E` | `#0B0B0A` | `#050A06` | `#FFFFFF` | `#0D2A4A` |
| `--accent-soft` | `rgba(196,241,105,.12)` | `#EDFAD1` | `rgba(255,176,0,.12)` | `rgba(57,255,106,.10)` | `rgba(229,64,42,.10)` | `rgba(127,212,255,.12)` |
| `--line` (bordes 1px) | `#2C313A` | `#DCDFE4` | `#2A2824` | `#183020` | `#C9C4B5` | `#2C5A8C` |
| `--danger` | `#FF6B5A` | `#C62828` | `#FF5A3C` | `#FF5A3C` | `#B3261E` | `#FF7A6B` |
| `--out-ink` (tinta de salida por defecto) | `#C4F169` | `#15181E` | `#FFB000` | `#39FF6A` | `#111111` | `#E6F0FF` |
| `--out-bg` (fondo de salida por defecto) | `#15181E` | `#F7F8FA` | `#0B0B0A` | `#050A06` | `#EFECE4` | `#0D2A4A` |

Nunca uses lima como color de **texto** sobre fondo claro (contraste insuficiente): en claro, el texto de acento es `--accent-text`.
Extras por tema: CRT añade overlay de scanlines muy sutil (`repeating-linear-gradient`, opacidad ≤ 0.06);
CAD añade cuadrícula de fondo (líneas cada 8 px y mayores cada 64 px en `--line`). Con `prefers-reduced-motion` nada se anima.

**El color por defecto de la salida** de cada modo sigue el tema (`--out-ink` / `--out-bg`) hasta que el usuario elija otro.

Radios (de la marca: icono redondeado y cápsula del logo): `--radius-sm: 6px` (inputs), `--radius-md: 12px` (paneles, tarjetas),
`--radius-pill: 999px` (botones y chips).

### 4.2 Lenguaje visual

- **Titulares** en Unbounded 600, **en minúsculas** como el logo, tracking −0.02em (`convierte imágenes y video en arte`).
- **Etiquetas de sección** en Geist 600 MAYÚSCULAS, `letter-spacing: .08em`, color `--fg-2`, numeradas: `01 / ENTRADA`, `02 / SALIDA`, `03 / AJUSTES`
  (como las etiquetas `WIRE="ESPINO"` del PDF de marca).
- Toque terminal: lecturas técnicas en Geist Mono (`160×72 · 58 fps · 12 ms`), detalles decorativos con
  **caracteres de dibujo de cajas** (`┌─┐│└┘├┤`) en el hero y en el dropzone. Los contenedores reales usan bordes CSS de 1 px `--line`.
- Botones: cápsula. **Primario** = fondo `--accent`, texto `--accent-ink`. **Secundario** = borde 1 px `--line`, hover borde `--accent-text`.
- Valores numéricos siempre en Geist Mono y alineados a la derecha.
- Micro-interacciones: al cambiar de modo, el título del modo hace un efecto "scramble" de caracteres (≤ 300 ms).

### 4.3 Layout

**Vista Inicio (sin archivo cargado)**
1. Header fijo: **logo espino** (SVG, alto 28 px) · `ESTUDIO` · `MODOS` · `ACERCA` · selector de tema `◐ HORAIN ▾` · `ES | EN` · GitHub.
2. Hero: canvas a ancho completo que ejecuta **el propio motor** sobre la fuente Demo (procedural) y rota de modo cada 4 s.
   Titular: **"convierte imágenes y video en arte"** / **"turn images & video into art"**.
   Subtítulo: "25 estilos · 100% en tu navegador · nada se sube". Debajo, una **valla** como separador.
3. **Dropzone** grande debajo del titular (ver 4.4).
4. `MODOS`: rejilla de tarjetas (una por modo) con miniatura renderizada en vivo desde la fuente Demo (pequeña, perezosa con `IntersectionObserver`), nombre, descripción de una línea y badges. Clic → abre el estudio con ese modo y la demo.
5. `ACERCA`: 3 bloques cortos (Privado · Imagen + Video · Exporta PNG/SVG/TXT/MP4/WebM), créditos de algoritmos y fuentes.
6. **Pie**: logo pequeño, **contador de visitas** (sección 17), enlace a GitHub, "hecho por ortzigar.org", licencia.

**Vista Estudio (con fuente cargada)** — `<body class="has-source">`; el hero se colapsa y el estudio ocupa la pantalla.

Escritorio (≥ 1100 px), 3 columnas:
```
┌ HEADER ───────────────────────────────────────────────────────────────────────┐
├──────────────┬──────────────────────────────────────────────┬─────────────────┤
│ 02 / SALIDA  │                                              │ 03 / AJUSTES    │
│ ▸ TEXTO      │            VISOR (canvas)                    │ ┄ ENTRADA       │
│   ASCII  TXT │   zoom/pan · split antes|después             │ ┄ IMAGEN        │
│   Braille    │                                              │ ┄ MODO: ASCII   │
│ ▸ PÍXEL      │                                              │ ┄ COLOR         │
│ ▸ VECTOR     │                                              │ ┄ POST-FX       │
│ ▸ 3D         │──────────────────────────────────────────────│ ┄ EXPORTAR      │
│ ▸ SIMULACIÓN │ ▶ ━━━━━━●━━━━━ 00:12/00:40  1× ⟲ 🔇   160×72 · 58fps │          │
└──────────────┴──────────────────────────────────────────────┴─────────────────┘
```
- Izquierda 240 px, derecha 340 px (scroll propio), centro flexible.
- Tablet (700–1099 px): lista de modos pasa a un `<select>` agrupado sobre el visor; ajustes a la derecha 300 px.
- Móvil (< 700 px): visor arriba (alto 55vh), fila horizontal desplazable de chips de modo, y los ajustes en un
  **bottom sheet** con pestañas (`IMAGEN · MODO · COLOR · EXPORTAR`). Márgenes laterales de 16 px, sin scroll horizontal.

### 4.4 Dropzone (texto exacto)

```
┌────────────────────────────────────────────────────────────┐
│                         ↓                                  │
│   Arrastra y suelta un archivo aquí, o haz clic para       │
│   seleccionarlo                                            │
│   IMG  PNG JPG WEBP GIF AVIF BMP  ·  VID  MP4 WEBM MOV     │
│   [ USAR CÁMARA ]   [ PEGAR ]   [ PROBAR DEMO ]            │
└────────────────────────────────────────────────────────────┘
```
- EN: **"Upload a file by dragging and dropping it here, or click here to select file"**.
- Borde discontinuo animado (marching ants) en estado `dragover`, color `--accent-text`.
- Todo el documento acepta soltar archivos (no solo la caja). `Ctrl/Cmd+V` pega imágenes del portapapeles.
- Validación y límites antes de decodificar (18.1). Errores: tipo no soportado, archivo demasiado grande, video que el navegador
  no puede decodificar (p. ej. HEVC `.mov` en Chrome) → toast explicando y sugiriendo MP4 H.264.
- Debajo, en pequeño: "Tus archivos no salen de tu dispositivo." / "Your files never leave your device."
- En el estudio, un botón compacto `[ CAMBIAR ARCHIVO ]` reabre el selector.

### 4.5 Controles (estilo panel de asciiart.eu, con look Horain)

Cada fila de slider:
```
Brillo                                   62%
━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━
```
- Etiqueta a la izquierda; valor a la derecha (clic → input numérico editable; Enter confirma).
- `input[type=range]` nativo estilizado (pista 2 px `--line`, tramo recorrido `--accent`, thumb = **el ojo**: círculo lima 14 px con punto tinta).
- Doble clic en la etiqueta = restaurar valor por defecto. Icono `?` con tooltip explicativo (i18n).
- Toggle tipo interruptor en cápsula (lima cuando está activo). Select con flecha `▾`. Color con muestra + hex editable.
- Cada grupo es un `<details>` con cabecera `AJUSTES DE IMAGEN ──────── ↺` (↺ restaura el grupo).
- Controles que el modo actual no usa: ocultos (no deshabilitados).
- Mientras se arrastra un slider se renderiza en **calidad borrador** (mitad de resolución); al soltar, calidad completa.

### 4.6 Visor

- Fondo de tablero de ajedrez cuando la salida tiene transparencia.
- Rueda / pinch = zoom (10 %–800 %), arrastrar = pan, botones `AJUSTAR` y `1:1`, `F` = pantalla completa.
- **Split antes/después**: línea vertical arrastrable que muestra el original a un lado.
- Esquina inferior derecha en mono: `160×72 · 58 fps · 12 ms` (resolución de trabajo, fps, tiempo de render).
  Si la calidad se reduce automáticamente (18.2), chip `CALIDAD AUTO ↓`.
- Modos 3D: arrastrar = orbitar cámara (pan con Shift), rueda = zoom de cámara (no del visor). Botón para alternar.
- Overlay con **el ojo + espino girando** y "renderizando… 43 %" para trabajos en worker.

### 4.7 Atajos

`Espacio` play/pausa · `←/→` frame anterior/siguiente (pausado) · `[` `]` modo anterior/siguiente · `R` reset del modo ·
`E` exportar · `C` copiar (texto o imagen) · `F` pantalla completa · `S` split · `?` ayuda de atajos.

---

## 5. Motor de render

### 5.1 Pipeline

```
Fuente (imagen | video | webcam | demo)
  └─▶ captura del frame → canvas de trabajo a resolución W×H (según modo y "Caracteres/Resolución")
        └─▶ preprocess: filtros de color → nitidez → bordes → umbral
              └─▶ analysis (lazy + caché): rgba, luma, sobel, depth
                    └─▶ modo.render(ctx) → superficie (canvas de salida) + datos para exportar (texto/SVG)
                          └─▶ postfx (opcional) → visor
```

- `FrameContext` que recibe cada modo:
  ```js
  {
    source,            // CanvasImageSource del frame actual (ya preprocesado a W×H)
    width, height,     // resolución de trabajo
    rgba,              // Uint8ClampedArray (lazy)
    luma(),            // Float32Array 0..1 (lazy, Rec.709)
    sobel(),           // { mag: Float32Array, angle: Float32Array } (lazy)
    depth(),           // Promise<Float32Array 0..1> (brillo o IA, según ajuste)
    time, dt,          // segundos (para modos animados)
    frameIndex,
    isVideo, isExport, // isExport = render final a máxima calidad
    quality,           // 'draft' | 'full'
    params,            // valores actuales de globales + modo
    out,               // { canvas, ctx2d | gl } superficie de salida
    gl,                // contexto WebGL2 compartido (gl.js) para modos GPU
  }
  ```
- La caché de `analysis` se invalida por `(sourceVersion, frameIndex, hash(paramsDePreprocesado), W, H)`.
- **Relación de aspecto de celda** en modos de texto: `rows = round(cols * (H_img / W_img) * cellAspect)`, con
  `cellAspect = anchoGlifo / altoLínea` medido de la fuente real (≈ 0.5–0.6). Braille: celda de 2×4 subpíxeles.
- Tamaño de la salida en pantalla = celdas × tamaño de celda; para exportar, escala 1×/2×/4× o ancho en px.

### 5.2 Preprocesado global ("AJUSTES DE IMAGEN")

Estos son los controles del panel de referencia. Aplican a todos los modos salvo que el modo los excluya.

| id | ES | EN | Tipo | Rango | Defecto |
|---|---|---|---|---|---|
| `cols` | Caracteres / Resolución | Characters / Resolution | slider | 10–600 | 120 |
| `brightness` | Brillo | Brightness | slider % | 0–200 | 100 |
| `contrast` | Contraste | Contrast | slider % | 0–300 | 100 |
| `saturation` | Saturación | Saturation | slider % | 0–300 | 100 |
| `hue` | Tono | Hue | slider ° | 0–360 | 0 |
| `grayscale` | Escala de grises | Grayscale | slider % | 0–100 | 0 |
| `sepia` | Sepia | Sepia | slider % | 0–100 | 0 |
| `invert` | Invertir colores | Invert Colors | slider % | 0–100 | 0 |
| `thresholdOn` + `threshold` | Umbral | Thresholding | toggle + slider | 0–255 | off, 128 |
| `sharpness` | Nitidez | Sharpness | slider | 0–20 | 0 |
| `edges` | Detección de bordes | Edge Detection | slider | 0–10 | 0 |
| `dither` | Mejoras de calidad | Quality Enhancements | select | ver 5.3 | Ninguno |
| `frame` | Marco transparente | Transparent frame | slider px | 0–100 | 0 |
| `flipX` / `crop` | Espejo / Recorte | Mirror / Crop | toggle / 4 sliders % | — | off / 0 |

Semántica:
- **Filtros de color**: deben dar el mismo resultado que los filtros CSS en este orden:
  `brightness → contrast → saturate → hue-rotate → grayscale → sepia → invert`.
  Ruta rápida: `ctx.filter = 'brightness(..) contrast(..) saturate(..) hue-rotate(..deg) grayscale(..) sepia(..) invert(..)'`
  al dibujar en el canvas de trabajo. **Detectar soporte** (dibujar un píxel con `invert(100%)` y leerlo); si no hay
  soporte, ruta JS con las matrices de la especificación *Filter Effects* (saturate, hueRotate, grayscale, sepia,
  con clamp a [0,1] después de cada paso). Brightness: `x·b`; contrast: `(x−0.5)·c+0.5`; invert: `a·(1−x)+(1−a)·x`.
- **Nitidez**: unsharp mask 3×3, `amount = sharpness / 4`.
- **Detección de bordes**: Sobel sobre luma. `edges/10` mezcla la magnitud con la imagen (oscureciendo bordes en modos
  de tinta, aclarando en modos de luz). En ASCII además habilita los caracteres direccionales (ver 7.1).
- **Umbral**: si está activo, `luma ≥ threshold/255 → blanco`, si no → negro (después de nitidez y bordes).
- **Marco transparente**: margen transparente de N px alrededor de la salida exportada y mostrada.

### 5.3 Dithering (`engine/dither.js`)

Opciones del select `dither` (y de los modos que dithean): `Ninguno`, `Floyd–Steinberg`, `Jarvis, Judice y Ninke (JJN)`,
`Stucki`, `Atkinson`, `Burkes`, `Sierra`, `Sierra de 2 filas`, `Sierra Lite`, `Bayer 2×2`, `Bayer 4×4`, `Bayer 8×8`,
`Bayer 16×16`, `Ruido azul`, `Aleatorio`. Opción `serpentina` (toggle) para difusión de error.

Matrices (X = píxel actual):
```
Floyd–Steinberg /16:         X 7          Atkinson /8 (propaga 6/8):   X 1 1
                         3 5 1                                   1 1 1
                                                                   1
JJN /48:            X 7 5     Stucki /42:       X 8 4     Burkes /32:     X 8 4
                3 5 7 5 3                   2 4 8 4 2                 2 4 8 4 2
                1 3 5 3 1                   1 2 4 2 1
Sierra /32:         X 5 3     Sierra 2 filas /16:  X 4 3     Sierra Lite /4:   X 2
                2 4 5 4 2                      1 2 3 2 1                    1 1
                  2 3 2
```
- Bayer: matriz generada recursivamente; umbral `(M[i][j] + 0.5) / n²`.
- Ruido azul: generar una textura 64×64 por *void-and-cluster* al arrancar (o en worker) y cachearla.
- API: `quantize(buffer, w, h, levels | palette, algorithm, { serpentine })` para escala de grises y para paletas RGB
  (distancia en espacio lineal o Lab, configurable).
- En ASCII, `dither` distribuye el error entre los **niveles del gradiente de caracteres** (mejora mucho los degradados).

### 5.4 Color de salida (grupo "COLOR", compartido)

| id | Opciones |
|---|---|
| `colorMode` | `Monocromo` · `Color original` · `Gradiente` (2–3 paradas, por luma) · `Paleta` (cuantiza al preset) |
| `ink` | color de tinta (defecto: `--accent` del tema) |
| `bg` | color de fondo (defecto: `--bg` del tema) + toggle `Fondo transparente` |
| `gradStops` | 2–3 colores |
| `palette` | **Horain** (`#15181E`, `#66696F`, `#C4F169`, `#EDFAD1`, `#F7F8FA`), 1-bit Mac, Game Boy DMG, CGA, EGA 16, C64, PICO-8, Endesga 32, Sweetie 16, Amber CRT, Green CRT, Ironbow, Personalizada (lista de hex) |
| `colorBoost` | 0–200 % (saturación extra solo en salida) |

Cada modo declara qué `colorMode` admite (p. ej. PETSCII solo `Paleta`).

### 5.5 Profundidad (`engine/depth.js`)

- `depthSource`: `Brillo` (defecto: `depth = luma`, con toggle `invertir profundidad` y `suavizado` 0–10 de blur) o `IA`.
- Botón **"Mejorar con IA (≈25–50 MB)"**: primera vez muestra un diálogo con tamaño aproximado y aviso de que se
  descarga una vez y queda en caché. Luego crea `depth.worker.js`:
  ```js
  import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
  const depth = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small',
    { device: navigator.gpu ? 'webgpu' : 'wasm' });
  ```
  Comprobar en la documentación de transformers.js de esa versión el nombre de opciones (`device`, `dtype`) y el formato
  del resultado (`depth` como `RawImage`, o `predicted_depth` como tensor); normalizar a Float32Array 0..1 en W×H.
- Progreso de descarga visible (`progress_callback`). Si falla (sin red, sin WebGPU y wasm muy lento) → toast y volver a Brillo.
- Video: la IA se ejecuta como mucho cada N frames en preview (`depthEveryN`, defecto 6, se interpola por blend) y en
  **cada frame** durante la exportación (avisar que la exportación será lenta).

### 5.6 Post-FX global (opcional, grupo "POST-FX", apagado por defecto)

Shader de pantalla completa aplicado a la salida raster: `Scanlines` (intensidad, densidad), `Curvatura CRT`,
`Glow/Bloom` (radio, intensidad), `Aberración cromática` (px), `Viñeta`, `Grano` (animado en video), `Parpadeo`.
Preset rápido `CRT completo`. No se aplica a exportaciones SVG/TXT.

### 5.7 Animación

- Modos con `animated: true` (reacción-difusión, flow fields, matrix, raymarch, LiDAR con auto-rotación, Vectrex con
  persistencia, glitch con jitter) corren el bucle aunque la fuente sea una imagen fija.
- Con imagen fija + modo animado, la exportación de video ofrece `duración` (1–60 s) y `fps`.
- `scheduler.js` solo renderiza cuando: cambian parámetros, llega un frame nuevo de video
  (`requestVideoFrameCallback` si existe; si no, rAF + `currentTime`), o el modo es animado.

---

## 6. Interfaz de un modo

```js
// src/modes/braille.js
export default {
  id: 'braille',
  category: 'text',               // 'text' | 'pixel' | 'vector' | '3d' | 'sim'
  name: { es: 'Braille', en: 'Braille Pattern Art' },
  blurb: { es: 'Puntos Braille 2×4 por carácter', en: '2×4 Braille dots per character' },
  badges: ['TXT'],                // TXT | SVG | ANIM | 3D | IA | GPU
  animated: false,
  uses: ['image', 'color'],       // grupos globales que aplica (image = 5.2, color = 5.4, depth = 5.5, postfx = 5.6)
  colorModes: ['mono', 'original', 'gradient', 'palette'],
  exports: ['png', 'txt', 'html', 'ansi', 'video'],   // 'svg', 'ply', 'json'...
  params: [
    { id: 'threshold', type: 'range', min: 0, max: 255, step: 1, default: 128,
      label: { es: 'Umbral', en: 'Threshold' }, help: { es: '...', en: '...' } },
    { id: 'dotShape', type: 'select', default: 'circle',
      options: [{ value: 'circle', label: { es: 'Círculo', en: 'Circle' } }, /* ... */] },
    { id: 'showEmpty', type: 'toggle', default: false, label: { es: 'Mostrar puntos vacíos', en: 'Show empty dots' } },
    // types: range | select | toggle | color | colors | text | button | seed
    // opcional: showIf: (p) => p.dotShape === 'circle'
  ],
  resolution(params, srcW, srcH) { /* → { width, height } de trabajo */ },
  init(ctx) { /* crear recursos (shaders, buffers); devolver estado */ },
  render(ctx, state) { /* dibujar en ctx.out; guardar en state lo necesario para exportar */ },
  toText(state, format) { /* 'txt' | 'html' | 'ansi' → string */ },
  toSVG(state, opts) { /* → string */ },
  dispose(state) {},
};
```

`modes/index.js` exporta la lista ordenada. Añadir un modo = crear archivo + registrarlo. Las claves de i18n de los
parámetros viven en el propio esquema (`label: {es, en}`) para que cada modo sea autocontenido.

---

## 7. Especificación de los 25 modos

Formato: **algoritmo** · **parámetros (rango, defecto)** · **salidas** · **notas de implementación**.
CPU/GPU indica dónde va el trabajo principal.

### TEXTO

#### 7.1 ASCII (`ascii`) — CPU
- Algoritmo: luma por celda (promedio del área de la celda, no muestra puntual) → índice en el gradiente de caracteres.
  Con `dither` ≠ Ninguno, el error de cuantización entre niveles se difunde a celdas vecinas.
  Con `edges > 0` y `edgeChars` activo: si la magnitud Sobel de la celda supera `edgeThreshold`, se usa un carácter
  según el ángulo cuantizado en 4 direcciones: `|`, `/`, `-`, `\` (estilo shader ASCII de bordes).
- Parámetros:
  - `gradient` (select) — presets en `engine/glyphs.js`, de claro a oscuro (todos empiezan con espacio):
    ```js
    export const GRADIENTS = {
      standard: ' .:-=+*#%@',
      detailed: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
      blocks:   ' ░▒▓█',
      math:     ' ·∙∘∗+±×÷=≠≈∼∝∞∫∑∏√∂∆∇≡≤≥∩∪∧∨¬∀∃∈',   // "Símbolos matemáticos" / "Math Symbols"
      arrows:   ' ←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓',
      binary:   ' 01',
      katakana: ' ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ',
      box:      ' ─│┌┐└┘├┤┬┴┼═║╬',
      dots:     ' ·•●',
      custom:   null,                                   // campo de texto
    };
    ```
  - `autoSort` (toggle, on): ordena los caracteres por **densidad de tinta medida** (renderizar cada glifo en un canvas
    offscreen con la fuente activa y contar píxeles). Imprescindible para los sets no ordenados (matemáticos, flechas, katakana).
  - `invertGradient` (toggle, off). `spaceDensity` "Densidad de espacio" (0–20, 1): repite el espacio N veces al inicio
    del gradiente → más zonas vacías en luces. `edgeChars` (toggle), `edgeThreshold` (0–1, 0.3).
  - `font` (JetBrains Mono / IBM Plex Mono / VT323 / Space Mono / Courier), `cellSize` px (6–32, 12), `lineHeight` (0.8–1.4, 1.0),
    `letterSpacing` (−2–4 px, 0).
- Render: **atlas de glifos** (un canvas con cada carácter del set dibujado una vez, en blanco) y `drawImage` por celda
  con tintado: dibujar el atlas coloreado una vez por color en modo Mono/Gradiente cuantizado; en Color original usar
  `globalCompositeOperation = 'source-in'` por lotes o fillText si es más rápido (medir). Objetivo: 160 columnas a 30 fps.
- Salidas: PNG, TXT, HTML (`<pre>` con `<span style="color">` fusionando celdas contiguas del mismo color), ANSI
  (escapes 24-bit), copiar texto, video.

#### 7.2 Braille (`braille`) — CPU
- Cada carácter = 2×4 subpíxeles. Bits: (0,0)=0x01 (0,1)=0x02 (0,2)=0x04 (1,0)=0x08 (1,1)=0x10 (1,2)=0x20 (0,3)=0x40 (1,3)=0x80.
  Carácter = `String.fromCodePoint(0x2800 + bits)`. Subpíxel encendido si luma < umbral (o > si invertido) tras dithering.
- Parámetros: `threshold` (0–255, 128), `dither` propio (defecto **Atkinson**), `invert`, `dotShape` (círculo/cuadrado),
  `dotScale` (0.3–1, 0.8), `showEmpty` (puntos apagados al 15 % de opacidad), `blankAsSpace` (exportar U+2800 como espacio).
- Render procedural de puntos (no depende de la fuente). Salidas: PNG, TXT, HTML, ANSI, video.

#### 7.3 ANSI Art (`ansi`) — CPU
- Modo **Medios bloques**: carácter `▀` con color de primer plano = píxel superior y fondo = píxel inferior (doble resolución vertical).
- Modo **Sombreado clásico**: para cada celda elegir el mejor trío (fg, bg, carácter ∈ {` `, `░`, `▒`, `▓`, `█`}) que
  minimiza el error de color (mezcla fg/bg con coberturas 0, .25, .5, .75, 1). Restricción opcional de 8 fondos (ANSI.SYS).
- Parámetros: `charMode` (medios bloques / sombreado / mixto), `palette` (VGA 16 · xterm 256 · Truecolor), `dither`, `cols`.
- Render procedural con rectángulos (estilo VGA 8×16). Salidas: PNG, TXT con escapes ANSI (UTF-8, listo para `cat` en terminal),
  **.ans** (bytes CP437: `▀`=0xDF `░`=0xB0 `▒`=0xB1 `▓`=0xB2 `█`=0xDB, con códigos SGR), HTML, video.

#### 7.4 PETSCII (`petscii`) — CPU (worker si > 40×25)
- Rejilla por defecto 40×25 celdas de 8×8 px, paleta C64 de 16 colores (paleta "Pepto"), **un color de fondo global**
  (como el C64) + color de primer plano por celda.
- Conjunto de glifos **propio inspirado en PETSCII** (no copiar la ROM): ~96 bitmaps 8×8 definidos en código como
  arrays de 8 bytes: vacíos/lleno, medios y cuartos de bloque, 1/8 de barras verticales y horizontales, diagonales y
  triángulos, líneas finas en varias posiciones, esquinas redondeadas, círculos, cuadrículas y damero.
- Matching por celda: para cada glifo, fg óptimo = color de paleta más cercano a la media de los píxeles "on";
  error = suma de distancias; elegir mínimo. Fondo global: `auto` (el color de paleta más frecuente) o manual.
- Parámetros: `grid` (40×25 · 80×50 · personalizado por `cols`), `paletteSet` (C64 · VIC-20 · PET verde monocromo),
  `bgColor` (auto/manual), `glyphSets` (toggles: bloques, líneas, diagonales, redondos), `border` (toggle + color: marco C64).
- Salidas: PNG (escala entera), TXT (aproximación con Unicode "Symbols for Legacy Computing" U+1FB00), JSON (glifos + colores), video.

#### 7.5 Lluvia Matrix (`matrix`) — CPU, animado — **extra**
- Columnas de glifos cayendo (katakana de medio ancho + dígitos) con estela; el **brillo de cada glifo se modula por la
  luma de la imagen** en esa celda, de modo que la imagen "aparece" en la lluvia. Cabeza de cada gota más brillante.
- Parámetros: `speed` (0.1–5, 1), `density` (0–1, 0.6), `trail` (4–60, 20), `imageInfluence` (0–1, 0.8), `glyphSet`,
  `ink` (defecto `#00FF41`), `glow` (0–1, 0.5), `charChangeRate` (0–1, 0.05).
- Salidas: PNG, video.

#### 7.6 Retrato tipográfico (`typoportrait`) — CPU — **extra**
- Un texto del usuario (defecto `HORAIN `) se repite llenando filas; cada letra toma el color de la imagen y/o su
  tamaño o peso varía según la luma.
- Parámetros: `text`, `font` (Archivo/Silkscreen/JetBrains Mono), `fontSize` (6–40, 12), `modulate` (color · tamaño · peso · opacidad),
  `letterSpacing`, `lineHeight`, `uppercase`.
- Salidas: PNG, SVG (`<text>` por fila con `<tspan>` coloreados), HTML.

### PÍXEL

#### 7.7 Dithering 1-bit (`dither1bit`) — GPU (Bayer/ruido azul) / CPU worker (difusión de error)
- "El filtro de imagen 1-bit (Ordered Dithering)". Reduce a 2 colores (o N niveles).
- Parámetros: `algorithm` (todas las de 5.3; defecto **Bayer 4×4**), `pixelSize` (1–16, 2), `levels` (2–8, 2),
  `bias` (−0.5–0.5, 0), `perChannel` (toggle: dithering por canal RGB → look color retro),
  `inkPaper` preset (Macintosh: `#000/#FFF` · Game Boy 2 tonos · Obra Dinn `#333319`/`#E5FFFF` · Ámbar · Fósforo verde · Personalizado).
- Render: escalar al final con `imageSmoothingEnabled = false` (píxeles nítidos). Salidas: PNG, video.

#### 7.8 Halftone / Semitono (`halftone`) — CPU (Canvas2D) + SVG
- Rejilla rotada por canal; radio de punto ∝ `sqrt(cobertura)`. Modos: **Mono**, **CMYK** (C 15°, M 75°, Y 0°, K 45°,
  conversión con UCR simple), **RGB aditivo** (fondo negro, `lighter`), **Duotono**.
- Parámetros: `cellSize` (3–40, 8), `angle` (0–90, 45) para mono, `shape` (círculo · cuadrado · diamante · línea · cruz · elipse),
  `dotGain` (0.5–1.5, 1), `paper` y tintas, `jitter` (0–1, 0) para look impreso, `misregistration` (0–4 px, 0).
- Composición `multiply` para CMYK. Salidas: PNG, **SVG** (círculos/paths por capa de tinta), video.

#### 7.9 Pixel Art / Paleta retro (`pixelart`) — CPU — **extra**
- Reducción a `pixelSize` con promedio por bloque (o mediana), cuantización a paleta (5.4) o **paleta automática k-means**
  de N colores (2–32), dithering opcional, **contorno** opcional (píxeles de borde oscurecidos), limpieza de píxeles sueltos.
- Salidas: PNG escalado con vecino más cercano (1×, 4×, 8×), PNG a resolución nativa, video.

#### 7.10 Panel LED / Dot-matrix (`led`) — CPU — **extra**
- Cada celda = LED circular; color cuantizado a `ledColor` (rojo · ámbar · verde · azul · RGB completo con N niveles);
  LEDs apagados visibles al 8 %; glow; separación.
- Parámetros: `cols`, `ledSize` (0.4–1, 0.8), `gap`, `levels` (2–16, 6), `glow`, `ledColor`. Salidas: PNG, SVG, video.

#### 7.11 Termografía e Image Gradients (`thermal`) — GPU
- Escalar → LUT de 256 colores. Fuente del escalar: `Luminancia` · `Magnitud de gradiente` · `Profundidad` · `"Calor"` (luma con
  peso extra al rojo). Sub-modo **Gradientes**: dirección del gradiente → tono, magnitud → valor (visualización HSV).
- Paletas: Ironbow, Inferno, Magma, Plasma, Viridis, Turbo, Arcoíris/Jet, Ártica, Blanco caliente, Negro caliente, Lava,
  Gradiente personalizado (usa `gradStops`).
- Parámetros: `range` min/max + `autoLevel` (toggle), `sensorRes` (80×60 · 160×120 · 320×240 · completa) con blur
  bilineal para simular sensor, `noise` (0–1), `isotherm` (rango resaltado en un color), `hud` (toggle: cruz central,
  lectura de "temperatura" ficticia, barra de escala con min/max en °C, marca de tiempo).
- Salidas: PNG, video.

#### 7.12 Glitch Art (`glitch`) — GPU, animado opcional
- Efectos combinables (cada uno con su intensidad 0–1): **Separación RGB** (offset x/y por canal), **Desplazamiento de franjas**
  (N franjas horizontales con offset aleatorio), **Corrupción de bloques** (macrobloques 8/16 px repetidos o desplazados,
  look datamosh), **Bit-crush** (1–8 bits por canal), **Artefactos DCT** (bloques 8×8 cuantizados), **Scanlines**,
  **Ruido**, **Entrelazado**.
- `seed` (con botón 🎲) y `animate` (toggle: la semilla cambia cada K frames; `rate`). Determinista para una semilla dada.
- Salidas: PNG, video.

#### 7.13 Pixel Sorting Direccional y Glitch Cuantificado (`pixelsort`) — CPU worker
- Para cada línea en la dirección `angle` (0–360, 0; recorrido con Bresenham sobre la imagen sin rotarla), se detectan
  **intervalos** y se ordenan sus píxeles por la `key`.
- Parámetros: `intervalMode` (umbral de luma · bordes · aleatorio · línea completa), `lower`/`upper` (0–1, 0.25/0.8),
  `key` (luma · tono · saturación · R · G · B), `order` (asc/desc), `maxSpan` (8–2000 px, 400), `randomness` (0–1),
  `quantize` (toggle + niveles 2–32: posteriza tras ordenar = "glitch cuantificado"), `paletteQuantize` (usa la paleta de COLOR),
  `showMask` (ver qué intervalos se ordenan).
- Video: resolución de trabajo reducida en preview (máx. 640 px de ancho); completa al exportar.
- Salidas: PNG, video.

### VECTOR

> Todos los modos vectoriales generan **polilíneas en memoria** (`[{points: Float32Array, width, color, layer}]`),
> que se dibujan en Canvas2D para el visor y se serializan a SVG para exportar. `exportSVG.js` ofrece:
> unidades en px o **mm** con tamaño de página (A4 · A3 · Carta · personalizado) y margen, solo `stroke` sin relleno
> (modo plotter), capas como `<g inkscape:groupmode="layer" inkscape:label="...">`, y **optimización de orden de trazos**
> (vecino más cercano + unir segmentos cuyos extremos coinciden) para plotters tipo AxiDraw.

#### 7.14 Grabado vectorial / Crosshatching / Pen-plotter (`crosshatch`) — CPU
- Estilos:
  - **Sombreado cruzado**: `layers` (1–6, 4) capas de líneas paralelas; capa i con ángulo `baseAngle + i·angleStep`
    y umbral `t_i` repartido en luma; una línea dibuja tramos donde `luma < t_i` (muestreo cada 1 px a lo largo de la línea).
  - **Grabado (billete)**: líneas paralelas onduladas siguiendo una distorsión suave; el grosor varía con la oscuridad
    (en SVG modo plotter: 1–4 trazos desplazados en vez de grosor).
  - **Garabato**: trazos cortos con ruido cuya densidad sigue la oscuridad.
- Parámetros: `spacing` (2–20 px, 6), `baseAngle` (0–180, 45), `angleStep` (15–90, 45), `strokeWidth` (0.2–3, 0.8),
  `minSegment` (0–20 px, 2), `wobble` (0–1, 0.1, ruido Perlin en las líneas = aspecto a mano), tinta/papel.
- Salidas: PNG, **SVG plotter**, video.

#### 7.15 Isolíneas y Topografía generativa (`contours`) — CPU
- Campo escalar = luma (o profundidad) con blur gaussiano `smooth` (0–20, 4). **Marching squares** a `levels` (2–60, 16)
  valores; unir segmentos en polilíneas; suavizar con Chaikin (`smoothIter` 0–4, 2).
- Cada `indexEvery` (2–10, 5) niveles, curva maestra más gruesa. `fillBands` (toggle): relleno de bandas hipsométricas
  con la paleta/gradiente. `labels` (toggle): números de cota sobre curvas maestras. `hillshade` (toggle): sombreado de
  relieve de fondo. `minLength` para descartar curvas cortas.
- Salidas: PNG, **SVG**, video.

#### 7.16 Voronoi, Stipple y Teselación celular (`voronoi`) — CPU worker + d3-delaunay
- **Stipple Voronoi ponderado** (Secord 2002): `points` (500–50 000, 5000) iniciales por muestreo por rechazo según
  oscuridad; `iterations` de Lloyd ponderado (0–50, 15): centroides ponderados calculados recorriendo los píxeles y
  asignándolos a la celda con `delaunay.find` (empezando por la celda del píxel anterior para que sea rápido).
  La relajación se ve **animada** en el visor (enviar puntos desde el worker cada iteración).
- Sub-estilos: **Stipple** (puntos, radio por oscuridad `minDot`–`maxDot`) · **Celdas** (cada celda rellena con su color medio,
  borde opcional → vitral/mosaico) · **Low-poly** (triángulos Delaunay con color del centroide) · **Constelación** (puntos + aristas cortas).
- Salidas: PNG, **SVG**, video (video: pocas iteraciones por frame partiendo de los puntos del frame anterior, para coherencia temporal).

#### 7.17 Campos de vectores y flujo de partículas (`flowfield`) — CPU, animado
- `particles` (500–50 000, 6000). Ángulo de la velocidad =
  `mix(ruidoPerlin(x·scale, y·scale, t), perpendicular del gradiente de la imagen (sigue contornos), imageFollow)`.
  Velocidad y opacidad moduladas por luma; reaparecen en posiciones elegidas con probabilidad ∝ oscuridad.
- Trazos acumulados en un canvas persistente con desvanecimiento `fade` (0–0.2, 0.02).
- Parámetros: `noiseScale` (0.001–0.05, 0.005), `imageFollow` (0–1, 0.7), `speed` (0.2–5, 1.5), `lifespan` (20–500, 120),
  `strokeWidth` (0.3–3, 1), `colorFrom` (imagen · paleta · tinta), `zSpeed` (evolución del ruido).
- Imagen fija: "Ejecutar N pasos" y exportar. SVG: grabar las trayectorias de las primeras `svgParticles` (≤ 3000) durante M pasos.
- Salidas: PNG, **SVG**, video.

#### 7.18 Brutalismo esquemático / Blueprint CAD (`blueprint`) — CPU
- Fondo según variante con cuadrícula fina y mayor; **bordes** (Sobel + umbral + adelgazamiento simple) vectorizados con
  marching squares sobre el mapa de bordes; **sombreado a 45°** en zonas oscuras; **cotas** automáticas (líneas de
  dimensión con flechas y medidas en "mm" sobre los bounding boxes de los 3–6 contornos mayores); marcas de centro;
  **cajetín** abajo a la derecha (TÍTULO, ESCALA 1:1, FECHA, HOJA 1/1, DIBUJÓ: HORAIN — campos editables).
- Variantes: **Blueprint** (azul `#0F3B73`, líneas blancas) · **Brutalista** (papel `#D9D6CF`, negro, acento rojo) ·
  **Pantalla CAD** (negro con capas cian/amarillo/verde estilo AutoCAD).
- Parámetros: `variant`, `edgeThreshold`, `gridSize`, `hatch` (toggle + densidad), `dimensions` (toggle + cantidad),
  `titleBlock` (toggle + textos), `lineWeight`.
- Salidas: PNG, **SVG**, video.

#### 7.19 Wireframe vectorial estilo Vectrex (`vectrex`) — Canvas2D `lighter`, animado
- Fondo negro, líneas brillantes con glow (dos pasadas: trazo grueso difuminado + núcleo fino, `globalCompositeOperation='lighter'`).
- Sub-estilos: **Terreno** (N líneas horizontales desplazadas hacia arriba por la luma, con oclusión opcional tipo
  "Unknown Pleasures": rellenar con negro bajo cada línea antes de dibujar la siguiente) · **Contornos** (isolíneas de
  pocos niveles) · **Malla** (rejilla desplazada en perspectiva).
- Parámetros: `lines` (10–200, 60), `displacement` (0–200 px, 60), `lineWidth`, `glow` (0–1, 0.6), `ink` (`#CFE8FF` · verde · personalizado),
  `persistence` (0–0.95, 0.6: estela de fósforo entre frames), `jitter` (0–2 px), `flicker` (0–1), `overlay` (degradado de color tipo lámina de Vectrex).
- Salidas: PNG, **SVG** (sin glow), video.

#### 7.20 Espiral de una línea / Squiggle (`spiral`) — CPU — **extra**
- **Espiral** de Arquímedes continua desde el centro; a lo largo de ella, una onda cuya amplitud ∝ oscuridad (una sola línea = ideal plotter).
  **Squiggle**: misma idea en líneas horizontales.
- Parámetros: `style` (espiral/squiggle), `turns` / `lines` (20–200), `maxAmplitude`, `frequency`, `strokeWidth`.
- Salidas: PNG, **SVG plotter**, video.

### 3D

> Requieren profundidad (5.5). Comparten `math3d.js` y la cámara orbital: `yaw`, `pitch`, `distance`, `fov`,
> `autoRotate` (velocidad), arrastre para orbitar. Botón `REINICIAR CÁMARA`.

#### 7.21 Escaneado LiDAR y nube de puntos (`lidar`) — WebGL2 `gl.POINTS`
- Un punto cada `step` px (1–16, 3); posición (x, y, depth·`depthScale`); proyección perspectiva.
- `colorBy`: profundidad (rampa Turbo) · altura · color original · tinta; `pointSize` (0.5–6, 1.5) con atenuación por distancia.
- **Barrido de escaneo**: plano que recorre la profundidad resaltando puntos cercanos (`scanSpeed`, `scanWidth`, color);
  `ringMode` (puntos alineados en anillos/scanlines como un sensor real); `noise` (jitter); `dropout` (pérdida de puntos 0–0.8).
- Salidas: PNG, video, **PLY** (ASCII: `x y z r g b`).

#### 7.22 Wireframe CAD con ocultación de líneas (`hiddenwire`) — WebGL2
- Malla de alturas desde la profundidad (`meshRes` 20–200, 80). **Ocultación**: pasada 1 dibuja triángulos rellenos del color
  de fondo con `polygonOffset`; pasada 2 dibuja las aristas con test de profundidad. Opcional `hiddenDashed`: aristas ocultas
  en discontinuo tenue (pasada 3 con `depthFunc(GREATER)` y patrón de guiones en el shader).
- `topology`: solo filas · solo columnas · rejilla · triángulos. `camera`: perspectiva · isométrica · ortográfica frontal/superior.
  `style`: blanco sobre negro · negro sobre blanco técnico · CAD cian.
- SVG: muestrear cada arista en k puntos contra el depth buffer leído (`readPixels` de un render de profundidad) y emitir
  solo los tramos visibles.
- Salidas: PNG, **SVG**, video.

#### 7.23 ASCII y geometría raymarched 3D (`raymarch`) — WebGL2 → ASCII, animado
- Escena SDF a resolución de celdas (cols×rows; un píxel del render = una celda) con raymarching en fragment shader:
  `shape` = Toroide (homenaje a donut.c) · Esfera · Cubo redondeado · Octaedro · Giroide · Morph (unión suave animada).
- La imagen subida se proyecta como **textura** (mapeo triplanar o esférico) y opcionalmente como **desplazamiento** de la superficie.
- Lectura con `readPixels` (es pequeño) → luma + color por celda → **reutilizar el renderer de glifos de 7.1**.
- Parámetros: `shape`, `rotX`/`rotY` velocidad, `zoom`, `lightAngle`, `textureMix` (0 = solo sombreado, 1 = imagen), `displace` (0–1),
  y los de gradiente de caracteres de ASCII.
- Salidas: PNG, TXT/HTML (frame actual), video.

#### 7.24 ASCII / Braille 3D con shaders de volumen (`volumetext`) — WebGL2 → texto, animado
- La imagen + profundidad se convierte en un **relieve/volumen** (heightfield extruido) que se raymarchea (avanzar el rayo hasta quedar
  bajo la altura, refinar con bisección), con normales del gradiente de profundidad, luz lambert/toon, oclusión ambiental barata y niebla.
- Salida en `charset`: **ASCII** (gradiente de 7.1) · **Braille** (render a 2×4 subpíxeles por celda y umbral → 7.2) · **Bloques**.
- Parámetros: `heightScale` (0–2, 0.6), `tilt` (0–80°, 35), `orbitSpeed`, `lightDir`, `fog` (0–1), `shading` (lambert/toon), `colorBy`.
- Salidas: PNG, TXT/HTML (frame actual), video.

### SIMULACIÓN

#### 7.25 Autómatas celulares y Reacción-Difusión (`reactiondiffusion`) — WebGL2 ping-pong, animado
- **Reacción-difusión Gray-Scott** en textura RG flotante (comprobar `EXT_color_buffer_float`; si no, half float; si no,
  RGBA8 empaquetado). `f` y `k` se **interpolan según la luma** de la imagen (`f = mix(fA, fB, luma)`), así el patrón dibuja la imagen.
- Presets (f, k): Coral 0.0545/0.062 · Mitosis 0.0367/0.0649 · Laberinto 0.029/0.057 · Gusanos 0.078/0.061 · Puntos 0.035/0.065 ·
  Huellas 0.055/0.062 (ajustar a ojo, mostrar los valores en sliders `fA`,`fB`,`kA`,`kB`).
- Parámetros: `stepsPerFrame` (1–60, 20), `Du`/`Dv` (1.0/0.5), `imageInfluence` (0–1, 0.8), `simScale` (0.25–1),
  `seed` (bordes de la imagen · aleatorio · centro), colorización (dos colores / gradiente / paleta), botón `REINICIAR`.
- Sub-modo **Autómata celular**: Juego de la Vida y reglas `B/S` (B3/S23 · HighLife B36/S23 · Day&Night B3678/S34678 ·
  Seeds B2/S · personalizada en texto), sembrado con la imagen ditheada; `imageLock` (0–1): probabilidad de re-sembrar
  celdas según la imagen cada frame para que la imagen persista.
- Video: la imagen actual modula f/k continuamente. Salidas: PNG, video.

---

## 8. Entrada (`io/sources.js`)

| Fuente | Implementación |
|---|---|
| Imagen | `createImageBitmap(file, { imageOrientation: 'from-image' })`. Si el lado mayor > 4096 px, reducir para trabajar (mantener el original para exportar a 1:1 si el modo lo permite). GIF animado: solo primer frame (aviso). |
| Video | `<video muted playsinline loop>` oculto con `URL.createObjectURL(file)`. Preview con `requestVideoFrameCallback`. Mostrar duración, fps estimado, resolución. |
| Webcam | `getUserMedia({ video: { width: 1280, height: 720 } })`, selector de cámara si hay varias, espejo por defecto. Grabación con MediaRecorder (sección 9). |
| Pegar | evento `paste` con `image/*`. |
| Demo | `DemoSource`: canvas procedural animado (gradientes, esfera sombreada, letras HORAIN, formas en movimiento) → sirve como imagen y como "video" sin archivos con licencia. |

Revocar los object URLs al cambiar de fuente. Al cambiar de fuente se conservan modo y parámetros.

---

## 9. Exportación

### 9.1 Imagen / texto
- **PNG**: render en un canvas offscreen a la escala elegida (1×, 2×, 4× o ancho en px), `isExport = true`, con marco
  transparente aplicado. `canvas.toBlob('image/png')`.
- **Copiar**: imagen con `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`; texto con `writeText`.
  Si falla (permisos/Safari), descargar y avisar.
- **TXT / HTML / ANSI / .ans / SVG / PLY / JSON** según `exports` del modo.
- Nombres: `horain-<modo>-<YYYYMMDD-HHMMSS>.<ext>`.

### 9.2 Video (MP4 y WebM) — `io/exportVideo.js`
Diálogo: formato (MP4 / WebM), fps (original · 24 · 30 · 60), calidad (baja · media · alta · muy alta), resolución de
salida (alto 480 · 720 · 1080 · original; ancho par), **incluir audio** (toggle), **recorte** inicio/fin, y para imagen
fija + modo animado, **duración**.

**Ruta principal — Mediabunny `Conversion` con `video.process`** (render offline frame a frame, determinista, conserva audio):
```js
const { Input, Output, Conversion, BlobSource, BufferTarget, ALL_FORMATS,
        Mp4OutputFormat, WebMOutputFormat, QUALITY_HIGH } = await import('../../vendor/mediabunny/1.59.1/mediabunny.min.mjs');

const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
const output = new Output({
  format: fmt === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
  target: new BufferTarget(),
});
const conversion = await Conversion.init({
  input, output,
  trim: { start, end },
  video: {
    frameRate: fps,               // omitir para mantener el original
    quality: QUALITY_HIGH,
    forceTranscode: true,
    processedWidth: outW, processedHeight: outH,
    process: async (sample) => {  // VideoSample → CanvasImageSource
      engine.setFrameFromSample(sample);  // sample.draw(ctx, 0, 0, w, h) en el canvas de trabajo
      await engine.renderExportFrame(sample.timestamp);
      return engine.outputCanvas;         // canvas de outW×outH
    },
  },
  audio: includeAudio ? {} : { discard: true },   // Mediabunny copia o transcodifica (p. ej. AAC→Opus para WebM)
});
if (!conversion.isValid) { /* mostrar conversion.discardedTracks y caer al fallback */ }
conversion.onProgress = (p) => ui.progress(p);
await conversion.execute();                 // botón CANCELAR → conversion.cancel()
download(new Blob([output.target.buffer], { type: fmt === 'mp4' ? 'video/mp4' : 'video/webm' }));
```
- Confirmar los nombres exactos contra `mediabunny.d.ts` de la versión fijada (1.59.1): `ConversionVideoOptions.process`,
  `processedWidth/Height`, `QUALITY_*`, `BufferTarget.buffer`, `Conversion.cancel()` existen en esa versión.
- Antes de exportar, comprobar codecs con `canEncodeVideo` / `getFirstEncodableVideoCodec` (MP4 → `avc`, alternativa `hevc`;
  WebM → `vp9`, alternativa `vp8`/`av1`). Si no hay codec, ofrecer el otro formato.
- **Imagen fija + modo animado / webcam**: no hay `Input`; usar `Output` + `CanvasSource` (añadir pista de video al
  `Output`, `output.start()`, `await canvasSource.add(t, 1/fps)` por frame, `output.finalize()`). Revisar la API de
  `CanvasSource` en el `.d.ts` antes de implementarlo.
- Modos animados durante la exportación: usar el **tiempo del frame** (`sample.timestamp`), no el reloj real, para que
  el resultado sea determinista.
- UI de progreso: `[████████░░░░] 64% · 00:12 restante`, cancelable. Avisar si duración > 2 min o resolución > 1080p.

**Fallback — tiempo real con MediaRecorder** (si no hay WebCodecs, o no hay codec):
`outputCanvas.captureStream(fps)` + pista de audio del `<video>` (`video.captureStream()` o `AudioContext` →
`MediaStreamDestination`), `MediaRecorder` con el primer `mimeType` soportado de
`['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']`.
Reproduce el video en tiempo real a 1× mientras graba. También se usa para **grabar la webcam**.

---

## 10. Estado, presets y compartir (`state.js`, `ui/presets.js`)

- Estado: `{ lang, theme, modeId, global: {...}, color: {...}, depth: {...}, postfx: {...}, modes: { [id]: {...} } }`.
  Los parámetros de cada modo se recuerdan al cambiar de modo.
- `localStorage` (con try/catch): tema, idioma, último modo y parámetros. La app funciona igual si falla.
- **Compartir**: botón que serializa el estado (sin la fuente) a JSON → base64url en `#s=...`; al cargar, se aplica.
- **Presets**: 2–3 presets curados por modo (p. ej. ASCII: "Clásico", "Matrix", "Bloques color") + guardar/exportar/importar JSON propios.
- **Sorpréndeme**: aleatoriza los parámetros del modo actual dentro de rangos "bonitos" (cada parámetro puede declarar `randomRange`).

---

## 11. i18n

- `t(key, vars)` con interpolación `{n}`; fallback a EN y luego a la clave.
- Atributos `data-i18n="key"` y `data-i18n-attr="placeholder:key"` en el HTML estático; `applyI18n(root)` al cambiar idioma.
- `<html lang>` actualizado. Las etiquetas de parámetros vienen del esquema de cada modo (`{es, en}`).
- Textos clave obligatorios: dropzone (4.4), estados de error (archivo no soportado, codec, sin WebGL2, sin cámara,
  descarga de IA), privacidad ("Todo se procesa en tu navegador; nada se sube."), atajos.

---

## 12. Fases (orden de implementación)

Cada fase termina con: smoke test Playwright verde (sección 13), sin errores de consola, guardrails revisados (18), commit y push.

### Fase 0 — Esqueleto, marca y despliegue
- `index.html` (con CSP en `<meta>`, 18.3), `fonts.css` enlazado, CSS de tokens/base/layout/components con los **6 temas** (4.1),
  `.nojekyll`, `.gitignore`, `src/config.js`, header con **logo espino** que cambia según `data-tone`, favicon y `apple-touch-icon`
  desde `horain-icon.svg`, selector de tema y ES|EN, i18n funcionando, layout de las vistas Inicio y Estudio (vacías),
  dropzone funcional (archivo, soltar, pegar, demo) **con validación** (18.1), manejadores globales de error (18.2).
- **Aceptación**: el sitio carga sin errores ni violaciones de CSP; cambiar tema e idioma funciona y se recuerda; soltar una
  imagen pasa a la vista Estudio y la muestra en el visor sin procesar; un `.txt` renombrado a `.png` se rechaza con un toast.

### Fase 1 — Motor + ASCII completo (MVP)
- `pipeline`, `preprocess` (todos los ajustes de 5.2), `analysis`, `dither` (todas las matrices), `glyphs` (densidad, atlas),
  `color` (4 modos), `controls.js` (esquema → DOM), `viewer.js` (zoom/pan/split/stats), `scheduler`.
- Modo **ASCII** completo con todos sus parámetros (7.1). Exportar PNG / TXT / HTML / ANSI / copiar.
- **Aceptación**: el panel reproduce el de referencia (Characters, Brightness, Contrast, Saturation, Hue, Grayscale,
  Sepia, Invert, Thresholding, Sharpness, Edge Detection, ASCII gradient, Space Density, Quality Enhancements (JJN, etc.),
  Transparent frame) y cada control cambia el resultado en vivo; 160 columnas ≥ 30 fps en portátil medio; el HTML exportado
  escapa los caracteres `& < > " '` del gradiente personalizado.

### Fase 2 — Video y webcam
- `VideoSource`, `WebcamSource`, `transport.js`, `exportVideo.js` (Mediabunny MP4/WebM con audio + fallback MediaRecorder),
  diálogo y progreso, aviso > 2 min, grabación de webcam.
- **Aceptación**: un video con audio de 10 s se exporta en ASCII con audio sincronizado y la duración correcta (MP4 donde el
  navegador codifique H.264; WebM siempre); cancelar funciona y libera memoria; sin WebCodecs se usa el fallback.

### Fase 3 — Modos de texto y píxel
- Braille, ANSI, PETSCII, Matrix, Retrato tipográfico, Dithering 1-bit, Halftone, Pixel art, LED, Termografía, Glitch, Pixel sort.
- `heavy.worker.js` con cancelación por `jobId` y watchdog (18.2). `modeList.js` con categorías y badges.

### Fase 4 — Modos vectoriales + SVG
- `geometry.js`, `exportSVG.js` (mm, páginas, capas, orden de trazos). Grabado/Crosshatch, Isolíneas, Voronoi/Stipple/Low-poly,
  Flow fields, Blueprint CAD, Vectrex, Espiral.
- **Aceptación**: los SVG abren bien en Inkscape/navegador, en modo plotter no tienen rellenos, y el texto del cajetín está escapado.

### Fase 5 — Profundidad y 3D
- `depth.js` (brillo + IA en worker con progreso y caché), `math3d.js`, cámara orbital. LiDAR (+PLY), Wireframe oculto (+SVG),
  Raymarch ASCII, Volumen texto ASCII/Braille. Manejo de pérdida de contexto WebGL (18.2).
- **Aceptación**: los 4 modos funcionan con profundidad por brillo sin descargar nada; "Mejorar con IA" pide confirmación,
  descarga una vez, muestra progreso y mejora visiblemente el relieve (no comprobable en el entorno de pruebas sin CDN: dejar
  el camino probado con un mock del worker).

### Fase 6 — Simulación
- Reacción-difusión GPU + Autómatas celulares. Presets.

### Fase 7 — Landing, contador, pulido y calidad
- Hero con demo animada rotando modos, galería de modos con miniaturas en vivo, sección Acerca, **pie con contador de visitas**
  (17, cliente `visitCounter.js`; el Worker ya existe en `worker/counter/`), presets curados, compartir URL (validado, 18.3),
  Sorpréndeme, Post-FX global, atajos y su ayuda, `og-image.png` (generada con la app, con el logo), metadatos Open Graph/Twitter
  con `siteUrl` de `config.js`, `site.webmanifest` con el icono, revisión de accesibilidad y móvil, README final con capturas.
- **Aceptación**: Lighthouse accesibilidad ≥ 95; sin scroll horizontal a 360 px; todos los modos visitados en el smoke test;
  con `counterUrl` vacío el contador no aparece y no hay errores; con un servidor de prueba local el contador muestra el número.

---

## 13. Pruebas (`tests/`)

- `tests/package.json` con `@playwright/test` **1.56.1** (exacta: es la versión cuyo Chromium, revisión 1194, ya está instalado en
  `/opt/pw-browsers`; `PLAYWRIGHT_BROWSERS_PATH` ya apunta ahí). **No ejecutar `playwright install`.** Servir la raíz con
  `python3 -m http.server 8080` (o `webServer` en `playwright.config.js`).
- Ese Chromium **no codifica H.264**: los tests de exportación usan **WebM**; MP4 se prueba con `canEncodeVideo('avc')` y se
  salta (`test.skip`) si no está disponible, nunca se marca como pasado.
- El entorno de pruebas **no tiene acceso a CDNs** (jsDelivr, unpkg, Hugging Face): por eso todo está en `vendor/`. La IA de
  profundidad se prueba con un worker simulado.
- Fixtures **generados** (sin archivos con licencia): `make-fixtures.mjs` crea `fixture.png` (degradados + formas + texto) y
  `fixture.webm` de 3 s con audio (con Mediabunny en una página de test: `CanvasSource` + `AudioBufferSource` de un tono).
- `smoke.spec.js`:
  1. Carga la página: sin errores de consola ni violaciones de CSP (`securitypolicyviolation`).
  2. Carga `fixture.png` vía `setInputFiles`; para **cada modo** del registro: seleccionarlo, esperar render, comprobar que el
     canvas no es uniforme (varianza de píxeles > 0) y guardar captura en `tests/screenshots/<modo>.png`.
  3. Cambiar tema (los 6) e idioma; comprobar textos y que el logo correcto es visible.
  4. ASCII: exportar TXT y verificar que tiene `rows` líneas de `cols` caracteres.
  5. Guardrails: archivo falso (texto con extensión `.png`) rechazado; hash `#s=` manipulado (valores fuera de rango, claves
     extrañas, `<script>`) se ignora o se recorta sin errores; texto con `<img onerror>` en el retrato tipográfico sale escapado en HTML/SVG.
  6. (Fase 2+) Cargar `fixture.webm`, exportar WebM corto y verificar que el blob tiene tamaño > 0 y tipo correcto.

Matriz manual antes de cerrar cada fase: Chrome/Edge (principal), Firefox, Safari 17+ (si es posible), Chrome Android.

---

## 14. GitHub Pages y dominio

Los pasos manuales (repo público, activar Pages, DNS en Cloudflare, verificar dominio, HTTPS, desplegar el contador) están en
**`DEPLOY.md`**. Para el código basta con:
1. `.nojekyll` en la raíz.
2. Sin cabeceras COOP/COEP (Pages no las permite): transformers.js funciona sin `SharedArrayBuffer` (wasm de un hilo o WebGPU).
3. Rutas relativas: debe funcionar en `https://ortzigaraio.github.io/Dither-art/` y en `https://dither.ortzigar.org/`.
4. **No crear el archivo `CNAME`**: lo crea GitHub al configurar el dominio en Settings → Pages (ver guardrail 18.5).

---

## 15. Rendimiento — presupuesto

| Caso | Objetivo |
|---|---|
| ASCII 160 col, video 720p | ≥ 30 fps preview |
| Braille 200 col, imagen | < 30 ms por render |
| Dithering de error 1080p | < 300 ms en worker |
| Pixel sort 1080p | < 1 s en worker, con overlay de progreso |
| Voronoi 10 000 puntos, 15 iteraciones | < 3 s en worker, animado |
| Export MP4 1080p 30 fps, ASCII | ≥ 0.5× tiempo real en portátil medio |

Técnicas: canvases y buffers reutilizados (no crear arrays por frame), atlas de glifos cacheados por (fuente, tamaño, color),
`OffscreenCanvas` en workers cuando exista, transferir `ArrayBuffer` (no copiar), calidad borrador al arrastrar sliders,
cancelar trabajos obsoletos.

---

## 16. Respuestas del dueño (resueltas)

| Pregunta | Respuesta |
|---|---|
| ¿Logo propio? | Sí: logo **espino** (`assets/brand/`). Colores y tipografías de marca en 4.0. |
| ¿Dominio? | Repo público + Pages + **subdominio de ortzigar.org** vía Cloudflare (`dither.ortzigar.org`, ya configurado; ver `DEPLOY.md`). |
| ¿Estadísticas? | **Contador de visitas público** (sección 17). |
| ¿Límite de video? | **Aviso** a partir de 2 min, sin bloqueo (más los límites técnicos de 18.1). |
| ¿GIF? | Más adelante; `exportVideo.js` debe tener una tabla de formatos donde añadir `gif` sea un caso más. |

---

## 17. Contador de visitas

**Backend (ya escrito)**: `worker/counter/` — Cloudflare Worker + base de datos D1. Lo despliega el dueño (`DEPLOY.md`).
- `POST /hit` → suma 1 al total y al día actual, devuelve `{ "total": n, "today": m }`.
- `GET /count` → devuelve los mismos números sin sumar.
- Sin cookies, **sin guardar IPs** ni user-agents; solo dos contadores. CORS solo para los orígenes permitidos
  (`ALLOWED_ORIGINS`), límite de peticiones por IP con el binding de rate limiting (si está configurado), `Cache-Control: no-store`.

**Cliente** (`src/ui/visitCounter.js`, fase 7):
- `config.counterUrl` vacío → el contador **no se muestra** (y no se hace ninguna petición).
- Una visita = un navegador por día: si `localStorage['horain.visit']` ≠ fecha de hoy (UTC) → `POST /hit` y guardar la fecha;
  si ya contó hoy → `GET /count`. Si el navegador envía **Global Privacy Control** (`navigator.globalPrivacyControl === true`)
  → solo `GET /count` (se muestra, no se cuenta).
- `fetch` con `AbortController` (timeout 4 s), `credentials: 'omit'`, `cache: 'no-store'`. Cualquier fallo → ocultar el contador en silencio.
- Diseño: odómetro retro en el pie, `VISITAS` en Geist 600 mayúsculas + 6 dígitos (relleno con ceros) en **Unbounded 600**, cada dígito
  en una celda `--panel-2` con borde `--line`; los dígitos ruedan (CSS transform) desde 0 al valor al entrar en pantalla
  (sin animación con `prefers-reduced-motion`). Debajo, en `--fg-2`: "hoy: 42". `aria-label="Visitas totales: 1234"`.
- Mencionarlo en `ACERCA`/privacidad: "Contamos visitas de forma anónima: un número, sin cookies ni datos personales."

`src/config.js` exporta `counterUrl: ''` (vacío hasta que el dueño despliegue el Worker; luego `'https://count.ortzigar.org'`, ya permitido en la CSP)
y `siteUrl: 'https://dither.ortzigar.org/'` (para Open Graph y `<link rel="canonical">`).

---

## 18. Guardrails

Reglas de seguridad y calidad. **Tienen prioridad** sobre el resto del plan. Los valores numéricos viven en `src/config.js`
(`LIMITS`) para poder ajustarlos en un solo sitio.

### 18.1 Entrada de archivos

| Regla | Valor |
|---|---|
| Tipos aceptados | Imagen: PNG, JPEG, WebP, GIF (1.er frame), AVIF, BMP. Video: MP4, WebM, MOV (QuickTime). **No** SVG, PDF, HEIC ni otros. |
| Validación de tipo | Por **magic bytes** (`io/validate.js`, leer los primeros 32 bytes), no por extensión ni por `file.type`. |
| Tamaño máximo de imagen | 50 MB de archivo y 100 megapíxeles; si el lado mayor > 4096 px se reduce para trabajar. |
| Tamaño máximo de video | 2 GB de archivo (aviso a partir de 500 MB). Duración: **aviso** a partir de 2 min (sin bloqueo). |
| Decodificación | Siempre dentro de `try/catch`; un archivo corrupto muestra un toast y deja la app usable. |
| Un archivo a la vez | Soltar varios → se usa el primero y se avisa. |

### 18.2 Robustez y rendimiento en ejecución

- Manejadores globales `error` y `unhandledrejection` → toast + registro en consola; la app nunca queda en blanco.
- Cada `mode.render()` va en `try/catch`: si falla, se muestra la fuente original con un chip `ERROR EN EL MODO` y el resto sigue funcionando.
- **Watchdog**: trabajos de worker > 30 s → ofrecer cancelar. Render de preview > 200 ms durante 5 frames seguidos → bajar la
  resolución de trabajo automáticamente (chip `CALIDAD AUTO ↓`); al exportar, siempre calidad completa.
- Límites duros de parámetros (aunque el estado diga otra cosa): columnas ≤ 600, partículas ≤ 50 000, puntos Voronoi ≤ 50 000,
  pasos de reacción-difusión por frame ≤ 60, resolución de exportación ≤ 8192 px de imagen y ≤ 3840×2160 de video.
- Memoria: `ImageBitmap.close()`, `VideoFrame/VideoSample.close()`, `URL.revokeObjectURL()` al cambiar de fuente, liberar
  texturas/FBO de WebGL al cambiar de modo, `getUserMedia` se detiene (`track.stop()`) al salir de la cámara.
- WebGL: escuchar `webglcontextlost` / `webglcontextrestored`, recrear recursos y avisar. Sin WebGL2 → los modos GPU se muestran
  deshabilitados con explicación.
- Sin WebCodecs → fallback MediaRecorder. Sin `getUserMedia` → se oculta el botón de cámara. Sin `OffscreenCanvas` → ruta en hilo principal.
- Pestaña oculta (`visibilitychange`) o visor fuera de pantalla → pausar el bucle. Móvil: fps máximo 30 y valores por defecto más bajos.
- Exportación: un único trabajo a la vez, botón cancelar que limpia todo, confirmación con tamaño estimado si > 2 min o > 1080p.

### 18.3 Seguridad y privacidad

- **Nada de lo que el usuario carga sale del navegador.** Las únicas peticiones de red permitidas son: archivos del propio sitio,
  el contador (`config.counterUrl`, sin datos del usuario) y, solo tras pulsar "Mejorar con IA", jsDelivr + Hugging Face.
- **CSP** en `<meta http-equiv="Content-Security-Policy">` (primera etiqueta del `<head>`, antes de cualquier script):
  ```
  default-src 'self';
  script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  img-src 'self' blob: data:;
  media-src 'self' blob:;
  connect-src 'self' blob: data: https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://count.ortzigar.org;
  object-src 'none'; base-uri 'self'; form-action 'none'
  ```
  Comprobar en los tests que no hay violaciones (`securitypolicyviolation`). Si la descarga del modelo de IA necesita otro host,
  añadir solo ese host y anotarlo en "Desviaciones".
- **XSS**: nunca `innerHTML` con texto del usuario (nombre de archivo, gradiente personalizado, texto del retrato tipográfico, campos
  del cajetín, presets importados, estado del hash). Usar `textContent`/`setAttribute`. Las exportaciones HTML y SVG escapan
  `& < > " '` con una función común `escapeXml()` en `io/exportText.js`.
- **Estado externo** (hash `#s=`, presets JSON importados, `localStorage`): `JSON.parse` en `try/catch` y validación contra el esquema:
  solo claves conocidas, números recortados a `min/max`, enums de una lista blanca, strings ≤ 500 caracteres. Nunca `eval` ni `new Function`.
- Enlaces externos con `rel="noopener noreferrer"`.
- Sin cookies, sin analítica de terceros, sin fuentes ni scripts de Google en tiempo de ejecución.
- No hay contenido generado por usuarios publicado en el sitio (nada se comparte en servidor), así que no hace falta moderación.
- **Secretos**: nunca en el repo. `config.counterUrl` es pública (no es un secreto). Los tokens de Cloudflare solo en la máquina del dueño.

### 18.4 Marca

- El logo siempre es uno de los SVG de `assets/brand/`; **no** recolorear, deformar, recortar, animar las letras ni reescribirlo con una fuente.
- Usar `horain-espino-on-dark.svg` en temas oscuros y `horain-espino.svg` en claros. Alto mínimo 24 px. Espacio libre alrededor ≥ alto de la "o".
- No colocar el logo sobre el canvas de arte ni sobre fondos con mucho ruido.
- No modificar ni borrar nada dentro de `assets/brand/`.

### 18.5 Desarrollo (agentes)

- Trabajar **solo** en la rama asignada. Nunca hacer push a `main`, nunca `push --force`, nunca reescribir historia.
- No borrar ni reescribir `PLAN.md`, `CLAUDE.md`, `DEPLOY.md`, `assets/brand/`, `assets/fonts/`, `vendor/` ni `worker/counter/`
  (sí se pueden **añadir** notas en "Desviaciones" al final de este plan).
- No añadir frameworks, bundlers ni dependencias nuevas; no cargar nada de CDNs salvo la excepción de la IA.
- No crear `CNAME` ni tocar configuración de DNS, Cloudflare o GitHub Pages: eso lo hace el dueño siguiendo `DEPLOY.md`.
- No desactivar, saltar ni debilitar tests, la CSP o la validación para "poner verde". Si algo no se puede resolver tras 3 intentos,
  anotarlo en "Desviaciones" con el motivo y seguir con la siguiente tarea.
- No subir archivos binarios > 1 MB (salvo los ya existentes); los fixtures se generan.
- Antes de cada commit: smoke test verde, sin errores de consola ni violaciones de CSP, `git status` limpio de basura (`node_modules`, capturas).

---

## 19. Desviaciones

Registro de cambios respecto a este plan, decididos durante la implementación (fecha, qué, por qué). Vacío por ahora.

### Fases 0 y 1 (2026-10-08)

**Archivos y estructura**
- Añadidos respecto a la sección 2: `src/boot.js` (aplica tema e idioma guardados antes del primer pintado; es un archivo externo porque la CSP prohíbe scripts inline), `src/studio.js` (controlador del estudio: estado, controles, visor, pipeline, scheduler y exportaciones; `main.js` queda como arranque), `src/ui/inputPanel.js` (grupo ENTRADA), `src/ui/scramble.js` (efecto de 4.2), `assets/icons/apple-touch-icon.png` (180×180, rasterizado desde `horain-icon.svg` con `tests/make-icons.mjs`, sin tocar `assets/brand/`).
- Pruebas: además de `smoke.spec.js` hay `engine.spec.js`, `controls.spec.js`, `guardrails.spec.js`, `i18n.spec.js` y `layout.spec.js`, más `helpers.js` y `global-setup.mjs` (que genera los fixtures). `.gitignore` añade `tests/fixtures/` (se generan en cada máquina; el plan solo listaba cuatro entradas) y `.DS_Store`.
- `webServer` de Playwright con `stdout/stderr: 'ignore'` (el log de `http.server` ensuciaba la salida).

**Entrada y validación (18.1)**
- `io/validate.js` lee **64 bytes** (no 32) para ver el `DocType` de WebM y las marcas compatibles de ISO-BMFF (AVIF frente a HEIC). Para rechazar imágenes de más de 100 MP antes de decodificar lee además la cabecera de dimensiones (PNG, GIF, BMP, WebP, y hasta 256 KB para JPEG / 16 KB para AVIF).
- Los **videos** se reconocen por magic bytes pero todavía no se abren (fase 2): muestran un aviso "el video llegará pronto". El botón USAR CÁMARA no se muestra hasta la fase 2 (`dropzone.addAction` ya permite añadirlo).
- La demo (`DemoSource`) dibuja "HORAIN" en mayúsculas con Geist Mono, no con Unbounded en minúsculas, para que no se confunda con el logo (18.4).

**Motor y modo ASCII**
- `dither` y `serpentine` viven en el grupo global IMAGEN (5.2); `serpentine` está apagado por defecto.
- **Polaridad**: los píxeles claros reciben glifos densos cuando el fondo de salida es oscuro y glifos ligeros cuando es claro (se decide con el color de fondo resuelto; con fondo transparente, con la luminosidad de la tinta). El sentido de la mezcla de bordes (`edges`) sigue esa polaridad; `invertGradient` invierte encima.
- ASCII declara `draftScale: 1`: es barato y no se baja a media resolución mientras se arrastra un slider. El resto de modos usarán el valor por defecto (0,5), que ya respeta el pipeline.
- `font` incluye **Geist Mono** (por defecto, sección 3) además de las cinco de 7.1; `edgeChars` está activo por defecto (solo tiene efecto con `edges > 0`). "Courier" cae a Geist Mono donde no exista Courier New.
- Los glifos se componen **en CPU desde el canal alfa del atlas** (`glyphs.drawGlyphGrid`, por bandas) en lugar de un `drawImage` por celda + `source-in`: 2,5 ms en vez de 17 ms a 120 columnas en el Chromium de pruebas (sin GPU). Los bloques `░▒▓█▀▄▌▐` se dibujan proceduralmente. Está pensado para reutilizarse en Matrix, Retrato tipográfico y Raymarch→ASCII.
- Extensiones de la interfaz de modo (6): `mode.preOptions(params, theme)` (fondo para píxeles transparentes y dirección de la mezcla de bordes), `mode.draftScale`, `mode.hide` (ids globales que no aplican), `showIf(p, all)` con todos los parámetros como segundo argumento. `FrameContext` añade `theme`, `outScale`, `srcWidth/srcHeight` e `invalidate()`; `pipeline.render()` es asíncrono (los modos pueden devolver promesas, p. ej. por `depth()`).
- **Tope de tamaño**: ASCII reduce la escala de render si la salida pasaría de 4096 px (vista previa) o 8192 px (exportación) y el pipeline devuelve la escala efectiva. La escala de la vista previa sigue al zoom (hasta 4×) para que el texto no se vea borroso al acercar. La exportación PNG estima el tamaño y luego lo verifica (las celdas son píxeles enteros en cada escala).
- La exportación ANSI de ASCII usa la extensión `.ansi.txt` (UTF-8 con SGR); `.ans` queda para el CP437 del modo ANSI (fase 3).
- Estado: claves de `localStorage` `horain.theme`, `horain.lang` y `horain.params` (versionado `v:1`). El enlace compartible `#s=` y la validación de estado externo ya están hechos (se necesitaban para las pruebas de 18.3); presets y "Sorpréndeme" siguen para la fase 7.

**Interfaz**
- Hero en dos columnas en escritorio (titular + dropzone a la izquierda, demo viva del motor a la derecha) en lugar de un canvas a ancho completo; rota 4 "looks" ASCII cada 4 s (con `prefers-reduced-motion`, un solo fotograma fijo). La galería de modos con miniaturas en vivo se hizo ya en la fase 1 porque el motor lo permite sin esfuerzo; el contador de visitas, Open Graph, manifest, atajos de teclado y Post-FX siguen para la fase 7.
- El subtítulo del hero cuenta los modos registrados ("1 estilo") en lugar del "25 estilos" final, y el texto de ACERCA dice que el video y la cámara están en camino: actualizar en la fase 2.
- Móvil (< 700 px): `cols` arranca en 80 en lugar de 120 y el bucle de animación se limita a 30 fps (18.2). El visor ocupa ~45–50 % de la altura (el plan decía 55vh) porque la barra de modos y la hoja de ajustes (38 dvh) también caben en pantalla.
- **Contraste**: en el tema PAPER, `--accent-ink #FFFFFF` sobre `--accent #E5402A` da 4,12:1 (< 4,5:1 de AA). Se mantiene la tabla de 4.1 tal cual; arreglo sugerido: `#111111` (4,6:1) o un rojo más oscuro. La prueba de contraste lo documenta como única excepción.

**Rendimiento medido** (Chromium de pruebas, sin GPU, con una fuente animada que cambia de fotograma en cada render, es decir, preprocesado + análisis + modo): ASCII a 160 columnas ≈ 12 ms por fotograma (mono, color original o con difusión de error de Floyd–Steinberg), 300 columnas ≈ 21 ms y 600 columnas ≈ 47 ms (≈ 21 fps, por debajo de 30 fps en este entorno sin GPU). Si solo cambian parámetros del modo (preprocesado en caché) un render cuesta ≈ 2–3 ms. La prueba exige mediana < 33 ms a 160 columnas (≥ 30 fps).

**Pendiente / no cubierto en estas fases**: sin workers todavía (preprocesado, dithering y difusión de error corren en el hilo principal, suficiente hasta 600 columnas); solo se ha probado Chromium (Firefox/Safari no); atajos de teclado (4.7), presets, Post-FX, grupo de profundidad y contador de visitas.
