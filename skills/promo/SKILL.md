---
name: promo
description: Record a web app's staging flows with Playwright and render a 15-30 s launch video (16:9 master, 1:1, 9:16 reel, hero loop, posters) with FFmpeg. Use when asked for a product launch video, promo, demo clip or social share copy for a shipped web feature.
---

# /promo - product launch videos from real footage

`/promo` records the running product on **staging**, plans a short launch video, renders it deterministically and writes share copy. Footage is the product doing its job; templates (hook, title card, feature callout, outro) frame it.

**The skill directory is the directory containing this SKILL.md. Every script path below is relative to it.** Write `SKILL` for that directory's absolute path in the commands.

Run it **after** a deploy. It is never a merge or deploy gate.

## Prerequisites

- Node 22 or newer, full FFmpeg (with `ffprobe`; on PATH, or set `PROMO_FFMPEG` to its bin directory, and a set-but-invalid value is a hard failure), Playwright Chromium.
- Once per install: `npm ci` inside `SKILL/scripts/`, then `npx playwright install chromium` if the doctor asks for it.
- Always start with `node SKILL/scripts/doctor.mjs`. Fix every `FAIL` line before going on.
- A per-product config at `<product repo>/.promo/promo.yaml`. First run? Copy `examples/personal-website.promo.yaml` and adapt it. Field rules are in `references/capture.md`.

## Invocation

- `/promo` - plan from everything the config offers.
- `--feature <tag>` - only flows whose `feature:` matches that tag.
- `--tone <preset|freeform>` - a preset from the tones table or freeform direction.
- `--duration <s>` - master length, 15 to 30 (default 20 to 25).
- `--formats feed,reel,hero` - subset of outputs (`feed` covers 16:9 and 1:1). Default is all.

## Exit codes (every script)

`0` ok. `1` validation, hard gate, layout issue or unknown font. `2` environment (FFmpeg, Chromium or the OCR data missing; `doctor.mjs` and every script that launches the browser use it). `3` flow failure (stale selector or navigation). `report.failed.kind` in `capture/report.json` is one of selector, navigation, origin, pii, login or hide.

## Workflow

`RUN` is `promo-output/<YYYY-MM-DD-HHMMSS>/` in the product repo, new on every run. Nothing is overwritten.

1. **Capture** (`references/capture.md`)
   `node SKILL/scripts/capture.mjs --config .promo/promo.yaml --out RUN/capture [--feature <tag>]`
   Exit 3: repair the selector in the yaml (see capture.md), re-run. Exit 1 with kind `pii`, `origin`, `login` or `hide`: see Hard gates.
2. **Plan** (`references/plan.md`) - read the product's own copy and README, `capture/report.json` and the settle stills (view the images). Answer the rubric, then write `RUN/promo-plan.md`.
3. **Compose** (`references/compose.md`) - write `RUN/scenes.json` from the plan. Validation rejects bad fields with their path.
4. **Stills check loop**
   `node SKILL/scripts/render.mjs --scenes RUN/scenes.json --capture RUN/capture --out RUN/stills --stills`
   View the master stills plus any layout-flagged scene. Fix `scenes.json`, repeat. **Max 3 iterations**, then stop and report to the user what is still wrong. Exit 1 is a validation or layout failure: read the log, which names the field or scene.
5. **Render the master**
   `node SKILL/scripts/render.mjs --scenes RUN/scenes.json --capture RUN/capture --out RUN`
   Writes `master-16x9.mp4` and `render-report.json`.
6. **Reframe** (skip when `--formats` omits feed and reel)
   `node SKILL/scripts/reframe.mjs --scenes RUN/scenes.json --capture RUN/capture --ratio 1x1 --out RUN/feed-1x1.mp4 --stills RUN/stills-1x1`
   `node SKILL/scripts/reframe.mjs --scenes RUN/scenes.json --capture RUN/capture --ratio 9x16 --out RUN/reel-9x16.mp4 --stills RUN/stills-9x16`
   View only `contact-1x1.png` and `contact-9x16.png`. Read `reframe-report-<ratio>.json` warnings (focus crop coverage); fix `focus` and re-run. A layout failure renders nothing.
7. **Hero loop** (when `hero` is requested)
   `node SKILL/scripts/loop.mjs --scenes RUN/scenes.json --capture RUN/capture --out RUN`
   Writes `hero-loop.mp4` and `hero-loop.webm`. Needs at least 8.5 s of footage, else a usage error.
8. **Posters** (`references/deliver.md`) - pick the strongest settled still per output, then
   `node SKILL/scripts/poster.mjs --video RUN/master-16x9.mp4 --still <png> --poster RUN/poster-16x9.jpg --out RUN/feed-16x9.mp4`
   Repeat for 1x1 and 9x16. For the hero loop use `--no-bake` (never bake a poster into a loop).
9. **Share copy** - write `RUN/share-copy.md` (channel rules in deliver.md).
10. **Report** - where each file is, one sentence on the creative angle, any gate or reframe warnings, and an offer to re-roll a scene or try another tone.

Reports: `render.mjs` writes `render-report.json`; `reframe.mjs` writes `render-report-<ratio>.json` and `reframe-report-<ratio>.json`, so the master's report is never overwritten. All deliverables share one output directory.

## Hard gates

Three gates fail the run with no override flag:

1. **Origin gate.** Any navigation outside `staging.url`'s origin aborts the flow, including cross-origin iframes (kind `origin`).
2. **`pii_policy`.** Missing from the config, the run refuses before the browser opens.
3. **PII scan.** Every captured still is OCR'd and the DOM text is scanned for emails, phone numbers, card-like digit runs and every `redact:` string. A hit fails the run and names the frame. Text that exists only as pixels (images, canvas, video, CSS pseudo-elements) is OCR'd only at a `settle`: put a `settle` on every state you show and `hide:` image regions (gaps in `references/capture.md`). A `hide:` selector whose match is still visible fails the run (kind `hide`). `hide:` takes CSS selectors only; Playwright selectors (`:has-text()`, `text=`) are rejected.

**Never edit around a gate.** If a gate fires, fix the demo data, add a `hide:` selector or a `redact:` string, or change the flow. Do not weaken the config, skip the scan, shorten footage to dodge a frame, or hand-edit output. The gates are fail-closed, so false positives happen (long numeric IDs, millisecond timestamps); known blind spots and the full list are in `references/capture.md`. Never post a video that was not produced through the gates.

## Creative laws

- **Short.** 15-30 seconds; 20-25 is the sweet spot.
- **Clear to a stranger.** After one viewing, someone who's never heard of it knows what it does, who it's for, and how to get it. Lead with that, not with how it's built.
- **The hook is everything.** The first 2 seconds decide whether anyone keeps watching. Plan it first.
- **Show the thing.** At least 50% of the runtime is real captured footage of the working product, never abstract filler. Small illustrative UI text is fine when showing the product in use; invented claims, numbers, or testimonials are not.
- **No unsourced claims.** No on-screen claim that is not in the product's own copy or README. Cite where each claim came from in `promo-plan.md`.
- **Specific.** It must feel made for this exact project. Use its own copy and claims; no generic SaaS language ("streamline your workflow" is banned).
- **Readable.** Pace comes from motion and cuts, not from pulling text away early. Any line the viewer is meant to read stays fully visible and settled long enough to read it (roughly 0.3s per word), counted from when the whole line is on screen.
- **Make it alive.** Things that appear one by one, simulated clicks, and typing beat static slides.
- **Funny earns its place.** Humor comes from the project's own absurdity, not from trying.
- **Every frame postable.** Any frozen frame should be worth sharing.

## Rubric (answer before planning)

What is it (one sentence)? Who is it for, and what does it do for them? What sets it apart? What's the most impressive or funniest claim? What's the visual hook? What real UI or flow should be shown? What tone fits? What's the one-line share caption?

Everything gathered here can end up in a public video. Never carry secrets, API keys, tokens, internal hostnames or URLs, real customer or user names, email addresses, or other personal data into the plan, the video, or the share copy. If the real UI shows such data, swap in plausible fictional stand-ins in the staging data and say so in the plan.

## Tones

Presets are defaults; freeform direction ("fake Series A launch from 2016") refines or overrides them. Transitions available: `cut`, `dip-to-brand`, `slide`, `none`.

| Tone | Feel | Pacing / transitions |
|---|---|---|
| `default` | Punchy, playful, clean | 4-5 scenes; `dip-to-brand`, `slide` |
| `polished` | Serious, elegant, restrained | 3-4 scenes, long holds; `dip-to-brand` |
| `yc-parody` | Deadpan startup launch, played straight | 4-5 scenes, one claim each; `cut` |
| `chaotic` | FAST, LOUD, ALL CAPS | 6-7 scenes, some under 2s; `cut` |
| `deadpan` | Calm, dry, nothing is a joke | 3-4 scenes, big empty space; `none`, `dip-to-brand` |
| `cinematic` | Trailer-scale, epic claims | 4-5 scenes, big type; `dip-to-brand` |
| `app-store` | Clean feature cards | 4-6 scenes; `slide` |

## Dispatch recipe (Opus 5.5)

Plan, compose and the stills check loop are model work. Run them in an **Opus 5.5** sub-agent, pinned by full model ID or through a pinned agent definition (never a floating `opus` alias), with:

- **Token budget 150K.** Past it, stop and report BLOCKED with what is missing.
- **Reads only** the product repo and the yaml's staging origin. **Writes only** under `promo-output/<timestamp>/`.
- **Never posts** anywhere (no social, no PR comments, no uploads). The user posts.
- Prompt contents: this SKILL.md path, the config path, the flags from the invocation, the run directory.
- Needs the stills-check token rule: view the master stills plus any layout-flagged scene, and only the 1:1 and 9:16 contact sheets.

Capture, render and delivery commands are mechanical and can run in the parent session.

## What is committed

`promo-output/` is gitignored except `promo-plan.md` and `share-copy.md`, which are committed as the record of what was claimed on screen. The rule for the product repo's `.gitignore` is `promo-output/*/*`, `!promo-output/*/promo-plan.md`, `!promo-output/*/share-copy.md`. Commit `.promo/promo.yaml` too (credentials are env var names only). Videos stay out of git.

## Music

`music` in `scenes.json` names a track: `{ "track": "<name>", "gain_db": -14, "duck_db": -6 }` (those are the defaults). Tracks live in `assets/music/` as `<track>.mp3` plus `<track>.cues.json`, with a row per track in `assets/music/LICENSES.md`. Three ende.app tracks (CC BY 4.0, Sascha Ende) are bundled: `happy-beats-business-moves-vol-1`, `happy-beats-business-moves-vol-3` and `happy-beats-business-moves-vol-12`. `--music-dir <dir>` on `render.mjs` and `reframe.mjs` points at any licensed track with its cues file. Cue files for new tracks come from the maintainer tool `tools/analyze_music_cues.py` (run via `uv run --project tools ...`). Cue alignment is in `references/compose.md`; the CC BY credit line is in `references/deliver.md`.

## References

- `references/plan.md` - storyboard, reading time, what to show, transitions.
- `references/capture.md` - the yaml, beats, gates and their gaps, repair loop.
- `references/compose.md` - scenes.json, templates and text limits, cues, focus.
- `references/deliver.md` - formats, posters, share copy, attribution.

Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi.
