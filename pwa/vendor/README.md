# Vendored QR decoder

`jsQR-1.4.0.js` is the pinned UMD distribution of **jsQR1.4.0**, from [cozmo/jsQR](https://github.com/cozmo/jsQR), package distribution `jsqr@1.4.0/dist/jsQR.js`. Its Apache2.0 license is retained verbatim in `jsQR-LICENSE.txt`. Integrity/byte counts: `../../qa/ui251-assets.json`.

The prototype loads this file locally on demand for the camera/manual QR flow. There is no runtime CDN request and no upload of camera frames. `../sensor-scanner.js` bounds the canvas, decoding interval and accepted DEMO payload. This pixel decoder does not grant device ownership or replace the future authenticated BE-06 client adapter.
