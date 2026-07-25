---
name: Bun
description: Use when building JavaScript/TypeScript applications, managing dependencies, running tests, bundling code, or creating HTTP servers. Reach for Bun when you need to replace npm/yarn/pnpm, run TypeScript directly, execute tests, or build production bundles.
metadata:
  mintlify-proj: bun
  version: "1.0"
---

# Bun Skill Reference

## Product summary

Bun is a JavaScript runtime, package manager, test runner, and bundler built for speed. It replaces Node.js for runtime execution, npm/yarn/pnpm for dependency management, Jest for testing, and esbuild for bundling. Key files: `bunfig.toml` (Bun-specific config), `package.json` (standard), `bun.lock` (lockfile). Primary CLI commands: `bun run`, `bun install`, `bun test`, `bun build`. See https://bun.com/docs for complete documentation.

## When to use

- **Running code**: Execute TypeScript, JSX, and JavaScript files directly without compilation steps (`bun file.ts`)
- **Package management**: Install, add, remove, and update dependencies faster than npm (`bun install`, `bun add`)
- **Testing**: Run Jest-compatible tests with built-in test runner (`bun test`)
- **Bundling**: Create optimized production bundles for browser, Node.js, or Bun targets (`bun build`)
- **Scripts**: Execute package.json scripts and executables (`bun run script-name`)
- **HTTP servers**: Build high-performance servers with `Bun.serve()`
- **Development**: Use watch mode (`--watch`) or hot reload (`--hot`) for rapid iteration

## Quick reference

### Essential commands

| Task                      | Command                                    |
| ------------------------- | ------------------------------------------ |
| Run a file                | `bun file.ts`                              |
| Run a script              | `bun run script-name`                      |
| Install dependencies      | `bun install`                              |
| Add a package             | `bun add package-name`                     |
| Add dev dependency        | `bun add -d package-name`                  |
| Remove a package          | `bun remove package-name`                  |
| Run tests                 | `bun test`                                 |
| Build for production      | `bun build ./src/index.ts --outdir ./dist` |
| Watch for changes         | `bun --watch file.ts`                      |
| Hot reload (soft restart) | `bun --hot file.ts`                        |
| Check version             | `bun --version`                            |

### Configuration files

| File            | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `bunfig.toml`   | Bun-specific settings (optional; placed in project root or `~/.bunfig.toml`)                  |
| `package.json`  | Standard Node.js metadata; Bun reads `scripts`, `dependencies`, `devDependencies`             |
| `bun.lock`      | Lockfile (text-based by default since v1.2); commit to version control                        |
| `.env`          | Environment variables (auto-loaded; also `.env.local`, `.env.production`, `.env.development`) |
| `tsconfig.json` | TypeScript configuration; Bun respects `compilerOptions`                                      |

### Common bunfig.toml sections

```toml
[install]
dev = true                    # Install devDependencies
optional = true               # Install optionalDependencies
production = false            # Production mode (no devDeps)
linker = "hoisted"           # "hoisted" or "isolated" (pnpm-like)

[test]
root = "."                    # Test directory
coverage = false              # Enable coverage reporting
preload = ["./setup.ts"]      # Scripts to run before tests

[serve]
port = 3000                   # Default port for Bun.serve

[run]
shell = "system"              # "system" or "bun"
silent = false                # Suppress command output
```

## Decision guidance

### When to use `--watch` vs `--hot`

| Scenario               | Use `--watch` | Use `--hot` |
| ---------------------- | ------------- | ----------- |
| Server restarts needed | ✓             |             |
| Preserve global state  |               | ✓           |
| Database connections   |               | ✓           |
| Full process reload    | ✓             |             |
| Development speed      |               | ✓           |

### When to use `bun install` vs `bun add`

| Scenario                 | Use `bun install`            | Use `bun add` |
| ------------------------ | ---------------------------- | ------------- |
| Install all dependencies | ✓                            |               |
| Add single package       |                              | ✓             |
| Add dev dependency       |                              | ✓ (with `-d`) |
| CI/CD reproducible build | ✓ (with `--frozen-lockfile`) |               |
| Update lockfile          | ✓                            | ✓             |

### When to use bundler targets

| Target    | Use case                                                     |
| --------- | ------------------------------------------------------------ |
| `browser` | Client-side code; prioritizes `"browser"` export condition   |
| `bun`     | Server code; adds `// @bun` pragma; use for full-stack apps  |
| `node`    | Node.js compatibility; prioritizes `"node"` export condition |

## Workflow

### 1. Initialize and run a project

1. Create a new project: `bun init my-app` (choose template: Blank, React, or Library)
2. Navigate to directory: `cd my-app`
3. Install dependencies: `bun install` (auto-runs if `node_modules` missing with auto-install enabled)
4. Run a file: `bun src/index.ts` or run a script: `bun run dev`
5. Check `package.json` for available scripts

### 2. Add and manage dependencies

1. Search for package: `bun add package-name`
2. Add as dev dependency: `bun add -d @types/package`
3. Check for outdated packages: `bun outdated`
4. Update a package: `bun update package-name`
5. Remove a package: `bun remove package-name`
6. Commit `bun.lock` to version control

### 3. Write and run tests

1. Create test file matching pattern: `*.test.ts`, `*.spec.ts`, `*_test.ts`, or `*_spec.ts`
2. Import from `bun:test`: `import { test, expect, describe } from "bun:test"`
3. Write tests: `test("name", () => { expect(2 + 2).toBe(4); })`
4. Run tests: `bun test`
5. Watch mode: `bun test --watch`
6. Filter by name: `bun test --test-name-pattern add`
7. Generate coverage: `bun test --coverage`

### 4. Build for production

1. Create build script in `package.json`: `"build": "bun build ./src/index.ts --outdir ./dist"`
2. Or use JavaScript API: `await Bun.build({ entrypoints: ['./src/index.ts'], outdir: './dist' })`
3. Specify target: `--target browser|bun|node`
4. Enable minification: `--minify`
5. Generate sourcemaps: `--sourcemap linked`
6. Watch for changes: `--watch`

### 5. Configure environment and runtime

1. Create `.env` file in project root
2. Add variables: `API_URL=https://api.example.com`
3. Access in code: `process.env.API_URL` or `Bun.env.API_URL`
4. Create `bunfig.toml` for Bun-specific settings
5. Override with CLI: `API_URL=prod bun run build`

## Common gotchas

- **Lifecycle scripts disabled by default**: Bun doesn't run `postinstall` scripts for security. Add trusted packages to `trustedDependencies` in `package.json` to allow them.
- **Auto-install can mask missing dependencies**: If `node_modules` doesn't exist, Bun auto-installs on the fly. Run `bun install` explicitly in CI/CD to catch missing dependencies early.
- **`--hot` doesn't restart the process**: Global state persists; if you need a full restart, use `--watch` instead.
- **TypeScript errors in Bun global**: Install `@types/bun` and add `"lib": ["ESNext"]` to `tsconfig.json` compilerOptions.
- **Lockfile format changed in v1.2**: Old `bun.lockb` (binary) is now `bun.lock` (text). Migrate with `bun install --save-text-lockfile --frozen-lockfile --lockfile-only`.
- **Environment variables not injected by default in bundles**: Use `--env inline` or `--env PREFIX_*` to inject env vars into bundled code.
- **`bun.lock` must be committed**: Without it, `bun install` in CI may resolve different versions. Use `bun ci` (equivalent to `bun install --frozen-lockfile`) in CI/CD.
- **Peer dependencies installed by default**: Unlike npm, Bun installs `peerDependencies` automatically. Disable with `--omit peer` if needed.
- **Test files must match patterns**: Only `*.test.ts`, `*.spec.ts`, `*_test.ts`, `*_spec.ts` are discovered. Nested files in `node_modules` are skipped.
- **Bun doesn't polyfill Node.js APIs for browser bundles**: Use `--target browser` carefully; Node.js APIs like `fs` won't work. Use `--target node` for Node.js code.

## Verification checklist

Before submitting work with Bun:

- [ ] Run `bun install` to ensure all dependencies are installed
- [ ] Run `bun test` and verify all tests pass
- [ ] Run `bun run build` (or equivalent) and check output in `dist/` or configured outdir
- [ ] Verify `bun.lock` is committed (if using version control)
- [ ] Check `bunfig.toml` for any project-specific settings that should be documented
- [ ] Test with `bun --watch` or `bun --hot` to verify development workflow
- [ ] Confirm environment variables are set correctly (check `.env` file)
- [ ] Run `bun run <script>` for any custom scripts defined in `package.json`
- [ ] Verify TypeScript files transpile without errors (no `@ts-ignore` hacks needed)
- [ ] Check that bundled output doesn't include unnecessary dependencies (use `--external` if needed)

## Resources

- **Comprehensive page listing**: https://bun.com/docs/llms.txt
- **Runtime documentation**: https://bun.com/docs/runtime
- **Package manager documentation**: https://bun.com/docs/pm/cli/install
- **Test runner documentation**: https://bun.com/docs/test
- **Bundler documentation**: https://bun.com/docs/bundler

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt
