# Branch Workflow

This document describes the Git branching strategy for the Polis project.

## Branch Overview

| Branch | Purpose |
|--------|---------|
| `edge` | Main development branch. All feature work merges here. |
| `stable` | Production deployment branch. Deployed code lives here. |

## The Golden Rule: One-Way Street

```text
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

When ready to deploy, create a PR to merge `edge` into `stable` using GitHub's standard workflow.

#### Using GitHub PRs for Deployment

1. Create a PR from `edge` → `stable`
2. Ensure CI checks pass
3. Get required approvals
4. Use the **"Create a merge commit"** option (GitHub's default merge button)

This creates a merge commit on `stable` that records the deployment. This is intentional and provides clear deployment markers in the history.

#### Why merge commits (not fast-forward)

We considered enforcing fast-forward-only merges to `stable`, but this approach has significant drawbacks:

- **Requires CLI-only workflow** — GitHub's UI cannot perform fast-forward merges
- **Brittle ancestry requirements** — Fast-forward only works when `stable` is a strict ancestor of `edge`. Any divergence (even from recovery operations) breaks this permanently unless you either merge `stable` back into `edge` (violating our golden rule) or use arcane git replacement techniques that confuse tooling and collaborators.
- **No practical benefit** — Merge commits clearly mark deployments and don't cause the problems that merging *from* `stable` *to* `edge` causes.

Merge commits on `stable` are fine. The important rule is the one-way flow: changes go `edge → stable`, never the reverse.

#### Branch protections for `stable`

`stable` should be protected with:

- **Require PR reviews** before merging to `stable`
- **Require status checks** to pass
- **Restrict direct pushes** — all changes via PR

### Marking Deployments (Optional)

Use tags to mark production deployments:

```bash
git tag prod-YYYY-MM-DD stable
git push origin prod-YYYY-MM-DD
```

### Hotfixes

If a critical fix is needed in production:

#### Option A: Fix on edge first (preferred)

1. Make the fix on `edge`
2. Merge `edge` into `stable`
3. Deploy

#### Option B: Cherry-pick (if urgent)

1. Make the fix directly on `stable`
2. Cherry-pick the commit to `edge` to keep them in sync:

   ```bash
   git checkout edge
   git cherry-pick <commit-hash>
   ```

## What to Avoid

- **Merging stable into edge** - This is the critical rule. Merging `stable → edge` creates bidirectional flow and causes long-term divergence problems. Don't do it.
- **Making commits directly on stable** - Except for true emergencies requiring Option B above
- **Manual deploy marker commits** - The merge commits from PRs serve as natural deployment markers. Use tags for additional labeling if needed (e.g., `prod-2024-12-06`).

## Recovery: Syncing Diverged Branches

If `stable` and `edge` diverge significantly due to improper merges or historical workflow issues, use this technique to reset `stable` to match `edge` exactly while preserving history:

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

### Historical Note

This recovery technique was used in December 2024 (commit `06c427cf9`) to resolve years of accumulated branch divergence from inconsistent merge practices. Going forward, consistent use of `edge → stable` PRs should prevent the need for this recovery procedure.

### Verifying the Sync

After a recovery sync, verify the branches have identical content:

```bash
# Should show identical tree hashes
git rev-parse stable^{tree} edge^{tree}
```

Note: `git log stable..edge` may still show commits if new work landed on `edge` after the sync — that's expected and normal.

## Why This Matters

Maintaining one-way flow ensures:

- Clean merge history
- Predictable deployments
- Easy rollbacks (just deploy an earlier `edge` commit)
- No "merge conflict roulette" when deploying
