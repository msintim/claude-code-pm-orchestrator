#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadScenes, ValidationError } from './lib/schema.js';
import { FfmpegUnavailableError, requireFfmpeg } from './lib/ffmpeg.js';
import {
  BrowserUnavailableError, UsageError, assertFootageFiles, makeContactSheet, readCaptureDurations, renderStills, renderVideo,
} from './lib/render-core.js';
import { createLogger } from './lib/log.js';

function parseSize(text) {
  const m = /^(\d+)x(\d+)$/.exec(text);
  if (!m || Number(m[1]) < 16 || Number(m[2]) < 16) throw new UsageError(`--size must look like 1920x1080, got "${text}"`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

const USAGE = 'usage: render.mjs --scenes <scenes.json> --capture <dir> --out <dir> [--size WxH] [--stills] [--webm] [--keep-frames] [--music-dir <dir>]';

async function main(argv) {
  const logger = createLogger();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        scenes: { type: 'string' }, capture: { type: 'string' }, out: { type: 'string' },
        stills: { type: 'boolean' }, size: { type: 'string' }, webm: { type: 'boolean' },
        'keep-frames': { type: 'boolean' }, 'music-dir': { type: 'string' },
      },
    });
    if (!values.scenes || !values.out || !values.capture) throw new UsageError(USAGE);

    const flowDurations = readCaptureDurations(values.capture);
    const doc = await loadScenes(values.scenes, { flowDurations });
    const size = values.size ? parseSize(values.size) : doc.master;
    assertFootageFiles(doc.scenes, values.capture);
    const { ffmpeg, ffprobe } = await requireFfmpeg();

    if (values.stills) {
      const { files, layoutIssues } = await renderStills({
        scenes: doc.scenes, brand: doc.brand, size, captureDir: values.capture, outDir: values.out,
      });
      logger.info(`stills: ${files.length} written to ${values.out} at ${size.w}x${size.h}`);
      for (const i of layoutIssues) logger.error(`layout ${i.kind} in scene ${i.scene + 1} field "${i.field}": ${i.detail}`);
      const sheet = path.join(values.out, 'contact-sheet.png');
      await makeContactSheet({ ffmpeg, files: files.map((f) => f.file), out: sheet });
      logger.info(`contact sheet: ${sheet}`);
      return layoutIssues.length > 0 ? 1 : 0;
    }

    fs.mkdirSync(values.out, { recursive: true });
    const outFile = path.join(values.out, 'master-16x9.mp4');
    const report = await renderVideo({
      scenes: doc, size, captureDir: values.capture, outFile, workDir: path.join(values.out, 'work'),
      ffmpeg, ffprobe, webm: values.webm, keepFrames: values['keep-frames'],
      music: doc.music ? { ...doc.music, musicDir: values['music-dir'] } : null,
    });
    logger.info(`rendered ${report.frames} frames at ${size.w}x${size.h} -> ${outFile}`);
    for (const i of report.layoutIssues) logger.error(`layout ${i.kind} in scene ${i.scene + 1} field "${i.field}": ${i.detail}`);
    return report.layoutIssues.length > 0 ? 1 : 0;
  } catch (e) {
    logger.error(e instanceof ValidationError ? `invalid scenes:\n${e.message}` : e.message);
    return e instanceof FfmpegUnavailableError || e instanceof BrowserUnavailableError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
