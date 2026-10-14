# Deliver: formats, posters, share copy

All deliverables land in one run directory, `promo-output/<timestamp>/`.

## Formats

| Output | Size | Length | Audio | Captions | Produced by |
|---|---|---|---|---|---|
| `feed-16x9.mp4` | 1920x1080 | 15-30 s | music | yes | `render.mjs` (writes `master-16x9.mp4`), then `poster.mjs` |
| `feed-1x1.mp4` | 1080x1080 | same | music | yes | `reframe.mjs --ratio 1x1` |
| `reel-9x16.mp4` | 1080x1920 | same | music | yes, inside the Instagram safe area (top 250 px and bottom 340 px clear) | `reframe.mjs --ratio 9x16` |
| `hero-loop.mp4`, `hero-loop.webm` | 1920x1080 | 8-15 s | none | none | `loop.mjs` |
| `poster-<output>.jpg` | matches its output | n/a | n/a | n/a | `poster.mjs` |
| `share-copy.md` | n/a | n/a | n/a | n/a | the model |

Reframing re-renders template scenes natively at the target ratio from the same `scenes.json`. Footage crops to the scene's `focus` (padded to the ratio, clamped to the frame); without one, a centre crop. Nothing is letterboxed. Run reframe with `--stills <dir>` and view only the 1:1 and 9:16 contact sheets.

Reports sit beside the outputs and never overwrite each other: `render-report.json` (master), `render-report-<ratio>.json` and `reframe-report-<ratio>.json` per reframe. Read the `warnings` in the reframe reports.

## Hero loop

Footage scenes only, no text, no audio. `loop.mjs` picks in and out points where inter-frame difference is lowest (UI static), targets 8-15 s, and crossfades the final 500 ms into the first 500 ms so playback loops without a visible jump. Output is mp4 and webm with `+faststart`. It fails with a usage error when the footage is shorter than 8.5 s; capture a longer flow or add footage scenes.

## Posters

Pull the strongest *settled* frame (text fully in, not mid-transition) from the stills you already viewed. Then:

```
node scripts/poster.mjs --video <in.mp4> --still <png> --poster <out.jpg> --out <baked.mp4>
```

This writes the JPEG and bakes it in as frame 0 of that output, replacing frame 0 rather than adding a frame, so duration, frame count and audio sync stay the same. At 30 fps the poster shows for 1/30 s before the intro rolls, so it is imperceptible on playback but it is what every thumbnail grabber sees. Stills with transparency are flattened first so nothing bleeds into frame 0.

Do one poster per video: 16:9, 1:1 and 9:16. Use a still from the matching ratio (the master stills for 16:9, the reframe stills for the others).

**The hero loop is never baked.** A different frame 0 would flash on every loop. Use `--no-bake`, which writes only the JPEG and leaves the video untouched:

```
node scripts/poster.mjs --video RUN/hero-loop.mp4 --still <png> --poster RUN/poster-hero.jpg --no-bake
```

## Share copy

Write `RUN/share-copy.md` with one caption per channel, postable as-is, specific to the project, and tone-matched to the video:

- **LinkedIn:** 2-4 sentences, no hashtags.
- **X:** 240 characters or fewer.
- **Instagram:** a short line plus up to 8 hashtags.

Banned: "Excited to share" and generic SaaS language. Every claim must be one the video already makes, sourced from the product's own copy or README. No secrets, internal hostnames, real names or emails.

`share-copy.md` is committed with `promo-plan.md` as the record of what was claimed.

## CC BY attribution

If `render-report.json` has a non-null `audio.attribution`, the track needs a credit: append it as a footnote on its own line to every caption that ships with a video that uses it, for example:

```
Music: "<title>" by <author>, CC-BY-4.0, <url>
```

Use the string from `render-report.json.audio.attribution` exactly. It is null for CC0 tracks and for a `--music-dir` without a `LICENSES.md`, in which case you are responsible for any licence terms of music you supplied.

## Tell the user

Where the video and copy are, one sentence on the creative angle, any gate or reframe warnings, and an offer to re-roll a scene or try another tone. Never post anything yourself.

Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi.
