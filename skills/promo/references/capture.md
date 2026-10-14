# Capture: the yaml, the beats, the gates

```
node SKILL/scripts/capture.mjs --config .promo/promo.yaml --out RUN/capture [--feature <tag>]
```

Output in `RUN/capture/`: one `<flow>.webm` per flow (1920x1080), a `<flow>-<n>.png` still at every `settle`, and `report.json` (per-flow beat timestamps, stills, durations, PII scan result, `blockedNavigations`, and `failed` on a failed run). Exit codes: 0 ok, 1 validation or gate (kinds `pii`, `origin`, `login`, `hide`), 2 environment (FFmpeg, Chromium or the OCR data missing), 3 flow failure (kinds `selector`, `navigation`).

## The config: `.promo/promo.yaml`

Committed in the product repo. See `examples/personal-website.promo.yaml` for a complete, no-login file.

| Key | Rule |
|---|---|
| `version` | `1` |
| `product`, `tagline` | Name (required) and optional one-liner. Use the product's own words. |
| `brand` | `primary` and `accent` as `#RRGGBB`, `font` one installed family name, `theme` `light` or `dark`. All four required. |
| `staging.url` | The ONLY origin capture may touch. |
| `staging.login` | Optional: `path` (starts with `/`), `user_env`, `pass_env` (environment variable NAMES, upper case), `submit` selector, `settled` selector. |
| `hide` | Selectors set to `display:none` on every navigation (cookie banners, dev toolbars, anything holding personal data). |
| `pii_policy` | Required, any non-empty string describing why the data is safe (for example `demo-tenant-only`). The run refuses without it. |
| `redact` | Extra strings the scan must never find (a surname, an email domain, a real address). |
| `flows` | At least one. `name` is lowercase letters, digits and `-`; optional `feature` tag for `--feature`; `beats` list. |
| `music.prefer` | Optional mood hint for the plan. |

Credentials are env var names only. The password never reaches logs, report or stills, and the login page is not recorded. The username field is found by convention (the first non-password text input); the schema has no selector for it.

## Beat vocabulary

Each beat is a one-key object. Anything else fails validation.

| Beat | Form | Effect |
|---|---|---|
| `goto` | `goto: /path` | Navigate. The path is resolved against the origin of `staging.url`, so a sub-path in `staging.url` is dropped: write the full path from the root (`/app/tenants`, not `/tenants`). |
| `click` | `click: "selector"` | Cursor eases to the target, pauses, clicks with a ripple. |
| `fill` | `fill: { selector: "#name", text: "Ama Mensah" }` | Types the text key by key. |
| `select` | `select: { selector: "#plan", value: "pro" }` | Picks an option. |
| `hover` | `hover: "selector"` | Moves the cursor onto the target. |
| `scroll` | `scroll: "selector"` | Smooth-scrolls the target into view. |
| `wait` | `wait: 800` | Milliseconds, 0 to 3000. |
| `settle` | `settle: "selector"` | Waits until visible, holds, and saves a still. Put one after every state change you want to show. |

Timing is built in. The cursor eases to its target over about 400 ms and pauses 150 ms before a click. Typing runs 60-90 ms per character with jitter. Each beat ends with a 600 ms hold. A fresh browser context starts every flow, `prefers-reduced-motion` is off, and service workers are blocked. Do not add `wait` to pad time; add a `settle` on the element that proves the page is ready.

Selectors: prefer `text=...`, `[data-testid=...]`, `role=` and stable ids over generated class names. Use `>> nth=0` to disambiguate.

## Writing flows for video

- One flow per story beat of the plan. Short flows (6-15 s of footage) give the plan freedom to cut.
- End each flow on a settled state worth a poster frame.
- Use seeded demo data with fictional names. The data you see on staging is the data in the video.
- Hero loop needs at least 8.5 s of footage in total across the footage scenes.

## Hard gates

No override flag exists. See SKILL.md: **never edit around a gate**.

1. **Origin gate.** Every navigation whose origin differs from `staging.url` aborts the flow (kind `origin`). Redirect chains are verified hop by hop.
2. **`pii_policy`** missing: abort before the browser opens.
3. **PII scan.** Every still is OCR'd and the DOM text is scanned for emails, phone numbers (Ghana and international forms), IBAN or card-like digit runs, and every `redact:` string. A hit fails the run (kind `pii`), names the frame, and ships no footage. The matched text is masked (first character only) in the log and `report.json`; the kind and frame stay.
4. **`hide:` check.** Every `hide:` selector is applied as `display:none` (the recorded browser ignores the site's CSP so the rule always installs), and after each `goto` and before each still the capture checks that every match really computes to `display:none`. A match that is still visible fails the run (kind `hide`, names the selector, no footage); fix the selector or the page's own styles. A page crash or an unexpected close also fails the PII gate, because the last frames could not be verified.

### What trips the PII gate (false positives)

The gate is fail-closed, so it over-matches:

- A run of 13-19 digits reads as a card number. Millisecond timestamps and long numeric IDs trigger it.
- `0XXXXXXXXX` (a 10-digit number starting with 0) reads as a Ghana phone number.
- Placeholders such as `you@example.com` are emails and fail the scan.

Fix with a `hide:` selector for the element, seeded demo data without the pattern, or shorter IDs. Do not "fix" it by timing the capture around the text.

### Known gaps (documented, not hidden)

- On-screen flashes shorter than about 100 ms can slip between scans.
- **Pixels-only text is checked only at a `settle`.** Text that exists only as pixels (images, `canvas`, `<video>`, CSS `::before` and `::after`, PDF viewers) is invisible to the DOM scan, and OCR runs only on the settle stills, so anything shown between settles is never checked. Put a `settle` on every state you show, and `hide:` the image and canvas regions that can carry personal data.
- Blind spots: Ghana numbers written `233...` without `+` or a leading 0; text inside shadow roots; the OCR tests cover email only.
- Cross-origin iframes, and any cross-origin subframe navigation, are blocked, so the flow fails with kind `origin`. Apps with third-party embeds (maps, video, payment widgets) cannot be captured until an explicit opt-in is designed. `hide:` does not help: a hidden iframe still loads, so the gate still fires. Capture a page without the embed.
- After the redirect chain is verified hop by hop, the final URL is requested a second time, unrouted. A server that answers differently the second time can still leak; one-time GET URLs get consumed twice; a 307 or 308 POST collapses to GET.
- Popups the browser refuses are listed in `report.blockedNavigations`, but only those the in-page wrapper sees.
- Service workers are blocked during capture, so a PWA's offline behaviour cannot be shown.
- Footage is recorded at 1920x1080 real pixels, so focus zooms and the 9:16 crop upscale by up to 2x and look softer. A 4K capture is a planned follow-up.

## When a flow fails (stale selector)

Exit 3 prints the flow, the beat and a screenshot path (`failure-<flow>-beat<n>.png` in the capture dir). Repair loop:

1. Open the screenshot and read `report.failed` (`kind`, `message`).
2. `selector`: find the right selector in the product source or the screenshot, fix it **in the yaml**.
3. `navigation`: the URL, a redirect or a timeout; check the route exists on staging and the app is up.
4. Re-run capture. Do not add retries, `wait` padding or alternative selectors that hide the break.
5. After two failed repairs of the same beat, stop and report to the user.
