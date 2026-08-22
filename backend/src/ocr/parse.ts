/**
 * P3 (v1.4.1) — built-in OCR for team screenshots. tesseract.js (pure WASM,
 * no system package) + sharp preprocessing. The extracted text goes to the
 * alive AI provider's normal CHAT model for reformatting — no vision model
 * required, at a fraction of a vision call's tokens.
 *
 * Rule 1c: the language model ships INSIDE the immutable release
 * (backend/assets/ocr/eng.traineddata); the only mutable path is the worker
 * cache under DATA_DIR/ocr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import sharp from 'sharp';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';

export interface OcrResult {
  text: string;
  lines: string[];
  nameLike: number; // lines that plausibly carry a player name
  meanConfidence: number;
  ms: number;
}

/** assets/ocr next to the compiled tree (dev: backend/assets; release: payload/backend/assets). */
function langDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'assets', 'ocr');
    if (fs.existsSync(path.join(candidate, 'eng.traineddata'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('assets/ocr/eng.traineddata not found — release packaging broken');
}

/**
 * Screenshot preprocessing (the published recipe for game-UI text): upscale,
 * grayscale, contrast-stretch, sharpen — and invert when the image is
 * predominantly dark (FPL pitch view is white-on-dark; tesseract wants
 * dark-on-light).
 */
export async function preprocessForOcr(buffer: Buffer): Promise<Buffer> {
  const img = sharp(buffer, { failOn: 'none' });
  const meta = await img.metadata();
  const width = meta.width ?? 800;
  const stats = await img.clone().grayscale().stats();
  const meanLuma = stats.channels[0]?.mean ?? 128;
  let pipe = sharp(buffer, { failOn: 'none' })
    .resize({ width: Math.min(2400, Math.max(1200, width * 2)), withoutEnlargement: false })
    .grayscale()
    .normalise()
    .sharpen();
  if (meanLuma < 110) pipe = pipe.negate({ alpha: false });
  return pipe.png().toBuffer();
}

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const cachePath = path.join(config.dataDir, 'ocr');
    fs.mkdirSync(cachePath, { recursive: true });
    workerPromise = createWorker('eng', undefined, {
      langPath: langDir(),
      cachePath,
      gzip: false,
      logger: () => undefined,
    }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return w;
    });
  }
  return workerPromise;
}

const NAME_LINE = /\p{L}{3,}/u;

/** OCR one screenshot. Serialised on a single worker (uploads are rare). */
export async function ocrTeamImage(buffer: Buffer): Promise<OcrResult> {
  const started = Date.now();
  const run = queue.then(async (): Promise<OcrResult> => {
    const pre = await preprocessForOcr(buffer);
    const worker = await getWorker();
    const { data } = await worker.recognize(pre);
    const lines = (data.text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 1);
    const nameLike = lines.filter((l) => NAME_LINE.test(l) && !/^\d+[.,]?\d*$/.test(l)).length;
    return {
      text: lines.join('\n'),
      lines,
      nameLike,
      meanConfidence: Number(data.confidence ?? 0),
      ms: Date.now() - started,
    };
  });
  queue = run.catch(() => undefined); // keep the chain alive after failures
  return run;
}

/**
 * Vision-call preprocessing (P4 hardening): cap the long edge at 1568px and
 * re-encode as JPEG q80 — full-res phone screenshots cost 2-3× the tokens
 * and can exceed provider size caps (Anthropic: 5 MB / 8000px).
 */
export async function downscaleForVision(buffer: Buffer): Promise<{ base64: string; mimeType: string }> {
  const out = await sharp(buffer, { failOn: 'none' })
    .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { base64: out.toString('base64'), mimeType: 'image/jpeg' };
}

/** Shut the worker down (tests / graceful exit). */
export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate().catch((err) => log.warn({ err: String(err) }, 'ocr worker terminate failed'));
  }
}
