# Compose: writing scenes.json

Turn `promo-plan.md` into `RUN/scenes.json`. You fill fields; you never write CSS. The renderer validates the file before doing anything and rejects problems with the field path (exit 1).

```json
{
  "version": 1,
  "fps": 30,
  "master": { "w": 1920, "h": 1080 },
  "brand": { "primary": "#0F766E", "accent": "#F59E0B", "font": "Inter", "theme": "light" },
  "music": { "track": "<track name>", "gain_db": -14, "duck_db": -6 },
  "scenes": [
    { "type": "hook", "duration": 2.5, "text": "Rent day, without the chasing.", "transition": "dip-to-brand" },
    { "type": "footage", "flow": "rent-collection", "in": 3.2, "out": 9.0,
      "focus": { "x": 420, "y": 180, "w": 1080, "h": 720 },
      "caption": "Record a payment in one tap", "transition": "cut" },
    { "type": "feature-callout", "duration": 3, "title": "Arrears, flagged automatically", "body": "Overdue tenants rise to the top.", "transition": "slide" },
    { "type": "outro", "duration": 3, "text": "RPMS", "sub": "rpms.example", "transition": "none" }
  ]
}
```

`version` is 1, `fps` 30, `master` 1920x1080. `brand` repeats the yaml's brand. `music` is optional.

## Brand font

`brand.font` is ONE installed family name (for example `Manrope`), not a CSS list. `"Inter, sans-serif"` fails with exit 1 (unknown font). The renderer never fetches fonts: install the family on the machine that renders, or change the font.

## Templates and text limits

Every scene has a `transition` into the next one: `cut`, `dip-to-brand`, `slide` or `none`. The last scene must use `none`. Durations are in seconds.

| Template | Fields | Notes |
|---|---|---|
| `hook` | `duration`, `text`, `transition` | The first 2 seconds. One line. |
| `title-card` | `duration`, `title`, `sub` (optional), `transition` | Name the product and who it is for. |
| `feature-callout` | `duration`, `title`, `body`, `transition` | One claim, one payoff. |
| `footage` | `flow`, `in`, `out`, `focus` (optional), `caption`, `transition` | A cut from a captured flow. `out` cannot pass the flow's recorded length. |
| `outro` | `duration`, `text`, `sub` (optional), `transition` | Product name plus where to get it. |

Maximum characters per field (the schema and the layout check enforce these):

| Template | Field | Max |
|---|---|---|
| `hook` | `text` | 60 |
| `title-card` | `title` | 50 |
| `title-card` | `sub` | 80 |
| `feature-callout` | `title` | 60 |
| `feature-callout` | `body` | 140 |
| `outro` | `text` | 30 |
| `outro` | `sub` | 50 |
| `footage` | `caption` | 60 |

Other enforced rules:

- Scene durations sum to 15-30 s and footage is at least 50% of that.
- A scene lasts at least 0.5 s of entrance plus the longest text hold, where the hold is max(0.8 s, 0.3 s x words). Footage counts `out - in` against its caption.
- A caption on every footage scene.
- Layout check: text that overflows or collides fails the render with exit 1. A schema-legal caption can still fail: a run of very wide glyphs (for example 60 x `W`) can wrap to 3 lines at 1:1 even though 60 characters are allowed. Shorten it.

Templates are built to render at 16:9, 1:1 and 9:16, so the same `scenes.json` drives every format.

## Footage: in, out, focus

`in` and `out` are seconds into the flow's recording. Pick settled stretches that match the `settle` timestamps in `capture/report.json`.

`focus` is a rectangle in 1920x1080 master coordinates. The crop is padded to the target ratio and clamped to the frame, in every format; without a `focus` the full frame is used at 16:9 and a centred crop at 1:1 and 9:16. Footage is captured at 1920x1080 real pixels, so zooms and the 9:16 crop upscale up to 2x and look softer. Keep zooms modest.

**Choose a tall or narrow focus for the reel.** A 9:16 crop is a thin vertical slice of the frame. If the focus is a wide rectangle, the reel keeps only part of it. `reframe.mjs` reports this: stderr prints `warning: scene N (flow "..."): the 1080x1920 crop keeps only 0.xxxx of its focus area; widen the focus or accept the crop`, and the same text is in `reframe-report-<ratio>.json` under `warnings`. Fix by giving that scene a taller, narrower `focus` (around the UI element that carries the story), then re-run reframe. With no `focus` the crop is centred.

## Music cues

`music.track` names `<track>.mp3` (or `.wav`) plus `<track>.cues.json` in `assets/music/` or in the directory given by `--music-dir`. `gain_db` (default -14) and `duck_db` (default -6, applied under footage) must be 0 or below. Bundled music may be absent in this build; any licensed track with a cues file works through `--music-dir`. New cues files come from the maintainer tool `tools/analyze_music_cues.py` (run via `uv run --project tools ...`).

The cues file has `duration`, `tempo`, `beats` (beat-grid points with `time` and normalized `intensity`) and `strongCues`: the highest-value landing moments with `time`, `intensity` and `kind` (`strong_beat` / `onset_peak`).

Align scene boundaries to `strongCues[].time`:

- Major reveals (hook landing, the first footage cut, the outro): within 0.15 s of a strong cue.
- Small entrances (a callout line, a caption): within 0.10 s of a strong cue.
- Lock 1-3 cues per video. More feels mechanical.
- Ignore cues when they harm copy readability, scene pacing, or the product story.
- For deadpan or restraint-heavy tones, cues should be rare, quiet, or saved for the final logo.

Alignment is a report, never a gate: `render-report.json` lists the nearest cue and delta for each boundary, and a miss never fails a render.

If no cue source is available, write this in `promo-plan.md` and continue without beat or cue sync:

```text
Music cue guidance: unavailable; continue without beat/cue sync.
```

Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi.
