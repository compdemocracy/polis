# Changelog


## 1.0

Landmark!

After 12 years of research and development, we are making this our first versioned release of the Polis platform!

This version signifies a turning point for the project, where we see the core methodology as stable, and wish to facilitate the growing need for coordination and transparency among an increasing number of partners, but also to free ourselves to continue innovating at the cutting edge of deliberative technology (e.g. [Opportunities and Risks](https://arxiv.org/abs/2306.11932) and [Coherent Mode](https://arxiv.org/abs/2211.12571)).

From here on out, we'll be maintaining two main branches of the Polis software:
* `stable`: points to the latest stable release of the software, after having passed QA assessment
* `edge`: the most recent version of the software to have been merged in, and ready (pending QA) for merging into `stable` (can be assumed to have passed automated testing criteria)

For now, the versioning scheme will look like: `major.minor[.patch]`.
In general, updates will look like:

* `patch`: bugfix; no intended behavior changed
* `minor`: new features, without major changes to the underlying algorithm, or significant interface changes (includes new translations or significant translation updates)
* `major`: significantly different default algorithmic behavior, participant interface, or other major new functionality

In general minor version bumps will be preferred over major if features don't by default effect either the algorithm or participation interface.
This allows us to build under feature flags before official release, giving us an opportunity to launch quickly, perform user testing, and iterate between major version releases as features solidify.

Changes which have been merged to `edge` but are not yet versioned on `stable` can be listed at the "edge changes" section at the end of this living document as they are merged in after passing automated testing.


## edge changes

* ...



## Migration runner

Deployments now apply pending numbered migrations through `polis-migrate` before
service replacement. The API refuses startup with pending or mismatched history.
Existing databases require one-time catalog-checked adoption. See
[upgrading](docs/upgrading.md) for the first CodeDeploy hook transition and the
release-wide coordinator hold. PostgreSQL 17+ is required.

The explicit release manifest admits the supported legacy schema then applies
M19/M23/M24; M20/M21/M25/M26 stay outside the forward path. Deprecated M4/M5/M7
are observation-only, never automatic destructive steps. Exact legacy type
alternatives, a catalog-only first-deploy report, per-deployment upgrade notes
and a source-to-release map are documented in
[migration upgrade notes](docs/migration-upgrade-notes.md). Historical SQL
checksums remain unchanged; no semantic version is invented for unversioned
historical releases.
