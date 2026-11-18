# V2 → V4 Capability Migration Ledger

## Product boundary

JANSEE V4 is a standalone product. V2 is a read-only source of proven business capabilities and media assets; no V4 runtime, build, test, or deployment step may require the V2 checkout to exist.

Do not copy the V2 web/admin/mobile applications or old production secrets/configuration into V4. Reuse proven business modules, reusable media resources, algorithms, and tests; adapt their boundaries to V4 contracts, storage, queue, and deployment.

## Migration rules

- Keep all work on the current non-main V4 branch.
- Preserve pre-existing uncommitted changes; never reset, clean, or overwrite them.
- Never modify V2 or deploy to production during migration.
- Every migrated capability needs: V4-owned source, V4-owned dependencies, V4 configuration, tests, and an end-to-end output contract.
- No hard-coded V2 filesystem paths, old hostnames, production SSH endpoints, or secrets.
- Large runtime assets (Whisper models, licensed audio, fonts) must have explicit provisioning, checksums/licensing, and deployment-volume instructions; do not silently omit them from release packaging.
- No fake visual understanding: LLM receives user text and file metadata only. Whisper is audio transcription, not image/video visual recognition.

## Capability inventory

| Capability | V2 source | V4 source status | V4 product integration |
|---|---|---|---|
| Image film / image-to-video | packages/image-film, modules/visual_engine_v4 | Copied; V4 package exists | Renderer branch exists; verify real assets/TTS |
| Video dubbing | packages/video-dub | Copied; V4 package exists | Renderer branch exists; verify real TTS/audio |
| Multi-video storyboard | modules/video_creator/video/storyboard.js | Copied; V4 module exists | Dedicated engine adapter and silent-audio test |
| Fixed-duration slicing | modules/video_creator/video/slicer.js | Copied and V4-adapted | Director operation dispatches fixed-duration slicing; worker persists each resulting MP4 as a separate work record |
| Speech-aware slicing / local ASR | modules/video_creator/asr, slicer.js | Source copied; local runtime provisioned separately | Optional ASR can prepare captions; user-facing subtitle correction/confirmation stage remains pending |
| Keep-original / speech cleanup | modules/video_creator/video/keepOriginal.js, asr/trim.js | Copied | ASR used by storyboard; standalone edit flow pending |
| Speech pause/filler cleanup | modules/video_creator/asr/trim.js, packages/speech-cut | Copied | Needs explicit V4 operation and tests |
| TTS | packages/tts-kit | Copied | Used by image-film/video-dub; production credential and provider tests pending |
| BGM emotion selection / ducking | packages/audio-kit | Copied | Used by render paths; inventory and fallback tests pending |
| Subtitle layout / timed subtitles | packages/subtitle-kit | Copied | Used in render paths; cross-mode verification pending |
| Intro / cover | packages/intro-kit | Copied | Used by storyboard and render paths; cross-mode verification pending |
| Ending / CTA | packages/ending-kit | Copied | Used by storyboard and render paths; cross-mode verification pending |
| FFmpeg probe / concurrency / quality | packages/ffmpeg-kit | Copied | Partially used; production resource/quality checks pending |
| AI provenance mark / metadata | packages/subtitle-kit | Copied | Some paths use it; verify all output modes |
| Publish copy / title / pinned comment | packages/publish-kit | Copied | Not yet integrated into V4 post-production response |
| Anchor/persona selection | packages/anchor-kit | Copied | Used by director planning; validate user-facing behavior |
| Material library | materials | 339 files previously counted in both trees | Compare hashes, licensing, and required runtime subset before release |

## Runtime assets

Whisper model and platform executables are provisioned under `whisper.cpp/` for local development. The Windows binaries are not Linux production binaries. Production deployment must build/provide a Linux `whisper-cli` and mount the model at the configured path. Keep the model and native executables out of Git; publish them as versioned runtime artifacts with checksums and provisioning instructions.

## Release gates

1. Inventory source files, manifests, dependencies, resources, licenses, and V2-only references.
2. Make every package resolve only from V4 workspaces or declared external dependencies.
3. Replace old V2 runtime assumptions with V4 environment/configuration/storage.
4. Add director operations and worker dispatch for all supported creation/editing capabilities without adding unnecessary user-visible tool buttons.
5. Test each operation with generated and real sample media; verify MP4 streams, duration, dimensions, audio, subtitles, AI marks/metadata, and cleanup.
6. Verify Docker image starts the V4 API/web stack (never a V2 entrypoint), DB migrations, persistent storage, and Linux Whisper runtime.
7. Re-run typecheck, complete tests, production build, and clean-room deployment test from V4 alone.

## Current known blockers

- Director request and job schemas currently constrain modes to image-film, video-dub, and storyboard.
- Worker has a special dispatch only for storyboard; image-film and video-dub use renderer branches.
- Fixed-duration video slicing is now scheduled through the Director operation field and can persist multiple independent MP4 outputs. Speech-aware trim/filler removal still needs a user confirmation stage before it is exposed as an automatic operation.
- The current slicing output path supports BGM, optional Whisper subtitles, and AI provenance marking. Intro/ending parity and reliable ASR confidence/review controls still need end-to-end acceptance.
- Windows Whisper development binary and model are now present in the V4 checkout; Linux production binary remains a separately provisioned release artifact.
- The legacy `deploy/Dockerfile` still references the V2 web gateway. Use only `deploy/Dockerfile.v4` and `deploy/docker-compose.v4.yml` for V4; their image build and Compose validation remain outstanding because Docker CLI is unavailable on the connected machine.
- Real TTS provider, full real-media end-to-end, Linux runtime, concurrency, and clean-room deployment acceptance are not complete.


## Work completed in the current migration pass

- Provisioned the V2 Whisper Windows runtime bundle and ggml-small.bin into the V4-owned whisper.cpp/ directory. The model SHA-256 is `1BE3A9B2063867B937E64E2EC7483364A79917E157FA98C5D94B5C1FFFEA987B`.
- Added whisper.cpp/README.md documenting the Windows development runtime and Linux production runtime boundary.
- Added ignore rules for native binaries and the large model so they are shipped as versioned runtime artifacts rather than committed as source.
- Added scripts/check-v4-independence.mjs and npm run check:independence.
- Added a V4-specific deployment path: deploy/Dockerfile.v4, deploy/docker-compose.v4.yml, and deploy/nginx-v4.conf. This uses a dedicated V4 API process and static web container; it does not launch the V2 gateway.
- Added .dockerignore to keep secrets, local storage, native local runtime binaries, and build caches out of the image context.

## Validation from this pass

- npm run check:independence: passed.
- npm run typecheck: passed.
- npm test: 84/84 passed.
- npm run build: passed (web and API production builds).
- Docker CLI is not installed on the connected development machine, so the new V4 container build and Compose validation have not yet been executed.

## Source/resource parity audit

- All 74 V2 package source files and all 23 V2 module source files have matching relative paths in V4; no missing source files were found.
- 8 package files and 4 module files differ in content. These are the V4 adaptation points (workspace exports/dependencies, asset path integration, and the storyboard/image-film/video-dub migration changes); they require focused diff review rather than blindly overwriting with V2 originals.
- All 339 V2 material files have matching V4 relative paths and matching file sizes. Full cryptographic parity across the entire large media library was not completed because the hash pass was too expensive for the current remote session.


## Additional work completed after the first migration pass

- Added DirectorPlan operation routing for explicit video-slicing intent, including requested segment duration (5?120 seconds). The public conversation remains a single composer; this is an internal production operation, not a new UI tool.
- Connected the V2 fixed-duration slicer to the V4 worker. It produces separate MP4 outputs (up to 20 per job; source duration capped at 20 minutes) and persists each output as an independent work record under the same job.
- Added optional ASR to prepareSlicer so fixed-duration workflows can avoid Whisper when captions are disabled. The compose stage respects subtitle/BGM opt-outs.
- Fixed a migrated slicer defect where composeSlice referenced an out-of-scope taskDir instead of deriving the task ID from slicesDir.
- Added tests for Director slicing intent and a real FFmpeg-generated two-segment MP4 slicing/compose path.
- The slicer E2E smoke test generated two separate MP4 files successfully. This is a local synthetic-media test, not a production-media acceptance test.

## Review of the V2/V4 source differences

The comparison identified 12 source/manifest differences (8 package files and 4 module files). These are intentional V4 integration adaptations rather than wholesale replacement: package export maps were added for workspace imports; anchor-kit now owns its deterministic seed helper instead of depending on ending-kit; audio-kit resolves the V4 materials root and reads shared BGM defaults from the V4 domain package; image-film/video-dub respect Director packaging opt-outs; video_creator declares its internal workspace dependencies and exports; storyboard normalizes source audio/aspect ratio for V4; slicer supports optional ASR/subtitle/BGM controls; and visual_engine_v4 has V4-specific integration adjustments.

V4-only additions include the contracts/domain packages and sms-kit. They have no V2 counterpart and are not missing migrations. 