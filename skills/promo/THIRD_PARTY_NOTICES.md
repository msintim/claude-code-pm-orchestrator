# Third-party notices

## latent-spaces/brag

Parts of /promo are derived from [latent-spaces/brag](https://github.com/latent-spaces/brag) v0.4.0, used under the MIT licence below.

Derived files:

- `tools/analyze_music_cues.py` (maintainer-only music cue analyser)
- `tools/pyproject.toml` (its dependency list)
- `SKILL.md` (creative laws, rubric, tones and delivery rules adapted from brag-slim)
- `references/plan.md` (storyboard, reading time, what to show and transition vocabulary adapted from brag's step-2-plan)
- `references/compose.md` (music cue schema, alignment guidance and fallback adapted from brag's audio reference)
- `references/deliver.md` (poster and share-copy rules adapted from brag's step-4-deliver)

Each of the four documentation files ends with the line "Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi." No brag audio or other assets are included.

MIT License

Copyright (c) 2026 Shunit Haviv Hakimi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Bundled music (CC BY 4.0)

Three tracks in `assets/music/` are by Sascha Ende (https://ende.app), licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). They are cut, looped and level-ducked when rendered, so any video that uses one must carry the credit line from `render-report.json` (`audio.attribution`), which names the title, author, source, the licence with its URI, and states that the track was edited. Sources and retrieval dates are in `assets/music/LICENSES.md`.

- `happy-beats-business-moves-vol-1` - "Happy Beats & Business Moves Vol. 1"
- `happy-beats-business-moves-vol-3` - "Happy Beats & Business Moves Vol. 3"
- `happy-beats-business-moves-vol-12` - "Happy Beats & Business Moves Vol. 12"

## Tesseract OCR data

`scripts/vendor/tessdata/eng.traineddata` is the English LSTM model (`4.0.0_best_int`) from the [Tesseract `tessdata_best`](https://github.com/tesseract-ocr/tessdata_best) project, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). It was fetched through the `@tesseract.js-data/eng@1.0.0` npm package (which declares MIT for its packaging); the upstream Apache-2.0 terms have not been re-verified from the downloaded bytes. Provenance, size and checksum are in `scripts/vendor/tessdata/README.md`.
