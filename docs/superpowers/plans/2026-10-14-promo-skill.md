# /promo Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `skills/promo/`, an agent skill that turns a running staging instance into a 16:9 feed cut, 1:1 cut, 9:16 reel and silent hero loop (with posters and share copy) using fixed Node scripts, Playwright and a full FFmpeg, with PII and origin hard gates.
**Architecture:** `capture.mjs` records declarative flows from `.promo/promo.yaml` into 60 fps webm footage plus settle stills and runs the origin/PII gates. The model plans and writes a schema-validated `scenes.json`; `render.mjs` (a Playwright compositor page driven by a pure `t -> frame` function, then FFmpeg) renders the master, `reframe.mjs` re-renders it at 1:1 and 9:16, `loop.mjs` cuts the hero loop, `poster.mjs` bakes frame 0. Every module is a small ESM file in `skills/promo/scripts/lib/` with `node:test` coverage.
**Tech Stack:** Node >=22 (ESM), `playwright@^1.64.1`, `tesseract.js@^7.0.0`, `ajv@^8.20.0`, `yaml@^2.9.1`, `node:test`, full FFmpeg/ffprobe (external), Python 3.11 + uv + librosa (maintainer tool only), GitHub Actions.
**Spec:** docs/superpowers/specs/2026-10-14-promo-skill-design.md

## Global Constraints

- Node `>=22`, ESM (`"type": "module"`), tests are `node:test` + `node:assert/strict`, no other test deps. Commands run from `skills/promo/scripts` unless a step says otherwise.
- Runtime deps, caret-pinned, `package-lock.json` committed: `playwright@^1.64.1` (import `chromium` from `playwright`, never `playwright-core`), `tesseract.js@^7.0.0`, `ajv@^8.20.0`, `yaml@^2.9.1`.
- FFmpeg: resolve a FULL ffmpeg/ffprobe from `process.env.PROMO_FFMPEG` (directory or binary) first, then PATH. Never search or fall back to the Playwright-bundled `ffmpeg-win64.exe` (VP8-only recorder build). If missing, exit 2 with a one-line hint: `winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`.
- Capture: viewport 1920x1080, 60 fps CFR output, device scale factor 2, fresh Playwright context per flow, `prefers-reduced-motion` off, `hide:` selectors forced `display:none` on every navigation, each beat waits for network idle (+ the selector for `settle`) then holds 600 ms.
- Cursor: eases over ~400 ms (cubic ease-out), 150 ms pause, click ripple; typing 60-90 ms/char with +/-20 ms jitter.
- Beat vocabulary is closed: `goto`, `click`, `fill`, `select`, `hover`, `scroll`, `wait` (ms, max 3000), `settle`.
- Hard gates, no override flag or env var: (1) navigation to any origin other than `staging.url`'s origin aborts the flow; (2) missing `pii_policy` aborts before the browser opens; (3) every settle still is OCR'd (tesseract.js) and DOM text is scanned; email, phone (Ghana + international), IBAN/card-like digit run, or any `redact:` string fails the run naming the frame.
- Scenes: types `hook|title-card|feature-callout|footage|outro`; transitions `cut|dip-to-brand|slide|none`; fps 30; master 1920x1080; total duration 15-30 s; footage >= 50% of runtime; caption required on every footage scene; readability hold = `max(0.8 s, 0.3 s x words)` after the line is fully on screen; per-template max text lengths.
- Render: frame = pure function of `t`; PNG frames to `work/frames/`; H.264 yuv420p, CRF 18, 30 fps, `+faststart`; music gain from `music.gain_db`, duck by `music.duck_db` during footage scenes, 300 ms fade-out; `music: null` renders a silent master with no audio stream; determinism = identical `frameSequenceSha256` across two renders.
- Deliverables: `feed-16x9.mp4` (1920x1080), `feed-1x1.mp4` (1080x1080), `reel-9x16.mp4` (1080x1920, captions clear of top 250 px / bottom 340 px), `hero-loop.mp4` + `hero-loop.webm` (1920x1080, 8-15 s, no audio, no text), `poster-<output>.jpg`, `share-copy.md`. Default tone `polished`; caption bar always on for feed/reel.
- Output directory: `promo-output/<YYYY-MM-DD-HHmmss>/` (e.g. `promo-output/2026-10-14-143022/`), never overwritten; `promo-output/` is gitignored except `promo-plan.md` and `share-copy.md`.
- Templates are ratio-agnostic: each renders into a renderer-sized `#stage` div (1920x1080, 1080x1080, 1080x1920) using container queries / `cqmin` units; the same HTML serves all three ratios. Template text is only ever set via `textContent`.
- Network: scripts never download anything at runtime (tessdata is vendored; fonts are local). The only network a run touches is the `staging.url` origin plus the loopback compositor/test servers on `127.0.0.1`.
- Music: no brag mp3s are copied. Bundled tracks are CC-BY-4.0 or CC0 with `assets/music/LICENSES.md`. The cue analyser is a maintainer tool; runtime only reads `<track>.cues.json`. Renderer must work with `music: null`.
- Repo: `scripts/validate.py` gains a `skills` check; the existing python CI job stays untouched; a second job `node-tests` is added. Brag-derived text keeps the MIT attribution ("Copyright (c) 2026 Shunit Haviv Hakimi").

## Review Focus

Five failure modes the spec implies but its tests do not cover. Each has a named test in the owning task.

1. **Capture fidelity is not what the spec assumes.** Playwright's `recordVideo` is fixed at 25 fps / VP8 / 1 Mbps (verified in installed playwright-core 1.63: `coreBundle.js:37040` `fps = 25`, `:37095` `-b:v 1M`), so "60 fps, device-scale 2 webm" cannot come from it. The plan captures with `page.screencast.start({ onFrame })` (types in 1.63 `types.d.ts:18621-18659`), re-timed to 60 fps CFR VP9. Delivered fps and pixel size are unverified until the Task 5 spike. Tests: Task 4 `assembleWebm` CFR/duration test; Task 5 `capture reports medianFps >= 30 and a >=1920x1080 webm`, with a STOP-AND-REPORT condition if the spike fails.
2. **PII coverage gaps.** OCR only sees settle stills; the video between them, transient toasts/tooltips, `display:none` text, OCR spacing around `@`, and secrets leaking through error output are all unguarded by the spec's tests. Tests (Task 6): `transient email visible 400 ms is caught`, `display:none text is not a hit but tiny-type text is`, `OCR hit survives spaced "name @ domain"`, `password never appears in stdout/stderr/report/stills`, `popup / redirect / JS navigation to another origin is aborted before a request is sent`.
3. **Frame purity, seek exactness and font fallback.** Determinism of the frame checksum depends on (a) every animation being driven by `t` rather than the wall clock, (b) `<video>` seeks landing on the intended frame, and (c) a missing brand font failing loudly (`document.fonts.check()` cannot detect system fonts). Tests: Task 8 `order-independent frames`, `unknown font fails loudly`; Task 9 `video seek is frame-exact (PSNR vs ffmpeg extract)`, `two renders have identical frameSequenceSha256`.
4. **Ratio-specific layout and crop loss.** The stills gate looks at 16:9, but reel and square re-render templates and crop footage. A 1080x720 focus cropped to 9:16 keeps only 56% of itself, and text can leave the IG safe area. Tests: Task 7 `coverage 0.5625 for the spec sample at 9:16`; Task 8 `worst-case max-length text fits at all three ratios`; Task 12 `no letterbox (cropdetect)` and `reel text inside y 250..1580`. Token cost is bounded by deterministic layout checks plus contact sheets so the model views one image per non-master ratio.
5. **Seams and pops.** The hero loop must not jump at the wrap; a baked poster on a looping clip would flash every loop; music ducking must not click. Tests: Task 10 `duck envelope ramps (no step)` + loudness; Task 13 `seam jump <= 2x median inter-frame diff`; Task 14 `hero poster is not baked (frame 0 untouched)` and `bake leaves duration and audio offset unchanged`.

## File Structure

Repo root `C:\Users\Micha\dev\Setup\claude` (paths below relative to it).

```
.gitignore                                   node_modules/, promo-output/, skills/promo/scripts/test/.tmp/, *.log
.github/workflows/validate.yml               MODIFY: add node-tests job (python job untouched)
scripts/validate.py                          MODIFY: check_skill() + skills glob
scripts/test_validate.py                     unittest for the skills check
README.md                                    MODIFY: What's-in-here bullet, Requirements line, ## Skills section
skills/promo/
  SKILL.md                                   workflow, gates, creative laws, dispatch recipe (frontmatter: name, description only)
  THIRD_PARTY_NOTICES.md                     brag MIT licence text + list of derived files
  references/{plan,capture,compose,deliver}.md
  examples/personal-website.promo.yaml       first-run config (no login)
  templates/
    base.css                                 tokens, #stage container, entrance animations, 3 ratios
    hook.html title-card.html feature-callout.html caption-bar.html outro.html
    compositor.html                          page shell: #stage, two layers, postMessage handler
    compositor.js                            browser module: window.__promo.{init,renderFrame}; imports lib/timeline.js + lib/geometry.js
  assets/music/
    LICENSES.md                              title, author, source URL, licence, retrieved date per track
    <track>.mp3 + <track>.cues.json          human-supplied (Task 11)
  tools/
    analyze_music_cues.py                    maintainer-only port of brag's analyser (attribution header kept)
    pyproject.toml                           librosa, numpy, scipy, soundfile; [tool.uv] package=false
  fixtures/demo-site/                        static site + .promo/promo.yaml + scenes.json for e2e
  scripts/
    package.json  package-lock.json
    doctor.mjs                               preflight CLI
    capture.mjs  render.mjs  reframe.mjs  loop.mjs  poster.mjs   CLIs, explicit path args
    vendor/tessdata/eng.traineddata + README.md                  vendored OCR data (source URL, sha256)
    lib/
      ffmpeg.js        resolve ffmpeg/ffprobe, capability check, run/ffprobeJson
      doctor.js        collectChecks()
      schema.js        promo.yaml + scenes.json validation, readability helpers, constants
      promo.schema.json scenes.schema.json   JSON Schemas (also read by the model via compose.md)
      pii.js           patterns, scanText, scanDom, page scanner script, OCR
      log.js           createLogger with secret redaction
      cursor.js        easing, cursor path, typing delays, PRNG, in-page cursor script
      screencast.js    frame capture -> CFR webm
      server.js        serveDirs(): loopback static server (+ test handlers)
      geometry.js      isomorphic crop/clamp/safe-area maths
      timeline.js      isomorphic scene timeline + transition windows
      layout-check.js  deterministic overflow/safe-area checks on a compositor page
      render-core.js   openCompositor, renderStills, renderVideo (Node side)
      audio.js         ducking envelope + ffmpeg audio filter
      cues.js          load/validate cue JSON, nearestCue, alignmentReport, resolveTrack, attributionFor
      loop-points.js   frame diffs + loop point selection
      poster.js        bakePoster, extractFrame
    test/
      helpers.mjs  *.test.mjs (unit)  e2e/*.test.mjs  fixtures/*  .tmp/ (gitignored)
```

Module boundaries (locked): `geometry.js` and `timeline.js` are isomorphic (no `node:` imports) because the compositor page imports them; `render-core.js` is the only module that owns a Playwright page for rendering; CLIs (`*.mjs`) only parse args, call a lib function, print, and set the exit code. Exit codes for all CLIs: `0` ok, `1` validation or hard-gate failure, `2` environment problem (ffmpeg/browser/deps missing), `3` flow failure (stale selector).

---

### Task 1: Scaffold, FFmpeg resolution, doctor, skills validation, CI job

**Files:**
- Create: `.gitignore`, `skills/promo/scripts/package.json`, `skills/promo/scripts/package-lock.json`, `skills/promo/scripts/lib/ffmpeg.js`, `skills/promo/scripts/lib/doctor.js`, `skills/promo/scripts/doctor.mjs`, `skills/promo/scripts/test/ffmpeg.test.mjs`, `skills/promo/scripts/test/doctor.test.mjs`, `scripts/test_validate.py`
- Modify: `scripts/validate.py`, `.github/workflows/validate.yml`

**Interfaces:**
- Produces (`lib/ffmpeg.js`):
  - `INSTALL_HINT: string` (single line naming the three install commands and `PROMO_FFMPEG`)
  - `class FfmpegNotFoundError extends Error`
  - `resolveFfmpeg(opts?: { env?: object, platform?: string, exists?: (p: string) => boolean }): { ffmpeg: string, ffprobe: string }`
  - `parseCapabilities(encodersText: string, filtersText: string): { ok: boolean, missing: string[] }` (required encoders `libx264`, `aac`, `libvpx-vp9`; filters `overlay`, `xfade`, `afade`, `volume`, `aloop`)
  - `checkCapabilities(bins: { ffmpeg: string }): Promise<{ ok: boolean, missing: string[] }>`
  - `requireFfmpeg(): Promise<{ ffmpeg: string, ffprobe: string }>` (memoised; on failure prints `INSTALL_HINT` to stderr and `process.exit(2)`)
  - `run(bin: string, args: string[], opts?: { cwd?: string, input?: Buffer }): Promise<{ stdout: string, stderr: string }>` (rejects with the last 20 stderr lines)
  - `ffprobeJson(ffprobe: string, file: string): Promise<{ streams: object[], format: { duration: string } }>`
- Produces (`lib/doctor.js`): `collectChecks(opts?: { env?: object }): Promise<{ name: string, ok: boolean, detail: string, fix?: string }[]>` (later tasks append checks)
- Produces (`scripts/validate.py`): `check_skill(path: Path) -> None` appending to the module-level `errors`.

- [ ] **Step 0: Branch.** `git switch -c feat/promo-skill` (repo CI triggers on push to `master` and on pull requests; the PM opens the PR).
- [ ] **Step 1: Scaffold files.** Write `.gitignore` (`node_modules/`, `promo-output/`, `skills/promo/scripts/test/.tmp/`, `*.log`). Write `package.json`: `name: "promo-scripts"`, `private: true`, `type: "module"`, `engines: { node: ">=22" }`, deps as in Global Constraints, scripts `"test": "node --test \"test/*.test.mjs\""`, `"test:unit": "node --test \"test/*.test.mjs\""`. Run `npm install` in `skills/promo/scripts`; if `^1.64.1` or any pin fails to resolve, STOP and report. Commit `package-lock.json`.
- [ ] **Step 2: Write failing test** `test/ffmpeg.test.mjs`:
  ```js
  test('PROMO_FFMPEG directory wins over PATH', () => {
    const exists = (p) => p.startsWith(path.join('/opt/ff')) || p.startsWith(path.join('/usr/bin'));
    const r = resolveFfmpeg({ env: { PROMO_FFMPEG: '/opt/ff', PATH: '/usr/bin' }, platform: 'linux', exists });
    assert.equal(r.ffmpeg, path.join('/opt/ff', 'ffmpeg'));
    assert.equal(r.ffprobe, path.join('/opt/ff', 'ffprobe'));
  });
  test('PROMO_FFMPEG pointing at the binary derives ffprobe from its sibling', ...);
  test('falls back to PATH when PROMO_FFMPEG unset', ...);          // windows variant expects ffmpeg.exe
  test('missing everywhere throws FfmpegNotFoundError with a one-line hint', () => {
    assert.throws(() => resolveFfmpeg({ env: { PATH: '' }, platform: 'linux', exists: () => false }),
      (e) => e instanceof FfmpegNotFoundError && !/\n/.test(e.message)
        && e.message.includes('winget install Gyan.FFmpeg') && e.message.includes('brew install ffmpeg')
        && e.message.includes('apt install ffmpeg'));
  });
  test('never probes ms-playwright paths', () => {
    const seen = []; try { resolveFfmpeg({ env: { PATH: '/x' }, platform: 'win32', exists: (p) => (seen.push(p), false) }); } catch {}
    assert.ok(seen.every((p) => !/ms-playwright/i.test(p)));
  });
  test('parseCapabilities rejects a VP8-only recorder build', () => {
    const r = parseCapabilities(' V....D libvpx   libvpx VP8', ' T.. scale  V->V');
    assert.equal(r.ok, false);
    for (const m of ['libx264', 'aac', 'libvpx-vp9', 'overlay', 'xfade']) assert.ok(r.missing.includes(m));
  });
  test('Playwright bundled ffmpeg fails checkCapabilities', { skip: !fs.existsSync(PW_FFMPEG) }, ...); // PW_FFMPEG under %LOCALAPPDATA%\ms-playwright\ffmpeg-1011\ffmpeg-win64.exe
  test('checkCapabilities passes on the resolved full ffmpeg', { skip: !hasFullFfmpeg }, ...);
  ```
  `test/doctor.test.mjs`: `collectChecks({ env: { PATH: '' } })` returns an `ffmpeg` check with `ok:false` and `fix` equal to `INSTALL_HINT`; a `node` check `ok:true`.
- [ ] **Step 3: Run** `node --test test/ffmpeg.test.mjs test/doctor.test.mjs`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `lib/ffmpeg.js` and `lib/doctor.js` per Interfaces. Approach: candidate list = `PROMO_FFMPEG` (dir or file) then each `PATH` entry; binary names `ffmpeg`/`ffprobe` (+ `.exe` on win32); `ffprobe` must sit next to a PROMO_FFMPEG hit, else be looked up on PATH. `collectChecks` covers: Node >=22, `resolveFfmpeg` + `checkCapabilities`, Playwright Chromium (`chromium.executablePath()` exists; fix `npx playwright install chromium`). Add `doctor.mjs` (prints `[ok]/[FAIL] name - detail` lines, fix hint under failures, exit 1 on any failure, 2 if ffmpeg is the failure).
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** "Scaffold the promo scripts package and make FFmpeg resolution explicit" (why: the Playwright-bundled build cannot encode H.264/AAC or run overlay/xfade).
- [ ] **Step 7: Write failing Python tests** `scripts/test_validate.py` (stdlib `unittest`, adds `scripts/` to `sys.path`, clears `validate.errors` in `setUp`, writes skills into a `tempfile.TemporaryDirectory`):
  ```python
  def test_valid_skill_passes(self):        # name == dir name, one-line description
  def test_name_must_equal_directory(self): # error contains "does not match directory"
  def test_extra_key_rejected(self):        # frontmatter with name, description, license -> error names the key
  def test_multiline_description_rejected(self):  # description: | block, and a folded >- block
  def test_missing_frontmatter_rejected(self):
  def test_missing_description_rejected(self):
  ```
  Run `python -m unittest discover -s scripts -p "test_*.py"` from the repo root. Expected: FAIL (`check_skill` missing).
- [ ] **Step 8: Implement** `check_skill(path)` in `scripts/validate.py` (reuse the `---\n` / `\n---` parse used at `:29-36`; require `data.keys() == {"name","description"}`; `name == path.parent.name`; description is a non-empty `str` with no newline and the raw frontmatter has exactly two non-blank lines). In `main()` add `skill_files = sorted((ROOT / "skills").glob("*/SKILL.md"))` (skip silently when `skills/` is absent), call `check_skill` for each, and change the success line to `OK: N agent file(s), M skill(s) validated, CLAUDE.md placeholders present.` Run the unittest command and `python scripts/validate.py`. Expected: PASS.
- [ ] **Step 9: Add CI job** to `.github/workflows/validate.yml` below the existing `validate` job (do not edit that job):
  ```yaml
    node-tests:
      runs-on: ubuntu-latest
      timeout-minutes: 30
      defaults:
        run:
          working-directory: skills/promo/scripts
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
            cache: npm
            cache-dependency-path: skills/promo/scripts/package-lock.json
        - run: npm ci
        - run: npx playwright install --with-deps chromium
        - run: sudo apt-get update && sudo apt-get install -y ffmpeg
        - run: npm test
  ```
  Validate the YAML parses (`python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/validate.yml'))"`).
- [ ] **Step 10: Commit** "Validate skills in CI and add a Node test job" (why: validate.py ignored `skills/**`, so a malformed SKILL.md would ship unchecked).

---

### Task 2: Schemas, constants and readability maths (`lib/schema.js`)

**Files:**
- Create: `skills/promo/scripts/lib/schema.js`, `lib/promo.schema.json`, `lib/scenes.schema.json`, `test/schema.test.mjs`, `test/fixtures/valid-scenes.json`, `test/fixtures/valid-promo.yaml`

**Interfaces:**
- Produces (`lib/schema.js`):
  - Constants: `BEAT_KEYS = ['goto','click','fill','select','hover','scroll','wait','settle']`, `SCENE_TYPES = ['hook','title-card','feature-callout','footage','outro']`, `TRANSITIONS = ['cut','dip-to-brand','slide','none']`, `ENTRANCE_SECONDS = 0.5` (brag reading-time rule: entrances 0.3-0.6 s), `TRANSITION_SECONDS = 0.4` (plan-chosen), `MIN_TOTAL = 15`, `MAX_TOTAL = 30`, `MIN_FOOTAGE_SHARE = 0.5`, `TEXT_LIMITS` (plan-chosen, tunable: `hook.text 60`, `title-card.title 50`, `title-card.sub 80`, `feature-callout.title 60`, `feature-callout.body 140`, `outro.text 30`, `outro.sub 50`, `footage.caption 60`)
  - `readabilityHold(text: string): number` = `max(0.8, 0.3 x words)` rounded to 3 dp (words = whitespace-split, non-empty)
  - `minSceneDuration(scene): number` = `ENTRANCE_SECONDS + max(readabilityHold(field))` over the scene's text fields
  - `sceneDuration(scene): number` (template: `duration`; footage: `out - in`), `totalDuration(scenes): number`, `footageShare(scenes): number`
  - `class ValidationError extends Error { errors: { path: string, message: string }[] }`, `formatErrors(errors): string` (one `path: message` per line, JSON-pointer paths such as `/flows/0/beats/2/wait`)
  - `validatePromoConfig(obj): { ok: boolean, errors }`, `loadPromoConfig(file: string): Promise<object>` (throws `ValidationError`), `stagingOrigin(url: string): string`
  - `validateScenes(obj, ctx?: { flowDurations?: Record<string, number> }): { ok: boolean, errors }`, `loadScenes(file, ctx?): Promise<object>`

- [ ] **Step 1: Write failing tests** `test/schema.test.mjs` (fixtures: `valid-scenes.json` = the spec section 5 sample with footage `out` changed from 9.0 to 14.2 and the callout `body` filled; the spec's own sample totals 14.3 s and would be rejected by the 15 s floor, so adjust and note it in the fixture's commit message):
  ```js
  test('readabilityHold', () => {
    assert.equal(readabilityHold('Hi'), 0.8);                          // floor
    assert.equal(readabilityHold('one two three'), 0.9);
    assert.equal(readabilityHold('Rent day, without the chasing.'), 1.5);
    assert.equal(readabilityHold('Record a payment in one tap'), 1.8);
  });
  test('minSceneDuration = entrance + longest hold', () => {
    assert.equal(minSceneDuration({ type: 'hook', text: 'Rent day, without the chasing.' }), 2.0);
  });
  test('valid scenes pass with flowDurations', () => {
    const r = validateScenes(valid, { flowDurations: { 'rent-collection': 20 } });
    assert.equal(r.ok, true, formatErrors(r.errors));
    assert.equal(totalDuration(valid.scenes), 19.5);
    assert.ok(footageShare(valid.scenes) >= 0.5);
  });
  // table-driven invalid cases, each asserts the error path:
  //  total 14.9 -> '/scenes'      total 30.1 -> '/scenes'      footage share 0.49 -> '/scenes'
  //  footage without caption -> '/scenes/1/caption'            crossfade transition -> '/scenes/0/transition'
  //  unknown type 'montage' -> '/scenes/0/type'                fps 60 -> '/fps'      master 1280x720 -> '/master'
  //  hook text 61 chars -> '/scenes/0/text'                    hook duration 1.9 for the 5-word text -> '/scenes/0/duration'
  //  footage with a 'duration' key -> '/scenes/1'              out <= in -> '/scenes/1/out'
  //  out beyond flowDurations -> '/scenes/1/out'               unknown flow -> '/scenes/1/flow'
  //  last scene transition 'dip-to-brand' -> '/scenes/3/transition' (last must be 'none')
  //  footage focus with negative w -> '/scenes/1/focus/w'
  test('promo.yaml: valid sample from spec 3.2 passes', ...);
  test('promo.yaml: pii_policy is required', () => assert.ok(errs.some(e => e.path === '/pii_policy')));
  test('beats: wait 3000 ok, 3001 rejected, unknown beat {drag} rejected, two keys in one beat rejected', ...);
  test('staging.url: http://localhost:3000 ok and stagingOrigin() === "http://localhost:3000"; ftp:// and urls with credentials rejected', ...);
  test('duplicate flow names rejected; flow names must match ^[a-z0-9][a-z0-9-]*$ (used in filenames)', ...);
  test('login env names must match ^[A-Z_][A-Z0-9_]*$; hex colours must be #RRGGBB', ...);
  ```
- [ ] **Step 2: Run** `node --test test/schema.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the two JSON Schemas and `lib/schema.js`: compile with `new Ajv({ allErrors: true, strict: true })` (no `ajv-formats`; hex via `pattern`, URL via the JS check in `validatePromoConfig`); map ajv errors to `{ path: instancePath, message }`; after schema success run the semantic rules in JS (duration sum, footage share, `minSceneDuration`, last-scene transition `none`, `flowDurations`, unique flow names). Footage scenes derive duration from `out - in` and reject a `duration` key. `title-card` fields are `title` (required) and `sub` (optional) and `select` beats are `{ selector, value }`; both are plan-chosen because the spec is silent (see Open Questions).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Add promo.yaml and scenes.json validation with readability rules" (why: invalid files must be rejected with a field path before the browser or encoder runs).

---

### Task 3: PII patterns, DOM scan, OCR scan (`lib/pii.js`) and vendored tessdata

**Files:**
- Create: `skills/promo/scripts/lib/pii.js`, `test/pii.test.mjs`, `vendor/tessdata/eng.traineddata`, `vendor/tessdata/README.md`
- Modify: `lib/doctor.js` (append a `tessdata` check)

**Interfaces:**
- Produces (`lib/pii.js`):
  - `type Hit = { kind: 'email'|'phone'|'iban'|'card'|'redact', match: string }`
  - `PATTERN_SOURCES: { kind: string, source: string, flags: string }[]` (serialisable; reused by the in-page scanner)
  - `normalizeText(s: string): string` (collapse whitespace; remove whitespace around `@` only when both neighbours are email-like)
  - `scanText(text: string, opts?: { redact?: string[] }): Hit[]` (redact compare case-insensitive on normalised text)
  - `PAGE_SCANNER_SCRIPT(patterns, redact): string` (init script: every 100 ms scans visible `document.body.innerText` plus visible input `value`/`placeholder`, pushes new hits into `window.__promoPiiHits`)
  - `scanDom(page, opts?: { redact?: string[] }): Promise<Hit[]>` (visible text only: `display:none` content excluded)
  - `TESSDATA_DIR: string` (absolute path to `vendor/tessdata`)
  - `createOcr(opts?: { langPath?: string }): Promise<{ scan(pngPath: string, opts?: { redact?: string[] }): Promise<Hit[]>, close(): Promise<void> }>` (one reused worker; `langPath` defaults to `TESSDATA_DIR`, `gzip: false`, no cache writes; rejects if `eng.traineddata` is missing instead of downloading)
  - `class PiiGateError extends Error { frame: string, hits: Hit[], source: 'ocr'|'dom' }`

- [ ] **Step 1: Vendor tessdata (maintainer step, one-time, recorded).** Find the data tesseract.js uses by default (read its default `langPath` in `node_modules/tesseract.js`; expected to be the `eng` `4.0.0_best_int` data, about 10 MB, UNVERIFIED), download it once, gunzip if needed, save as `vendor/tessdata/eng.traineddata`, and write `vendor/tessdata/README.md` with source URL, sha256, retrieved date, licence (Apache-2.0, to be confirmed from the source). Runtime never downloads.
- [ ] **Step 2: Write failing tests** `test/pii.test.mjs`:
  ```js
  const positives = [
    ['Contact jane.doe@example.com today', 'email'],
    ['jane.doe @example.com', 'email'],                    // OCR-style spacing
    ['+233 24 123 4567', 'phone'], ['024 123 4567', 'phone'], ['0241234567', 'phone'],
    ['+44 20 7946 0958', 'phone'], ['+1 (415) 555-0132', 'phone'],
    ['GB82 WEST 1234 5698 7654 32', 'iban'],
    ['4111 1111 1111 1111', 'card'], ['4111-1111-1111-1111', 'card'],
  ];
  const nearMisses = ['2026-10-14', '1920x1080', 'v1.2.3', '12:30:45', 'GHS 1,250.00', '1,234,567.89',
    '60 fps at 2x', '@handle', 'Order #10024', '14 Oct 2026 10:30', 'meet @ noon', 'Ref 2026101414'];
  test.each-style loops: scanText(p).some(h => h.kind === kind); scanText(n) deep-equals [].
  test('redact is case-insensitive and reports kind redact', () => deepEqual(scanText('paid by mr SINTIM', { redact: ['Sintim'] }).map(h => h.kind), ['redact']));
  test('scanDom ignores display:none text but sees tiny visible text', async () => { /* page.setContent: hidden a@b.co -> []; font-size:3px;color:#fefefe on #fff jane@example.com -> email */ });
  test('scanDom reads typed input values and placeholders', ...);
  test('OCR finds an email rendered at 24px and at 14px with deviceScaleFactor 2', ...);  // page.screenshot of generated HTML
  test('OCR returns [] for a blank page', ...);
  test('createOcr rejects (no download) when langPath has no eng.traineddata', () => assert.rejects(createOcr({ langPath: path.join(tmp, 'nope') })));
  ```
- [ ] **Step 3: Run** `node --test test/pii.test.mjs`. Expected: FAIL.
- [ ] **Step 4: Implement** `lib/pii.js`. Patterns: email `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`; phone = Ghana (`+233`/`00233`/leading `0` + 9 digits, optional spaces/dashes/parens) and international `\+\d` followed by 8-15 digits allowing separators; IBAN `[A-Z]{2}\d{2}` followed by 2-7 groups of 4 alphanumerics + optional tail; card-like = 13-19 digits with optional single spaces/dashes. No Luhn and no email domain allow-list (fail closed; the negative e2e uses `@example.com`). Tune until both tables pass. `createOcr` wraps `createWorker('eng', 1, { langPath, gzip: false, cacheMethod: 'none' })`; UNVERIFIED that these option names are unchanged in tesseract.js 7.0.0, confirm from the installed package README/types and adjust.
- [ ] **Step 5: Append the doctor check** `tessdata` (file exists and size > 1 MB) and extend `test/doctor.test.mjs`. Run `node --test test/pii.test.mjs test/doctor.test.mjs`. Expected: PASS.
- [ ] **Step 6: Commit** "Add the PII scanner and vendor OCR data so capture never downloads" (why: PII gate is a hard gate; it must be offline and deterministic).

---

### Task 4: Capture primitives (`lib/cursor.js`, `lib/screencast.js`)

**Files:**
- Create: `skills/promo/scripts/lib/cursor.js`, `lib/screencast.js`, `test/cursor.test.mjs`, `test/screencast.test.mjs`

**Interfaces:**
- Produces (`lib/cursor.js`):
  - Constants `MOVE_MS = 400`, `PAUSE_MS = 150`, `HOLD_MS = 600`
  - `easeOutCubic(t: number): number`
  - `mulberry32(seed: number): () => number`
  - `cursorPath(from: {x,y}, to: {x,y}, opts?: { durationMs?: number, fps?: number }): { x: number, y: number, t: number }[]` (t in ms, ends exactly on `to`)
  - `typingDelays(text: string, rng: () => number): number[]` (ms; per char `U(60,90) + U(-20,20)`)
  - `CURSOR_INIT_SCRIPT: string` (installs `#__promo-cursor` and `window.__promoCursor = { moveTo(x,y), click(x,y) }`; click adds a ripple element removed after 500 ms)
- Produces (`lib/screencast.js`):
  - `type Frame = { file: string, t: number }` (seconds since first frame)
  - `startFrameCapture(page, opts: { dir: string, size: { width: number, height: number }, quality?: number }): Promise<{ stop(): Promise<{ frames: Frame[], endT: number }>, nowT(): number }>` (uses `page.screencast.start({ onFrame, size, quality })`; writes JPEG frames to `dir`; `nowT()` is seconds on the same clock for beat timestamps)
  - `frameDurations(frames: Frame[], endT: number): number[]`
  - `medianFps(frames: Frame[]): number`
  - `assembleWebm(opts: { ffmpeg: string, frames: Frame[], endT: number, fps?: number, out: string, crf?: number }): Promise<void>` (concat demuxer with per-frame `duration`, `fps=60`, `libvpx-vp9 -crf 12 -b:v 0 -pix_fmt yuv420p`)

- [ ] **Step 1: Write failing tests.**
  ```js
  // cursor.test.mjs
  test('easeOutCubic', () => { equal(easeOutCubic(0), 0); equal(easeOutCubic(1), 1); equal(easeOutCubic(0.5), 0.875); });
  test('cursorPath eases, lands on target, spans 400 ms at 60 fps', () => {
    const p = cursorPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    deepEqual(p.at(-1), { x: 100, y: 0, t: 400 }); ok(p.length >= 24 && p.length <= 26);
    ok(p.find((q) => q.t >= 200).x > 50);                         // ease-out: past halfway at half time
    ok(p.every((q, i) => i === 0 || q.x >= p[i - 1].x));
  });
  test('typingDelays within 40..110 ms with mean 60..90 and are seed-deterministic', () => {
    const d = typingDelays('x'.repeat(2000), mulberry32(1));
    ok(d.every((v) => v >= 40 && v <= 110)); const m = d.reduce((a, b) => a + b) / d.length; ok(m >= 60 && m <= 90);
    deepEqual(typingDelays('abc', mulberry32(7)), typingDelays('abc', mulberry32(7)));
  });
  test('in-page cursor follows moveTo and ripple disappears', async () => { /* Playwright page: addInitScript(CURSOR_INIT_SCRIPT);
     moveTo(100,100) -> #__promo-cursor box centre within 2px; click(100,100) -> .ripple exists, gone after 600 ms */ });
  // screencast.test.mjs
  test('frameDurations', () => deepEqual(frameDurations([{ t: 0 }, { t: 0.1 }, { t: 0.35 }], 0.5).map(r3), [0.1, 0.25, 0.15]));
  test('medianFps of evenly spaced 30 fps frames is 30', ...);
  test('assembleWebm yields 60 fps CFR VP9 of the right length', async () => {
    // make 3 JPEGs with ffmpeg lavfi color sources at t = 0, 0.5, 1.0; endT 1.5
    // ffprobe: codec_name vp9, r_frame_rate '60/1', pix_fmt yuv420p, |duration - 1.5| < 0.03, nb frames 90 +/- 1
  });
  ```
- [ ] **Step 2: Run** `node --test test/cursor.test.mjs test/screencast.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. Notes: the ripple and cursor are DOM elements so they are captured by the screencast; `assembleWebm` repeats the last file in the concat list (concat-demuxer quirk) so the final duration is honoured; the compositor later loads these webms in Chromium, so footage MUST be VP9/VP8 webm (Chromium builds without proprietary codecs cannot play H.264).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Add cursor and screencast primitives for the capture step" (why: Playwright's recordVideo is 25 fps / 1 Mbps; frames are re-timed to a constant 60 fps instead).

---

### Task 5: Capture core (`capture.mjs`), loopback server and demo-site fixture

**Files:**
- Create: `skills/promo/scripts/capture.mjs`, `lib/server.js`, `lib/log.js`, `test/helpers.mjs`, `test/capture.test.mjs`, `test/fidelity.probe.mjs`, `skills/promo/fixtures/demo-site/{index.html,tenants.html,payments.html,poll.html,site.css}`, `skills/promo/fixtures/demo-site/.promo/promo.yaml`
- Consumes: `lib/schema.js` (`loadPromoConfig`, `stagingOrigin`), `lib/cursor.js`, `lib/screencast.js`, `lib/ffmpeg.js` (`requireFfmpeg`)

**Interfaces:**
- Produces (`lib/server.js`): `serveDirs(mounts: { prefix: string, root: string }[], opts?: { host?: string, port?: number, handlers?: Record<string, (req, res) => void> }): Promise<{ origin: string, close(): Promise<void> }>` (default host `127.0.0.1`, port 0; MIME for html, js, css, json, png, jpg, webm, mp4, woff2; path-traversal safe)
- Produces (`lib/log.js`): `createLogger(opts: { secrets?: string[] }): { info(msg: string): void, error(msg: string): void, scrub(s: string): string }` (replaces every secret value with `***` in everything written)
- Produces (`capture.mjs`): CLI `node capture.mjs --config <promo.yaml> --out <dir> [--feature <tag>]`; export `runCapture(opts: { configPath: string, outDir: string, feature?: string, env?: object }): Promise<CaptureReport>`. Env knobs for tests only: `PROMO_BEAT_TIMEOUT_MS` (default 10000), `PROMO_IDLE_TIMEOUT_MS` (default 10000).
- Produces (`report.json`, version 1): `{ version, status: 'ok'|'failed', product, stagingOrigin, piiPolicy, source: { viewport: {w:1920,h:1080}, deviceScaleFactor: 2, fps: 60, videoSize: {w,h} }, thirdPartyRequests: [{origin,count}], flows: [{ name, feature, video: '<flow>.webm', durationSec, screencast: { frames, medianFps }, hidden: {selector: matchCount}, beats: [{ index, kind, t0, t1, networkIdle: boolean }], settles: [{ index, still: '<flow>-<n>.png', t }] }], failed?: { flow, beatIndex, kind: 'selector'|'origin'|'login'|'pii', message, screenshot? }, pii: { scanned: number, hits: [] } }`
- Produces (`test/helpers.mjs`): `tmpDir(name): string` (under `test/.tmp/`), `materializeConfig(templatePath: string, vars: Record<string,string>): string` (replaces `{{PORT}}`/`{{ORIGIN}}` tokens, returns written path), `runCli(script: string, args: string[], env?: object): { status, stdout, stderr }` (spawnSync of `process.execPath`).

- [ ] **Step 1: Fidelity spike (STOP condition).** Write `test/fidelity.probe.mjs`: serve the fixture, open a context at viewport 1920x1080 with `deviceScaleFactor: 2`, call `startFrameCapture` with `size: {3840, 2160}`, `quality: 90`, run a 3 s CSS animation plus scripted cursor motion, then print `medianFps`, delivered frame pixel size (`ffprobe` a JPEG) and the unit/epoch of `timestamp`. Record the findings as a comment block at the top of `lib/screencast.js`. Acceptance: `medianFps >= 30` and frames at least 1920x1080 (3840x2160 preferred). If not met, STOP and report to the PM with the measured numbers and two fallbacks (device scale 1 at 1920x1080; or CDP `Page.startScreencast` directly); do not continue to Step 2. Also confirm `page.screencast` exists in `playwright@1.64.1` (types verified only in 1.63).
- [ ] **Step 2: Fixture site.** Static pages with a constant CSS animation (so frames differ), `.cookie-banner` div, `/tenants.html` (form `#name`, button "Save tenant", `.toast-success` after click), `/payments.html` (button "Record payment" then `.payment-row.recorded`), `/poll.html` (fetch poll every 200 ms forever). `fixtures/demo-site/.promo/promo.yaml` uses tokens `{{ORIGIN}}`, `pii_policy: demo-tenant-only`, `hide: [".cookie-banner"]`, two flows `tenant-onboarding` (feature `tenants`) and `rent-collection` (feature `payments`) whose `rent-collection` footage runs at least 14 s via `wait: 3000` beats (needed by Task 16).
- [ ] **Step 3: Write failing tests** `test/capture.test.mjs` (serve `fixtures/demo-site` with `serveDirs`, materialize yaml, call `runCapture` or `runCli`):
  ```js
  test('happy path writes webm per flow, settle stills and report.json', async () => {
    const rep = await runCapture({ configPath, outDir });
    equal(rep.status, 'ok'); deepEqual(rep.flows.map((f) => f.name), ['tenant-onboarding', 'rent-collection']);
    for (const f of rep.flows) { ok(fs.existsSync(path.join(outDir, f.video))); ok(f.settles.length >= 1); }
    ok(fs.existsSync(path.join(outDir, 'tenant-onboarding-1.png')));
    deepEqual(rep.source.viewport, { w: 1920, h: 1080 }); equal(rep.source.deviceScaleFactor, 2); equal(rep.source.fps, 60);
  });
  test('webm is VP9, 60 fps CFR, >= 1920x1080, duration within 0.3 s of last beat end', ...);   // ffprobe
  test('capture reports medianFps >= 30', () => ok(rep.flows.every((f) => f.screencast.medianFps >= 30)));
  test('beat timestamps are monotonic and every beat holds >= 0.6 s', () => ok(beats.every((b, i) => b.t1 - b.t0 >= 0.6 && (i === 0 || b.t0 >= beats[i - 1].t1))));
  test('hide selectors are display:none and counted', () => ok(rep.flows[0].hidden['.cookie-banner'] >= 1));
  test('--feature payments runs only rent-collection; unknown feature exits 1 naming the tag', ...);
  test('stale selector: exit 3, stderr names flow + beat index + selector, failure screenshot written, report.failed set', async () => {
    // env PROMO_BEAT_TIMEOUT_MS=1500; yaml click: '#does-not-exist'
    equal(r.status, 3); match(r.stderr, /tenant-onboarding.*beat 2.*#does-not-exist/s);
    ok(fs.existsSync(path.join(outDir, 'failure-tenant-onboarding-beat2.png'))); equal(report.failed.kind, 'selector');
  });
  test('a page that never reaches network idle does not hang: beat proceeds with networkIdle:false', ...);   // poll.html, PROMO_IDLE_TIMEOUT_MS=1000
  test('invalid yaml exits 1 before any output dir is created and prints the field path', ...);
  ```
- [ ] **Step 4: Run** `node --test test/capture.test.mjs`. Expected: FAIL.
- [ ] **Step 5: Implement** `capture.mjs`, `lib/server.js`, `lib/log.js`. Approach per flow: new context (viewport, DSF 2, `reducedMotion: 'no-preference'`) with `addInitScript` for `CURSOR_INIT_SCRIPT` and a style injector for `hide:`; `startFrameCapture`; execute beats with cursor easing (`MOVE_MS` ease, `PAUSE_MS`, then act), typing with `typingDelays(text, mulberry32(seedFromFlowName))`, `scroll` as smooth programmatic scroll to the selector, then wait for network idle (capped by `PROMO_IDLE_TIMEOUT_MS`, recording `networkIdle`) and `HOLD_MS`; on `settle`, wait for the selector then `page.screenshot` to `<flow>-<n>.png`; stop capture; `assembleWebm` at 60 fps; delete the JPEG frame dir. Cross-origin sub-resources are allowed but tallied in `thirdPartyRequests` (see Open Questions). Exit codes per File Structure (selector failure = 3).
- [ ] **Step 6: Run** the same command. Expected: PASS.
- [ ] **Step 7: Commit** "Add capture.mjs with declarative flows, fixture site and loopback server" (why: footage is the product's own motion, recorded repeatably; stale selectors fail loudly instead of being improvised around).

---

### Task 6: Capture hard gates (origin, pii_policy, PII scan, login secrecy)

**Files:**
- Modify: `skills/promo/scripts/capture.mjs`
- Create: `test/capture-gates.test.mjs`, `skills/promo/fixtures/demo-site/{login.html,app.html,pii.html,external-link.html}`
- Consumes: `lib/pii.js` (`PATTERN_SOURCES`, `PAGE_SCANNER_SCRIPT`, `scanDom`, `createOcr`, `PiiGateError`), `lib/log.js`, `lib/server.js` (`handlers` for the 302 test)

**Interfaces:**
- Produces: `capture.mjs` enforces the three gates inside `runCapture`; on any gate failure sets `report.status = 'failed'`, `report.failed.kind` in `{'origin','pii','login'}`, deletes that run's `*.webm`, keeps `report.json` and the offending still as `<flow>-<n>.png`, and exits 1.
- Failure messages: origin = `flow <name> beat <i>: blocked navigation to <origin>`; PII = `PII gate: <frame> contains <kind> "<match>" (<ocr|dom>)` where `<frame>` is the still file name (e.g. `pii-flow-1.png`) or `<flow>@<seconds>s` for a transient in-page hit.

- [ ] **Step 1: Write failing tests** `test/capture-gates.test.mjs`:
  ```js
  test('gate 2: missing pii_policy exits 1 before the browser opens', () => {
    // PLAYWRIGHT_BROWSERS_PATH points to an empty dir: if a launch were attempted the error would be exit 2, not 1
    const r = runCli('capture.mjs', [...], { PLAYWRIGHT_BROWSERS_PATH: emptyDir });
    equal(r.status, 1); match(r.stderr, /\/pii_policy/); ok(!fs.existsSync(outDir));
  });
  for (const via of ['goto', 'click-link', 'redirect-302', 'popup-target-blank', 'js-location']) {
    test(`gate 1: ${via} to another origin aborts the flow before any request is sent`, async () => {
      // second server on another port counts requests
      equal(r.status, 1); match(r.stderr, /blocked navigation to http:\/\/127\.0\.0\.1:\d+/);
      equal(otherServer.requestCount, 0); equal(report.failed.kind, 'origin');
      ok(!fs.existsSync(path.join(outDir, 'origin-flow.webm')));
    });
  }
  test('gate 3: visible email at a settle fails and names the frame', () => {
    equal(r.status, 1); match(r.stderr, /pii-flow-1\.png.*email/); equal(report.status, 'failed');
    ok(report.pii.hits.some((h) => h.frame === 'pii-flow-1.png' && h.kind === 'email'));
  });
  test('gate 3: email visible for 400 ms between settles is caught by the in-page scanner', ...);
  test('gate 3: display:none email is not a hit, 3px near-bg email is a dom hit (source "dom")', ...);
  test('gate 3: redact string rendered on page fails (source ocr or dom)', ...);
  test('gate 3: OCR hit survives spaced "jane.doe @ example.com" markup', ...);
  test('hide: selector containing the email removes it from both OCR and DOM scans', ...);
  test('login: missing env var exits 1 naming the variable name, not a value, before the browser opens', ...);
  test('login: password never appears in stdout, stderr, report.json, or any file in outDir; /login is not recorded', async () => {
    const SECRET = 's3cr3t-Value-123';       // env RPMS_DEMO_PASS; fixture login rejects it -> kind "login", exit 1
    for (const f of walk(outDir)) if (/\.(json|txt|log)$/.test(f)) ok(!fs.readFileSync(f, 'utf8').includes(SECRET));
    ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
    // success variant: recorded context never visits /login (report.flows[].visited has no '/login')
  });
  ```
- [ ] **Step 2: Run** `node --test test/capture-gates.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Origin: `context.route('**/*', ...)` aborts any request where `request.isNavigationRequest() && new URL(request.url()).origin !== allowed` *before* it is sent (covers goto, link clicks, redirects, JS navigation and popups); record the block, close popups, throw `OriginGateError`. PII: check `pii_policy` and login env vars before `chromium.launch`; install `PAGE_SCANNER_SCRIPT` in every recorded context and read `window.__promoPiiHits` at each beat end; OCR every settle still with one `createOcr()` worker; run `scanDom` at each settle; any hit fails the run. Login: perform in a separate non-recording context, save `storageState`, then create the recorded context from it; all logging goes through `createLogger({ secrets: [passwordValue] })` and Playwright error messages are scrubbed before printing.
- [ ] **Step 4: Run** the same command plus `node --test test/capture.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** "Enforce origin, pii_policy and PII scan as hard capture gates" (why: the spec makes these non-overridable; tests prove there is no path around them, including popups, redirects and transient on-screen text).

---

### Task 7: Geometry (`lib/geometry.js`)

**Files:**
- Create: `skills/promo/scripts/lib/geometry.js`, `test/geometry.test.mjs`

**Interfaces:**
- Produces (isomorphic ESM, no `node:` imports):
  - `type Rect = { x: number, y: number, w: number, h: number }`
  - `padToRatio(rect: Rect, ratio: number): Rect` (grow the short axis about the rect centre until `w/h === ratio`)
  - `clampToFrame(rect: Rect, frame: { w: number, h: number }): Rect` (shift inside; if larger than the frame, scale down preserving ratio about the centre)
  - `cropForRatio(focus: Rect | null, source: { w: number, h: number }, target: { w: number, h: number }, opts?: { sourceScale?: number }): { rect: Rect, coverage: number, centered: boolean }` (`sourceScale` defaults 2; the crop is never narrower than `target.w / sourceScale`, so output pixels are never upscaled from capture pixels; `coverage` = area(focus intersect rect) / area(focus), 1 when focus is null)
  - `safeBand(size: { w: number, h: number }): { top: number, bottom: number }` (9:16 only: `top 250`, `bottom 340` scaled by `h / 1920`; zeros otherwise)
  - `captionRect(size, opts?: { heightFrac?: number }): Rect` (bottom-anchored caption bar inside the safe band; 16:9 and 1:1 use an 8% bottom margin)

- [ ] **Step 1: Write failing tests** (spec sample focus `{x:420,y:180,w:1080,h:720}` in a 1920x1080 source; compare with tolerance 0.01):
  ```js
  const S = { w: 1920, h: 1080 }, F = { x: 420, y: 180, w: 1080, h: 720 };
  test('16:9 pads horizontally', () => approx(cropForRatio(F, S, { w: 1920, h: 1080 }).rect, { x: 320, y: 180, w: 1280, h: 720 }));
  test('1:1 pads vertically', () => approx(cropForRatio(F, S, { w: 1080, h: 1080 }).rect, { x: 420, y: 0, w: 1080, h: 1080 }));
  test('9:16 clamps to full height and reports 0.5625 coverage', () => {
    const r = cropForRatio(F, S, { w: 1080, h: 1920 });
    approx(r.rect, { x: 656.25, y: 0, w: 607.5, h: 1080 }); approx1(r.coverage, 0.5625);
  });
  test('focus near the right edge is shifted inside, not stretched', () => {
    approx(cropForRatio({ x: 1500, y: 0, w: 400, h: 300 }, S, { w: 1920, h: 1080 }).rect, { x: 960, y: 0, w: 960, h: 540 });   // min-width rule (960) applies, then shifted inside the frame
  });
  test('tiny focus is padded outward: crop.w >= target.w / 2 (never upscales capture pixels)', ...);
  test('null focus centre-crops: 9:16 -> x 656.25, w 607.5, centered true', ...);
  test('safeBand', () => { deepEqual(safeBand({ w: 1080, h: 1920 }), { top: 250, bottom: 340 }); deepEqual(safeBand({ w: 1920, h: 1080 }), { top: 0, bottom: 0 }); });
  test('captionRect at 1080x1920 lies within y 250..1580', () => { const c = captionRect({ w: 1080, h: 1920 }); ok(c.y >= 250 && c.y + c.h <= 1580); });
  ```
- [ ] **Step 2: Run** `node --test test/geometry.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the five functions (pure arithmetic; order: min-width rule, pad to ratio, clamp).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Add crop geometry with coverage and safe-area maths" (why: reframing is a pure function that must be testable without a browser, and coverage exposes lossy 9:16 crops).

---

### Task 8: Templates, timeline, compositor for template scenes, layout check, stills

**Files:**
- Create: `skills/promo/templates/{base.css,hook.html,title-card.html,feature-callout.html,caption-bar.html,outro.html,compositor.html,compositor.js}`, `scripts/lib/timeline.js`, `lib/layout-check.js`, `lib/render-core.js`, `render.mjs`, `test/timeline.test.mjs`, `test/compositor.test.mjs`
- Consumes: `lib/schema.js` (constants, `TEXT_LIMITS`), `lib/geometry.js`, `lib/server.js`, `lib/ffmpeg.js`

**Interfaces:**
- Produces (`lib/timeline.js`, isomorphic):
  - `buildTimeline(scenes: object[], fps?: number): { total: number, frameCount: number, scenes: { index: number, start: number, end: number, duration: number }[] }`
  - `at(timeline, t: number): { outgoing: { index: number, localT: number }, incoming?: { index: number, localT: number }, transition?: { kind: string, progress: number, boundary: number } }` (transition window = `TRANSITION_SECONDS` centred on a boundary whose outgoing scene transition is `dip-to-brand` or `slide`; outgoing `localT` clamps to its duration, incoming `localT` clamps to 0; `cut`/`none` have no window)
  - `stillTimes(timeline): { kind: 'scene'|'transition', index: number, t: number, name: string }[]` (scene midpoints `scene-NN-mid`; transition midpoints `transition-NN-MM-mid`)
- Produces (`templates/compositor.js`): `window.__promo = { init(spec: { scenes, brand, size, fps }): Promise<void>, renderFrame(t: number): Promise<void> }` plus a `message` listener (`{type:'render', t}` -> renders then `postMessage({type:'frame-ready', t})`). Animations are driven only by `document.getAnimations().forEach(a => a.currentTime = localT * 1000)`; template fields are set via `textContent` on `[data-field]`.
- Produces (`lib/layout-check.js`): `checkLayout(page, opts: { size: {w,h}, sceneIndex: number }): Promise<{ kind: 'overflow'|'outside-stage'|'safe-area', scene: number, field: string, detail: string }[]>` (every `[data-field]` rect inside `#stage`, not clipped, and for 9:16 inside `safeBand`)
- Produces (`lib/render-core.js`): `openCompositor(opts: { scenes: object[], brand: object, size: {w,h}, captureDir?: string }): Promise<{ page, drive(t: number): Promise<void>, shot(): Promise<Buffer>, close(): Promise<void> }>`; `renderStills(opts: { scenes, brand, size, captureDir?, outDir }): Promise<{ files: { kind, index, t, file }[], layoutIssues: object[] }>`; `makeContactSheet(opts: { ffmpeg: string, files: string[], out: string, cols?: number, thumbWidth?: number }): Promise<void>`; `assertFontAvailable(page, font: string): Promise<void>` throwing `FontUnavailableError` (generic families `serif|sans-serif|monospace` always pass; otherwise compare text width of the font against two different generic fallbacks).
- Produces (`render.mjs`): `--scenes <file> --capture <dir> --out <dir> --stills [--size WxH]` (full render arrives in Task 9).

- [ ] **Step 1: Write failing tests.**
  ```js
  // timeline.test.mjs   (scenes durations [2.5, 11, 3, 3]; transitions [dip-to-brand, cut, slide, none])
  test('totals and starts', () => { equal(tl.total, 19.5); equal(tl.frameCount, 585); deepEqual(tl.scenes.map(s => s.start), [0, 2.5, 13.5, 16.5]); });
  test('transition window around a dip boundary', () => { equal(at(tl, 2.5).transition.kind, 'dip-to-brand'); approx(at(tl, 2.5).transition.progress, 0.5); equal(at(tl, 2.0).transition, undefined); });
  test('cut and none have no window', () => equal(at(tl, 13.5).transition, undefined));
  test('stillTimes: 4 scene mids + 2 transition mids with stable names', () => deepEqual(stillTimes(tl).map(s => s.name), ['scene-01-mid','scene-02-mid','scene-03-mid','scene-04-mid','transition-01-02-mid','transition-03-04-mid'].sort(byTime)));
  test('every scene midpoint is after the entrance (settled): start + duration/2 >= start + ENTRANCE_SECONDS for all schema-valid scenes', ...);
  // compositor.test.mjs (Playwright, loopback server; template-only scenes)
  test('renders a hook at 1920x1080, 1080x1080 and 1080x1920 from the same template', async () => { for (const size of SIZES) { const c = await openCompositor(...); await c.drive(1.2); const png = await c.shot(); equal(pngSize(png), size); ... } });
  test('frames are a pure function of t (order independent)', async () => { await c.drive(1.2); const a = sha(await c.shot()); await c.drive(0.3); await c.drive(2.0); await c.drive(1.2); equal(sha(await c.shot()), a); });
  test('field text is set via textContent: markup in text renders as text', async () => { /* text '<img src=x onerror=window.pwn=1>' -> no img element, window.pwn undefined */ });
  test('worst-case max-length text fits every template at all three ratios', async () => { /* each field filled with 'W'x(limit) in words of 8 chars; checkLayout returns [] for hook,title-card,feature-callout,outro */ });
  test('checkLayout flags an element forced outside the 9:16 safe band', ...);
  test('unknown brand font fails loudly naming the font; sans-serif passes', () => assert.rejects(assertFontAvailable(page, 'Definitely Not A Font 123'), /Definitely Not A Font 123/));
  test('renderStills writes one PNG per scene midpoint and per non-cut transition midpoint', ...);
  test('makeContactSheet writes one image whose width = cols x thumbWidth', ...);
  ```
- [ ] **Step 2: Run** `node --test test/timeline.test.mjs test/compositor.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `base.css`: `#stage { container-type: size; position: relative; overflow: hidden; }`, brand tokens `--brand-primary`, `--brand-accent`, `--brand-font` set by the compositor from `scenes.json` `brand`, `[data-theme]` variants (`light`, `dark`: see Open Questions), type sizes in `cqmin`, `@container (aspect-ratio < 1)` blocks for the portrait layouts, entrance keyframes defined with `animation-play-state: paused` and a duration of `ENTRANCE_SECONDS`. Each template is a `<section data-template>` with `[data-field]` children and no scripts. Transitions: `dip-to-brand` fades the outgoing layer to `--brand-primary` then the incoming layer in; `slide` moves the incoming layer in from the right over the outgoing layer; progress is eased with a cosine curve. `render-core.js` serves a temp dir (templates + `lib/timeline.js` + `lib/geometry.js` + generated `spec.json`) and, when `captureDir` is given, mounts it at `/capture/` via `serveDirs`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Add ratio-agnostic templates and a pure-function compositor for template scenes" (why: one HTML source for three ratios makes reframing a re-render, and frames must not depend on wall-clock state).

---

### Task 9: Footage layer and full render (`render.mjs`)

**Files:**
- Modify: `skills/promo/templates/compositor.js`, `lib/render-core.js`, `render.mjs`
- Create: `test/render.test.mjs`, `test/fixtures/footage-sample.webm` (generated by the test via ffmpeg lavfi `testsrc`, not committed)
- Consumes: `lib/geometry.js` (`cropForRatio`, `captionRect`), `lib/timeline.js`, `lib/schema.js` (`loadScenes`), `lib/ffmpeg.js`, capture `report.json`

**Interfaces:**
- Produces (`lib/render-core.js`): `renderVideo(opts: { scenes: object, size: {w,h}, captureDir: string, outFile: string, workDir: string, ffmpeg: string, ffprobe: string, music?: { audio: string, cues: string } | null, webm?: boolean, keepFrames?: boolean, captionMode?: 'feed'|'reel' }): Promise<RenderReport>`; `RenderReport = { version: 1, size, fps: 30, frames: number, frameSequenceSha256: string, encode: { codec: 'libx264', crf: 18, pix_fmt: 'yuv420p', preset: 'slow', movflags: '+faststart' }, audio: null | object, cueAlignment: object[], layoutIssues: object[] }` written to `render-report.json` beside the output.
- Footage layer contract: `<video muted playsinline preload="auto">` per flow served from `/capture/<flow>.webm`; scene local time `lt` maps to `currentTime = (Math.floor((in + lt) * 60 + 1e-6) + 0.5) / 60` (centre of the source frame), awaited via `seeked` then `requestVideoFrameCallback`; the video is sized to the source CSS size and transformed (`scale`, `translate`, origin 0 0) to show `cropForRatio(focus, source, size)`; the caption bar (`caption-bar.html`) overlays at `captionRect(size)`.
- `render.mjs`: `--scenes <file> --capture <dir> --out <dir> [--size WxH] [--stills] [--webm] [--keep-frames] [--music-dir <dir>]`. Output `master-16x9.mp4` (+ `master-16x9.webm` only with `--webm`, VP9; the spec line "also writes a .webm" is ambiguous, see Open Questions) and `render-report.json`. Validates `scenes.json` with `loadScenes(file, { flowDurations })` and refuses a capture `report.json` whose `status !== 'ok'`.

- [ ] **Step 1: Write failing tests** `test/render.test.mjs` (programmatic API for speed; CLI for refusal paths):
  ```js
  test('video seek is frame-exact: frame k from the compositor matches ffmpeg extract (PSNR > 35 dB)', async () => {
    // synthetic 30 fps (60 fps source) testsrc webm; drive footage scene to lt for k in [0, 1, 29, 30, 31, 89]; compare with `ffmpeg -i src -vf select=eq(n\,K) -frames:v 1`
    // PSNR via `ffmpeg -i a.png -i b.png -lavfi psnr -f null -`
  });
  test('footage frames are order-independent', ...);
  test('two renders of the same scenes have identical frameSequenceSha256', async () => { equal(r1.frameSequenceSha256, r2.frameSequenceSha256); });
  test('master mp4 is 1920x1080 h264 yuv420p 30 fps, duration = frames/30 +/- 0.05, silent has no audio stream', async () => { /* ffprobe */ });
  test('render-report.json lists frames, checksum and encode settings (crf 18)', ...);
  test('focus zooms the master: a footage scene with focus differs from the same scene without', ...);
  test('caption bar text is set from scene.caption and sits at captionRect(size)', ...);
  test('CLI refuses invalid scenes.json (exit 1, prints the field path)', ...);
  test('CLI refuses a capture report with status failed (exit 1)', ...);
  test('CLI names the missing flow video when scenes reference a flow with no webm', ...);
  test('unknown brand.font exits 1 naming the font', ...);
  test('compositor can play the capture codec: video.error === null and readyState >= 2 for a VP9 webm', ...);
  ```
- [ ] **Step 2: Run** `node --test test/render.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `renderVideo`: `buildTimeline`, `openCompositor`, for each frame `drive(i / 30)` then `page.screenshot({ type: 'png' })` into `work/frames/%05d.png` while updating a running sha256 over the PNG bytes in order; ffmpeg encodes `-framerate 30 -i %05d.png -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -movflags +faststart` (audio arguments added in Task 10); delete frames unless `keepFrames`. Wait for `document.fonts.ready` and all `<video>` `loadeddata` before frame 0. If the seek test fails in Step 1 and cannot be fixed, STOP and report; the contingency (not implemented here) is pre-extracting footage frames with ffmpeg and compositing `<img>` instead of `<video>`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Render footage and transitions deterministically and encode the master" (why: success criterion 2 requires byte-identical frame sequences; the seek and codec risks are tested rather than assumed).

---

### Task 10: Audio mix and cue loading (`lib/audio.js`, `lib/cues.js`)

**Files:**
- Create: `skills/promo/scripts/lib/audio.js`, `lib/cues.js`, `test/audio.test.mjs`, `test/cues.test.mjs`, `test/fixtures/valid.cues.json`
- Modify: `lib/render-core.js`, `render.mjs` (wire music into `renderVideo`)

**Interfaces:**
- Produces (`lib/audio.js`):
  - `duckIntervals(timeline, scenes): { start: number, end: number }[]` (footage scenes; adjacent/overlapping intervals merged)
  - `envelopeDb(t: number, intervals, duckDb: number, rampSec?: number): number` (0 dB outside; ramps linearly to `duckDb` over `rampSec` = 0.15 s *before* each interval start and back to 0 over 0.15 s after each end)
  - `buildAudioFilter(opts: { gainDb: number, duckDb: number, intervals, total: number, fadeOutSec?: number }): string` (volume gain + `volume=...:eval=frame` envelope + `afade=t=out:st=<total-0.3>:d=0.3`; fade default 0.3 s)
  - Looping: caller passes `-stream_loop -1` and `-t <total>` for tracks shorter than the video
- Produces (`lib/cues.js`):
  - `MAJOR_TOL = 0.15`, `MINOR_TOL = 0.10` (brag `audio.md:288-293`)
  - `loadCues(file: string): Promise<{ tempo: number, duration: number, strongCues: { time: number, intensity?: number, kind?: string }[] }>` (validates `schemaVersion`, `source{filename,trackStem}`, `duration`, `tempo`, `beats[]`, `strongCues[]` with numeric `time`; extra keys allowed; throws naming the field)
  - `nearestCue(cues, t: number): { time: number, delta: number } | null`
  - `alignmentReport(boundaries: number[], cues, tol?: number): { t: number, nearest: number | null, delta: number | null, within: boolean }[]` (report only; never fails a render)
  - `resolveTrack(track: string, opts?: { musicDir?: string }): { audio: string, cues: string }` (looks for `<track>.mp3` then `<track>.wav`; `musicDir` defaults to `PROMO_MUSIC_DIR` env else `skills/promo/assets/music`; throws naming the missing path)

- [ ] **Step 1: Write failing tests.**
  ```js
  // audio.test.mjs
  test('duckIntervals merges adjacent footage scenes', () => deepEqual(duckIntervals(tl, [hook, f1, f2, outro]), [{ start: 3, end: 9 }]));
  test('envelope ramps rather than steps', () => {
    const iv = [{ start: 5, end: 10 }];
    equal(envelopeDb(4.8, iv, -6), 0); approx(envelopeDb(4.925, iv, -6), -3); equal(envelopeDb(5, iv, -6), -6);
    equal(envelopeDb(10, iv, -6), -6); equal(envelopeDb(10.15, iv, -6), 0);
  });
  test('filter ends with a 300 ms fade-out at total - 0.3', () => match(buildAudioFilter({ gainDb: -14, duckDb: -6, intervals: [], total: 19.5 }), /afade=t=out:st=19\.2:d=0\.3/));
  test('loudness: -14 dB gain, -6 dB duck in [5,10], faded tail (real ffmpeg on a generated 20 s sine)', async () => {
    // volumedetect mean_volume on [1,4] vs source = -14 +/- 1; on [6,9] = [1,4] - 6 +/- 1; last 0.3 s at least 10 dB below [1,4]
  });
  test('a 2 s track loops to a 20 s output with no gap (segment [3,4] within 1 dB of [0,1])', ...);
  // cues.test.mjs
  test('loadCues accepts brag-shaped JSON incl. extra keys', ...);   // fixtures/valid.cues.json
  test('loadCues names the missing field', () => assert.rejects(loadCues(badFile), /strongCues/));
  test('nearestCue / alignmentReport honour tolerance 0.15: boundary 2.5 with cue 2.4 -> within true; cue 2.3 -> within false', ...);
  test('resolveTrack honours PROMO_MUSIC_DIR and names the missing file', ...);
  // render integration (add to render.test.mjs or here)
  test('music null -> no audio stream; music set -> one aac stream with duration == video +/- 0.05; render-report.cueAlignment filled', ...);
  ```
- [ ] **Step 2: Run** `node --test test/audio.test.mjs test/cues.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules and wire `renderVideo` (`-stream_loop -1 -i <audio>`, `-filter_complex "[1:a]<filter>[a]"`, `-map 0:v -map "[a]" -c:a aac -b:a 192k -shortest`; omit audio inputs entirely when `music` is null). `music.track` (from `scenes.json`) resolves through `resolveTrack`; `render-report.json.audio` records track, gain, duck, and cue alignment of every scene boundary.
- [ ] **Step 4: Run** the same command plus `node --test test/render.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** "Mix, duck and fade music from precomputed cues" (why: runtime must only read cue JSON; ducking needs ramps or it clicks).

---

### Task 11: Music tooling and bundled tracks (HUMAN INPUT REQUIRED)

**Files:**
- Create: `skills/promo/tools/analyze_music_cues.py`, `skills/promo/tools/pyproject.toml`, `skills/promo/assets/music/LICENSES.md`, `skills/promo/THIRD_PARTY_NOTICES.md`, `skills/promo/assets/music/<track>.mp3` + `<track>.cues.json` (3 tracks), `test/music-assets.test.mjs`, `test/fixtures/sample.cues.json`
- Modify: `lib/cues.js` (add `attributionFor`)
- Source (read-only): `BRAG/skills/brag/scripts/analyze_music_cues.py` (309 lines) and its `pyproject.toml`; `BRAG/LICENSE` (verified present). BRAG is a session scratchpad path; if it has been cleaned, re-clone `latent-spaces/brag` v0.4.0.

**Interfaces:**
- Produces (`lib/cues.js`): `attributionFor(track: string, opts?: { musicDir?: string }): Promise<string | null>` (parses the `LICENSES.md` table row for the track and returns e.g. `"Title" by Author, CC-BY-4.0, <url>`; `null` when the licence is CC0 and no attribution is required)
- `LICENSES.md` row format (table): `| track | title | author | source URL | licence | retrieved |`.

- [ ] **Step 1 (HUMAN/PM INPUT): supply tracks.** Source decided by Saint 2026-10-14: **ende.app** (CC BY 4.0 per https://ende.app/en/standard-license — commercial use allowed, attribution optional). The PM picks 3 tracks from ende.app (e.g. the "Happy Beats / Business Moves" series), confirms the licence on each track page, downloads them directly from ende.app (NOT from the brag clone) after Saint approves the download, and records per track: title, author, source URL, licence, retrieved date. Do NOT copy any brag mp3 (licence undocumented). This step blocks Step 6 only; Steps 2-5 proceed with a synthetic click-track. Note: the spec section 2 says 4-5 tracks; the PM decision here is 3.
- [ ] **Step 2: Port the analyser.** Copy `analyze_music_cues.py` and `pyproject.toml` to `skills/promo/tools/`; keep the CLI (`input`, `--output-json`, `--output-md`, `--window-start 0`, `--window-duration 25`, `--top-cues 10`, `--sr 44100`); edit the module docstring to say it is a maintainer-only tool for /promo (drop the /brag runtime-path wording); add the header `# Derived from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi`; write `THIRD_PARTY_NOTICES.md` with the full MIT text from `BRAG/LICENSE` and a list of derived files (extended in Task 15).
- [ ] **Step 3: Verify the tool runs.** `uv run --project skills/promo/tools python skills/promo/tools/analyze_music_cues.py --help` exits 0. Generate a 25 s click-track (`ffmpeg -f lavfi -i "aevalsrc=...|..."` at 120 BPM), run the tool to write `scripts/test/fixtures/sample.cues.json`, and confirm the top-level keys are `schemaVersion, source, duration, tempo, analysis, scoring, beats, strongCues` and `strongCues[].kind` is `strong_beat` or `onset_peak`. Not run in CI (needs uv + librosa).
- [ ] **Step 4: Write failing test** `test/music-assets.test.mjs`:
  ```js
  test('the tool-produced sample cue file loads', async () => ok((await loadCues(SAMPLE)).strongCues.length > 0));
  test('every bundled mp3 has a valid cues.json and a LICENSES.md row with licence CC-BY-4.0 or CC0, an https URL and an ISO date', ...);
  test('attributionFor returns a CC-BY credit line and null for CC0', ...);     // uses a temp musicDir fixture
  ```
  Run `node --test test/music-assets.test.mjs`. Expected: FAIL (`attributionFor` missing).
- [ ] **Step 5: Implement** `attributionFor`; wire its result into `render-report.json.audio.attribution`. Run the test. Expected: PASS (bundled-track assertions pass vacuously until Step 6, printing a TODO).
- [ ] **Step 6 (needs Step 1 inputs): bundle tracks.** Add the 3 mp3s, run the analyser on each (`--output-json assets/music/<stem>.cues.json`), write `LICENSES.md`, re-run the test. Expected: PASS with real assertions.
- [ ] **Step 7: Commit** "Add the maintainer cue analyser and licence-tracked music bundle" (why: licences must be provable and runtime must stay Python-free).

---

### Task 12: Reframe (`reframe.mjs`)

**Files:**
- Create: `skills/promo/scripts/reframe.mjs`, `test/reframe.test.mjs`
- Modify: `lib/render-core.js` (export `layoutGate`)
- Consumes: `renderVideo`, `renderStills`, `makeContactSheet`, `cropForRatio`, `checkLayout`, `loadScenes`

**Interfaces:**
- Produces (`reframe.mjs`): `--scenes <file> --capture <dir> --ratio 1x1|9x16 --out <file.mp4> [--stills <dir>] [--music-dir <dir>]`; sizes `1x1 = 1080x1080`, `9x16 = 1080x1920`; `captionMode` is `feed` for 1x1 and `reel` for 9x16. Writes `reframe-report.json` beside the output: `{ ratio, size, scenes: [{ index, rect, coverage, centered }], warnings: string[] }` (warning when `coverage < 0.6`, a plan-chosen threshold). With `--stills <dir>` writes the stills for that ratio plus `contact-<ratio>.png`.
- Produces (`render-core.js`): `layoutGate(scenes, brand, size): Promise<object[]>` (runs `checkLayout` over every scene's mid still time; `reframe.mjs` exits 1 listing issues before encoding).

- [ ] **Step 1: Write failing tests.**
  ```js
  test('9x16 output is 1080x1920 with duration equal to the master +/- 1 frame and audio duration equal to video +/- 0.05', ...);
  test('1x1 output is 1080x1080', ...);
  test('nothing is letterboxed: ffmpeg cropdetect on a mid frame reports the full frame', async () => match(cropdetectOutput, /crop=1080:1920:0:0/));
  test('reel template text and captions stay inside y 250..1580 for every scene', async () => { /* checkLayout issues [] and DOM rects asserted explicitly */ });
  test('template scenes are re-rendered natively, not cropped: the 9x16 hook still has its text block width <= 90% of the stage width', ...);
  test('reframe-report warns with coverage 0.5625 for the spec focus sample at 9x16', ...);
  test('--stills writes scene/transition stills at 1080x1920 and one contact sheet', ...);
  test('overflowing text at 9x16 exits 1 and lists scene + field before any encode', ...);
  ```
- [ ] **Step 2: Run** `node --test test/reframe.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `reframe.mjs` as a thin CLI: `loadScenes` -> `layoutGate` -> `renderVideo({ size, captionMode })` -> write `reframe-report.json`. Same `scenes.json`, same music, same transitions; only size and caption placement differ.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Add native reframing for 1:1 and the 9:16 reel with safe-area checks" (why: re-rendering templates natively avoids crops that cut text; layout failures are caught before encode).

---

### Task 13: Hero loop (`lib/loop-points.js`, `loop.mjs`)

**Files:**
- Create: `skills/promo/scripts/lib/loop-points.js`, `loop.mjs`, `test/loop-points.test.mjs`, `test/loop.test.mjs`

**Interfaces:**
- Produces (`lib/loop-points.js`):
  - `frameDiffs(frames: Uint8Array[]): number[]` (mean absolute difference between consecutive frames, normalised 0..1; `diffs[i]` compares frame `i` with `i-1`)
  - `class NoLoopError extends Error`
  - `pickLoopPoints(diffs: number[], fps: number, opts?: { minSec?: number, maxSec?: number, tailSec?: number }): { start: number, end: number, score: number }` (defaults 8, 15, 0.5; `start >= tailSec x fps` so the head-side crossfade source exists; cost = mean(diffs over `[start, start+w)`) + mean(diffs over `[end-w, end)`), `w = tailSec x fps`; ties resolve to the earliest start then the longest length; throws `NoLoopError` when the series is shorter than `minSec + tailSec`)
- Produces (`loop.mjs`): `--scenes <file> --capture <dir> --out <dir>`; writes `hero-loop.mp4` (`-movflags +faststart`) and `hero-loop.webm` (VP9), 1920x1080, 30 fps, no audio, no text. Source = concatenated ranges of footage scenes (16:9 `cropForRatio`), normalised to an intermediate lossless clip in `work/`; loop segment `[start, end]` plus a 500 ms crossfade of the tail `[end-0.5, end]` into the head-side frames `[start-0.5, start]` (ffmpeg `xfade=transition=fade:duration=0.5`), so output frame 0 is `F(start)` and the last frame approaches `F(start)`.

- [ ] **Step 1: Write failing tests.**
  ```js
  // loop-points.test.mjs  (600 frames @ 30 fps, diff 0.5 everywhere except quiet windows [40,100) and [350,420) at 0.01)
  test('picks start and end inside the quiet windows within 8..15 s', () => {
    const r = pickLoopPoints(series, 30);
    ok(r.start >= 40 && r.start <= 85); ok(r.end >= 365 && r.end <= 420);
    const sec = (r.end - r.start) / 30; ok(sec >= 8 && sec <= 15);
  });
  test('deterministic: same input, same answer', ...);
  test('start leaves room for the 500 ms head crossfade', () => ok(pickLoopPoints(flatSeries, 30).start >= 15));
  test('throws NoLoopError when footage is shorter than 8.5 s', () => assert.throws(() => pickLoopPoints(new Array(200).fill(0.1), 30), NoLoopError));
  test('frameDiffs: identical frames -> 0, inverted frames -> 1', ...);
  // loop.test.mjs (real ffmpeg, synthetic footage webm with a quiet static stretch)
  test('outputs: mp4 + webm, 1920x1080, 30 fps, duration 8..15 s, no audio stream', ...);
  test('seam: |last frame - first frame| <= 2x the median inter-frame diff of the output', ...);
  test('mp4 is faststart: "moov" occurs before "mdat" in the file bytes', ...);
  test('no text/captions: loop.mjs ignores scene text fields (scenes with only template scenes -> exit 1 "no footage scenes")', ...);
  ```
- [ ] **Step 2: Run** `node --test test/loop-points.test.mjs test/loop.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Diff series from `ffmpeg -vf scale=64:36,format=gray -f rawvideo` piped into `frameDiffs`; search all `(start, end)` pairs in the allowed length range (O(n x range), fine at n <= 900). The webm has no `moov` atom, so `+faststart` applies to the mp4 only (spec says "mp4 and webm with faststart"; webm needs nothing).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Add the hero loop with quiet-frame loop points and a 500 ms seam crossfade" (why: a loop with a visible jump reads as broken on a website hero).

---

### Task 14: Posters (`lib/poster.js`, `poster.mjs`)

**Files:**
- Create: `skills/promo/scripts/lib/poster.js`, `poster.mjs`, `test/poster.test.mjs`

**Interfaces:**
- Produces (`lib/poster.js`):
  - `extractFrame(opts: { ffmpeg: string, video: string, t: number, out: string }): Promise<void>` (`ffmpeg -ss <t> -i in.mp4 -frames:v 1 -q:v 2 out.jpg`, brag `step-4-deliver.md:52-55`)
  - `bakePoster(opts: { ffmpeg: string, ffprobe: string, video: string, still: string, outVideo: string, outJpg: string }): Promise<{ width: number, height: number }>` (writes the JPEG with `-q:v 2`; bakes the still as frame 0 with `-filter_complex "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]" -map "[v]" -map "0:a?" -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -c:a copy -movflags +faststart`; throws `PosterSizeError` naming both sizes when the still and the video differ; supports `outVideo === video` via a temp file + rename)
- Produces (`poster.mjs`): `--video <mp4> --still <png> --out <mp4> --poster <jpg>`; `--no-bake` writes only the JPEG (used for the hero loop).

- [ ] **Step 1: Write failing tests** (synthetic 3 s 30 fps H.264 clip with a 440 Hz AAC track, and a silent variant):
  ```js
  test('bake keeps duration within one frame and audio start/duration within 20 ms; audio codec copied', ...);
  test('frame 0 equals the still (PSNR > 40 dB) and frame 5 equals the source frame 5 (PSNR > 35 dB)', ...);
  test('output is faststart (moov before mdat)', ...);
  test('silent video bakes fine (-map "0:a?") and stays silent', ...);
  test('still of the wrong size throws PosterSizeError naming both sizes', ...);
  test('in-place bake (out === video) replaces the file atomically', ...);
  test('--no-bake leaves the video byte-identical and writes poster jpg (hero loop frame 0 is not altered)', ...);
  ```
- [ ] **Step 2: Run** `node --test test/poster.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both files per Interfaces.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Bake poster frames into outputs without moving duration or audio" (why: thumbnails on feeds use frame 0; the hero loop is excluded because a different frame 0 would flash on every loop).

---

### Task 15: SKILL.md, references, example config, README

**Files:**
- Create: `skills/promo/SKILL.md`, `skills/promo/references/{plan,capture,compose,deliver}.md`, `skills/promo/examples/personal-website.promo.yaml`, `skills/promo/scripts/test/docs.test.mjs`
- Modify: `skills/promo/THIRD_PARTY_NOTICES.md`, `README.md`
- Outside repo (do NOT commit here; the PM or a human applies it): `C:\Users\Micha\dev\Projects\AGENTS.md` (verified to exist) gets one line pointing agents at the skill and at `.promo/promo.yaml`.
- Sources (verbatim reuse needs an attribution line at the bottom of that file): `BRAG/skills/brag-slim/SKILL.md` (`:51-55` rubric, `:65-75` laws, `:77-89` tones, `:95-105` build/deliver rules); `BRAG/skills/brag/references/step-2-plan.md` (`:72-89` storyboard, `:122-134` reading time, `:136-162` what to show, `:221-233` transitions); `step-4-deliver.md` (`:52-55`, `:63-71`, `:77-91`); `audio.md` (`:273-278` cue schema, `:288-293` tolerances, `:296-297` fallback).

**Interfaces:**
- `SKILL.md` frontmatter is exactly `name: promo` and a one-line `description:`. Body (aim ~200 lines, hard cap 250): prerequisites (Node 22, full FFmpeg, Playwright Chromium, `npm ci` in the skill's `scripts/`, `node scripts/doctor.mjs`), invocation (`/promo`, `--feature <tag>`, `--tone <preset|freeform>`, `--duration <s>`, `--formats feed,reel,hero`), the workflow with exact commands in order (capture -> plan -> compose -> `render.mjs --stills` check loop, max 3 iterations then report to the user -> render -> reframe 1x1/9x16 -> loop -> poster -> share copy), the three hard gates and the rule "never edit around a gate; fix demo data, `hide:`, `redact:` or the flow", creative laws (brag's, plus >=50% real footage and no on-screen claim not in the product's own copy/README), rubric, tones table, the Opus 5.5 dispatch recipe (150K token budget; reads only the product repo and the yaml's staging origin; writes only under `promo-output/<timestamp>/`; never posts), post-deploy-only rule (never a merge/deploy gate), what is committed (`promo-plan.md`, `share-copy.md`), "the skill directory is the directory containing SKILL.md; script paths are relative to it", and the stills-check token rule (view master stills plus any layout-flagged scene; view the 1:1 and 9:16 contact sheets only).
- `compose.md` lists every template with its fields and the `TEXT_LIMITS` values; documents `strongCues[].time` alignment with tolerances 0.15 s (major reveals) / 0.10 s (small entrances), 1-3 cue locks per video, ignore cues that hurt readability; documents the `focus` coverage warning and "choose a tall or narrow focus for the reel".
- `capture.md` documents the yaml, beat vocabulary, cursor/timing rules, `hide`/`redact` usage, that long numeric IDs and placeholders like `you@example.com` trip the gate, and the stale-selector repair loop.
- `deliver.md`: formats matrix, poster rules (hero not baked), share-copy rules per channel (LinkedIn 2-4 sentences no hashtags; X <= 240 chars; Instagram short line + up to 8 hashtags; "Excited to share" banned) and the CC-BY attribution footnote from `render-report.json.audio.attribution`.
- `examples/personal-website.promo.yaml` (first-run guide, no login). Verified facts: `app/page.tsx` (route `/`, sections `#projects` and `#blog` exist: `components/Projects.tsx:113`, `components/Blog.tsx:9`), `app/blog/page.tsx` (route `/blog`, `.post-grid` and `a.post-card` per `components/PostCard.tsx:6`, `main#main-content`), `app/blog/[slug]/page.tsx` (dynamic route), brand tokens from `DESIGN.md` (`aged-brass #c6b593`, `bone-soft #d9d7ce`, font `Manrope`, dark theme). Content: `staging.url: http://localhost:3000`; `pii_policy: public-content-only` (plan-chosen string, see Open Questions); `hide: ['a[href^="mailto:"]', '#contact', 'nextjs-portal']` (the real address `michael.sintimkoree@gmail.com` is in `components/Footer.tsx:15-19` on every page and `components/Contact.tsx:65`, so the "no-PII smoke test" would fail the email gate unless hidden; `nextjs-portal` is the Next dev-overlay element, UNVERIFIED); `redact: ["michael.sintimkoree"]`; flows `home-tour` (`goto: /`, `settle: "#projects"`, `scroll: "#blog"`, `settle: "#blog"`) and `blog-read` (`goto: /blog`, `settle: ".post-grid"`, `click: ".post-grid a.post-card >> nth=0"`, `settle: "h1"`; the `h1` on the post page is UNVERIFIED). Header comment: Manrope must be installed locally or `brand.font` changed (renderer does not fetch fonts).
- README changes: bullet under `## What's in here` (bold backticked `skills/promo/` + description), a Requirements line (Node 22+, full FFmpeg, Playwright Chromium; only needed for `/promo`), and a new `## Skills` section between `## Install` and `## The memory vault`: copy install for BOTH `~/.claude/skills/promo/` and `~/.agents/skills/promo/` as real copies (no symlinks; PowerShell `Copy-Item -Recurse` and bash `cp -R` shown), then `npm ci` inside the installed `scripts/`, `node scripts/doctor.mjs`, and the AGENTS.md line to add. The `npx skills add` route in spec section 9 is omitted because it is unverified.

- [ ] **Step 1: Write failing test** `test/docs.test.mjs`:
  ```js
  test('SKILL.md frontmatter is exactly name+description, name === "promo", body <= 250 lines', ...);
  test('every references/*.md and scripts/*.mjs path mentioned in SKILL.md exists', ...);
  test('SKILL.md documents --feature, --tone, --duration, --formats, "150K", "Opus 5.5", "3 iterations", and all three hard gates', ...);
  test('compose.md quotes every TEXT_LIMITS value', () => { for (const [tpl, fields] of Object.entries(TEXT_LIMITS)) for (const [f, n] of Object.entries(fields)) match(compose, new RegExp(`${f}[^\\n]*\\b${n}\\b`)); });
  test('files with verbatim brag text end with the attribution line', ...);
  test('example promo.yaml validates with validatePromoConfig', async () => ok((await validatePromoConfig(parse(example))).ok));
  test('README has "## Skills" between "## Install" and "## The memory vault" and names both install dirs', ...);
  ```
  Run `node --test test/docs.test.mjs`. Expected: FAIL.
- [ ] **Step 2: Write the docs** (reuse brag text at the cited lines; adapt transitions vocabulary to the four ours; add the attribution line "Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi." at the bottom of each file with verbatim text; extend `THIRD_PARTY_NOTICES.md`).
- [ ] **Step 3: Run** `node --test test/docs.test.mjs` and, from the repo root, `python scripts/validate.py` (now validates the real `skills/promo/SKILL.md`). Expected: PASS, `1 skill(s) validated`.
- [ ] **Step 4: Commit** "Document /promo, add the personal-website first-run config and README install steps" (why: the skill is only usable if an agent can find, install and run it; the example surfaces the real-email hazard on the first target).
- [ ] **Step 5 (outside repo, human/PM):** add to `C:\Users\Micha\dev\Projects\AGENTS.md`: `- /promo: product launch videos. Skill at ~/.claude/skills/promo (or ~/.agents/skills/promo); per-product config at <repo>/.promo/promo.yaml.` Not committed to this repo.

---

### Task 16: End-to-end pipeline and negative PII e2e

**Files:**
- Create: `skills/promo/scripts/test/e2e/pipeline.test.mjs`, `test/e2e/pii-negative.test.mjs`, `skills/promo/fixtures/demo-site/scenes.json`
- Modify: `skills/promo/scripts/package.json` (`"test": "node --test \"test/*.test.mjs\" \"test/e2e/*.test.mjs\""`; `test:unit` unchanged), `skills/promo/fixtures/demo-site/.promo/promo.yaml` (add the `pii-flow` variant as a separate file `promo.pii.yaml`)
- Consumes: all CLIs via `runCli`

**Interfaces:**
- `fixtures/demo-site/scenes.json`: hook 2.5 s, footage `rent-collection` in 3.2 / out 13.2 with `focus` and caption, feature-callout 2.0 s, outro 2.0 s (total 16.5 s, footage 61%); durations are chosen at the schema floor to bound render time; adjust against `validateScenes` output if `minSceneDuration` rejects them. `music: { track: "test-tone", gain_db: -14, duck_db: -6 }`.
- The test writes its own 2 s sine WAV (`ffmpeg -f lavfi -i sine=frequency=440:duration=2`) and a hand-written `test-tone.cues.json` into a temp dir exposed as `PROMO_MUSIC_DIR`; no bundled mp3 is used.

- [ ] **Step 1: Write the failing pipeline test** (single `test` with sub-steps via `t.test`, timeout 20 min; serves the fixture with `serveDirs`, then CLIs only):
  ```js
  // capture -> render -> reframe x2 -> loop -> poster x3 (+ hero --no-bake)
  await t.test('capture succeeds and PII is clean', () => { equal(report.status, 'ok'); equal(report.pii.hits.length, 0); });
  await t.test('scenes.json validates with real flow durations and footage >= 50%', ...);
  await t.test('three mp4 playable with exact sizes', async () => {
    deepEqual(sizeOf('feed-16x9.mp4'), [1920, 1080]); deepEqual(sizeOf('feed-1x1.mp4'), [1080, 1080]); deepEqual(sizeOf('reel-9x16.mp4'), [1080, 1920]);
    for (const f of three) { ok(Math.abs(durationOf(f) - 16.5) < 0.1); ok(hasAudio(f)); }
  });
  await t.test('hero loop mp4 + webm: 1920x1080, 8..15 s, no audio', ...);
  await t.test('posters exist as jpg and match output sizes; hero poster not baked', ...);
  await t.test('two master renders have identical frameSequenceSha256', () => equal(r1.frameSequenceSha256, r2.frameSequenceSha256));
  await t.test('reel layout: reframe-report has no warnings other than coverage', ...);
  ```
  `pii-negative.test.mjs`: serve the fixture, run `capture.mjs` with `promo.pii.yaml` whose flow `pii-flow` settles on `pii.html` (contains `jane.doe@example.com`):
  ```js
  equal(r.status, 1); match(r.stderr, /pii-flow-1\.png/); match(r.stderr, /email/);
  equal(report.status, 'failed'); ok(!fs.existsSync(path.join(outDir, 'pii-flow.webm')));
  const rr = runCli('render.mjs', [... '--capture', outDir]); equal(rr.status, 1); match(rr.stderr, /status/);   // downstream refuses a failed capture
  ```
- [ ] **Step 2: Run** `npm test` from `skills/promo/scripts`. Expected: FAIL (fixture/scenes missing or gaps found). Fix gaps in the owning task's module, not in the test.
- [ ] **Step 3: Implement** the fixture files and the `poster.mjs` wiring used by the test (the pipeline order is the same as the SKILL.md workflow, so a divergence here is a doc bug: fix SKILL.md and `docs.test.mjs` together).
- [ ] **Step 4: Run** `npm test`. Expected: PASS (budget about 5-8 minutes locally; CI timeout is 30 minutes).
- [ ] **Step 5: Commit** "Add the end-to-end pipeline test and the negative PII gate test" (why: success criteria 1-3 are only real if the whole chain runs on a fixture in CI).
- [ ] **Step 6: Report to the PM:** all 16 tasks done, plus the first real run instruction (`node scripts/capture.mjs --config examples/personal-website.promo.yaml --out <dir>` against `next dev` on :3000), which is a PM-run smoke test and not part of CI.

---

## Open Questions / UNVERIFIED

1. **Capture mechanism (blocking, Task 5 Step 1).** `page.screencast.start({ onFrame })` exists in installed playwright-core 1.63 types; presence in `playwright@1.64.1` and the delivered fps/pixel size/timestamp unit are UNVERIFIED until the spike. If it fails the 60 fps / device-scale 2 constraint must be relaxed or CDP screencast used: PM decision.
2. **Fonts and network.** Spec section 3.2 allows "loadable locally or via Google Fonts"; this plan loads local/system fonts only (renderer must not touch the network). Decision needed: keep local-only, or allow Google Fonts hosts at render time. Consequence for the first target: `Manrope` (DESIGN.md:23) must be installed locally.
3. **Cross-origin sub-resources during capture.** Spec gate 1 says "navigation"; the comment on `staging.url` says "the ONLY origin capture may touch". The plan blocks cross-origin navigations and tallies (does not block) sub-resources such as CDN fonts/analytics in `report.json.thirdPartyRequests`. Confirm.
4. **Value lists the spec does not give (plan-chosen, confirm):** allowed `pii_policy` values (plan: any non-empty string; example uses `demo-tenant-only` and `public-content-only`); `brand.theme` (plan: `light` and `dark`; only `light` appears in the spec); `title-card` fields (`title`, optional `sub`); `select` beat shape (`{ selector, value }`); `TEXT_LIMITS` numbers; `TRANSITION_SECONDS = 0.4`; reel coverage warning threshold `0.6`; the rule that the last scene's transition must be `none`; flow-name pattern `^[a-z0-9][a-z0-9-]*$`.
5. **Hero poster.** Spec section 7 says every output's poster is baked as frame 0. Baking a different frame into a looping clip flashes on each loop, so the hero loop gets a JPEG only. Confirm.
6. **`render.mjs` webm.** Spec section 6 says render "also writes a .webm (VP9)"; section 7 has `loop.mjs` produce the hero webm. Plan: `master-16x9.webm` only with `--webm`. Confirm.
7. **Music count.** Spec section 2 says 4-5 tracks; PM decision is 3 (human-supplied, Task 11 Step 1).
8. **tesseract.js 7.0.0 option names** (`gzip`, `cacheMethod`, `langPath`) and the exact default tessdata source are UNVERIFIED; resolve from the installed package in Task 3.
9. **Playwright 1.64.1 browser revision.** The machine has chromium builds 1208-1243; whether 1.64.1 needs a newer one is UNVERIFIED; `doctor.mjs` reports it and the fix is `npx playwright install chromium`.
10. **Personal-website items marked UNVERIFIED in Task 15:** the `h1` on `/blog/[slug]`, `nextjs-portal` dev-overlay selector, and sections `#about` / `#experience` (not used). The real email in Footer/Contact is verified and is why the example hides it.
11. **Workspace `AGENTS.md`** at `C:\Users\Micha\dev\Projects\AGENTS.md` exists but its current content was not read; the edit is outside this repo.
12. **CI**: `sudo apt-get update` was added before the PM-specified `apt-get install -y ffmpeg`; harmless, flagged as a deviation. Unit/e2e runtime in CI is estimated, not measured.

## PM decisions on the open questions (2026-10-14, Fable PM session; Saint approved the spec, these resolve the plan-writer's flags)

1. **Capture mechanism:** run the Task 5 spike as written. If `page.screencast` is absent or delivers < 30 fps median, the pre-approved fallback is CDP: `context.newCDPSession(page)` → `Page.startScreencast({format:'png', everyNthFrame:1})` consuming `Page.screencastFrame` events (ack each with `Page.screencastFrameAck`). Only if both fail, relax to 30 fps capture and report. Device-scale 2 is kept in all cases (viewport 1920×1080 at DSF 2; frames downscaled to 1920×1080 on assembly if the screencast delivers 3840×2160).
2. **Fonts:** local-only at render time, as planned. `doctor.mjs` checks that `brand.font` is installed and names it in the failure. Manrope is installed locally before the personal-website run.
3. **Cross-origin sub-resources during capture:** allowed and tallied in `report.json.thirdPartyRequests`; cross-origin *navigations* (top-level, popup, redirect, JS) are blocked. Confirmed.
4. **Plan-chosen value lists:** all accepted as written (pii_policy any non-empty string; theme light|dark; title-card {title, sub?}; select {selector, value}; TEXT_LIMITS; TRANSITION_SECONDS 0.4; reel coverage warning 0.6; last transition `none`; flow-name pattern).
5. **Hero poster:** JPEG only, not baked. Confirmed; spec §7 is amended by this note.
6. **Master webm:** only with `--webm`. Confirmed.
7. **Music:** 3 tracks from ende.app (see Task 11 Step 1). Download is an external fetch and is brought to Saint for approval at execution time.
8–9. Resolve from the installed packages in Tasks 3 and 1 as planned; `doctor.mjs` owns the browser-revision message.
10. UNVERIFIED personal-website selectors are confirmed by the Task 15 implementer with a grep before use; anything still missing is left out of the example rather than guessed.
11. The workspace `AGENTS.md` line is a PM-session edit, not part of this repo's diff.
12. `apt-get update` accepted.

