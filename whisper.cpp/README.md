# JANSEE V4 local Whisper runtime

This directory is owned by V4. The V2 checkout is not required at runtime.

## Expected layout

- `bin/whisper-cli.exe` on local Windows development machines.
- `bin/whisper-cli` on Linux production hosts/containers (must be built for the target Linux architecture).
- `models/ggml-small.bin` model file.

The V4 ASR adapter resolves these defaults relative to the V4 repository root. Override them with `JX_WHISPER_CLI` and `JX_WHISPER_MODEL` when deploying to a mounted runtime directory.

## Local Windows setup

The Windows executable bundle and `ggml-small.bin` are provisioned locally in this folder. They are intentionally excluded from Git because native binaries and the 488 MB model should be versioned as runtime artifacts, not source files.

## Linux production setup

Do not copy the Windows `.exe` or `.dll` files into Linux containers. Provision a Linux `whisper-cli` built from the upstream whisper.cpp source for the deployment architecture, place it at `whisper.cpp/bin/whisper-cli` (or set `JX_WHISPER_CLI`), and provision the same model at `whisper.cpp/models/ggml-small.bin` (or set `JX_WHISPER_MODEL`). Mount this runtime directory read-only into the API container. Record the upstream revision, compiler/build flags, model source, SHA-256 checksums, and license notices in the release artifact manifest.

## Resource limits

The default ASR adapter uses two Whisper threads so it can coexist with FFmpeg on a 4-vCPU host. Do not raise worker concurrency without load tests against the actual 4 GB memory limit.

## Important boundary

Whisper performs audio transcription and word-level timestamping. It does not understand image/video visuals, products, scenes, or highlight quality.
