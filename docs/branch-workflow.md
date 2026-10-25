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

Follow [Preparing and publishing a Polis release](release-promotion.md):

1. Run the preparation workflow and review and merge its version preparation PR
   into `edge`. It updates `VERSION` and the Cargo version mirrors together.
2. Refresh the promotion plan for the new `edge` SHA. Open or update the promotion
   pull request with **`edge` itself as the head** and `stable` as the base, then
   merge it with a **merge commit** through the required review.
3. Run the gated publication workflow for that exact stable merge commit. After
   approval, it creates the annotated `vX.Y.Z` tag and publishes the CLI release.
4. Deploy that published stable commit through the existing deployment gates.

The annotated version tag is the canonical release marker. Publication must
finish before the deployment build reads the commit's version identity.

### Hotfixes

Make the fix through a reviewed PR to `edge`, then follow the same version
preparation, promotion PR, gated publication and deployment sequence above.
The publication workflow does not support a separate stable-only hotfix path.

## What to Avoid

- **Merging stable into edge** - This creates bidirectional merge commits and causes divergence
- **Making commits directly on stable** - Use reviewed edge-to-stable promotion PRs
- **Deploy marker commits** - Use the annotated `vX.Y.Z` release tag

## Recovery: Syncing Diverged Branches

If `stable` and `edge` diverge due to improper merges, stop the promotion and
review the differing commits and trees. Resolve the divergence through reviewed
changes to `edge`, preserving the stable ruleset; do not push directly to stable.
Then refresh the version preparation and open the promotion PR with `edge`
itself as its head. Merge with a merge commit whose tree equals the promoted
source, as required by [release validation](release-promotion.md).

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
- Easy rollbacks (redeploy an earlier published stable commit)
- No "merge conflict roulette" when deploying
