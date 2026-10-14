#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadScenes, ValidationError } from './lib/schema.js';
import { FfmpegUnavailableError, requireFfmpeg } from './lib/ffmpeg.js';
import { FontUnavailableError, makeContactSheet, renderStills } from './lib/render-core.js';
import { createLogger } from './lib/log.js';

class UsageError extends Error {}

function parseSize(text) {
  const m = /^(\d+)x(\d+)$/.exec(text);
  if (!m || Number(m[1]) < 16 || Number(m[2]) < 16) throw new UsageError(`--size must look like 1920x1080, got "${text}"`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

async function main(argv) {
  const logger = createLogger();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        scenes: { type: 'string' }, capture: { type: 'string' }, out: { type: 'string' },
        stills: { type: 'boolean' }, size: { type: 'string' },
      },
    });
    if (!values.scenes || !values.out) {
      throw new UsageError('usage: render.mjs --scenes <scenes.json> --capture <dir> --out <dir> --stills [--size WxH]');
    }
    if (!values.stills) throw new UsageError('only --stills is available yet; the full video render arrives with the footage scenes');

    const doc = await loadScenes(values.scenes);
    const size = values.size ? parseSize(values.size) : doc.master;
    const { files, layoutIssues } = await renderStills({
      scenes: doc.scenes, brand: doc.brand, size, captureDir: values.capture, outDir: values.out,
    });
    logger.info(`stills: ${files.length} written to ${values.out} at ${size.w}x${size.h}`);
    for (const i of layoutIssues) logger.error(`layout ${i.kind} in scene ${i.scene + 1} field "${i.field}": ${i.detail}`);

    const { ffmpeg } = await requireFfmpeg();
    const sheet = path.join(values.out, 'contact-sheet.png');
    await makeContactSheet({ ffmpeg, files: files.map((f) => f.file), out: sheet });
    logger.info(`contact sheet: ${sheet}`);
    return layoutIssues.length > 0 ? 1 : 0;
  } catch (e) {
    logger.error(e instanceof ValidationError ? `invalid scenes:\n${e.message}` : e.message);
    return e instanceof FfmpegUnavailableError || e instanceof FontUnavailableError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
