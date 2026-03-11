export const APP_NAME = 'Car Replacement Studio';
export const DEFAULT_MODEL = 'gemini-3-pro-image-preview';
export const DEFAULT_SEARCH_ENABLED = true;
export const DEFAULT_IMAGE_CONFIG = Object.freeze({
  aspectRatio: '1:1',
  imageSize: '1K',
});

export const DEFAULT_PROMPT = `Replicate Input 1 exactly. Every detail identical — background, lighting, mood, setting, lamp structure, angle, composition. The ONLY change is replace the car in Input 1 with the exact car model and colorway from Input 2. Car must be mounted in the exact same position and orientation as in Input 1. Nothing else changes. No text. No props. Hyper-realistic. Make sure the rim color is the same as Input 1.`;

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

export const SETTINGS_FILE_NAME = 'settings.json';
export const JOBS_FILE_NAME = 'jobs.json';

export const RUN_EVENT_CHANNEL = 'run:event';

export const RUN_MODES = Object.freeze({
  SYNC: 'sync',
  BATCH: 'batch',
});

export const JOB_STATES = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  SUBMITTED: 'submitted',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
});
