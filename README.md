# JANSEE V4

**简兮 JANSEE — AI Director System**

V4 is a clean, independent product and engineering repository. It is not a branch or patch layer over V3.

## Product contract

PC and APP have the same creation capabilities and business workflows:

1. **图片成片** — turn product or scene photos into a complete short video.
2. **视频配音** — turn one source video into a polished video with director-led voiceover, subtitles, music, and finishing.
3. **多视频分镜合成** — understand and arrange multiple clips into one coherent short video.

The clients share the same capability catalog, API contracts, identity, assets, projects, job states, and delivery model. Responsive presentation is allowed; capability divergence is not.

## Engineering principles

- Independent V4 monorepo and release lifecycle.
- Domain-driven boundaries; contracts shared by every client.
- API-first design, typed boundaries, schema validation, and explicit job state transitions.
- PostgreSQL as the intended durable system of record; object storage for media. Database, queue, and object-storage adapters must be selected and threat-modelled before production integration.
- Jobs must be idempotent, bounded, observable, cancellable, and tenant-isolated.
- Production secrets are injected through environment/secret management and never committed.
- No V3 source is copied without source/dependency/security/license review.

## Repository layout

```
apps/
  web/          Responsive PC + APP client
  api/          HTTP boundary and application composition
packages/
  contracts/    Shared runtime schemas and API contracts
  domain/       Framework-independent business rules
docs/
  architecture/ Architecture decisions and system design
  product/      Product behavior and interaction rules
```

## Runtime workflow

1. The client uploads source files through POST /api/v1/assets.
2. The director analyzes the prompt and uploaded asset metadata through POST /api/v1/director/plan and returns a structured plan.
3. The user must click “确认方案并开始制作”. This submits POST /api/v1/jobs; merely sending the prompt creates a plan, not a render job.
4. The PostgreSQL job queue and worker claim the job, run the selected media engine, render with FFmpeg, perform Auto-QC, and publish the MP4 to the user's works library.
5. Uploaded source assets and generated outputs follow the configured retention/cleanup policy (the current default is 24 hours).

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

The current local .env uses JX_AUTH_TEST=1; the development SMS code is 123456. It also uses PAY_SIMULATE=1 for local payment UI/testing. These are local-only settings: production startup rejects mock SMS and requires real payment credentials.

The responsive Web client is also the shared installable PWA experience. PC and APP use the same UI code, creation modes and API contracts; only layout adapts to screen size. The service worker caches the static shell and frontend assets only, and excludes API, authentication, upload and media routes.

## Current milestone

**Alpha.1 — local integration available.** The independent V4 repository contains the authenticated upload/API flow, director planning, job queue/worker, FFmpeg renderer, Auto-QC, output delivery, local/COS storage adapters, and production guards. Build and automated test coverage exist, but this does not mean production deployment is complete: production still needs its own native PostgreSQL, durable media storage, live SMS/payment configuration, production secrets, and deployment verification.

## Team & Contributors (团队协同治理)

JANSEE V4 是一个由工程团队分布式协作研发的企业级 AI 导演系统。关于详细的分工与模块职责矩阵，请查阅 [AUTHORS.md](AUTHORS.md)。

- **Project Lead & Core Contributor**: [YJXK](https://github.com/yjxk2021) (`yjxk2021@gmail.com`) — 系统架构治理、体验一致性与商业化闭环
- **Chief Architect & Systems**: JANSEE Architecture (`admin@jansee.cn`) — 基础设施、后端服务与异步渲染管线
- **Visual Design & Audio/Video Labs**: JANSEE Design & Media Teams — 黑曜石设计系统与微光音视频渲染算法

