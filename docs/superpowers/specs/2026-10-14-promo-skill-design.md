# /promo — product launch-video skill (design spec)

**Date:** 2026-10-14
**Status:** Draft for review
**Owner:** Saint (Michael Sintim-Koree)
**Supersedes:** nothing. Informed by a read of `latent-spaces/brag` v0.4.0 (MIT).

## 1. Purpose

`/promo` turns a product with a running staging instance into a set of short, polished, shareable videos: a LinkedIn/X feed cut (16:9 and 1:1), an Instagram Reel (9:16), and a silent website hero loop, plus poster frames and per-channel share copy. It targets Saint's own products (RPMS and AssetBridge first, personal-website as the no-PII smoke test) and is meant to be re-run on every feature launch.

"Better than brag" means, in priority order: **higher-end output** (real product footage from staging rather than motion text over screenshots), then repeatability (the same inputs render the same video), then cost (the model plans and reviews; it never improvises a renderer).

### Success criteria

1. One `/promo` run against RPMS staging produces all deliverables in §7, each playable, each passing the PII scan, in under 15 minutes wall-clock and under ~70K Opus 5.5 tokens for the planning/compose/check steps.
2. Re-rendering an unchanged `scenes.json` produces a byte-identical frame sequence.
3. At least half of the master cut's runtime is real captured footage.
4. The skill is discoverable and runnable from Claude Code and Codex CLI on Windows without symlinks.

### Non-goals (v1)

Voiceover, SFX library, PR-diff as input, cloud rendering, auto-posting to any platform, animated logo stings, A/B variants.

## 2. What is taken from brag, what is changed

| From brag (keep) | Change in /promo |
|---|---|
| Creative laws: short, hook first, show the thing, specific, readable, no generic SaaS language, every frame postable | Kept verbatim in `SKILL.md`, plus two of ours: ≥50% real footage; no on-screen claim that isn't in the product's own copy/README |
| Planning rubric (what is it, who for, what sets it apart, strongest claim, visual hook, flow to show, tone, caption) | Kept; answers recorded in `promo-plan.md` |
| Plan → check stills → render gates | Kept; the stills check is done by the model on rendered PNGs, not by a third-party linter |
| Tone presets (default, polished, yc-parody, chaotic, deadpan, cinematic, app-store) | Kept, defaults to `polished` for products |
| Secrets/PII rule ("never carry secrets, keys, hostnames, real names into the video") | Turned from a request into a hard check: URL allow-list + OCR scan of every captured still |
| Poster frame baked as frame 0 | Kept, per output |
| Bundled CC-BY music with precomputed beat cues | Kept, smaller set (4–5 tracks) |
| Hyperframes dependency | Removed. Rendering is Playwright + FFmpeg, already present on the machine |
| Model builds the pipeline each run (brag-slim) | Removed. Fixed scripts; model fills a validated JSON schema |
| 17 MB SFX library | Removed |

## 3. Architecture

```
            promo.yaml (per product repo)        SKILL.md + references (skill)
                     │                                     │
                     ▼                                     ▼
   capture.mjs ──► capture/ (webm + stills + report.json) ──► Opus: plan ──► promo-plan.md
                                                                   │
                                                                   ▼
                                                         Opus: compose ──► scenes.json (schema-validated)
                                                                   │
                                            render.mjs --stills ◄──┘
                                                   │
                                            Opus: check stills, fix scenes.json (loop until clean)
                                                   │
                                            render.mjs ──► master-16x9.mp4
                                                   │
                      ┌────────────────────────────┼─────────────────────────┐
                      ▼                            ▼                         ▼
               reframe.mjs 1:1            reframe.mjs 9:16              loop.mjs hero
                      │                            │                         │
                      └──────────── poster per output + share-copy.md ───────┘
```

Model work (Opus 5.5): plan, compose, stills check, shot/focus selection, share copy.
Deterministic work (Node scripts): capture, validation, rendering, reframing, looping, PII scan.

### 3.1 Skill layout

Lives at `skills/promo/` in this repo (versioned, ships with the kit) and is installed as a real copy to each agent's skill directory (see §9).

```
skills/promo/
  SKILL.md                 workflow, gates, creative laws (~200 lines)
  references/
    plan.md                rubric, tones, storyboard format, focus-region rules
    capture.md             writing and repairing promo.yaml flows; cursor/timing rules
    compose.md             scene template catalogue, scenes.json schema walkthrough, caption rules, loop rules
    deliver.md             formats matrix, poster rules, share copy per channel
  scripts/
    package.json           deps: playwright (uses already-installed browsers), tesseract.js, ajv, yaml
    capture.mjs
    render.mjs
    reframe.mjs
    loop.mjs
    lib/                   schema.js, pii.js, cursor.js, geometry.js, loop-points.js, ffmpeg.js
    test/                  unit tests + e2e fixture run
  templates/
    hook.html  title-card.html  feature-callout.html  caption-bar.html  outro.html  base.css
  assets/music/
    <track>.mp3  <track>.cues.json  LICENSES.md
  fixtures/demo-site/      tiny static site + .promo/promo.yaml for the e2e test
```

### 3.2 Per-product config: `.promo/promo.yaml`

Committed in the product repo. Credentials are env-var *names* only.

```yaml
version: 1
product: RPMS
tagline: "Property management for Ghana, done properly"
brand:
  primary: "#0F766E"
  accent: "#F59E0B"
  font: "Inter"            # must be loadable locally or via Google Fonts
  theme: light
staging:
  url: https://staging.rpms.example      # the ONLY origin capture may touch
  login:
    path: /login
    user_env: RPMS_DEMO_USER
    pass_env: RPMS_DEMO_PASS
    submit: "button[type=submit]"
    settled: "[data-testid=dashboard]"
hide: [".cookie-banner", "#dev-toolbar"]
pii_policy: demo-tenant-only            # required; run refuses without it
redact: ["Sintim", "@gmail.com"]        # extra strings the OCR scan must not find
flows:
  - name: tenant-onboarding
    feature: tenants
    beats:
      - goto: /tenants/new
      - fill: { selector: "#name", text: "Ama Mensah" }
      - click: "text=Save tenant"
      - settle: ".toast-success"
  - name: rent-collection
    feature: payments
    beats: [...]
music:
  prefer: upbeat-clean       # optional hint; model picks from bundled set
```

Beat vocabulary (v1): `goto`, `click`, `fill`, `select`, `hover`, `scroll` (to selector), `wait` (ms, max 3000), `settle` (selector). Anything else fails validation. Flows are declarative so a stale selector fails loudly and is fixed in the yaml, never papered over by the model.

## 4. Capture (`capture.mjs`)

Input: `promo.yaml` path, output dir, optional `--feature <tag>` filter.
Output: `capture/<flow>.webm` (1920×1080, 60 fps, device-scale 2), `capture/<flow>-<n>.png` at every `settle`, `capture/report.json`.

Rules:
- Fresh Playwright context per flow; viewport fixed; `prefers-reduced-motion` **off** (we want the product's own motion); selectors in `hide:` set to `display:none` on every navigation.
- Login runs once per flow using env vars; the password never appears in logs, report, or stills (the login page is not recorded).
- Scripted cursor overlay: eases to the target over ~400 ms (cubic ease-out), 150 ms pause, click ripple. Typing at 60–90 ms per character with ±20 ms jitter. Scroll is smooth programmatic scroll.
- Each beat waits for network idle and (for `settle`) the selector, then holds 600 ms.
- `report.json`: per flow, per beat timestamps, settle still paths, durations, and the PII scan result.

**Hard gates (fail the run, no override flag):**
1. Any navigation whose origin differs from `staging.url` aborts the flow.
2. Missing `pii_policy` aborts before the browser opens.
3. After capture, every still is OCR'd with `tesseract.js`. A hit on an email pattern, a phone-number pattern (Ghana and international forms), an IBAN/card-like digit run, or any `redact:` string fails the run and names the frame. DOM text is scanned too (cheap, catches what OCR misses on small type).

Stale-selector failure: the script exits non-zero with the flow and beat name and a screenshot at the failure point; `capture.md` tells the model to repair the yaml and re-run, not to improvise around it.

## 5. Plan and compose (model work)

**Plan.** Opus reads: product source (copy, README, CSS tokens), `report.json`, the settle stills (images), and `promo.yaml`. It answers the rubric and writes `promo-plan.md`: angle, hook, tone, 4–7 scenes totalling 20–30 s for the master, each scene a **template scene** (`hook`, `title-card`, `feature-callout`, `outro`) or a **footage scene** (flow, in/out seconds, optional `focus` region in master coordinates, caption line). It also picks the music track and aligns scene boundaries to the track's strong cues where that doesn't hurt readability.

**Compose.** Opus writes `scenes.json`. The renderer validates it against a JSON Schema (ajv) before doing anything; invalid files are rejected with the field path.

```json
{
  "version": 1,
  "fps": 30,
  "master": { "w": 1920, "h": 1080 },
  "brand": { "primary": "#0F766E", "accent": "#F59E0B", "font": "Inter", "theme": "light" },
  "music": { "track": "upbeat-clean-01", "gain_db": -14, "duck_db": -6 },
  "scenes": [
    { "type": "hook", "duration": 2.5, "text": "Rent day, without the chasing.", "transition": "dip-to-brand" },
    { "type": "footage", "flow": "rent-collection", "in": 3.2, "out": 9.0,
      "focus": { "x": 420, "y": 180, "w": 1080, "h": 720 },
      "caption": "Record a payment in one tap", "transition": "cut" },
    { "type": "feature-callout", "duration": 3, "title": "Arrears, flagged automatically", "body": "…", "transition": "slide" },
    { "type": "outro", "duration": 3, "text": "RPMS", "sub": "rpms.example", "transition": "none" }
  ]
}
```

Rules enforced by schema or renderer: scene durations sum to 15–30 s; footage ≥ 50% of runtime; caption on every footage scene for feed/reel outputs; text fields have max lengths per template; readability hold = max(0.8 s, 0.3 s × words) after the line is fully on screen.

Template scenes are HTML/CSS with brand tokens injected as CSS variables. The model fills fields; it does not write CSS. Templates must render correctly at 16:9, 1:1 and 9:16 (container queries), which is what makes native reframing possible.

**Stills check gate.** `render.mjs --stills` renders one PNG per scene at its midpoint and one at each transition midpoint. Opus reviews them for overflow, collisions, low contrast, caption legibility, and muddy crossfades, edits `scenes.json`, and repeats until clean. Max 3 iterations before it reports to the user.

## 6. Render (`render.mjs`)

- Opens a local compositor page in Playwright (served from a temp dir on `127.0.0.1`). The page takes a `t` via postMessage and renders the frame for that time: template scenes via DOM, footage scenes via a `<video>` element seeked to the exact frame (`currentTime` + `seeked` + `requestVideoFrameCallback`), transitions composited in CSS.
- Every frame is a pure function of `t`. Fonts and images are awaited before the first capture. Frames are captured as PNG to `work/frames/`.
- FFmpeg (Playwright's bundled binary, or system ffmpeg if on PATH) encodes H.264 yuv420p at 30 fps, CRF 18, with the music track mixed in: gain from `music.gain_db`, ducked by `duck_db` during footage scenes, 300 ms fade-out at the end. Also writes a `.webm` (VP9) for the hero loop case.
- Output: `master-16x9.mp4` + `render-report.json` (frame count, checksum of the frame sequence, encode settings). Determinism check in tests compares the checksum across two renders.

## 7. Delivery

| Output | Size | Length | Audio | Captions | Produced by |
|---|---|---|---|---|---|
| `feed-16x9.mp4` | 1920×1080 | 20–30 s | music | yes | master |
| `feed-1x1.mp4` | 1080×1080 | same | music | yes | `reframe.mjs` |
| `reel-9x16.mp4` | 1080×1920 | same | music | yes, inside IG safe area (top 250 px / bottom 340 px clear) | `reframe.mjs` |
| `hero-loop.mp4`, `hero-loop.webm` | 1920×1080 | 8–15 s | none | none | `loop.mjs` |
| `poster-<output>.jpg` | matches | – | – | – | best settled frame, baked as frame 0 of that output |
| `share-copy.md` | – | – | – | – | model |

**Reframe.** Template scenes re-render natively at the target ratio from the same `scenes.json`. Footage scenes crop to the scene's `focus` region (padded to the target ratio, clamped to the frame); without a `focus`, centre crop with the caption bar guaranteed inside the safe area. Nothing is letterboxed.

**Hero loop.** Footage scenes only, no text, no music. `loop.mjs` picks in/out points at frames where inter-frame difference is lowest (UI static), targets 8–15 s, and crossfades the final 500 ms into the first 500 ms so playback loops without a visible jump. Encoded as mp4 and webm with `movflags +faststart`.

**Poster.** Per output, the strongest *settled* frame (text fully in, not mid-transition), chosen by the model from the stills set, written as JPEG and swapped in as frame 0 of that output without changing duration or audio offset.

**Share copy.** `share-copy.md` with one caption each for LinkedIn (2–4 sentences, no hashtags), X (≤ 240 chars), Instagram (short line + up to 8 hashtags). Tone matches the plan. "Excited to share" and generic SaaS phrasing banned.

## 8. Workflow fit

- `/promo` runs **post-deploy**, never as a merge or deploy gate.
- Dispatch recipe (in `SKILL.md`): Opus 5.5 sub-agent, token budget 150K, reads only the product repo and its yaml's staging origin, writes only under `promo-output/`. It never posts anywhere; Saint posts.
- `promo-output/` is gitignored except `promo-plan.md` and `share-copy.md`, which are committed as the record of what was claimed on screen.
- `/promo --feature <tag>` restricts shot selection to flows tagged with that feature. `/promo --tone <preset|freeform>` and `/promo --duration <s>` as in brag. `/promo --formats feed,reel,hero` to produce a subset.
- Output directory is timestamped on every run (`promo-output/2026-10-14-143022/`); nothing is overwritten.

## 9. Cross-agent compatibility

- `SKILL.md` follows the Agent Skills format read by Claude Code, Codex CLI, Cursor, Gemini CLI, opencode and Antigravity. No Claude-only tool calls inside the skill; scripts take explicit path arguments; the skill directory is "the directory containing SKILL.md".
- Install as real copies, not symlinks (symlinks break on Windows without Developer Mode): `npx skills add <kit repo> --skill promo -g`, or copy `skills/promo/` into `~/.claude/skills/promo/` and `~/.agents/skills/promo/`. Documented in the kit README.
- One line in the workspace `AGENTS.md` points every agent at the skill and at `.promo/promo.yaml`.

## 10. Testing

- **Unit (node:test):** scenes.json schema (valid/invalid fixtures), readability hold calculation, reframe geometry (focus padding, clamping, safe-area), loop point selection on a synthetic frame-difference series, PII regexes (positives and near-misses), yaml beat validation.
- **E2E fixture:** `fixtures/demo-site/` is a static site served locally with its own `promo.yaml` (two flows) and a tiny `scenes.json`. `npm test` runs capture → render → reframe → loop and asserts: three playable mp4s plus webm (ffprobe duration/size), PII scan clean, frame-sequence checksum identical across two renders.
- **Negative E2E:** a fixture page containing a fake email address must fail the PII gate and name the frame.
- **First real runs:** personal-website (live, no PII, no login) as smoke test; then RPMS staging with the demo tenant; then AssetBridge.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Staging demo data contains real-looking PII | OCR + DOM scan is a hard gate; `redact:` list per product; demo tenant seeded with fictional names |
| Flows go stale as UI changes | Declarative yaml fails fast with beat name + screenshot; flow updates land in the same PR as the UI change |
| Video seek precision in Chromium drifts by a frame | Seek via `currentTime` + wait for `seeked` + `requestVideoFrameCallback`; determinism test catches regressions |
| Fonts differ between machines | Fonts declared in yaml; renderer fails if the font isn't available rather than falling back silently |
| Token cost creeps as Opus "improves" the plan | Fixed schema, max 3 stills-check iterations, 150K sub-agent budget |
| Music licence drift | `LICENSES.md` next to the tracks with source URL and licence text; CC-BY attribution line written into `share-copy.md` footnote |

## 12. Open decisions

None blocking. Deferred to implementation: exact bundled track list; whether `tesseract.js` language data is vendored or downloaded on first run (prefer vendored `eng.traineddata`, ~10 MB).

## 13. Verification record (plan-verification gate)

Checked against the machine on 2026-10-14: Playwright Chromium builds 1208–1243 and `ffmpeg-1011` present under `%LOCALAPPDATA%\ms-playwright`; Node 24.14, Python 3.11, uv 0.11 present; no system ffmpeg on PATH (renderer must locate Playwright's binary or require one). RPMS and AssetBridge have staging environments (vault, 2026-10-13 / 2026-09-21); demo tenant seeding is **assumed**, to be confirmed before the first RPMS run.
