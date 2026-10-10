# Pendiente

Estado a 2026-10-10. `main` tiene las 7 fases fusionadas: 25 modos, video y webcam, exportaciones, presets, post-FX, contador, atajos, SEO y accesibilidad.
Las 427 pruebas pasaron en la última suite completa (1 saltada, MP4 sin H.264). Solo se corrió en Chromium.

## 1. Fase 7 y pasada de lógica (2026-10-10, rama `preview`)

Hecho (pruebas en `tests/logic.spec.js`, `tests/logic-webcam.spec.js` y `tests/perf.spec.js`):
- [x] **Carreras**: al cambiar de modo gana siempre la última elección aunque un modo tarde en cargar; un fotograma que termina después de cambiar de fuente o de modo se descarta; dos exportaciones a la vez dan un solo archivo.
- [x] **Memoria**: la tubería solo guarda el estado del modo en pantalla (libera buffers, canvas y recursos WebGL del anterior); la de exportar y la de miniaturas se liberan al terminar. Prueba: dos vueltas por todos los modos sin crecimiento (`pipelineStats()`).
- [x] **Casos límite**: imágenes de 1×1, 1×4096 y 4096×1 en todos los modos (arreglado un bucle sin fin de la espiral con imágenes de pocos píxeles de alto); valores extremos en los sliders (los no finitos se ignoran, los finitos se recortan); recorte inicio = fin rechazado también en `exportFromFile`; webcam desconectada mientras graba (se guarda lo grabado); pestaña oculta durante la exportación (se pausa y el archivo sale completo).
- [x] **Validación**: prueba de fuzzing con 300 estados basura en `#s=`, sesión guardada y presets; los ajustes guardados de un modo que aún no se ha cargado se conservan con forma segura (`holdRaw`) y se validan al cargarlo.
- [x] **i18n**: la prueba de paridad ES/EN ya existía (`i18n.spec.js`).
- [x] **Reposo**: imagen quieta en modo no animado = 0 fotogramas y 0 `requestAnimationFrame`.
- [x] **Profundidad con IA**: límite sin progreso (60 s) y total (10 min); vuelve al brillo con aviso y sin errores en consola.

**Rendimiento de carga** (sin cambios visuales): `modulepreload` generado del grafo estático (`tests/make-preload.mjs`), modos bajo demanda (`src/modes/registry.js` + `src/modes/meta.js`, generado con `tests/make-mode-meta.mjs`), exportación de video y tareas pesadas del hilo principal bajo demanda, fuentes críticas precargadas. Fast 3G con el servidor local (HTTP/1.0, sin gzip): **17,5 s → 7,5 s** hasta `data-ready`, **123 → 67** peticiones y **105 → 49** módulos JS. En GitHub Pages (HTTP/2 + gzip) la mejora absoluta será menor.

Queda:
- [ ] Cargar solo el diccionario del idioma activo (ahora van ES y EN, ~33 KB) y separar `depth.js`/`postfx.js` del arranque.
- [ ] Medir en el navegador real con Lighthouse.

Lo que no se pudo comprobar aquí y conviene probar a mano en el navegador real:
- [ ] Exportar a MP4 (H.264).
- [ ] "Mejorar con IA": la descarga real del modelo desde jsDelivr y Hugging Face.
- [ ] Firefox, Safari y Chrome Android.
- [ ] Lighthouse (aquí se usó axe-core en su lugar).
- [ ] Rendimiento con GPU real: flow field, Vectrex, LiDAR y reacción-difusión se midieron con render por software.

Pasos manuales del dueño (`DEPLOY.md`):
- [ ] Desplegar el Worker del contador (§5) y poner `counterUrl: 'https://count.ortzigar.org'` en `src/config.js`.
- [ ] Si `dither.ortzigar.org` usa el proxy de Cloudflare (nube naranja): desactivar **Rocket Loader** y la **ofuscación de emails**, porque reescriben o inyectan scripts que la CSP bloquea.

Mejoras visuales detectadas, que el dueño dirigirá:
- Matrix: la imagen apenas se ve en la lluvia.
- Flow field: sale demasiado oscuro.
- ASCII, Voronoi, espiral y crosshatch: poco contraste en el tema claro.

## 2. Siguiente encargo (borrador): rediseño de la landing al estilo Hermes y página "Quiénes somos"

Referencias aportadas: la landing de Hermes Agent (fondo azul eléctrico, ilustración grabada de líneas, titulares condensados en mayúsculas), un collage en blanco y negro con damero y líneas radiales, un retrato en halftone azul y una composición en blanco y negro con escalera y celestial.

- **Estética general**: oscura, lujosa y minimalista.
- [x] **Quitar "by Horain"** de todo el sitio de Dither (hecho en `preview`, ver PLAN.md §19). La página «Quiénes somos» con la paleta Horain queda descartada en este repo.
- **Imágenes**: piezas creadas con los propios modos de Dither. Lo prioritario son el **halftone lineal** y el dithering, con un tratamiento fotográfico de alta costura (grabado, collage y retrato).
- **Nuevo efecto "Linear halftone"**: líneas paralelas cuyo grosor varía con el tono, como en la ilustración de Hermes. Va como modo nuevo y también como tratamiento de las imágenes de la landing.
- **Scroll "Cropped Reveal & Pan"**:
  - Imágenes grandes dentro de contenedores con `overflow: hidden`, a escala 1.15–1.2.
  - Al hacer scroll se desplazan en vertical más despacio que la página (parallax), revelando lo que estaba oculto arriba y abajo.
  - El movimiento se suaviza con interpolación (`lerp`) y respeta `prefers-reduced-motion`.
- **La demo animada del hero** se mantiene intacta, con su cambio fluido de efecto a efecto.
- **Página "Quiénes somos"**:
  - Página aparte o sección con contraste total: blanco y negro más los colores de la paleta Horain (lima `#C4F169`, tinta `#15181E`, etc.).
  - Pensada para poder extraerla después a la web principal de Horain.

### Decisiones del dueño (2026-10-09)
- **Color**: fondo negro (`#050505`) con secciones e imágenes en azul eléctrico tipo Hermes (`#1E1EFF`, a afinar). El blanco solo se usa como tinta.
- **Titulares**: añadir una tipografía condensada libre (OFL, autoalojada en `assets/fonts/`, por ejemplo Big Shoulders Display o Six Caps) solo para los titulares grandes en mayúsculas. Geist y Geist Mono se mantienen para el resto.
- **Imágenes**: obras de **dominio público** (grabados, estatuas y retratos clásicos del Met Open Access, el Rijksmuseum o Wikimedia). Como este entorno no tiene acceso a internet, el dueño las sube a `assets/source/` y se procesan con los modos de Dither (halftone lineal, dithering, halftone azul, collage con damero). Se guarda el crédito de cada obra.
- **Quiénes somos**: página aparte `about.html` en este repo, con textos de ejemplo marcados como `TODO` que el dueño reemplaza. Va en blanco y negro con la paleta Horain y está pensada para copiarse al repo de Horain.

### Imágenes sugeridas para subir (dominio público)
1. Un grabado de Durero (por ejemplo «Melencolia I» o «El caballero, la muerte y el diablo»), para el halftone lineal grande del hero.
2. Un retrato con armadura o un busto clásico (Met Open Access), para el halftone azul.
3. Una escultura (Laocoonte, Victoria de Samotracia o similar), para el collage con damero y las líneas radiales.
4. Un grabado de Doré (por ejemplo de «La Divina Comedia»), para la composición vertical con el scroll de revelado.
5. Un paisaje o un cielo nocturno, para la sección de video y animación.
