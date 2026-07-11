# Generated SpacetimeDB bindings

This private package contains the TypeScript client bindings generated from the exact Rust module
schema by SpacetimeDB CLI 2.6.1. Files in `src/` are generated and must not be edited manually.

Regenerate after every public reducer or View schema change:

```bash
scripts/install-spacetime-cli.sh
PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.93.0 \
  .tools/spacetime/spacetime generate \
  --lang typescript \
  --module-path spacetimedb \
  --out-dir packages/db-bindings/src \
  --yes
```

CI type-checks the generated output. The browser application must subscribe only to the public,
caller-aware Views represented here; private tables are intentionally absent.

`skipLibCheck` is enabled only for this generated boundary because the 2.6.1 browser SDK package
also publishes server-only declaration files that reference the Spacetime host runtime. Project
source remains strictly type-checked.
