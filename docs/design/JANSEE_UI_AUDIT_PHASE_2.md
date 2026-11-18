# JANSEE V4 UI Audit — Phase 2

Date: 2026-11-16
Status: In progress
Design baseline: `docs/design/JANSEE_DESIGN_SYSTEM.md`

## Scope reviewed

- Main AI Director shell: header, brand mark/wordmark, conversation stage, composer, attachment menu, navigation drawer.
- Account and login panel structure.
- Works panel structure and empty-state entry point.
- Credit center, membership/top-up cards, billing tabs and history states.
- Admin console structure and its dark operational surface.
- Shared responsive breakpoints and reduced-motion rules.

## Changes made

1. Raised mobile header actions (menu, works, account) to 44×44px touch targets.
2. Raised mobile composer attachment, voice and send controls to 40×40px.
3. Raised drawer and modal close controls to 44×44px.
4. Bounded mobile dialogs by the dynamic viewport height, enabled internal scrolling and overscroll containment, and accounted for device safe areas.
5. Tightened the narrow 320–380px header wordmark and credit-card layout to reduce collision risk.

## Findings retained for follow-up

- The consumer app is a single React shell with state-driven overlays, not separate routed pages. Visual verification must open each overlay state deliberately.
- Works, account/login, credit center and billing history depend on API responses. Empty, loading and failure states must be checked with both an authenticated API session and an unavailable API.
- Admin uses a separate operational component and must be reviewed at desktop and mobile widths; the CSS pass alone does not certify its information density.
- The current development mock-login switch is local-only and must never be used as production authentication.
- Do not modify unrelated pre-existing working-tree changes while finishing this audit.

## Verification record

- Web production bundle: passed after this phase's CSS changes.
- Full test suite: passed, 105 tests / 105 passed / 0 failed (62.79s).
- Scoped `git diff --check` for `AGENTS.md` and `apps/web/src/styles.css`: passed; Git emitted only a CRLF-to-LF normalization notice for the stylesheet.
- Local Vite development server responds with HTTP 200 at `http://127.0.0.1:5173/`.
- Manual screenshot verification of all overlay states and the 320px / 390px / 768px / 1024px / 1440px viewport matrix remains outstanding.
- Full repository typecheck/build is tracked separately; do not conflate a Vite-only web bundle build with a full monorepo build.

## Completion gate

This phase is complete only after the overlay states and responsive viewport matrix have been visually inspected, overflow and keyboard dismissal have been checked, and the test suite has a final result recorded.


## Phase 3 — visual QA and mobile admin corrections

### Changes

- Added mobile admin composition rules: two-column metric cards, stacked filters, scrollable tab strip, bounded body content, and smaller but readable metric typography.
- Added viewport-width containment for the consumer shell and narrow-phone copy.
- Reserved a mobile action rail for the consumer header and composer to protect primary actions from flex shrink.
- Kept the light consumer shell and graphite admin palette; no business logic or API contracts changed in this phase.

### Visual review

- Desktop consumer home: clean editorial hierarchy, centered brand identity, generous whitespace, calm composer; direction is consistent with the approved Gemini-like restraint.
- Desktop admin: dark graphite surface, legible navigation and filters, clear empty state; no neon treatment remains.
- Mobile admin: stacked header and compact metrics are improved, but the headless capture still shows the tab row wider than the visible viewport and does not reliably show the header action controls. Verify on a real browser/device before release.
- Narrow-phone home: the 320px headless capture still needs a real-device viewport check; Chrome CLI screenshot sizing did not provide a trustworthy device-emulation result for every breakpoint. Do not treat the screenshot as a certified 320 CSS-pixel test.
- Consumer Works/account/credit overlays: not all states could be opened and visually inspected in this pass. Empty/loading/error/populated states remain unverified.

### Verification

- Web Vite production build: passed after Phase 3 CSS changes.
- Independence check: passed; V4 has no V2 checkout/runtime gateway references.
- Full test suite: 109 total, 106 passed, 3 failed. All 3 failures are in existing deep Auto-QC tests (tests/auto-qc-deep.test.ts): corrupt-media decode rejection, long-black-segment detection, and subtitle time-window validation. No UI files are involved in those failures; investigate separately before release.
- Scoped diff check for apps/web/src/styles.css: must be rerun and recorded after the final stylesheet changes.
- Full monorepo typecheck/build: not rerun in this phase; prior known App.tsx speech-cut optional-property type issue remains a separate release gate.

### Release decision

**Not yet launch-ready.** The visual direction is established and the desktop consumer/admin surfaces are coherent, but launch sign-off is blocked by:
1. Real mobile verification of the home header/composer, admin close action and tab navigation.
2. Visual review of Works, account/login, credit center and billing history overlays.
3. Resolution or explicit triage of the three failing deep Auto-QC tests.
4. A clean full monorepo typecheck/build and final diff check.

Do not deploy or claim final design acceptance until these gates pass.

## Phase 4 — navigation drawer hierarchy correction

### Issue identified
- The two bottom navigation actions each used margin-top: auto as independent flex children. This distributed free vertical space unpredictably and visually detached the actions from each other.
- The actions were styled as separate bordered cards, making them compete with the primary conversation navigation.

### Changes
- Grouped “我的作品” and “算力余额” inside one semantic utility-links region.
- Anchored that group as a single unit at the bottom of the drawer with one quiet divider.
- Restyled both actions as consistent, flat navigation rows with aligned 18px icons and 44px touch height.
- Made the recent-conversation section the flexible, internally scrollable region so a long history cannot push bottom actions off-screen.
- Reduced drawer header and section spacing and kept safe-area padding on mobile.
- Did not change navigation destinations, auth state, balance data, or any API behavior.

### Verification
- npm --prefix apps/web run build: passed (Vite production bundle).
- git diff --check -- apps/web/src/App.tsx apps/web/src/styles.css: rerun after trimming the extra blank line at the end of App.tsx.
- Current branch remains feat/v4-admin-director-console.
- No commit, push, deployment, or V2 changes.
- The drawer received browser DOM verification at 320, 390, 768, and 1440 CSS px in Phase 4. Screenshot-based visual sign-off and real-device touch verification remain outstanding.

## Phase 4 — Navigation drawer hierarchy refinement

- Removed the redundant drawer title so the menu no longer spends a full row repeating the conversation context.
- Tightened the sequence to: close control, primary new-conversation action, recent conversations/search, then a separated bottom utility group for My Works and credit balance.
- Replaced the oversized pill treatment with a restrained full-width neutral action; recent rows and utility links now share consistent alignment, icon sizing, and compact row rhythm.
- Kept the utility group bottom-anchored while the conversation section owns the flexible scroll area.
- Browser DOM verification with the drawer open at 320, 390, 768, and 1440 CSS px: drawer width 282/304/304/304 px respectively; no document horizontal overflow; utility group remained bottom-anchored; no drawer vertical overflow at 900 px height.
- npm --prefix apps/web run build: passed.
- git diff --check -- apps/web/src/styles.css apps/web/src/App.tsx: passed (only the existing CRLF normalization notice for styles.css).
- No API, persistence, or generation behavior changed. No commit, push, or deployment performed.
## Phase 4 — Navigation drawer hierarchy refinement

- Removed the redundant drawer title so the menu no longer spends a full row repeating the conversation context.
- Tightened the sequence to: close control, primary new-conversation action, recent conversations/search, then a separated bottom utility group for My Works and credit balance.
- Replaced the oversized pill treatment with a restrained full-width neutral action; recent rows and utility links now share consistent alignment, icon sizing, and compact row rhythm.
- Kept the utility group bottom-anchored while the conversation section owns the flexible scroll area.
- Browser DOM verification with the drawer open at 320, 390, 768, and 1440 CSS px: drawer width 282/304/304/304 px respectively; no document horizontal overflow; utility group remained bottom-anchored; no drawer vertical overflow at 900 px height.
- npm --prefix apps/web run build: passed.
- git diff --check -- apps/web/src/styles.css apps/web/src/App.tsx: passed (only the existing CRLF normalization notice for styles.css).
- No API, persistence, or generation behavior changed. No commit, push, or deployment performed.
## Phase 5 - Account, works, and credit center refinement

### Findings and changes
- Corrected the login form inputs, which had white text on a translucent dark background inside the white panel. Inputs now use a white surface, dark readable text, neutral border, and neutral visible focus ring.
- Reserved a clear top offset for the credit-center tabs so the final tab no longer collides with the panel close control.
- Simplified the Works empty state: removed the dashed file-drop-zone treatment because this is a gallery, not an upload target; retained the clear start-new-creation action.
- Removed the retired purple accent from credit quantity and featured-plan surfaces; descriptions now meet the 12px helper-text baseline.
- Updated the design system with reusable panel-form, gallery-empty-state, and billing-navigation rules.
- No React business logic, API, authentication, billing, or persistence behavior was changed.

### Browser verification
- Login panel opened in local development preview and checked at 320, 390, 768, and 1440 CSS px. Inputs computed to white backgrounds and dark primary text; no page horizontal overflow.
- Credit center checked at 320, 390, 768, and 1440 CSS px. Close control and tabs have no bounding-box overlap; purchase controls are consistent within each breakpoint (88x38 at 320, 92x38 at 390, 112x40 at 768/1440); page horizontal overflow not detected.
- Works empty state checked at 320, 390, and 1440 CSS px. Empty-state bounds and primary action remain inside the panel; Escape closes the panel and drawer overlay.
- Web production build: passed after changes.
- V4 independence check: passed.
- Scoped git diff --check for App.tsx and styles.css: passed; Git only reports the stylesheet CRLF normalization notice.
- These are local browser DOM/layout checks, not real-device touch certification. Authenticated production data, populated works gallery, real payment provider flow, and transaction history with real records remain unverified.
- No commit, push, deployment, or V2 modification performed.
## Phase 6 - Admin accessibility and engineering gate

### Admin refinement
- Increased desktop admin icon controls from 32px to the design-system 36px baseline.
- Increased mobile admin header icon controls from 36px to 40px and reserved 90px for the action rail so the brand text cannot collide with refresh/close controls.
- Added explicit accessible names to refresh and close icon buttons.
- No Admin API, data, compensation, or authorization behavior changed.

### Engineering verification
- `npm run build`: passed (workspace typecheck, Vite production build, API TypeScript build).
- `npm test`: 120 tests passed, 0 failed. This includes the three previously failing deep Auto-QC cases.
- `npm run check:independence`: passed; no V2 checkout/runtime gateway references found.
- `git diff --check`: reported pre-existing trailing blank lines in `apps/api/migrations/0002_add_phone_to_users.sql`, `apps/web/public/sw.js`, `packages/sms-kit/index.js`, and `packages/sms-kit/package.json`; no whitespace errors were reported in the Admin files touched in this phase. CRLF normalization notices are present in the working tree.

### Remaining release gates
- Browser-based visual and interaction verification of Admin at 320, 390, 768, 1024, and 1440 CSS px was not completed: the isolated headless Chrome/CDP session did not expose a debuggable page in this environment. Do not treat CSS source review as visual sign-off.
- Authenticated production records, populated Works playback/expiry, live payment-provider checkout/webhook, database migration against the target PostgreSQL instance, object-storage credentials and signed media URLs, worker restart/recovery, and production readiness remain unverified.
- No commit, push, deploy, production data changes, or V2 modifications were performed.

## Drawer utility row correction
- Restored explicit full-width, stacked rows for “我的作品” and “算力余额”. Each action spans the drawer content width and retains its own full-row click target; they are not compressed into a two-column or compact chip layout.
- Kept the shared bottom utility group, divider, icon/text alignment, and existing navigation handlers.
- This correction changes layout only; no data, API, or business logic changed.

### Drawer icon consistency
- Replaced the two utility icons' filled SVG rendering with consistent unfilled 1.6px outline strokes and rounded joins/caps, matching JANSEE's line-based logo language.
- The full-row layout and existing navigation actions are preserved.


## Phase 7 - Final visual refinement pass

### Visual corrections
- Kept the Works and credit-balance drawer actions as independent full-width rows; removed the browser-default filled button surface, made the resting surface transparent, and aligned both rows to a 44px touch height.
- Changed the composer invitation to a shorter natural-language placeholder so it stays on one line at 320 CSS px without crowding the voice and send controls.
- Added vertical separation to the mobile Admin tab strip so it clears the fixed refresh/close action rail.
- Updated the design-system rules for drawer row dimensions, outline icon consistency, narrow composer copy, and mobile Admin header spacing.

### Browser visual checks
- Consumer home: inspected screenshots at 1440, 390, and 320 CSS px. The centered brand, left-aligned editorial welcome message, and bottom composer remain balanced; the 320px composer placeholder now fits on one line.
- Consumer responsive DOM checks at 1440, 1024, 768, 390, and 320 CSS px: document width equals viewport width at every size; composer action controls remain inside the dock; no horizontal overflow detected.
- Navigation drawer at 320 CSS px: both utility rows span the available drawer width, each is 44px high, both icons render as unfilled outline strokes, and the page has no horizontal overflow.
- Login panel at 320 CSS px: panel and input fields remain within the viewport; inputs retain white surfaces and dark readable text.
- Works panel at 390 CSS px: centered panel, clear close affordance, readable empty state, and full-width primary action.
- Credit center at 390 CSS px: close control clears the tabs; purchase buttons are consistently 92x38px; panel content scrolls internally; no page horizontal overflow.
- Admin console: inspected desktop at 1440 CSS px and mobile at 390 CSS px. Mobile tab strip now clears the refresh/close controls. DOM checks at 1440, 1024, 768, 390, and 320 CSS px show no document horizontal overflow and no tab/action overlap.

### Scope and remaining visual limits
- This phase changed visual CSS and one composer placeholder only. No product behavior, API, or business logic was changed.
- Authenticated populated Works states, live media thumbnails, and real-device touch/gesture behavior were not available in this local visual pass and are not claimed as verified.
- No commit, push, or deployment performed.


## Account center: collapse existing feature sections

- Kept the existing account center content and feature set unchanged; no new sections, cards, metrics, or account concepts were introduced.
- Converted the three existing growth feature sections (daily check-in, invite/referral, and city partner) into native disclosure panels, collapsed by default.
- Preserved each section's existing heading, reward/status label, description, controls, data, and handlers. Users expand only the section they want to inspect or use.
- Added a restrained outline chevron that rotates when expanded and respects reduced-motion preferences.
- `npm run build` passed after the change. Full test run progressed through test 136; the runner had not yet emitted its final TAP summary at the time of this audit.
