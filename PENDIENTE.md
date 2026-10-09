# Pendiente

Estado a 2026-10-09. `main` tiene las 7 fases fusionadas: 25 modos, video y webcam, exportaciones, presets, post-FX, contador, atajos, SEO y accesibilidad.
Las 427 pruebas pasaron en la última suite completa (1 saltada, MP4 sin H.264). Solo se corrió en Chromium.

## 1. Lo que quedó sin hacer de la fase 7 y de la pasada de lógica

La pasada de lógica se detuvo a petición del dueño para no gastar más tokens. Ya está hecho:
- El fallo intermitente al cancelar la exportación de video: se cierran todos los `VideoSample` (`ea257f4`).
- El falso aviso "Dither no ha podido arrancar" en cargas lentas (`c46c1ec`).

Queda pendiente, todo de lógica y sin cambios visuales:
- [ ] **Carreras al cambiar de modo o de fuente**: que nunca se dibuje un resultado viejo encima de uno nuevo, y que no se pueda exportar dos veces a la vez.
- [ ] **Fugas de memoria**: liberar los buffers de Braille y ANSI y los recursos WebGL al cambiar de modo, y una prueba que recorra los 25 modos varias veces y compruebe que la memoria no crece.
- [ ] **Casos límite**:
  - imágenes de 1×1 o 1×4096
  - valores extremos de los sliders (NaN o Infinity)
  - recorte de video con inicio = fin, duración 0 o video sin audio
  - webcam desconectada mientras graba
  - pestaña oculta durante una exportación
- [ ] **Validación**: revisar los huecos al leer el hash `#s=`, `localStorage` y los presets importados.
- [ ] **i18n**: una prueba que compare las claves ES y EN.
- [ ] **Rendimiento en reposo**: una imagen quieta en un modo no animado debe renderizar 0 fotogramas por segundo.
- [ ] **Profundidad con IA**: añadir un tiempo límite a la descarga del modelo y volver siempre a la profundidad por brillo con un aviso, sin errores en consola.
- Hay un trabajo a medias de esta pasada en un `git stash` local del entorno (no subido): `unfinished logic pass`.

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
- **Quitar "by Horain"** de todo el sitio de Dither: cabecera, pie, título, meta y textos. El logo espino deja de usarse en Dither.
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

Decisiones abiertas: ver las preguntas al dueño en el chat.
