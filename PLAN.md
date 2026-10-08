# HORAIN — Plan de implementación

> Documento de trabajo para que **Sonnet (Claude Code)** construya todo el código.
> Léelo entero antes de empezar. Trabaja **fase por fase** (sección 12) y no pases a la siguiente sin cumplir los criterios de aceptación.

---

## 0. Resumen

**HORAIN** es una web estática (GitHub Pages) que convierte **imágenes, video y webcam** en arte generativo:
ASCII, dithering 1-bit, Braille, halftone, ANSI, PETSCII, glitch, pixel sorting, wireframe vectorial, LiDAR,
grabado de plotter, termografía, isolíneas, raymarching 3D, blueprint CAD, Voronoi, reacción-difusión,
flow fields y más (25 modos en total).

- El usuario sube un archivo (arrastrar o clic), **elige el tipo de salida**, **ajusta parámetros** en vivo y **exporta**.
- **Todo se procesa en el navegador.** Nada se sube a ningún servidor. Este es un mensaje clave de la UI.
- UI/UX propia de Horain, inspirada en la estética de terminal de *hermes-agent.nousresearch.com* (oscuro, mayúsculas,
  tipografía pixel/expandida, datos en monoespaciada, marcos de caracteres de dibujo de cajas). No es una copia.

### Decisiones ya tomadas con el dueño del proyecto

| Tema | Decisión |
|---|---|
| Estilo | **Multi-tema**: AMBER (por defecto), CRT, PAPER, CAD. Todo con variables CSS. |
| Idioma | **Bilingüe ES/EN** con selector; diccionarios en módulos JS. Idioma inicial = el del navegador (`es*` → ES, resto → EN). |
| Profundidad 3D | **Brillo como profundidad por defecto** + botón opcional **"Mejorar con IA"** que carga Depth Anything V2 en el navegador (solo bajo demanda). |
| Export de video | **MP4 y WebM** (con audio original). Sin GIF por ahora. |
| Export de imagen | PNG siempre; SVG en modos vectoriales; TXT / HTML / ANSI en modos de texto; copiar al portapapeles. |
| Hosting | GitHub Pages, **sin paso de build**: HTML + CSS + ES modules nativos. |

---

## 1. Reglas para el implementador (Sonnet)

1. **Sin frameworks ni bundler.** Vanilla JS (ES2022, ES modules), CSS plano, WebGL2, Canvas2D, Web Workers.
   La página tiene que funcionar sirviendo la carpeta tal cual (`python3 -m http.server`) y en GitHub Pages.
2. **Dependencias externas solo por CDN con versión exacta** a través de un `<script type="importmap">` en `index.html`
   (ver sección 3). Nunca `@latest` ni rangos. Si cambias una versión, que tenga al menos 2 semanas de publicada.
3. **Rutas relativas siempre** (`./src/...`), porque Pages sirve el sitio bajo `/<repo>/`.
4. Cada **modo** es un módulo independiente que cumple la interfaz de la sección 6. La UI de parámetros se genera
   **automáticamente desde el esquema** de cada modo; no escribas HTML a mano para los controles de cada modo.
5. Todo texto visible pasa por `t('clave')` (i18n). Nada de strings sueltos en la UI.
6. Rendimiento: nunca bloquees el hilo principal más de ~50 ms. Lo pesado (difusión de error a alta resolución,
   pixel sort, Voronoi, IA de profundidad) va en Web Workers, con cancelación por `jobId`.
7. Accesibilidad: todos los controles con `<label>`, navegables con teclado, foco visible, `prefers-reduced-motion`
   respetado (sin animaciones de fondo en el hero), contraste AA en los 4 temas.
8. Comentarios en el código: breves y solo donde el algoritmo no sea obvio (citar el nombre del algoritmo/paper).
9. Commits pequeños por fase/modo, mensajes en inglés tipo `feat(mode): add braille renderer`.
10. Antes de cada commit: abrir la página con Playwright (sección 13) y comprobar que **no hay errores en consola**.

---

## 2. Estructura de archivos

```
/
├─ index.html                 # única página; importmap; layout (hero + estudio)
├─ .nojekyll                  # Pages no debe procesar con Jekyll
├─ README.md                  # qué es, cómo usar, cómo desarrollar, créditos de algoritmos
├─ PLAN.md                    # este documento
├─ CLAUDE.md                  # reglas cortas para agentes (ya existe)
├─ assets/
│  ├─ favicon.svg             # glifo "H" en estilo pixel
│  └─ og-image.png            # se genera en la fase 7 con la propia app
├─ css/
│  ├─ tokens.css              # temas (variables), tipografías, escalas
│  ├─ base.css                # reset, tipografía, utilidades
│  ├─ layout.css              # hero, estudio (3 columnas), responsive
│  └─ components.css          # botones, sliders, selects, toggles, dropzone, toasts, modal
├─ src/
│  ├─ main.js                 # arranque: carga fuentes, i18n, tema, estado, UI, loop
│  ├─ state.js                # store global con pub/sub, persistencia localStorage, hash compartible
│  ├─ scheduler.js            # bucle rAF: render solo si "dirty" / frame de video nuevo / modo animado
│  ├─ i18n/
│  │  ├─ i18n.js              # t(), setLang(), aplica data-i18n al DOM
│  │  ├─ es.js                # export default { 'drop.title': '...', ... }
│  │  └─ en.js
│  ├─ ui/
│  │  ├─ header.js            # logo, selector de tema, ES|EN, enlace GitHub
│  │  ├─ hero.js              # demo animada + dropzone + galería de modos
│  │  ├─ dropzone.js          # drag&drop, clic, pegar (Ctrl+V), webcam, demo
│  │  ├─ modeList.js          # lista de modos agrupados por categoría con badges
│  │  ├─ controls.js          # esquema de parámetros → DOM (slider, select, color, toggle, text, button)
│  │  ├─ viewer.js            # canvas de salida, zoom/pan, split antes/después, fullscreen, stats
│  │  ├─ transport.js         # play/pausa, scrubber, loop, velocidad, mute (video)
│  │  ├─ exportPanel.js       # botones de exportación según capacidades del modo + diálogo de video
│  │  ├─ presets.js           # guardar/cargar presets, aleatorio ("Sorpréndeme"), compartir URL
│  │  ├─ shortcuts.js         # atajos de teclado
│  │  └─ toast.js             # notificaciones y errores
│  ├─ io/
│  │  ├─ sources.js           # ImageSource, VideoSource, WebcamSource, DemoSource (procedural)
│  │  ├─ exportImage.js       # PNG (escala 1x/2x/4x/ancho custom), copiar imagen
│  │  ├─ exportText.js        # TXT, HTML coloreado, ANSI (escapes 24-bit / 256 / 16), .ans CP437
│  │  ├─ exportSVG.js         # helpers de SVG (paths, capas, unidades mm para plotter)
│  │  ├─ exportVideo.js       # MP4/WebM con Mediabunny (offline, frame a frame) + fallback MediaRecorder
│  │  └─ download.js          # descarga de Blob con nombre "horain-<modo>-<fecha>.<ext>"
│  ├─ engine/
│  │  ├─ pipeline.js          # fuente → preprocesado → análisis → modo → post-FX → superficie
│  │  ├─ preprocess.js        # filtros de color (semántica CSS), nitidez, bordes, umbral
│  │  ├─ analysis.js          # buffers cacheados: rgba, luma, sobel (mag/ángulo), depth
│  │  ├─ dither.js            # difusión de error (todas las matrices) + Bayer + ruido azul
│  │  ├─ palettes.js          # paletas retro y LUTs térmicas
│  │  ├─ color.js             # modos de color de salida, mezcla, conversión rgb/hsl/lab
│  │  ├─ glyphs.js            # charsets, medición de densidad de glifos, atlas de glifos
│  │  ├─ noise.js             # Perlin/Simplex 2D/3D propios (sin dependencia)
│  │  ├─ geometry.js          # marching squares, Chaikin, clipping de líneas, orden de trazos
│  │  ├─ math3d.js            # vec3/mat4, perspectiva/ortográfica, cámara orbital
│  │  ├─ gl.js                # helpers WebGL2: programa, quad, texturas, FBO ping-pong, readPixels
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

---

## 3. Dependencias (importmap en `index.html`)

```html
<script type="importmap">
{
  "imports": {
    "mediabunny": "https://cdn.jsdelivr.net/npm/mediabunny@1.59.1/+esm",
    "d3-delaunay": "https://cdn.jsdelivr.net/npm/d3-delaunay@6.0.4/+esm",
    "@huggingface/transformers": "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm"
  }
}
</script>
```

- **mediabunny** — lectura y escritura de MP4/WebM con WebCodecs. Se importa **de forma diferida** (`await import('mediabunny')`) solo al exportar video.
- **d3-delaunay** — Voronoi/Delaunay para stippling y low-poly.
- **@huggingface/transformers** — solo dentro de `depth.worker.js` y solo cuando el usuario pulsa "Mejorar con IA".
  Los workers no heredan el importmap: en el worker importa con la URL completa del CDN.
- Ruido Perlin/Simplex, matrices de dithering, marching squares, matemáticas 3D: **implementación propia** (son pocas líneas).

Fuentes (Google Fonts, `display=swap`):
- **JetBrains Mono** (400, 700): UI de datos, valores, y fuente por defecto del render ASCII.
- **Silkscreen** (400, 700): logo, títulos de sección, etiquetas de botones grandes (pixel).
- **Archivo** con eje `wdth` (125) en 600/800: titulares expandidos en mayúsculas del hero.
- Opciones extra para el render ASCII (cargadas bajo demanda): **IBM Plex Mono**, **VT323**, **Space Mono**.

> Antes de medir glifos o dibujar texto en canvas: `await document.fonts.load('16px "JetBrains Mono"')`.
> Braille, bloques, ANSI y PETSCII **no dependen de la fuente**: se dibujan proceduralmente en el canvas
> (puntos y rectángulos). Solo la exportación de texto usa los caracteres Unicode.

---

## 4. Identidad visual y UX

### 4.1 Temas (`css/tokens.css`)

Se aplican con `<html data-theme="amber|crt|paper|cad">`. Guardar elección en `localStorage` (envuelto en try/catch).

| Token | AMBER (defecto) | CRT | PAPER | CAD |
|---|---|---|---|---|
| `--bg` | `#0B0B0A` | `#050A06` | `#EFECE4` | `#0D2A4A` |
| `--panel` | `#141311` | `#0B140D` | `#E6E2D6` | `#10335A` |
| `--panel-2` | `#1C1A17` | `#102016` | `#DCD7C8` | `#163E6B` |
| `--fg` | `#E8E4D8` | `#C8F7D2` | `#111111` | `#E6F0FF` |
| `--fg-2` (secundario) | `#8A8578` | `#5F8F6A` | `#5B5850` | `#8FB0D9` |
| `--accent` | `#FFB000` | `#39FF6A` | `#E5402A` | `#7FD4FF` |
| `--accent-ink` (texto sobre acento) | `#0B0B0A` | `#050A06` | `#FFFFFF` | `#0D2A4A` |
| `--line` (bordes 1px) | `#2A2824` | `#183020` | `#C9C4B5` | `#2C5A8C` |
| `--danger` | `#FF5A3C` | `#FF5A3C` | `#B3261E` | `#FF7A6B` |

Extras por tema: CRT añade overlay de scanlines muy sutil (`repeating-linear-gradient`, opacidad ≤ 0.06) en el fondo;
CAD añade cuadrícula de fondo (líneas cada 8px y mayores cada 64px en `--line`). Todos: grano/ruido SVG muy sutil sobre `body`.
Con `prefers-reduced-motion` nada de esto se anima.

**El color por defecto de la salida** de cada modo sigue el tema (tinta = `--accent`, fondo = `--bg`) hasta que el usuario elija otro.

### 4.2 Lenguaje visual

- Etiquetas de sección en **MAYÚSCULAS** con `letter-spacing: .08em`, numeradas: `01 / ENTRADA`, `02 / SALIDA`, `03 / AJUSTES`.
- Marcos y separadores con **caracteres de dibujo de cajas** (`┌─┐│└┘├┤`) solo en elementos decorativos; los
  contenedores reales usan bordes CSS de 1px `--line` (nunca esquinas redondeadas > 2px).
- Botones tipo `[ EXPORTAR ]`: fondo transparente, borde 1px, hover = fondo `--accent` y texto `--accent-ink`.
- Valores numéricos siempre en JetBrains Mono y alineados a la derecha.
- Micro-interacciones: al cambiar de modo, el título del modo hace un efecto "scramble" de caracteres (≤ 300 ms).

### 4.3 Layout

**Vista Inicio (sin archivo cargado)**
1. Header fijo: logo `HORAIN` (Silkscreen) · `ESTUDIO` · `MODOS` · `ACERCA` · selector de tema `◐ AMBER ▾` · `ES | EN` · GitHub.
2. Hero: canvas a ancho completo que ejecuta **el propio motor** sobre la fuente Demo (procedural) y rota de modo cada 4 s.
   Titular expandido: **"CONVIERTE IMÁGENES Y VIDEO EN ARTE"** / **"TURN IMAGES & VIDEO INTO ART"**.
   Subtítulo: "25 estilos · 100% en tu navegador · nada se sube".
3. **Dropzone** grande debajo del titular (ver 4.4).
4. `MODOS`: rejilla de tarjetas (una por modo) con miniatura renderizada en vivo desde la fuente Demo (pequeña, perezosa con `IntersectionObserver`), nombre, descripción de una línea y badges. Clic → abre el estudio con ese modo y la demo.
5. `ACERCA`: 3 bloques cortos (Privado · Imagen + Video · Exporta PNG/SVG/TXT/MP4/WebM) y créditos de algoritmos.

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
- Borde discontinuo animado (marching ants) en estado `dragover`, color `--accent`.
- Todo el documento acepta soltar archivos (no solo la caja). `Ctrl/Cmd+V` pega imágenes del portapapeles.
- Errores: tipo no soportado, video que el navegador no puede decodificar (p. ej. HEVC `.mov` en Chrome) → toast explicando y sugiriendo MP4 H.264.
- En el estudio, un botón compacto `[ CAMBIAR ARCHIVO ]` reabre el selector.

### 4.5 Controles (estilo panel de asciiart.eu, con look Horain)

Cada fila de slider:
```
Brillo                                   62%
━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━
```
- Etiqueta a la izquierda; valor a la derecha (clic → input numérico editable; Enter confirma).
- `input[type=range]` nativo estilizado (pista 2px `--line`, tramo recorrido `--accent`, thumb cuadrado 12px).
- Doble clic en la etiqueta = restaurar valor por defecto. Icono `?` con tooltip explicativo (i18n).
- Toggle con apariencia `[x] Invertir` / `[ ] Invertir`. Select con flecha `▾`. Color con muestra cuadrada + hex editable.
- Cada grupo es un `<details>` con cabecera `── AJUSTES DE IMAGEN ─────── [↺]` (↺ restaura el grupo).
- Controles que el modo actual no usa: ocultos (no deshabilitados).
- Mientras se arrastra un slider se renderiza en **calidad borrador** (mitad de resolución); al soltar, calidad completa.

### 4.6 Visor

- Fondo de tablero de ajedrez cuando la salida tiene transparencia.
- Rueda / pinch = zoom (10 %–800 %), arrastrar = pan, botones `AJUSTAR` y `1:1`, `F` = pantalla completa.
- **Split antes/después**: línea vertical arrastrable que muestra el original a un lado.
- Esquina inferior derecha en mono: `160×72 · 58 fps · 12 ms` (resolución de trabajo, fps, tiempo de render).
- Modos 3D: arrastrar = orbitar cámara (pan con Shift), rueda = zoom de cámara (no del visor). Botón para alternar.
- Overlay "RENDERIZANDO… 43%" para trabajos en worker.

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
| `palette` | 1-bit Mac, Game Boy DMG, CGA, EGA 16, C64, PICO-8, Endesga 32, Sweetie 16, Amber CRT, Green CRT, Ironbow, Personalizada (lista de hex) |
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
        Mp4OutputFormat, WebMOutputFormat, QUALITY_HIGH } = await import('mediabunny');

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

Cada fase termina con: smoke test Playwright verde (sección 13), sin errores de consola, commit y push.

### Fase 0 — Esqueleto y despliegue
- `index.html`, CSS de tokens/base/layout/components, `.nojekyll`, header con selector de tema (4 temas) y ES|EN,
  i18n funcionando, layout de las vistas Inicio y Estudio (vacías), dropzone funcional (archivo, soltar, pegar, demo).
- **Aceptación**: el sitio carga en Pages; cambiar tema e idioma funciona y se recuerda; soltar una imagen pasa a la
  vista Estudio y la muestra en el visor sin procesar.

### Fase 1 — Motor + ASCII completo (MVP)
- `pipeline`, `preprocess` (todos los ajustes de 5.2), `analysis`, `dither` (todas las matrices), `glyphs` (densidad, atlas),
  `color` (4 modos), `controls.js` (esquema → DOM), `viewer.js` (zoom/pan/split/stats), `scheduler`.
- Modo **ASCII** completo con todos sus parámetros (7.1). Exportar PNG / TXT / HTML / ANSI / copiar.
- **Aceptación**: el panel reproduce el de referencia (Characters, Brightness, Contrast, Saturation, Hue, Grayscale,
  Sepia, Invert, Thresholding, Sharpness, Edge Detection, ASCII gradient, Space Density, Quality Enhancements (JJN, etc.),
  Transparent frame) y cada control cambia el resultado en vivo; 160 columnas ≥ 30 fps en portátil medio.

### Fase 2 — Video y webcam
- `VideoSource`, `WebcamSource`, `transport.js`, `exportVideo.js` (Mediabunny MP4/WebM con audio + fallback MediaRecorder),
  diálogo y progreso, grabación de webcam.
- **Aceptación**: un MP4 H.264 con audio de 10 s se exporta a MP4 y a WebM en ASCII con audio sincronizado y la
  duración correcta; cancelar funciona; en un navegador sin WebCodecs se usa el fallback.

### Fase 3 — Modos de texto y píxel
- Braille, ANSI, PETSCII, Matrix, Retrato tipográfico, Dithering 1-bit, Halftone, Pixel art, LED, Termografía, Glitch, Pixel sort.
- `heavy.worker.js` con cancelación por `jobId`. `modeList.js` con categorías y badges.

### Fase 4 — Modos vectoriales + SVG
- `geometry.js`, `exportSVG.js` (mm, páginas, capas, orden de trazos). Grabado/Crosshatch, Isolíneas, Voronoi/Stipple/Low-poly,
  Flow fields, Blueprint CAD, Vectrex, Espiral.
- **Aceptación**: los SVG abren bien en Inkscape/navegador y en modo plotter no tienen rellenos.

### Fase 5 — Profundidad y 3D
- `depth.js` (brillo + IA en worker con progreso y caché), `math3d.js`, cámara orbital. LiDAR (+PLY), Wireframe oculto (+SVG),
  Raymarch ASCII, Volumen texto ASCII/Braille.
- **Aceptación**: los 4 modos funcionan con profundidad por brillo sin descargar nada; "Mejorar con IA" descarga una vez,
  muestra progreso, y mejora visiblemente el relieve.

### Fase 6 — Simulación
- Reacción-difusión GPU + Autómatas celulares. Presets.

### Fase 7 — Landing, pulido y calidad
- Hero con demo animada rotando modos, galería de modos con miniaturas en vivo, sección Acerca, presets curados,
  compartir URL, Sorpréndeme, Post-FX global, atajos y su ayuda, `og-image.png` (generada con la app), favicon,
  revisión de accesibilidad y móvil, README final con capturas.
- **Aceptación**: Lighthouse accesibilidad ≥ 95; sin scroll horizontal a 360 px; todos los modos visitados en el smoke test.

---

## 13. Pruebas (`tests/`)

- `tests/package.json` con `@playwright/test` como devDependency. Servir la raíz con `python3 -m http.server 8080`.
- Fixtures **generados** (sin archivos con licencia): `make-fixtures.mjs` crea `fixture.png` (degradados + formas + texto)
  y `fixture.mp4` de 3 s con audio (con Mediabunny desde la propia página de test o con `ffmpeg` si está disponible).
- `smoke.spec.js`:
  1. Carga la página, sin errores de consola.
  2. Carga `fixture.png` vía `setInputFiles`; para **cada modo** del registro: seleccionarlo, esperar render, comprobar que el
     canvas no es uniforme (varianza de píxeles > 0) y guardar captura en `tests/screenshots/<modo>.png`.
  3. Cambiar tema e idioma; comprobar textos.
  4. ASCII: exportar TXT y verificar que tiene `rows` líneas de `cols` caracteres.
  5. (Fase 2+) Cargar `fixture.mp4`, exportar WebM corto y verificar que el blob tiene tamaño > 0 y tipo correcto.
- En el entorno de Claude Code: Chromium ya está instalado en `/opt/pw-browsers` — **no ejecutar `playwright install`**.

Matriz manual antes de cerrar cada fase: Chrome/Edge (principal), Firefox, Safari 17+ (si es posible), Chrome Android.

---

## 14. GitHub Pages

1. Settings → Pages → *Deploy from a branch* → `main` / `/ (root)`.
2. `.nojekyll` en la raíz.
3. Sin cabeceras COOP/COEP (Pages no las permite): transformers.js funciona sin `SharedArrayBuffer` (wasm de un hilo o WebGPU).
4. Todas las rutas relativas; probar en `https://<usuario>.github.io/Ascii-dithering-Image-to-art-/`.

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

## 16. Pendiente de confirmar con el dueño (no bloquea las fases 0–2)

- ¿Logo/wordmark de Horain propio? (si no, wordmark en Silkscreen + favicon "H" pixel).
- ¿Dominio propio (CNAME) o `github.io`?
- ¿Analítica? (por defecto: ninguna).
- ¿Límite de duración de video para exportar? (por defecto: aviso a partir de 2 min, sin bloqueo).
- ¿Añadir GIF en el futuro? (la arquitectura de `exportVideo.js` lo permite con un tercer formato).
