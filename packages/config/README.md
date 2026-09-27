# @velo/config

Shared configuration for every TypeScript workspace. **Consumed, never copied** — a configuration that has been duplicated into three apps is three configurations that will diverge.

| Export                             | Use                                                      |
| ---------------------------------- | -------------------------------------------------------- |
| `@velo/config/eslint/base`         | Node and library packages                                |
| `@velo/config/eslint/next`         | Next.js apps; accessibility rules are errors             |
| `@velo/config/tsconfig/base.json`  | Libraries                                                |
| `@velo/config/tsconfig/next.json`  | Next.js apps                                             |
| `@velo/config/tailwind/tokens.css` | Design tokens — imported by each app's global stylesheet |

## Tokens

`tailwind/tokens.css` is the machine-readable form of [`docs/DESIGN-SYSTEM.md`](../../docs/DESIGN-SYSTEM.md) §2. Change the document first, then this file — a token whose rationale is not written down is a magic number with better syntax.

Layering:

- **`@theme`** holds primitive scales (`--color-brand-500`, `--text-lg`, `--radius-md`). Tailwind generates utilities from them.
- **`:root`** holds semantic tokens (`--surface-page`, `--text-primary`). Components reference only these.
- **Dark mode** re-points the semantic tokens. Primitives never change meaning between themes.
- **`@theme inline`** exposes the semantic tokens as utilities, so `bg-surface-raised` and `text-secondary` work and automatically follow the theme.

The contrast table in `DESIGN-SYSTEM.md` §2 is verified in CI against this file. A token change that drops a pair below its threshold fails the build.
