# After a feature — commands

Run these in a terminal from the repo root (or use Cursor’s Source Control instead of `git add` / `git commit` if you prefer).

You only use **`main`**: commit there, then `git push` (no `-u origin branch`).

## Ship a change (usual)

```bash
git status
git diff
git add .
git commit -m "feat: what you built"
git push
```

Use `fix:` instead of `feat:` for bug fixes.

## Ship a versioned release (Windows build on GitHub)

Only when you want a new **Release** / tag — not every commit.

```bash
git pull
npm version patch
git push
git push --tags
```

Use `npm version minor` or `npm version major` instead of `patch` when needed.
