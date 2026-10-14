#!/usr/bin/env node
// Reframe the promo to 1:1 (feed) or 9:16 (reel). The scenes are re-rendered natively at the new size, not
// cropped from the 16:9 master: templates reflow, footage is re-cropped around its focus, and captions move
// into the safe band. Same scenes.json, same music, same transitions.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadScenes, ValidationError } from './lib/schema.js';
import { FfmpegUnavailableError, requireFfmpeg } from './lib/ffmpeg.js';
import {
  UsageError, assertFootageFiles, layoutGate, makeContactSheet, readCaptureDurations, renderStills, renderVideo,
} from './lib/render-core.js';
import { cropForRatio } from './lib/geometry.js';
import { createLogger } from './lib/log.js';

// Sizes and caption modes per ratio; the 16:9 master stays with render.mjs.
export const RATIOS = Object.freeze({
  '1x1': { size: { w: 1080, h: 1080 }, captionMode: 'feed' },
  '9x16': { size: { w: 1080, h: 1920 }, captionMode: 'reel' },
});
// The capture viewport every flow video is treated as (the compositor's SOURCE).
const SOURCE = { w: 1920, h: 1080 };
// Plan-chosen: below this share of the focus rectangle kept in the crop, the reframe is flagged.
export const MIN_COVERAGE = 0.6;

const USAGE = 'usage: reframe.mjs --scenes <scenes.json> --capture <dir> --ratio 1x1|9x16 --out <file.mp4> [--stills <dir>] [--music-dir <dir>]';

/** Per footage scene: the source rectangle the compositor crops to, and a warning when the focus is cut. */
function cropReport(scenes, size) {
  const entries = [];
  const warnings = [];
  scenes.forEach((scene, index) => {
    if (scene.type !== 'footage') return;
    const { rect, coverage, centered } = cropForRatio(scene.focus, SOURCE, size);
    entries.push({ index, rect, coverage, centered });
    if (coverage < MIN_COVERAGE) {
      warnings.push(`scene ${index + 1} (flow "${scene.flow}"): the ${size.w}x${size.h} crop keeps only ${coverage.toFixed(4)} of its focus area; widen the focus or accept the crop`);
    }
  });
  return { entries, warnings };
}

export async function main(argv, { load = loadScenes } = {}) {
  const logger = createLogger();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        scenes: { type: 'string' }, capture: { type: 'string' }, ratio: { type: 'string' }, out: { type: 'string' },
        stills: { type: 'string' }, 'music-dir': { type: 'string' },
      },
    });
    if (!values.scenes || !values.capture || !values.ratio || !values.out) throw new UsageError(USAGE);
    const target = RATIOS[values.ratio];
    if (!target) throw new UsageError(`--ratio must be 1x1 or 9x16, got "${values.ratio}"`);
    const { size, captionMode } = target;

    const flowDurations = readCaptureDurations(values.capture);
    const doc = await load(values.scenes, { flowDurations });
    assertFootageFiles(doc.scenes, values.capture);
    const { ffmpeg, ffprobe } = await requireFfmpeg();

    // Layout failures are caught here, before a single frame is rendered or encoded.
    const issues = await layoutGate(doc.scenes, doc.brand, size, { captureDir: values.capture, captionMode });
    if (issues.length > 0) {
      for (const i of issues) logger.error(`layout ${i.kind} in scene ${i.scene + 1} field "${i.field}": ${i.detail}`);
      logger.error(`${values.ratio} layout check failed: nothing was rendered`);
      return 1;
    }

    const outDir = path.dirname(path.resolve(values.out));
    const workDir = path.join(outDir, `work-${values.ratio}`);
    const report = await renderVideo({
      scenes: doc, size, captureDir: values.capture, outFile: path.resolve(values.out), workDir,
      ffmpeg, ffprobe, captionMode,
      music: doc.music ? { ...doc.music, musicDir: values['music-dir'] } : null,
    });
    fs.rmSync(workDir, { recursive: true, force: true });
    logger.info(`reframed ${report.frames} frames at ${size.w}x${size.h} -> ${values.out}`);

    const { entries, warnings } = cropReport(doc.scenes, size);
    for (const w of warnings) logger.error(`warning: ${w}`);
    fs.writeFileSync(path.join(outDir, 'reframe-report.json'), `${JSON.stringify({ ratio: values.ratio, size, scenes: entries, warnings }, null, 2)}\n`);

    if (values.stills) {
      const { files } = await renderStills({
        scenes: doc.scenes, brand: doc.brand, size, captureDir: values.capture, outDir: values.stills, captionMode,
      });
      const sheet = path.join(values.stills, `contact-${values.ratio}.png`);
      await makeContactSheet({ ffmpeg, files: files.map((f) => f.file), out: sheet });
      logger.info(`stills: ${files.length} written to ${values.stills}; contact sheet: ${sheet}`);
    }
    return 0;
  } catch (e) {
    logger.error(e instanceof ValidationError ? `invalid scenes:\n${e.message}` : e.message);
    return e instanceof FfmpegUnavailableError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
