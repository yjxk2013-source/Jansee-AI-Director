# JANSEE V4 — Tencent Cloud Mainland China Deployment Baseline

## Decision

V4 targets users in mainland China. Production dependencies must be reachable and supportable from a mainland Tencent Cloud region. V3 is production and remains untouched until V4 has passed release acceptance and the user explicitly approves the cutover.

The deployment target is a clean V4-only server after product completion. Do not format or repurpose the current server during development. Before cutover, inventory and back up any V3 data the user explicitly chooses to retain, confirm DNS/domain transition, and verify that V3 no longer depends on that machine.

## Target topology

- **V4 application server:** clean Tencent Cloud CVM running only V4 services, with a dedicated OS account, application directory, systemd service/container, ports, logs, resource limits and firewall rules.
- **Database:** dedicated TencentDB for PostgreSQL in the same region/VPC, accessed over private networking. No V3 database sharing. Do not expose a public database endpoint to the application.
- **Media storage — local-first ephemeral:** use a dedicated V4-only directory on the V4 server for short-lived source media, processing intermediates and generated MP4 files. Source uploads are removed after processing; outputs expire after 24 hours. This is the cost-conscious default, not a promise that any arbitrary disk size is sufficient.
- **COS — optional overflow / durable exception:** retain the Tencent COS adapter for cases where disk pressure, file size, concurrency, backup/recovery requirements or future scale justify object storage. Do not route every upload through COS by default. Any production COS bucket must be private, V4-specific, least-privilege and in the selected mainland region.
- **AI providers:** use mainland-reachable providers and endpoints appropriate for the product's data-processing requirements. Keep all API keys server-side.
- **CDN:** optional later; only after private-origin authorization, custom domain, HTTPS, cache policy and media access controls are validated.

## Local media storage safety requirements

1. Store media only below a dedicated root such as `/srv/jansee-v4/media`; never share V3 paths, service accounts or cleanup jobs.
2. Keep upload, processing, output and quarantine namespaces separate. Object keys are opaque and never accept arbitrary filesystem paths.
3. Enforce per-file, per-user and per-job limits before accepting data. Reject uploads when free disk would fall below a configured safety reserve.
4. Size capacity for peak simultaneous source + intermediate + output files, not just final MP4 size. Bound worker concurrency and queue admission by disk watermark.
5. Write to a temporary file, verify the written size, then atomically rename into place. Do not serve arbitrary filesystem paths to clients.
6. Run a V4-scoped TTL sweeper: source media after processing; generated output after 24 hours; abandoned temporary files after a short recovery window. Verify physical deletion and reconcile database state.
7. Cleanup must never traverse outside the V4 media root. Skip symlinks and reject path traversal. Keep filesystem permissions restrictive.
8. Monitor disk free bytes, storage growth, oldest queued job and cleanup failures. Stop accepting new jobs before the disk reaches a dangerous watermark.
9. Keep database backups separate from ephemeral media. Do not back up temporary source media by default; define an explicit retention policy for outputs if product/legal requirements change.

## Data and network boundaries

1. V4 data is never written to V3 databases, V3 object buckets or V3 runtime paths.
2. V4 API derives owner IDs from the authenticated session; it never trusts client-supplied user IDs.
3. Upload authorization binds user, asset ID, storage key, MIME type, expected size and expiry. Inspect file signatures and media metadata before marking an asset ready.
4. Browser clients never receive permanent storage credentials. For local storage, uploads pass through an authenticated API/streaming path; for COS, use short-lived object-scoped signed URLs.
5. Database connections use private VPC networking and TLS where supported. Security groups allow only V4 application/worker and approved administration paths.
6. Credentials are held in server environment/secret management, never in Git, frontend bundles, browser storage, logs or chat.
7. Backups, point-in-time recovery, restore drills, deletion verification, monitoring and incident procedures are release gates.

## Cost and isolation policy

- Do not create paid Tencent Cloud resources or change V3 security groups, DNS, firewall or services without explicit user approval.
- Do not assume the existing 4C4G / 40GB V3 server can host V4. It is not the final target if the user chooses a clean V4-only deployment.
- Prefer a small, dedicated V4 CVM sized from measured concurrency and media peak-space tests. Prefer managed TencentDB PostgreSQL for durable production data; do not colocate an unbounded database and media workload on a tiny application disk without capacity evidence.
- COS is an optional capacity/reliability tool, not a mandatory default. Compare storage, request, transfer and lifecycle costs before enabling it.
- Never weaken V3 isolation to save initial cost.

## Current implementation status

The repository now includes an authenticated multipart upload API, session-based owner binding, JPEG/PNG/WebP/GIF/BMP/TIFF/AVIF/HEIC and MP4/MOV/WebM signature detection, per-file limits (20 MB images / 200 MB videos), a 500 MB request cap, a nine-file cap, per-IP rate limiting, two concurrent upload slots, private local storage writes and transactional asset metadata insertion. The browser uploads through this API and stores returned asset IDs in the local conversation record. Uploads still require a configured absolute MEDIA_STORAGE_ROOT and a real PostgreSQL database. No live TencentDB instance is connected and no migration has been applied to a real database. Expiry cleanup, asset retrieval/deletion, worker consumption, real-media inspection and end-to-end production verification remain outstanding. The COS adapter remains optional and has no live bucket integration. Do not report production readiness until these remaining gates and restore/security checks pass.

## Clean V4 cutover checklist

1. Finish V4 features, end-to-end tests, security review, load tests and operational runbooks locally/staging.
2. Confirm V3 backup/retention requirements and export only the records/assets the user explicitly wants to keep.
3. Provision or select a dedicated V4 mainland CVM and TencentDB PostgreSQL; create private networking and least-privilege access.
4. Format/reinitialize the target server only after the user explicitly approves and confirms backups and V3 independence.
5. Deploy V4 application, worker, database migrations and secrets; configure V4-only local media root and disk watermarks.
6. Run smoke tests, payment sandbox tests, backup/restore drill, deletion checks, monitoring and alert tests.
7. Switch DNS only after acceptance; keep a rollback plan and do not delete V3 backups prematurely.

## References

- TencentDB PostgreSQL same-VPC private connectivity: https://cloud.tencent.com/document/product/409/40429
- TencentDB PostgreSQL regions and availability zones: https://cloud.tencent.com/document/product/409/113656
- COS Node.js signed URL guidance: https://cloud.tencent.com/document/product/436/36121
- COS private pre-signed upload: https://cloud.tencent.com/document/product/436/14114


## Current upload API configuration

- Set MEDIA_STORAGE_ROOT to an absolute, dedicated V4-only path (for example /srv/jansee-v4/media). Production startup rejects a missing or relative path when PostgreSQL is configured.
- Optional MEDIA_MIN_FREE_BYTES defaults to 1 GiB; new uploads are rejected when the local storage volume cannot preserve that reserve.
- Uploads require the jansee_session HttpOnly cookie and an allowed Origin. The API never accepts a client-supplied owner ID or storage path.
- The API accepts up to 9 same-kind files per request, 20 MB per image, 200 MB per video and 500 MB total. It limits uploads to 5 requests per IP per minute and 2 concurrent uploads per process.
- Source uploads are not yet automatically expired. Do not enable public production uploads until the expiry sweeper and job lifecycle are deployed.
