# 🤝 Contributing to TAMIAS

Thanks for considering a contribution. TAMIAS is a small, opinionated codebase — please read this short guide before opening a PR.

## What we accept

- Bug fixes with a clear repro
- New file-format support (image or model) that doesn't pull in heavy native deps
- Performance improvements with before/after numbers
- Documentation improvements
- Phase-2/3/4 features listed in [docs/ROADMAP.md](docs/ROADMAP.md)

## What we don't accept (without prior discussion)

- ❌ Hardcoded model URLs, demo data, or test fixtures shipped in the bundle
- ❌ Telemetry, analytics, or any phone-home code
- ❌ Anything that introduces a network egress path bypassing the CSP
- ❌ Vendor-specific GPU paths that break the WebGPU + WASM fallback chain
- ❌ Heavy native deps in the runtime container (the static server uses Node built-ins only on purpose)

## Local development

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm run lint
npm run build
npm start            # serves dist/ via the production static server
```

CI (GitHub Actions) runs `typecheck → lint → build` and uploads the `dist/` artifact. PRs must be green before review.

## Code style

- TypeScript strict; avoid `any`
- `prettier` for formatting (`npm run format`)
- `eslint --max-warnings=0` for lint
- React function components with hooks; no class components
- One default export per `*.tsx` file when feasible (helps `react-refresh`)

## Commits

Conventional commit-style messages help readers and changelog tooling:

```
feat(viewer): add segmentation contour brush
fix(inference): handle 4D NIfTI with single timepoint
docs(readme): clarify nginx COOP/COEP forwarding
```

Smaller, atomic commits are preferred over one giant squash.

## Filing an issue

When filing a bug, include:

- Browser + version + OS
- WebGPU adapter (the GPU diagnostics card shows it)
- File format you were trying to load
- Model name + manifest (with patient data redacted)
- Steps to reproduce
- Expected vs. actual

Thank you. 🐿️
