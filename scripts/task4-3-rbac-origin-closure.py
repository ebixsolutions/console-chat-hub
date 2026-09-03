from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))


svc = "src/lib/api/config.service.ts"
route = "src/routes/_authenticated/console.channel-settings.tsx"

# Defense in depth: protected channel settings reads are Admin/Supervisor only.
replace_once(
    svc,
'''    const scope = await resolveCompanyScope({
      supabase: context.supabase,
      userId: String(context.userId),
    });
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    const { data, error } = await context.supabase
      .from("channel_config")''',
'''    const scope = requireRole(
      await resolveCompanyScope({
        supabase: context.supabase,
        userId: String(context.userId),
      }),
      ["admin", "supervisor"],
    );
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    const { data, error } = await context.supabase
      .from("channel_config")''',
)

# Apply the same read/write role contract to widget settings resolved through a channel.
replace_once(
    svc,
'''async function resolveOwnedWidget(
  context: { supabase: any; userId: string },
  channelId: string,
  requireAdmin: boolean,
): Promise<ServerResult<{ companyId: string; widgetId: string }>> {
  let scope = await resolveCompanyScope(context);
  if (requireAdmin) scope = requireRole(scope, ["admin"]);''',
'''async function resolveOwnedWidget(
  context: { supabase: any; userId: string },
  channelId: string,
  allowedRoles: readonly AppRole[],
): Promise<ServerResult<{ companyId: string; widgetId: string }>> {
  const scope = requireRole(await resolveCompanyScope(context), allowedRoles);''',
)
replace_once(
    svc,
'''      data.channel_id,
      false,
    );''',
'''      data.channel_id,
      ["admin", "supervisor"],
    );''',
)
replace_once(
    svc,
'''      data.channel_id,
      true,
    );''',
'''      data.channel_id,
      ["admin"],
    );''',
)

# Supervisor keeps the frozen read access contract; write controls are Admin only.
replace_once(
    route,
'''  return <ChannelSettingsContent />;
}

function ChannelSettingsContent() {''',
'''  return <ChannelSettingsContent canManage={productionRole === "admin"} />;
}

function ChannelSettingsContent({ canManage }: { canManage: boolean }) {''',
)
replace_once(
    route,
'''              ) : (
                <button
                  type="button"
                  disabled={bindingChannelId === ch.id || source !== "live"}''',
'''              ) : canManage ? (
                <button
                  type="button"
                  disabled={bindingChannelId === ch.id || source !== "live"}''',
)
replace_once(
    route,
'''                  {bindingChannelId === ch.id ? "Binding…" : "Bind to my company"}
                </button>
              )}
            </div>''',
'''                  {bindingChannelId === ch.id ? "Binding…" : "Bind to my company"}
                </button>
              ) : (
                <div style={{ fontSize: 10, color: "#64748b" }}>Admin permission is required to bind this channel.</div>
              )}
            </div>''',
)
replace_once(
    route,
'''            {editingChannelId === ch.id ? (''',
'''            {canManage && (editingChannelId === ch.id ? (''',
)
replace_once(
    route,
'''            )}
            {ch.channel_type === "website_widget" && (
              <button
                onClick={() => setPreviewChannelId(ch.id)}''',
'''            ))}
            {ch.channel_type === "website_widget" && (
              <button
                onClick={() => setPreviewChannelId(ch.id)}''',
)

for path, needles in {
    svc: [
        '["admin", "supervisor"]',
        'allowedRoles: readonly AppRole[]',
        'requireRole(await resolveCompanyScope(context), allowedRoles)',
    ],
    route: [
        'ChannelSettingsContent canManage={productionRole === "admin"}',
        'function ChannelSettingsContent({ canManage }',
        'Admin permission is required to bind this channel.',
        'canManage && (editingChannelId === ch.id ? (',
    ],
}.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"missing postcondition {needle!r} in {path}")

print("TASK4_3_RBAC_SOURCE_PATCH=PASS")
