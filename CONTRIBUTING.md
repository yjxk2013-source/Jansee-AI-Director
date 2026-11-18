# Contributing to JANSEE V4

## Before changing code

- Work only in the V4 repository.
- Create a feature branch; never develop directly on main.
- Read AGENTS.md and the relevant architecture decision records.
- V3 is a read-only reference. Do not add runtime imports, symlinks or shared node_modules pointing into V3.

## Engineering rules

- Keep domain rules framework-independent.
- Change shared contracts before adding client-specific behavior.
- PC and APP must retain the same creation capabilities and job actions.
- Validate external inputs at boundaries and enforce ownership server-side.
- Do not commit secrets, real customer assets, uploads, generated videos or production data.
- Do not add a capability to the UI before its backend path and error states are implemented.

## Required checks

Before requesting review, run:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Include the scope, user impact, risks, tests performed and rollback notes in the pull request.
