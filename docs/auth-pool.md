# Auth Pool (OpenAI Codex)

`openclaw models auth pool ...` manages multiple `openai-codex` OAuth profiles without running onboarding.

## Commands

- `openclaw models auth pool add --provider openai-codex`
- `openclaw models auth pool list`
- `openclaw models auth pool status`
- `openclaw models auth pool activate <profileId>`
- `openclaw models auth pool auto`
- `openclaw models auth pool remove <profileId>`

## Behavior

- Pool metadata is stored in `~/.openclaw/auth-pools.json`.
- OAuth credentials remain in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
- Pool entry visibility and cleanup are agent-scoped to avoid cross-agent deletion.
- Plain `openclaw models auth login` credentials are not auto-imported into the pool. Pool membership is managed by `pool add` / `pool remove`.
- `pool add` runs OAuth login only, then adds/updates one pooled profile.
- If an account is already in the pool, `pool add` reuses that profile and updates workspace label.
- Auto ranking is:
  1. Higher remaining `5h/3h` first.
  2. Higher remaining `Week/Day` next.
  3. Older `lastUsed` first.
- Any profile with `5h/3h == 0%` or `Week/Day == 0%` is excluded from candidates.
- In auto mode, the last successful profile is written back as `activeProfileId` (sticky until failover).
- In manual mode, `activate` pins one profile.
- `pool remove` deletes both pool metadata and the stored auth profile.

## Notes

- `pool status` refreshes quota snapshots unless `--cached` is used.
- If all pooled profiles are unavailable, model calls should surface a quota-limit style error.
