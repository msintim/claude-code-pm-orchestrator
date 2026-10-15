import fs from 'node:fs';
import path from 'node:path';
import { run, ffprobeJson } from './ffmpeg.js';
import { ENCODE, UsageError } from './render-core.js';

/** The still is not the size of the video, so it cannot be laid over frame 0. */
export class PosterSizeError extends UsageError {
  constructor(message) {
    super(message);
    this.name = 'PosterSizeError';
  }
}

/** One frame of `video` at `t` seconds as a high-quality JPEG. */
export async function extractFrame({ ffmpeg, video, t, out }) {
  await run(ffmpeg, ['-hide_banner', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-q:v', '2', out]);
}

async function videoSize(ffprobe, file) {
  const info = await ffprobeJson(ffprobe, file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new UsageError(`${file} has no video stream`);
  return { width: v.width, height: v.height };
}

/**
 * Writes the still as a JPEG and lays it over frame 0 of the video only, so feeds that thumbnail frame 0
 * show the poster. Audio is copied untouched and the encode matches the renderer's.
 */
export async function bakePoster({ ffmpeg, ffprobe, video, still, outVideo, outJpg }) {
  const size = await videoSize(ffprobe, video);
  const stillSize = await videoSize(ffprobe, still);
  if (size.width !== stillSize.width || size.height !== stillSize.height) {
    throw new PosterSizeError(
      `the still is ${stillSize.width}x${stillSize.height} but the video is ${size.width}x${size.height}; render the still at the video's size`,
    );
  }

  await run(ffmpeg, ['-hide_banner', '-y', '-i', still, '-frames:v', '1', '-q:v', '2', outJpg]);

  // Encode beside the target so the final rename never crosses a volume; this also makes outVideo === video safe.
  const temp = path.join(path.dirname(outVideo), `.${path.basename(outVideo, path.extname(outVideo))}.poster-tmp.mp4`);
  try {
    await run(ffmpeg, [
      '-hide_banner', '-y', '-i', video, '-i', still,
      // format=rgb24 drops any alpha channel so a translucent still replaces frame 0 instead of blending into it.
      '-filter_complex', "[1:v]format=rgb24[s];[0:v][s]overlay=0:0:enable='eq(n,0)'[v]",
      '-map', '[v]', '-map', '0:a?',
      '-c:v', ENCODE.codec, '-crf', String(ENCODE.crf), '-preset', ENCODE.preset, '-pix_fmt', ENCODE.pix_fmt,
      '-c:a', 'copy', '-movflags', ENCODE.movflags, temp,
    ]);
    fs.renameSync(temp, outVideo);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return size;
}
