# C3 rev1.3 scoped rollback

No rollback has been executed on production.

Stop new UAT requests first. Re-read version, bundle digest, SQL definition/ACL and any dependencies; stop if another owner has advanced them. Restore changed Edge slugs in dependency reverse order using saved full bundles and original verify_jwt. Version numbers will advance; verify actual bytes.

S03: run the adjacent exact baseline RPC/ACL restore transaction only when current RPC matches this release. Keep the additive cache and any legitimate derived rows; this is functional rollback, not exact schema rollback. No conversation, queue or message deletion.

S02: keep appearance_theme/launcher_icon additive columns and constraints once published callers or production writes depend on them. Restore affected application behavior; do not drop data to claim exact rollback.

S01: only the five exact new tenant RPC signatures may be revoked/dropped, without CASCADE, after source/function callers are safely restored and pg_depend/current-owner checks demonstrate no other consumers. Baseline had none. Any dependency or subsequent owner change blocks automatic removal. Existing Auth users, legacy RPCs and audit records are untouched.

Source: same-branch forward revert or bounded verified repair; no reset or force push. Keep the single approved nrfx target; do not silently reactivate the old Demo as a product. No merge or frontend Publish.
