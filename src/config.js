// Single place for site settings and the hard limits of PLAN.md §18.
// `counterUrl` is public (not a secret). Leave it empty until the visit-counter Worker is deployed (DEPLOY.md).

// The product is called Dither ("by Horain"): it reuses the Horain brand (logo, themes, tokens) but is its own tool
// (PLAN.md section 0, owner's clarification). Internal ids (theme "horain", css --horain-* tokens) keep the brand name.
export const config = {
  productName: 'Dither',
  fileSlug: 'dither', // prefix of exported file names: dither-<mode>-<YYYYMMDD-HHMMSS>.<ext>
  counterUrl: '',
  siteUrl: 'https://dither.ortzigar.org/',
  repoUrl: 'https://github.com/ortzigaraio/Dither-art',
  authorUrl: 'https://ortzigar.org',
};

const MB = 1024 * 1024;

export const LIMITS = {
  // 18.1 file input
  imageMaxBytes: 50 * MB,
  imageMaxPixels: 100e6,
  imageWorkMaxSide: 4096,
  videoMaxBytes: 2048 * MB,
  videoWarnBytes: 500 * MB,
  videoWarnSeconds: 120,
  sniffBytes: 64,
  // 18.2 runtime
  maxCols: 600,
  maxParticles: 50000,
  maxVoronoiPoints: 50000,
  maxReactionSteps: 60,
  maxExportImageSide: 8192,
  maxExportVideoW: 3840,
  maxExportVideoH: 2160,
  slowRenderMs: 200,
  slowRenderFrames: 5,
  workerWatchdogMs: 30000,
  mobileMaxFps: 30,
  // 18.3 external state
  maxStateString: 500,
  maxHashChars: 16000,
};
