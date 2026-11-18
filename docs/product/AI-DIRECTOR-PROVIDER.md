# AI Director Provider

## What is implemented

- `POST /api/v1/director/plan` validates the creation mode, prompt, aspect ratio, and asset metadata.
- The API calls an OpenAI-compatible chat-completions endpoint from the server only.
- The model must return a structured JSON director plan. The API validates the output before returning it to the client.
- The browser now calls this API for a plan. The former hard-coded local director reply has been removed.
- Provider credentials are read only from server environment variables and are never sent to the browser.

## Configuration

Copy the relevant keys from `.env.example` into the API server environment:

```dotenv
DIRECTOR_API_BASE_URL=https://api.siliconflow.cn/v1
DIRECTOR_API_KEY=replace-with-server-side-secret
DIRECTOR_MODEL=replace-with-supported-model-id
DIRECTOR_TIMEOUT_MS=20000
```

The base URL must be the provider's OpenAI-compatible API root; the adapter appends `/chat/completions`.

Restart the API after changing these values. If any required value is absent, the endpoint intentionally returns `503 DIRECTOR_NOT_CONFIGURED`. Do not put the API key in `VITE_*` variables, frontend source, browser storage, or committed files.

## Current limitation

This phase sends asset names, media types, and byte sizes as metadata. It does not upload the original image/video bytes to the model, analyze visual content, or generate an MP4. The returned plan is a proposal only. Cloud asset storage, authenticated ownership, job creation, rendering workers, and output delivery are separate release gates and are not yet implemented.

## Verification

The API tests cover missing provider configuration, request validation, structured plan responses, server-side key handling, and malformed model output.
