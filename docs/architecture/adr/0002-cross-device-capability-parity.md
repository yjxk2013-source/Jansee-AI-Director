# ADR-0002: Cross-device Capability Parity

- Status: Accepted
- Date: 2026-11-15

## Context

The product deliberately removes redundant complexity. That reduction must not create different product editions on PC and APP.

## Decision

PC and APP expose the same creation modes, assets, project data, director workflows, task controls, and output delivery. They use one responsive client codebase and one API contract. Layout, navigation density, and device-native input ergonomics may differ.

The capability registry is shared code and is the sole source of truth. Any future native shell must consume the same contract and pass the same parity suite.

## Consequences

- No APP-only or PC-only creation modes without an explicit product decision.
- New capabilities ship to the shared contract first and are accessible on both form factors.
- Responsive tests verify all three creation modes at mobile and desktop breakpoints.
