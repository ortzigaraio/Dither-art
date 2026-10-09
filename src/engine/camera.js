// Orbit camera parameters shared by the 3D modes (PLAN.md 4.6, 7 3D). Every 3D mode declares `camera: true` and
// includes these params (with its own defaults); the studio maps viewer gestures onto them: drag = orbit (yaw/pitch),
// Shift + drag = pan, wheel = distance. The "Reset camera" button restores exactly CAMERA_IDS.

export const CAMERA_IDS = ['yaw', 'pitch', 'distance', 'fov', 'autoRotate', 'panX', 'panY'];

export const CAMERA_LIMITS = { minDistance: 0.6, maxDistance: 12, maxPan: 2 };

/**
 * @param {object} d defaults { yaw, pitch, distance, fov, autoRotate }
 * @param {object} [labels] optional label overrides, e.g. { pitch: {es, en}, autoRotate: {es, en} }
 */
export function cameraParams(d, labels = {}) {
  return [
    {
      id: 'yaw', type: 'range', min: -180, max: 180, step: 1, default: d.yaw ?? 0, unit: '°',
      label: labels.yaw || { es: 'Giro (yaw)', en: 'Yaw' },
      help: { es: 'Rotación de la cámara alrededor del objeto. Arrastra en el visor para orbitar.', en: 'Camera rotation around the object. Drag in the viewer to orbit.' },
    },
    {
      id: 'pitch', type: 'range', min: -89, max: 89, step: 1, default: d.pitch ?? 20, unit: '°',
      label: labels.pitch || { es: 'Inclinación (pitch)', en: 'Pitch' },
    },
    {
      id: 'distance', type: 'range', min: CAMERA_LIMITS.minDistance, max: CAMERA_LIMITS.maxDistance, step: 0.05, default: d.distance ?? 3,
      label: { es: 'Distancia', en: 'Distance' },
      help: { es: 'La rueda del ratón sobre el visor acerca o aleja la cámara.', en: 'The mouse wheel over the viewer moves the camera in and out.' },
    },
    {
      id: 'fov', type: 'range', min: 10, max: 100, step: 1, default: d.fov ?? 45, unit: '°',
      label: { es: 'Campo de visión', en: 'Field of view' },
    },
    {
      id: 'autoRotate', type: 'range', min: -90, max: 90, step: 1, default: d.autoRotate ?? 0, unit: '°/s',
      label: labels.autoRotate || { es: 'Auto-rotación', en: 'Auto-rotate' },
      help: { es: 'Grados por segundo. En la exportación de video usa el tiempo de cada fotograma.', en: 'Degrees per second. Video exports use each frame\'s time.' },
    },
    {
      id: 'panX', type: 'range', min: -CAMERA_LIMITS.maxPan, max: CAMERA_LIMITS.maxPan, step: 0.01, default: 0,
      label: { es: 'Desplazamiento X', en: 'Pan X' },
      help: { es: 'Mayús + arrastrar en el visor desplaza la cámara.', en: 'Shift + drag in the viewer pans the camera.' },
    },
    {
      id: 'panY', type: 'range', min: -CAMERA_LIMITS.maxPan, max: CAMERA_LIMITS.maxPan, step: 0.01, default: 0,
      label: { es: 'Desplazamiento Y', en: 'Pan Y' },
    },
    {
      id: 'resetCamera', type: 'button', resets: CAMERA_IDS,
      label: { es: 'Reiniciar cámara', en: 'Reset camera' },
    },
  ];
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** Camera values after a drag of (dx, dy) CSS px (orbit). Not rounded: the caller accumulates small moves. */
export function orbitBy(cam, dx, dy) {
  let yaw = cam.yaw - dx * 0.4;
  yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
  const pitch = Math.max(-89, Math.min(89, cam.pitch + dy * 0.3));
  return { yaw: r6(yaw), pitch: r6(pitch) };
}

/** Camera values after a Shift-drag of (dx, dy) CSS px over a viewport `size` px tall (pan). */
export function panBy(cam, dx, dy, size) {
  const k = 2 / Math.max(100, size);
  const clamp = (v) => Math.max(-CAMERA_LIMITS.maxPan, Math.min(CAMERA_LIMITS.maxPan, v));
  return { panX: r6(clamp(cam.panX - dx * k)), panY: r6(clamp(cam.panY + dy * k)) };
}

/** Camera distance after a wheel delta (positive = away). */
export function dollyBy(cam, deltaY) {
  const d = cam.distance * Math.exp(deltaY * 0.0012);
  return { distance: r6(Math.max(CAMERA_LIMITS.minDistance, Math.min(CAMERA_LIMITS.maxDistance, d))) };
}
