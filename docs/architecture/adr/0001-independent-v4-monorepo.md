# ADR-0001: Independent V4 Monorepo

- Status: Accepted
- Date: 2026-11-15

## Context

V4 is a clean architectural and product iteration. V3 is a functioning product codebase with live history and must not become the V4 working tree. Sharing code without auditing dependencies and assumptions would couple releases and risk production stability.

## Decision

Create a separate Git repository at F:\Jansee-v4 with its own packages, dependency graph, CI, tests, and release lifecycle. V3 remains read-only. Reuse is performed by audited extraction into V4-owned packages; no runtime references to V3 paths.

## Consequences

- V4 can establish new boundaries without compatibility debt.
- Shared V3 modules require review and adaptation before adoption.
- V3 changes and uncommitted work are protected from V4 development.
