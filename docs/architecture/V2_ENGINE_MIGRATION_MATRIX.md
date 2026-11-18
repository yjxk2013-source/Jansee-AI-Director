# V2 to V4 Engine Migration Matrix

Date: 2026-11-16

## Scope and method

Compared the V2 packages and modules directories against the corresponding V4 directories, excluding node_modules, generated dist, and cache folders. This is a source-file presence/content comparison, not a claim that every V2 workflow is already callable in V4.

## Source migration result

| Area | V2 files | V4 files | Missing in V4 | Byte-identical | Different | V4-only |
|---|---:|---:|---:|---:|---:|---:|
| packages | 74 | 86 | 0 | 66 | 8 | 12 |
| modules | 23 | 23 | 0 | 20 | 3 | 0 |

All V2 source files found under packages and modules have corresponding files in V4. The differences inspected so far are predominantly V4 workspace/dependency exports and compatibility changes:
- image-film: supports director-controlled ending and subtitle switches.
- video-dub: supports director-controlled intro, ending, and subtitle switches; fixes duration handling when subtitles are disabled.
- video_creator/storyboard.js: adds aspect-ratio canvas selection and silent-audio normalization.
- visual_engine_v4/imageFilm.js: accepts subtitle and CTA switches.
- audio-kit: resolves BGM assets from V4 materials paths and exports ducking filter helper.
- anchor-kit: removes the ending-kit dependency for deterministic seed generation.
- package manifests: add V4 workspace exports/dependencies.

## Migrated V2 packages

- anchor-kit
- audio-kit
- ending-kit
- ffmpeg-kit
- image-film
- intro-kit
- publish-kit
- shared
- speech-cut
- subtitle-kit
- tts-kit
- video-dub

## Migrated V2 modules

- modules/video_creator (including ASR, audio, speechcut, storyboard, slicer and related helpers)
- modules/visual_engine_v4

## V4 production call-chain status

| V2 capability | V4 source present | V4 production path | Status |
|---|---|---|---|
| Image film | Yes | renderer.ts to @jansee/image-film when Tencent TTS is configured | Connected through unified Engine Registry ? renderer adapter; production TTS credentials still required |
| Video dubbing | Yes | renderer.ts to @jansee/video-dub | Connected through unified Engine Registry ? renderer adapter |
| Storyboard composition | Yes | worker.ts to Engine Registry to engine-adapters.ts to @jansee/video-creator | Connected through unified Engine Registry ? storyboard adapter |
| TTS | Yes | Consumed by image-film/video-dub/storyboard paths | Connected in code; real Tencent API not yet verified |
| BGM selection/ducking | Yes | Consumed by the above engines | Connected in code; production asset path/library still needs deployment verification |
| Intro / ending / subtitles / AI provenance | Yes | Consumed by the above engines | Connected in code; visual output still needs full E2E review |
| Anchor selection | Yes | director.ts to @jansee/anchor-kit | Partially connected; verify selected voice/anchor maps correctly for each engine |
| Speech-cut / spoken-video refinement | Yes | Package and module are present, but no V4 API/worker/UI workflow invokes the V2 two-stage analyze, user-confirm, produce flow | Not integrated |
| Publish-kit compliance and publish package | Yes | worker.ts calls sanitizePublish after rendering, persists sanitized caption/cover title/pinned comment/post time in directorPlan; GET /api/v1/jobs/:id returns directorPlan | Integrated in worker; client presentation/copy actions still need E2E review |

## Important architecture gaps

1. Speech-cut is not a simple FFmpeg filter. V2's mature flow performs word-level ASR, detects redundant words and long pauses, lets the user confirm deletion markers, validates those markers against server-owned ASR results, then cuts audio/video synchronously and remaps subtitles. V4 currently has no equivalent confirmation workflow. Automatically deleting detected words without a user review stage would weaken the V2 safety contract, so this must be implemented as a Director-led review step rather than silently enabled.
2. Publish-kit is called by worker.ts after successful rendering. The sanitized publish fields are persisted in directorPlan and returned by GET /api/v1/jobs/:id. The remaining task is to verify the completed-job UI presents these fields clearly and supports copying them.
3. Engine Registry now registers all three creation modes. Image-film and video-dub use renderer adapters; storyboard uses the dedicated ASR/storyboard adapter. The Worker resolves the registry for all standard creation jobs. Explicit video slicing remains a specialized operation branch because it returns multiple deliverables.
4. V2's old web server/BFF is not the V4 architecture. Its routes, in-memory task records, legacy billing and upload-path assumptions should not be copied wholesale. Rebuild the required workflows using V4 auth, persisted jobs, storage and billing contracts.
5. Source presence is not production readiness. Real DB migrations, Tencent TTS credentials, media-library availability, real payment provider and deployed storage remain separate production integration tasks.

## Recommended next implementation order

1. Verify the unified registry with real media fixtures and ensure operation-specific capabilities (video slicing and keep-original) compose correctly.
2. Verify the completed-job UI exposes the sanitized publish package and copy actions.
3. Build the V2 speech-cut two-stage review workflow on V4 persisted jobs: ASR analysis, user-confirmed deletion markers, then produce. Do not auto-delete words without explicit user confirmation.
4. Add package-level integration tests for V4 workspace imports and end-to-end tests for each production mode.
5. Only then perform real provider/storage/database integration and deployment readiness review.

## Safety

- V2 source directory was inspected read-only and not modified.
- V4 remains on feat/v4-admin-director-console.
- No commit, deployment, production DB operation, or production data mutation was performed.



## 2026-11-16 execution update

- The production Engine Registry now has renderer adapters for `image-film` and `video-dub`, plus the dedicated `storyboard` adapter. Worker dispatch resolves the registry for standard creation modes.
- Fixed-duration slicing is connected as an internal Director operation (`video-slice`), not a separate user-facing tool. It routes to V2 `prepareSlicer` / `composeSlicer`, produces multiple MP4 outputs, stores each output independently, and runs Auto-QC on every deliverable before publication. Current guardrails: source video up to 20 minutes, 5–120 seconds per segment, at most 20 outputs. It preserves source audio; subtitles invoke local Whisper only when enabled; BGM is skipped when disabled. It does not claim semantic/highlight selection and does not delete spoken words.
- Original-audio preservation is connected for single-video requests (`keep-original`) through the storyboard adapter and V2 `runKeepOriginalAsr` / `composeStoryboard` path. It keeps the source audio track and can apply subtitles, BGM, intro and ending according to DirectorPlan. If Whisper is unavailable, it keeps the source audio and does not invent captions.
- Speech-cut / filler-word removal remains intentionally unconnected: the V2 two-stage ASR → user review → confirmed deletion workflow still needs persisted review state and client confirmation UI. No automatic spoken-word deletion is enabled.
- Verification after these changes: `npm run typecheck` passed; `npm test` passed **98/98**. Worker integration tests exercise real FFmpeg media for fixed-duration slicing and single-video original-audio delivery.
- Development remains on `feat/v4-admin-director-console`; existing uncommitted work was preserved. No commit, deployment, production database operation or production data mutation was performed.
