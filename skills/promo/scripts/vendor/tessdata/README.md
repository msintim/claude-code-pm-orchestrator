# Vendored OCR data

`eng.traineddata` is the English LSTM-only model (`4.0.0_best_int`) that tesseract.js 7 downloads by default on its LSTM-only path. It is vendored so the PII gate never touches the network at runtime.

| Field | Value |
|---|---|
| Source URL | https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz |
| Compressed size | 2,952,873 bytes (gunzipped once, saved uncompressed) |
| Uncompressed size | 5,199,098 bytes |
| sha256 (uncompressed) | `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |
| Retrieved | 2026-10-14 |
| Licence | Package `@tesseract.js-data/eng@1.0.0` declares `MIT` in its package.json (packaging). The model data itself derives from the upstream Tesseract `tessdata_best` project, which is Apache-2.0; that upstream attribution was not shipped in the npm package and was not re-verified from the downloaded bytes. |

Runtime never downloads: `createOcr` in `../../lib/pii.js` loads from this directory with `gzip: false` and `cacheMethod: 'none'`, and rejects if the file is missing.

To refresh: download the same URL into an empty temp directory, gunzip, replace the file, and update the sha256 and date above.
