# PWA-LIVE-14–23 · local patch

Based on `01d5eba6c7693e38d2203a7d4ec749c79bffe6c2`; preserves the subscription backend baseline. Frontend only, no migrations/API changes, not deployed.

- Active-address sensor connection; automatic QR acceptance with tracked corners, bounded structured proofs, manual fallback, camera cleanup and final authoritative confirmation.
- Approved compact additional-address review and three-field inline editor; name preserved and hidden during editing; thoughtful pose; final save only on “Показати графік”.
- Empty street/house lists use parent-scoped cursor pagination on scroll; city still requires two letters. Database repair is deferred.
- Remove Options privacy summary and duplicate grid status note; reorder full legend; layer current-hour frame over segments and handle Kyiv date rollover/Home return.
- Full-body street mascot uses the user's complete costume reference and changed arm pose; form occludes the lower body.

Validation: 335 serial unit/model/SQL tests passed, then23 targeted checks after final CSS cleanup. Controlled browser:51 functional +42 layout +11 dates/focus +6 offline conditions, plus4 genuine jsQR canvas decodes. Both themes,320/360/414, text100/150/200%; document zoom surrogate tested separately. Actual Chrome zoom, physical phone camera/IME and screen readers remain unverified. No live writes, pushes or publication.

Workspace evidence: `work/pwa-next-20261105/QA.md` from the parent Світло workspace. Browser fixtures and rejected illustration attempts remain outside the product checkout.
