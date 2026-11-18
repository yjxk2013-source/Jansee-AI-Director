# JANSEE V4 Design System
Version: 1.0
Status: Normative
Applies to: JANSEE V4 Web / PC / Mobile Web / PWA / Admin

> This document is the source of truth for all new and changed JANSEE V4 interfaces. Every AI agent, engineer, designer, and contractor must read it before creating or modifying UI. If an implementation conflicts with this document, follow this document unless the product owner explicitly approves an exception.

## 1. Product and experience principles

JANSEE is an **AI Director system**, not a traditional video editor, timeline editor, template marketplace, or toolbox.

The interface must communicate a capable creative director that understands natural-language intent; a calm, premium, trustworthy product worth paying for; a simple conversation-led workflow; and finished creative output as the hero rather than the machinery that produced it.

Priorities: clarity and task completion; consistency; restraint and visual quality; accessibility and responsive behavior; decoration only when it adds meaning.

Do not expose internal engines, FFmpeg stages, model names, queues, or implementation details in ordinary user workflows unless genuinely necessary.

## 2. Visual direction

Reference direction: Gemini-like conversational simplicity, Apple-like restraint and typographic precision, with JANSEE's own identity. References are directional, not permission to copy logos, exact layouts, or proprietary assets.

The interface is light, neutral, quiet, spacious, editorial, precise. It relies on typography, spacing, alignment, and hierarchy rather than decorative containers.

It is NOT neon cyberpunk, gaming UI, sci-fi HUD, purple-gradient-first, rainbow, glassmorphism-heavy, saturated, emoji-led, or a miniature desktop squeezed onto a phone.

## 3. Color tokens

Use CSS custom properties in `apps/web/src/styles.css` as the implementation source. Do not introduce one-off colors when a token exists.

| Token | Value | Use |
|---|---|---|
| Canvas | `#FFFFFF` | Main background |
| Surface subtle | `#F7F7F5` | Secondary surface |
| Surface raised | `#FFFFFF` | Panels and popovers |
| Text primary | `#202124` | Headings and key content |
| Text secondary | `#5F6368` | Body copy |
| Text muted | `#80868B` | Metadata |
| Border | `#E5E7EB` | Separators |
| Border subtle | `#F0F1F2` | Quiet dividers |
| Action | `#252629` | Primary actions |
| Action hover | `#111214` | Primary hover |
| Focus | `#6B7280` | Keyboard focus |
| Success | `#26734D` | Success only |
| Warning | `#946B22` | Pending / caution only |
| Danger | `#B54747` | Error / destructive only |

Neutral monochrome is the default. Color communicates state, not decoration. Green, amber, and red are semantic only. Avoid purple as default action color or large background. Existing purple should be removed when components are next touched. Never use low-contrast gray text on white. Do not communicate status through color alone.

## 4. Typography

Font stack: `"DM Sans", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

- Use system fonts; no remote font dependency without approval.
- Body: 14–16px desktop, 14–15px mobile.
- Helper text: 12–13px; avoid below 11px except dense metadata.
- Panel heading: 20–28px, weight 550–650.
- Hero: 36–48px desktop; 29–36px mobile.
- Prices, credits, durations, counts use tabular numerals.
- Restrained weights; avoid excessive bold and all-caps labels.
- Chinese letter spacing must remain natural.
- Body line-height 1.5–1.75; headings 1.2–1.4.

## 5. Spacing, layout, surfaces

Use an 8px base rhythm. Preferred steps: 4, 8, 12, 16, 24, 32, 40, 48, 64.

- Align content to a clear grid; align repeated edges.
- Main reading / conversation column: target 760–880px maximum.
- Header is quiet and compact.
- Use whitespace before borders or cards.
- Prefer a divider or subtle surface shift over nested cards.
- Radius: 8px controls, 10–14px cards, 16–20px large overlays.
- Borders are 1px and low contrast.
- Shadows are rare and subtle, reserved for overlays.
- Avoid gradient page backgrounds, glowing shadows, thick outlines, and excessive blur.
- Do not turn every section into a rounded rectangle.

## 6. Buttons and controls

Same-role controls share dimensions, typography, radius, and states.

Primary: dark neutral solid, white text; 40px standard height, 44–48px prominent/touch-first; 16–20px horizontal padding; 8–10px radius. Prefer one primary action per region.

Secondary: white/subtle neutral surface, 1px neutral border, same height as adjacent primary, no decorative shadow.

Icon button: 36–40px square desktop; aim for at least 40px touch target mobile. Center SVG; consistent 1.75–2px stroke. Accessible name and visible focus required.

Hover is subtle; active is clear; disabled remains readable; loading preserves dimensions. Never remove focus indication. Never use emoji as UI icons.

## 7. AI Director home and conversation

Home priorities: JANSEE identity and minimal navigation; concise creative invitation; one obvious conversation composer.

Keep top bar quiet. Works and account access must not compete with the composer.

Composer: one dominant calm input; attachment, voice, send aligned; no extra toolbars, mode selectors, or settings without a demonstrated user need; readable text area; mobile respects `env(safe-area-inset-bottom)`.

Conversation: distinguish user/director through alignment and subtle surfaces, not saturated bubbles. Director responses are scannable. Plans and progress feel like a director communicating, not an operations dashboard. Clearly distinguish queued, processing, completed, failed and explain recovery. The finished video is the visual hero.

## 8. Upload and media

The add control presents a clear choice between image upload and video upload. Preview selected assets, preserve aspect ratio, and show filename/size only when useful. Reorder, remove, replace are discoverable and accessible. Never crop or cover user product media for decoration. Consistent ratios within a collection. Design empty, loading, error, and populated states.

## 9. Works / output gallery

Treat generated work as a portfolio/gallery, not a file manager. Thumbnail leads; metadata is secondary. Consistent thumbnail ratio; preserve original video when opened. Concise titles; duration and creation time are quiet. Secondary actions belong in a restrained overflow menu. Expired/deleted work must not appear playable or remain as a misleading live item. Design all empty/loading/error/populated states.

## 10. Billing, credits, account

Billing is trust-critical.

- Show balance and unit clearly; explain consumption in plain language.
- Separate recurring membership and one-time top-ups with labels, not radically different visual styles.
- Every purchase button in a comparison group has exactly the same width and height on PC and mobile.
- Align price, old price, credits, and included usage across plans.
- Use tabular numerals.
- Only one plan may receive recommendation treatment; subtle border/text label only, never a glowing card or large colored badge.
- State renewal, expiry, legal, and payment-channel facts explicitly. Never imply an unavailable payment method is live.
- Order history and ledger use consistent alignment, labels, and empty states.
- Never obscure errors or payment limitations with decoration.

## 11. Admin console

Admin may use a denser operational surface, but remains in the same design family: neutral graphite/charcoal or light neutral surfaces, restrained contrast, one restrained accent for active navigation/selected data. No neon glow, ornamental cyberpunk frames, gradients, or sci-fi effects. Metrics align and use tabular numerals. Tables prioritize scanability and truthful status. Confirm destructive/high-impact actions. Admin density must not leak into consumer UI.

### 11.1 Mandatory admin text-contrast standard

- On every light/white admin surface, all visible text must use dark, high-contrast colors. This is a permanent rule, not a per-screen preference.
- Primary text, headings, metric values, counts, percentages, and durations: `#202124` (or darker).
- Secondary labels and explanatory copy: `#505861` to `#5F6368`.
- Muted metadata may use `#68717B`, but must remain clearly readable; never use pale gray text on white or near-white backgrounds.
- Metric values must be visually stronger than their labels and use tabular numerals.
- When a dark component is placed on a light admin page, explicitly define its surface and text colors together. Do not inherit pale text intended for a dark surface.
- Before closing any admin visual task, inspect all text roles against the actual rendered surface. If contrast is uncertain, choose the darker token.
- This standard applies to existing and future admin pages, cards, summaries, charts, tables, helper notes, empty states, and responsive layouts.

## 12. Responsive rules: PC and mobile

PC and APP/PWA share capabilities, labels, workflows, and visual identity. Only layout and input ergonomics differ.

- Design mobile deliberately, not as compressed desktop.
- Follow content pressure; current conventions use 760px and 560px where appropriate.
- Prevent horizontal overflow at 320px.
- Respect device safe areas.
- Aim for 44px touch targets.
- Mobile dialogs fit viewport, scroll internally, keep primary action reachable.
- Long labels/prices wrap or truncate intentionally.
- Verify at 1440px desktop, 1024px tablet landscape, 768px tablet, 390px mobile, and 320px narrow mobile.

## 13. Accessibility and interaction

Use semantic controls and landmarks. Every icon-only action has an accessible name. All controls are keyboard reachable with visible focus. Keep contrast WCAG AA where applicable. Respect reduced motion. Do not use color alone for status. Loading, empty, error, disabled, and success are first-class states. Preserve expected Escape/back behavior for overlays.

## 14. Motion

Motion is functional feedback, not decoration. Typical transitions 120–200ms ease-out. Avoid bounce, elastic movement, constant pulse, parallax, large transforms, and animations that move a target during interaction. Honor reduced motion.

## 15. Content and microcopy

Use clear natural Simplified Chinese by default. Short labels and action verbs. Explain value in user language, not internal engineering terms. Avoid repeated slogans, redundant descriptions, and decorative English labels. Use consistent terms for credits, membership, works, generation, and account. Never invent capabilities, guarantees, processing times, or payment status.

## 16. Prohibited patterns

Without explicit product-owner approval, do not introduce dominant purple/blue/pink gradients; neon/glow/glassmorphism-heavy/cyberpunk effects; emoji navigation; inconsistent same-role control dimensions; differently sized plan purchase buttons; repeated badges; unnecessary nested cards; tiny low-contrast helper text; excessive all-caps English; a new UI framework for a small styling change; or a second mobile design language.

## 17. Agent implementation protocol

Before UI work:
1. Read this file and root `AGENTS.md`.
2. Inspect actual component and responsive styles.
3. Identify all related PC/mobile states and shared components.
4. Reuse tokens and components.
5. Preserve business logic, API contracts, accessibility, and capability parity.
6. Do not reformat unrelated files or overwrite uncommitted work.

During implementation:
1. Prefer shared tokens/primitives over page-specific values.
2. Same-role controls have identical dimensions and states.
3. Include loading, empty, error, disabled, success.
4. Test mobile and narrow widths.
5. Avoid accumulating end-of-file CSS overrides; consolidate touched rules when safe.

Before completion:
1. Run relevant web build and focused tests.
2. Run `git diff --check`.
3. Inspect PC/mobile at section 12 viewport sizes.
4. Verify keyboard focus, contrast, overflow, and touch targets.
5. Report changed files, tests actually run, and unverified visual states.
6. Never commit, push, or deploy unless explicitly requested.

## 18. Design exception process

For a genuine exception, document the user problem, why existing tokens/components fail, affected screens/breakpoints, and how the exception stays in the JANSEE visual language. Obtain product-owner approval and update this document when a reusable pattern is approved.

## 19. Panel forms, gallery empty states, and billing navigation

- Login and account forms always use the same light neutral surface as the panel: white input backgrounds, primary text color, subtle neutral borders, and a visible neutral focus ring. Never place white input text on a white panel.
- Panel close controls reserve a clear exclusion zone. Tabs and primary content must never sit underneath or visually compete with the close target.
- Empty gallery states should be quiet and editorial. Prefer a small neutral icon, concise explanation, and one clear next action; avoid dashed drop-zone styling when the area is not an upload target.
- Billing plan purchase controls share identical dimensions within each breakpoint. Long billing content scrolls inside the panel, never the page; tabs remain clear of the close control.
- Status colors are semantic only. Plan names, credit quantities, descriptions, and purchase actions use neutral typography and surfaces by default.
## Icon language consistency
- The “我的作品” and “算力余额” drawer icons now use unfilled outline strokes (`currentColor`, 1.6px, rounded caps/joins), matching the JANSEE line-based logo and the interface's outline icon language.
- Their full-width stacked rows and click behavior remain unchanged.


## 20. Drawer utility rows and narrow composer

- The drawer's Works and credit-balance utilities remain two separate, full-width stacked rows. Each row is borderless, transparent at rest, left-aligned, and at least 44px high; hover uses only a quiet neutral surface.
- Utility icons use unfilled outline SVGs with `currentColor`, consistent 1.6px strokes, and rounded caps/joins. Do not mix filled and outline icons within the same navigation system.
- The composer placeholder must remain concise enough to fit on one line at 320 CSS px while preserving the natural-language invitation.
- On narrow mobile admin layouts, reserve clear vertical separation between the header action rail and the tab strip; neither may overlap the other.
