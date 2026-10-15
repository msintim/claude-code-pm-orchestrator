# Plan: angle, storyboard, pacing

Inputs: the product's own copy and README, brand tokens, `capture/report.json`, the settle stills from capture (open the images), and `.promo/promo.yaml`. Answer the rubric in SKILL.md, then write `promo-plan.md` in the run directory. It is committed, so it must be safe to read in public.

`promo-plan.md` contains: angle (one sentence), hook, tone, a claim ledger (every on-screen claim with the product copy or README line it came from), the storyboard, music pick, and any fictional stand-ins used.

Limits that shape the plan: aim for 4-7 scenes; the master must total 15-30 seconds; footage must be at least 50% of the runtime; every footage scene is captioned; a footage scene's `out` cannot pass the end of the recorded flow; the last scene's transition must be `none`.

## Storyboard

Write each scene like this:

### Scene 1 - [name] - [duration]s
[What's on screen. What text appears. What product material must be referenced.]
Template or footage: [hook / title-card / feature-callout / outro, or footage: flow, in, out, focus]
Sequential/interaction: [yes - describe what appears one by one or what interaction is simulated, e.g. "3 stat cards arrive one by one" or "cursor clicks the match button"; or none]
Audio intent: [what the sound should do emotionally]
Audio-coupled idea: [typed text, beat-aligned reveal, counter ticks, card-by-card sequence, simulated tap/swipe/type - or none]
Music: [mood, or "none" only if disabled / missing / intentionally silent]
Transition mood: [cut / dip-to-brand / slide / none] -> Scene 2

### Scene 2 - [name] - [duration]s
[...]
Sequential/interaction: [yes - describe it; or none]
Audio intent: [what the sound should do emotionally]
Audio-coupled idea: [type or none]
Transition mood: [mood] -> Scene 3

[... continue for all scenes]

## Reading time (keep the pace, not at text's expense)

High pace comes from fast motion, fast transitions, and tight cuts, NOT from pulling text off screen before it can be read. Every text element a viewer must read needs enough fully-visible, settled time (entered, not yet exiting) to actually read it:

- Short label or 1-3 word line: about 0.8s settled.
- Headline or full sentence: about 0.3s per word, minimum ~1.2s. The hook line gets the most.

Plan that floor, then keep everything else fast: entrances and transitions stay snappy (0.3-0.6s) and motion stays energetic. A line can SLAM in fast and then HOLD: fast-in plus an adequate hold reads as punchy AND legible.

The renderer enforces the floor: a scene must last at least 0.5 s of entrance plus the longest text hold, where the hold is max(0.8 s, 0.3 s x words). Plan to it; do not discover it from a validation error.

Two failure modes to design out at the plan stage:

- **Too much text for the scene length.** A 4s scene lands maybe 2-3 short reads at the floor, not 6. If a scene carries more text than its duration allows, cut copy or split the scene; do not speed it up.
- **Sequential text snapped onto a fast beat.** Beat-grid reveals can land ~0.5s apart at 110+ BPM. That spacing is fine for accents (glows, dots, ticks) but too fast for readable lines. For sequential TEXT, hold each item to the floor: snap to every other beat, or reveal them quickly and hold the full set on screen afterward. Flag any sequential text reveal in the storyboard with its intended hold.

## Choosing what to show

Every promo must show something real from the product. In preferred order:

1. **A working-app moment from a captured flow** - the upload screen, the result view, the dashboard with real-looking content. The product *doing* its thing beats the product *describing* its thing. This is the default and it must be at least half the runtime.
2. **A feature callout over a still-frame of that flow** - a hero card, stat block or progress meter, strong when the flow has a clear single payoff.
3. **Text-forward sequence** - if the product is copy-driven, let the copy be the visual: giant display type, minimal chrome.

Never fill scenes with abstract patterns, color washes, or generic motion graphics that could belong to any video.

### Bias the storyboard toward the user flow

If the config has a real user flow, the **centerpiece scenes must show that flow**, not landing-page recreations.

Good (working-app scenes):
- "Upload screen: cursor drops a file. Filename appears. Progress bar fills 0 to 100% in 1.2s."
- "Three result thumbnails pop in. Each shows a real-looking caption."
- "Inbox row appears, gets a green 'resolved' badge, slides off the top of the list."

Avoid (marketing-only scenes when a flow exists):
- A diagram of what the product does, instead of the product doing it.
- Three stat cards that repeat the landing page's social-proof row.

Stat cards, headline blocks and the hero still have a place, but at most one of them, used as a frame around the flow and not as a substitute. If a flow was not captured for a moment you want, add it to the yaml and re-capture; do not invent it in a template.

## Transition vocabulary

Available transitions are `cut`, `dip-to-brand`, `slide` and `none`. A plain crossfade between two busy layouts makes a muddy double exposure, so there is none; dip through the brand colour or cut instead. Match transitions to tone:

| Tone | Preferred transitions |
|---|---|
| `default` | `dip-to-brand`, `slide` |
| `polished` | `dip-to-brand`, `slide` |
| `yc-parody` | `cut` |
| `chaotic` | `cut` |
| `deadpan` | `none`, `dip-to-brand`, with long holds |
| `cinematic` | `dip-to-brand` |
| `app-store` | `slide` |

Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi.
