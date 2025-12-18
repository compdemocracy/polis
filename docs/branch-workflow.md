# Branch Workflow

This document describes the Git branching strategy for the Polis project.

## Branch Overview

| Branch | Purpose |
|--------|---------|
| `edge` | Main development branch. All feature work merges here. |
| `stable` | Production deployment branch. Deployed code lives here. |

## The Golden Rule: One-Way Street

```
feature branches ──> edge (development) ──> stable (production)
```

**Never merge stable back into edge.** This maintains a clean, linear flow from development to production.

## Standard Workflows

### Day-to-Day Development

1. Create feature branches from `edge`
2. Open PRs targeting `edge`
3. Merge to `edge` when approved

```bash
git checkout edge
git pull origin edge
git checkout -b feature/my-feature
# ... do work ...
git push -u origin feature/my-feature
# Open PR to edge
```

### Deploying to Production

When ready to deploy, merge `edge` into `stable`:

```bash
git checkout stable
git pull origin stable
git merge edge
git push origin stable
```

This should always be a fast-forward or clean merge. If there are conflicts, something went wrong (see Recovery section below).

### Marking Deployments

Use tags instead of commits to mark production deployments:

```bash
git tag prod-YYYY-MM-DD stable
git push origin prod-YYYY-MM-DD
```

This keeps the commit history clean while still tracking what was deployed when.

### Hotfixes

If a critical fix is needed in production:

**Option A: Fix on edge first (preferred)**
1. Make the fix on `edge`
2. Merge `edge` into `stable`
3. Deploy

**Option B: Cherry-pick (if urgent)**
1. Make the fix directly on `stable`
2. Cherry-pick the commit to `edge` to keep them in sync:
   ```bash
   git checkout edge
   git cherry-pick <commit-hash>
   ```

## What to Avoid

- **Merging stable into edge** - This creates bidirectional merge commits and causes divergence
- **Making commits directly on stable** - Except for true emergencies requiring Option B above
- **Deploy marker commits** - Use tags instead (e.g., `prod-2024-12-06`)

## Recovery: Syncing Diverged Branches

If `stable` and `edge` diverge due to improper merges, use this technique to reset `stable` to match `edge` exactly while preserving history:

```bash
git checkout stable
git merge -s ours --no-commit edge
git read-tree edge
git checkout-index -f -a
git commit -m "Sync stable with edge"
git push origin stable
```

This creates a merge commit that:
- Records `edge` as a parent (proper merge history)
- Results in `stable` having identical content to `edge`
- Does not require force-push (no history rewriting)

### Verifying the Sync

After syncing, verify the branches match:

```bash
# Should show identical hashes
git rev-parse stable^{tree} edge^{tree}

# Should show 0 commits
git log --oneline stable..edge | wc -l
```

## Why This Matters

Maintaining one-way flow ensures:
- Clean merge history
- Predictable deployments
- Easy rollbacks (just deploy an earlier `edge` commit)
- No "merge conflict roulette" when deploying
