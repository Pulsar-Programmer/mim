# MIM development

## Check UI changes with sample data

Run `bun run dev:sample` from the repo root. It recreates the disposable
`sample-minecraft/` fixture and launches Tauri with that directory as its
Minecraft root. Keep sample changes disposable and use this launch for checks
that edit, move, link, or delete Minecraft files.

The plain `bun run dev` command starts Vite. Screens that load data through
Tauri commands need the desktop app to exercise their normal data flows.

- Open the changed screen in the sample app. Check populated and empty states
  where relevant, plus any loading, error, or busy state the change touches.
- For layout or styling changes, check light and dark themes and resize to the
  configured minimum window size (860 × 580).
- For dialogs and drawers, check keyboard focus, Escape, and focus return to
  the opener. Exercise nested dialogs and busy dismissal guards when affected.
- Run `bun run build` for TypeScript and bundling checks. In your handoff, say
  which flows you exercised in Tauri and which remain unverified.
