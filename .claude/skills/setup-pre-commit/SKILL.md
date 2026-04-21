---
name: setup-pre-commit
description: Set up Husky pre-commit hooks with lint-staged running Prettier + ESLint, plus a full typecheck/lint/format/test gate, using the detected package manager. Use when user wants to add pre-commit hooks, set up Husky, configure lint-staged, add commit-time formatting/linting/typechecking/testing, or mentions "/setup-pre-commit".
---

# Setup Pre-Commit Hooks

## Steps

### 1. Detect package manager

| Lockfile                 | Manager |
| ------------------------ | ------- |
| `bun.lock` / `bun.lockb` | bun     |
| `pnpm-lock.yaml`         | pnpm    |
| `yarn.lock`              | yarn    |
| `package-lock.json`      | npm     |

Commands below assume `bun`/`bunx`. Swap for detected manager.

### 2. Install devDependencies (skip ones already present)

```
husky lint-staged prettier prettier-plugin-organize-imports @eslint/js eslint typescript-eslint jiti
```

Drop eslint + typescript-eslint + jiti if repo has no TypeScript.

### 3. Initialize Husky

```bash
bunx husky init
```

### 4. Add `package.json` scripts (merge, don't overwrite)

```json
{
    "prepare": "husky",
    "typecheck": "bunx tsc --noEmit",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "check": "bun run typecheck && bun run lint && bun run format:check && bun test"
}
```

Omit any script whose tool isn't installed.

### 5. Write `.husky/pre-commit`

```
bunx lint-staged
bun run check
```

Husky v9+ — no shebang. Skip the `bun run check` line for repos with slow test suites; let CI catch it.

### 6. Write `.lintstagedrc`

```json
{
    "*.{ts,tsx,js,jsx,json,md,yml,yaml}": ["prettier --write"],
    "*.{ts,tsx,js,jsx}": ["eslint --fix"]
}
```

Drop the second entry when repo has no ESLint.

### 7. Write `.prettierrc` if missing

```json
{
    "semi": true,
    "singleQuote": false,
    "tabWidth": 4,
    "trailingComma": "all",
    "printWidth": 100,
    "plugins": ["prettier-plugin-organize-imports"]
}
```

### 8. Write `.prettierignore` if missing

```
node_modules
dist
build
coverage
bun.lock
pnpm-lock.yaml
yarn.lock
package-lock.json
*.log
docs
```

### 9. Write `eslint.config.ts` if missing (TypeScript repos)

```ts
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["node_modules", "dist", "build", "coverage"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: { parserOptions: { projectService: true } },
        rules: {
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-control-regex": "off",
        },
    },
    {
        files: ["**/*.test.ts", "**/test-helpers.ts"],
        rules: { "@typescript-eslint/no-non-null-assertion": "off" },
    },
);
```

### 10. Verify + commit

```bash
bun run check
bunx lint-staged
```

Commit with `chore: add pre-commit hooks (husky + lint-staged)` — the commit itself exercises the hook.

## Gotchas

| Failure                                                     | Fix                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `check` runs tests on every commit; slow repo feels painful | Drop `bun run check` from hook; keep only `lint-staged`. Run full check in CI.                |
| Husky hook not executable                                   | `chmod +x .husky/pre-commit`                                                                  |
| `prepare` script missing from package.json                  | Re-run `bunx husky init`; it adds it                                                          |
| ESLint complains about `projectService`                     | Add a `tsconfig.json` with `include: ["src/**/*"]` — projectService needs one                 |
| Prettier reformats huge chunks of repo on first run         | Run `bun run format` + commit separately BEFORE adding the hook so reformat noise is isolated |
| Lint-staged runs on binaries                                | File globs in `.lintstagedrc` scope to text extensions; don't use `"*": "..."`                |

## Edge cases

| Scenario                              | Handling                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No TypeScript in repo                 | Skip eslint.config.ts, drop `typecheck` script, drop `@typescript-eslint/*` deps                                              |
| No test script                        | Compose `check` as `typecheck && lint && format:check`; drop the `&& bun test`                                                |
| Prettier config already present       | Keep existing config; only add missing scripts + husky wiring                                                                 |
| Monorepo                              | Install deps at root; scripts + hooks belong at root; `lint-staged` runs against the whole staged set regardless of workspace |
| Repo has existing `.husky/pre-commit` | Read first; append missing lines rather than overwrite                                                                        |
| User already uses Prettier v2         | `bunx husky init` works on v9 Husky but `prettier-plugin-organize-imports` needs Prettier v3; tell the user before upgrading  |
