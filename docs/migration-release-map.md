# Migration source to release map

These 46 source variants map to releases by exact SQL bytes. Source membership
does not prove execution on any database. The only actual source version label
established by the historical research is `1.0`; subsequent semantic versions
were not consistently assigned. Strict/OIDC numbers below are the previously
reviewed retrospective proposals, **not published tags or a new version ruling**.
The current M19/M23/M24/M27 bytes first ship at promotion PR #2994 (`5ded2e0a9`);
their semantic version is **UNASSIGNED**. A release owner must assign the real
release version before publishing one; this patch invents none.

For an installation's execution record, use its receipts or record execution
as unknown. Never infer an apply date from this source table. The historical
version research is tracked separately from schema adoption.

| Audited source variant | Role | Filename first present | Exact audited bytes first present | Disposition |
| --- | --- | --- | --- | --- |
| `000000_initial.sql` (#2997 reference; `2652134140cd`) | numbered_forward | declared 1.0 source (anchor) | `53817ae39`; strict 3.24.2 / OIDC 2.24.2 | SHIPPED_SOURCE_BYTES |
| `000001_update_pwreset_table.sql` (#2997 reference; `cb21278194c4`) | numbered_forward | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000002_add_xid_constraint.sql` (#2997 reference; `a27a8e63c79c`) | numbered_forward | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000003_add_origin_permanent_cookie_columns.sql` (#2997 reference; `0d7f27facfec`) | numbered_forward | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000004_drop_waitinglist_table.sql` (#2997 reference; `f2fc4184a965`) | numbered_forward | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000005_drop_slack_stripe_canvas.sql` (#2997 reference; `392e5b8aadb7`) | numbered_forward | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000006_update_votes_rule.sql` (#2997 reference; `8fb05b7b1b6a`) | numbered_forward | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000007_drop_geolocation_fields.sql` (#2997 reference; `f68b69b86112`) | numbered_forward | `8040579ef`; strict 1.1.0 / OIDC 1.1.0 | `8040579ef`; strict 1.1.0 / OIDC 1.1.0 | SHIPPED_SOURCE_BYTES |
| `000008_add_comment_priority.sql` (#2997 reference; `c867b53be3cc`) | numbered_forward | `8040579ef`; strict 1.1.0 / OIDC 1.1.0 | `8040579ef`; strict 1.1.0 / OIDC 1.1.0 | SHIPPED_SOURCE_BYTES |
| `000009_add_uuid_to_zinvites.sql` (#2997 reference; `43f36fe0b857`) | numbered_forward | `4ba8b0938`; strict 1.6.0 / OIDC 1.6.0 | `4ba8b0938`; strict 1.6.0 / OIDC 1.6.0 | SHIPPED_SOURCE_BYTES |
| `000010_create_oidc_user_mappings.sql` (#2997 reference; `450a3f69883a`) | numbered_forward | `3a7da1468`; strict 3.0.0 / OIDC 2.0.0 | `3a7da1468`; strict 3.0.0 / OIDC 2.0.0 | SHIPPED_SOURCE_BYTES |
| `000011_alter_suzinvites_xid_to_text.sql` (#2997 reference; `00a1eb2d9604`) | numbered_forward | `3a7da1468`; strict 3.0.0 / OIDC 2.0.0 | `3a7da1468`; strict 3.0.0 / OIDC 2.0.0 | SHIPPED_SOURCE_BYTES |
| `000012_create_topic_agenda_selections.sql` (#2997 reference; `cc513693124f`) | numbered_forward | `199569498`; strict 3.4.0 / OIDC 2.4.0 | `199569498`; strict 3.4.0 / OIDC 2.4.0 | SHIPPED_SOURCE_BYTES |
| `000013_create_treevite.sql` (#2997 reference; `4b8334f73246`) | numbered_forward | `b986fca0f`; strict 3.6.0 / OIDC 2.6.0 | `b986fca0f`; strict 3.6.0 / OIDC 2.6.0 | SHIPPED_SOURCE_BYTES |
| `000014_alter_reports_modlevel.sql` (#2997 reference; `c2af6d57af28`) | numbered_forward | `ee4405a44`; strict 3.7.2 / OIDC 2.7.2 | `ee4405a44`; strict 3.7.2 / OIDC 2.7.2 | SHIPPED_SOURCE_BYTES |
| `000015_add_xid_requirements.sql` (#2997 reference; `186c904addd0`) | numbered_forward | `a6d7215f7`; strict 3.19.0 / OIDC 2.19.0 | `06d6fa1af`; strict 3.23.0 / OIDC 2.23.0 | SHIPPED_SOURCE_BYTES |
| `000016_add_orig_id.sql` (#2997 reference; `6cdc0588c000`) | numbered_forward | `b13b316e9`; strict 3.21.0 / OIDC 2.21.0 | `b13b316e9`; strict 3.21.0 / OIDC 2.21.0 | SHIPPED_SOURCE_BYTES |
| `000017_create_byod_job_table.sql` (#2997 reference; `f27c03a1229f`) | numbered_forward | `b13b316e9`; strict 3.21.0 / OIDC 2.21.0 | `b13b316e9`; strict 3.21.0 / OIDC 2.21.0 | SHIPPED_SOURCE_BYTES |
| `000018_add_topics_enabled.sql` (#2997 reference; `a1e1c0572064`) | numbered_forward | `06d6fa1af`; strict 3.23.0 / OIDC 2.23.0 | `06d6fa1af`; strict 3.23.0 / OIDC 2.23.0 | SHIPPED_SOURCE_BYTES |
| `000019_create_polis_queue.sql` (#2997 reference; `fedfbcf9fc59`) | numbered_forward | `335418338`; strict 3.28.0 / OIDC 2.28.0 | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | SHIPPED_SOURCE_BYTES |
| `000020_create_math_source_journal.sql` (PR#2739; `24c1dff07637`) | numbered_forward | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000021_create_polis_coordinator.sql` (#2997 reference; `d50f169ad7af`) | numbered_forward | `335418338`; strict 3.28.0 / OIDC 2.28.0 | `335418338`; strict 3.28.0 / OIDC 2.28.0 | SHIPPED_SOURCE_BYTES |
| `000022_add_poll_timestamp_indexes.sql` (#2997 reference; `14efc95b1478`) | numbered_forward | `2547b6ee5`; strict 3.30.0 / OIDC 2.30.0 | `2547b6ee5`; strict 3.30.0 / OIDC 2.30.0 | SHIPPED_SOURCE_BYTES |
| `000023_create_delphi_foundation.sql` (#2997 reference; `97437ea57d90`) | numbered_forward | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | SHIPPED_SOURCE_BYTES |
| `000024_create_polis_queue_large_class.sql` (#2997 reference; `68261afb81f2`) | numbered_forward | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | SHIPPED_SOURCE_BYTES |
| `000025_vote_convention.sql` (PR#2944; `cfff57e4f416`) | numbered_forward | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000026_create_polis_queue_retention.sql` (PR#2978; `ee29e37e94f5`) | numbered_forward | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000019_create_delphi_storage.sql` (PR#2600; `5808d85fe674`) | numbered_forward | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000012_create_topic_agenda_selections.sql` (PR#2110; `cc513693124f`) | numbered_forward | `199569498`; strict 3.4.0 / OIDC 2.4.0 | `199569498`; strict 3.4.0 / OIDC 2.4.0 | PENDING_VARIANT_BYTES_ALREADY_SHIPPED |
| `000000_initial.sql` (PR#2556; `183d22c0238a`) | numbered_forward | declared 1.0 source (anchor) | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000026_create_polis_queue_retention.sql` (PR#2983; `0d1e357a72a9`) | numbered_forward | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000024_vote_sign_unflip.sql` (PR#2942; `3e67e0ab857d`) | held | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000023_vote_convention.sql` (PR#2942; `351628cfc1bc`) | fixture | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000025_drop_vote_convention.sql` (PR#2944; `9d747f6d0fe3`) | down | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000026_drop_polis_queue_retention.sql` (PR#2978; `747085bf1324`) | down | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `000026_drop_polis_queue_retention.sql` (PR#2983; `063272749473`) | down | NOT SHIPPED at checked endpoints | NOT SHIPPED at checked endpoints | PENDING_VARIANT_NOT_SHIPPED |
| `db_000002.sql` (#2997 reference; `1f214c31e557`) | archive | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `db_000004.sql` (#2997 reference; `3afacfa4c4e6`) | archive | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `db_000006.sql` (#2997 reference; `4c6f61fa0a5b`) | archive | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `db_000008.sql` (#2997 reference; `e5d4990d1dd7`) | archive | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `db_000010.sql` (#2997 reference; `498344c75e9c`) | archive | declared 1.0 source (anchor) | declared 1.0 source (anchor) | SHIPPED_SOURCE_BYTES |
| `000019_drop_polis_queue.sql` (#2997 reference; `483de532876f`) | down | `335418338`; strict 3.28.0 / OIDC 2.28.0 | `335418338`; strict 3.28.0 / OIDC 2.28.0 | SHIPPED_SOURCE_BYTES |
| `000021_drop_polis_coordinator.sql` (#2997 reference; `f8547afa1e87`) | down | `335418338`; strict 3.28.0 / OIDC 2.28.0 | `335418338`; strict 3.28.0 / OIDC 2.28.0 | SHIPPED_SOURCE_BYTES |
| `000022_drop_poll_timestamp_indexes.sql` (#2997 reference; `fcf1f4695e48`) | down | `2547b6ee5`; strict 3.30.0 / OIDC 2.30.0 | `2547b6ee5`; strict 3.30.0 / OIDC 2.30.0 | SHIPPED_SOURCE_BYTES |
| `000023_drop_delphi_foundation.sql` (#2997 reference; `aa0a3d67766a`) | down | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | SHIPPED_SOURCE_BYTES |
| `000024_drop_polis_queue_large_class.sql` (#2997 reference; `08735f922a17`) | down | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | `5ded2e0a9`; strict UNASSIGNED / OIDC UNASSIGNED | SHIPPED_SOURCE_BYTES |


The M20/M25/M26 PR-only variants, unflip fixture, archives and down scripts
are not in this release manifest. M21 is held. M4/M5/M7 are retained historical
sources and can only receive observed ADOPTED receipts in ordinary apply.

## Release B addition

M27 (`000027_create_sealed_job_graphs.sql`, SHA-256
`fbbf948e4316010dd96344ae91542006c38299e52e0a0eb281371c039ab37775`)
is selected after M19/M23/M24. It adds the approved per-step graph core.
Its strict release version remains UNASSIGNED until the release decision;
this source selection is not evidence of a production application.
M28/M29 and the DynamoDB readers/importer are not part of this release.
