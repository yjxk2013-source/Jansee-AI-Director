# JANSEE V4

**简兮 JANSEE — AI Director System**

V4 is a clean, independent product and engineering repository. It is not a branch or patch layer over V3.

## Product contract

PC and APP expose the same two creation functions and business workflows:

1. **出片流 (AI-director production)** — the user picks one of three creation scenes, supplies source material and a plain-language intent, and the AI Director plans the production and delivers a finished short video. The scenes are 带货视频 (`online-ecommerce`), 门店获客 (`physical-store`), and 个人创作 (`personal-creation`). 个人创作入口免费，不消耗积分；带货视频与门店获客按成片计费。
2. **一句话剪辑 (natural-language editing)** — the user describes an edit in one sentence and the system runs it through local deterministic controls (slice, keep-original, speech-pause fine-cut). This path is free and skips the multi-role LLM director loop.

Both functions are backed by three shared production engines / creation modes:

- **图片成片** (`image-film`) — product or scene photos into a complete short video.
- **视频配音** (`video-dub`) — one source video into a polished video with director-led voiceover, subtitles, music, and finishing.
- **多视频分镜合成** (`storyboard`) — multiple clips arranged into one coherent short video.

The clients share the same capability catalog, API contracts, identity, assets, projects, job states, and delivery model. Responsive presentation is allowed; capability divergence is not.

## Engineering principles

- Independent V4 monorepo and release lifecycle.
- Domain-driven boundaries; contracts shared by every client.
- API-first design, typed boundaries, schema validation, and explicit job state transitions.
- PostgreSQL as the durable system of record; object storage for media. Database, queue, and object-storage adapters are selected and threat-modelled for production.
- Jobs must be idempotent, bounded, observable, cancellable, and tenant-isolated.
- Production secrets are injected through environment/secret management and never committed.
- No V3 source is copied without source/dependency/security/license review.

## Repository layout

```
apps/
  web/          Responsive PC + APP client (PWA)
  api/          HTTP boundary, auth, director, job queue and render worker
packages/
  contracts/    Shared runtime schemas and API contracts
  domain/       Framework-independent business rules
  */            Audited media kits (image-film, video-dub, speech-cut, tts,
                subtitle, audio, intro, ending, ffmpeg, publish, etc.)
modules/
  visual_engine_v4/  Image-film visual engine
  video_creator/     ASR, slicing, keep-original, storyboard
deploy/
  Production Docker Compose, Nginx, env template and release checklist
docs/
  architecture/ Architecture decisions and system design
  product/      Product behavior and interaction rules
```

## Runtime workflow

1. The client uploads source files through POST /api/v1/assets.
2. The director analyzes the prompt and uploaded asset metadata through POST /api/v1/director/plan and returns a structured plan. The client then immediately submits POST /api/v1/jobs; progress is reported in the conversation. The earlier explicit "确认方案并开始制作" confirmation step has been removed — sending the request produces both the plan and the render job.
3. The PostgreSQL job queue and worker claim the job, run the selected media engine, render with FFmpeg, perform Auto-QC, and publish the MP4 to the user's works library.
4. Uploaded source assets and generated outputs follow the configured retention/cleanup policy (the current default is 24 hours).

## Local development

For one-command local startup on Windows, run `npm run dev:local` from this repository. It starts (or reuses) the project-local PGlite database, the API plus render worker, and the Vite web client as background Node processes. It verifies database/API/worker readiness and the frontend proxy before returning. Logs are written to `.local/logs`; the processes remain running after the command returns.

The restored local V4 database is stored under `.local/pglite/data-recovered-20261117` and was rebuilt from the verified V2 production snapshot dated 2026-11-17. The previous local database and pre-recovery copies are retained separately; do not delete them until the restored database has been validated by the user.


Requires Node.js 22+ and npm 10+.

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm run start:api:local
npm run dev:web
```

The API requires a reachable PostgreSQL-compatible database and a writable local media directory. On the current Windows workstation, a persistent PGlite 18.6 compatibility database is staged under the ignored .local/pglite directory; start it in a separate terminal with npm run db:local before running migrations/API. PGlite is for local development only and is not a production PostgreSQL replacement. For production, use the supported native PostgreSQL service and production storage configuration.

Web: http://127.0.0.1:5173

API liveness: http://127.0.0.1:4100/health/live

API readiness: http://127.0.0.1:4100/health/ready (requires a healthy database and an active worker).

Local development may use mock SMS (`JX_AUTH_TEST=1`, code `123456`) and simulated payment (`PAY_SIMULATE=1`) for UI/testing. These are development-only conveniences. In production the real Aliyun dypnsapi SMS channel and the OPCPAY (一人付) Alipay gateway with webhook verification are configured; mock SMS is rejected at startup and payment simulation is off. The production environment template is `deploy/.env.production.example`.

The responsive Web client is also the shared installable PWA experience. PC and APP use the same UI code, creation modes and API contracts; only layout adapts to screen size. The service worker caches the static shell and frontend assets only, and excludes API, authentication, upload and media routes.

## Deployment

V4 runs in production as a single-server Docker Compose stack (`deploy/docker-compose.v4.yml`): native PostgreSQL 16 with a named data volume, the API/render worker, and host Nginx terminating HTTPS for `jansee.cn` and `admin.jansee.cn`. Production configuration is templated in `deploy/.env.production.example`; all secrets (Postgres, director LLM, Tencent TTS, Aliyun SMS, OPCPAY, partner-payout encryption) are injected at deploy time and never committed. See `deploy/V4-SINGLE-SERVER.md` and `deploy/V4-CLEAN-SERVER-RELEASE-CHECKLIST.md` for the server topology and release procedure.

## Current milestone

**Production release.** The independent V4 repository now runs the full authenticated upload/API flow, director planning, job queue/worker, FFmpeg renderer, Auto-QC, output delivery, storage adapters (local and COS), and production guards against a native PostgreSQL database. Real Aliyun SMS authentication, the OPCPAY (一人付) payment gateway with signed webhooks, and production secrets are configured; the single-server Docker/Nginx deployment has been verified. The two creation functions (出片流 across three scenes, and 一句话剪辑) are available on PC and APP through the same contracts.

Release artifacts and operational docs live in `deploy/`. Keep production secrets, user data and generated media out of the repository.

## Team & Contributors (团队协同治理)

JANSEE V4 是一个由工程团队分布式协作研发的企业级 AI 导演系统。分工与模块职责以仓库现有工程治理文档为准。

- **Project Lead & Core Contributor**: [YJXK](https://github.com/yjxk2021) (`yjxk2021@gmail.com`) — 系统架构治理、体验一致性与商业化闭环
- **Chief Architect & Systems**: JANSEE Architecture (`admin@jansee.cn`) — 基础设施、后端服务与异步渲染管线
- **Visual Design & Audio/Video Labs**: JANSEE Design & Media Teams — 黑曜石设计系统与微光音视频渲染算法

