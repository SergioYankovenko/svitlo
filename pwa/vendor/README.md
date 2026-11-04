# Local QR decoder

`jsQR-1.4.0.js` is the pinned distribution of jsQR1.4.0 from https://github.com/cozmo/jsQR. The Apache2.0 license is retained in jsQR-LICENSE.txt.

The live scanner loads it locally on demand, bounds camera frames and accepts only explicitly confirmed structured server proofs. Camera frames are not uploaded. DEMO payloads are rejected. The decoder never grants ownership; the authenticated private server validates proof, membership and binding epoch. Viewer-invitation creation is deferred by the user; no QR generator or new invitation window is shipped.
