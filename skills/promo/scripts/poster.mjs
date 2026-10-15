#!/usr/bin/env node
// Bake a poster still into frame 0 of a video (feeds thumbnail frame 0) and write the poster JPEG.
// --no-bake writes only the JPEG and leaves the video untouched: the hero loop must keep its own frame 0,
// or a different frame would flash on every loop.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FfmpegUnavailableError, requireFfmpeg, run } from './lib/ffmpeg.js';
import { UsageError } from './lib/render-core.js';
import { bakePoster } from './lib/poster.js';
import { createLogger } from './lib/log.js';

const USAGE = 'usage: poster.mjs --video <mp4> --still <png> --poster <jpg> (--out <mp4> | --no-bake)';

export async function main(argv) {
  const logger = createLogger();
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          video: { type: 'string' }, still: { type: 'string' }, out: { type: 'string' },
          poster: { type: 'string' }, 'no-bake': { type: 'boolean', default: false },
        },
      }));
    } catch (e) {
      throw new UsageError(`${e.message}\n${USAGE}`);
    }
    const noBake = values['no-bake'];
    if (!values.video || !values.still || !values.poster || (!noBake && !values.out)) throw new UsageError(USAGE);
    for (const [flag, file] of [['--video', values.video], ['--still', values.still]]) {
      if (!fs.existsSync(file)) throw new UsageError(`${flag} file not found: ${file}`);
    }
    const { ffmpeg, ffprobe } = await requireFfmpeg();

    if (noBake) {
      await run(ffmpeg, ['-hide_banner', '-y', '-i', values.still, '-frames:v', '1', '-q:v', '2', values.poster]);
      logger.info(`poster: ${values.poster} (video left unchanged)`);
      return 0;
    }
    const { width, height } = await bakePoster({
      ffmpeg, ffprobe, video: values.video, still: values.still, outVideo: values.out, outJpg: values.poster,
    });
    logger.info(`poster: ${width}x${height} baked into frame 0 -> ${path.resolve(values.out)}, ${values.poster}`);
    return 0;
  } catch (e) {
    logger.error(e.message);
    return e instanceof FfmpegUnavailableError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
