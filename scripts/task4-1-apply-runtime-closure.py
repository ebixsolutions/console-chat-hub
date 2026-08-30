from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected=(0, 1)) -> bool:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count not in expected:
        raise SystemExit(f"FAIL {path}: expected replacement count {expected}, got {count} for {old[:80]!r}")
    if count == 0:
        return False
    p.write_text(text.replace(old, new))
    print(f"PATCH {path}: {count} replacement(s)")
    return True

changed = False

# Canonical KB orchestration is now the production default. Operators may only
# explicitly disable it with ENABLE_KB_ADAPTER=false for emergency rollback.
changed |= replace_exact(
    "supabase/functions/generate-reply/index.ts",
    'const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") === "true";',
    'const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") !== "false";',
)

# Required escalation runtime is product-default-on with explicit false rollback.
changed |= replace_exact(
    "supabase/functions/generate-reply/index.ts",
    'if (Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") !== "true") return null;',
    'if (Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "false") return null;',
)
changed |= replace_exact(
    "supabase/functions/generate-reply/index.ts",
    'if (flags.enable_full_ruleset || flags.enable_r2) enabled.add("R2");',
    'enabled.add("R2");',
)
changed |= replace_exact(
    "supabase/functions/generate-reply/index.ts",
    'const _escEnableS0 = Deno.env.get("ESC_ENABLE_S0") === "true";',
    'const _escEnableS0 = Deno.env.get("ESC_ENABLE_S0") !== "false";',
)

# Migrate all Task 4.1 privileged internal clients to the server-only modern
# admin-key resolver, while retaining the Supabase-hosted safe fallback there.
changed |= replace_exact(
    "supabase/functions/generate-reply/index.ts",
    'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";',
    'import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";\nimport { createClient } from "https://esm.sh/@supabase/supabase-js@2";',
)
changed |= replace_exact(
    "supabase/functions/generate-reply/index.ts",
    'createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")',
    'createClient(Deno.env.get("SUPABASE_URL") ?? "", getSupabaseAdminKey())',
    expected=(0, 2),
)

changed |= replace_exact(
    "supabase/functions/_shared/kb-client.ts",
    'import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";',
    'import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";\nimport { getSupabaseAdminKey } from "./supabase-admin-key.ts";',
)
changed |= replace_exact(
    "supabase/functions/_shared/kb-client.ts",
    '    const supabaseUrl = Deno.env.get("SUPABASE_URL");\n    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");\n    if (!supabaseUrl || !serviceRoleKey) {',
    '    const supabaseUrl = Deno.env.get("SUPABASE_URL");\n    let serviceRoleKey = "";\n    try { serviceRoleKey = getSupabaseAdminKey(); } catch { serviceRoleKey = ""; }\n    if (!supabaseUrl || !serviceRoleKey) {',
)

changed |= replace_exact(
    "supabase/functions/_shared/llm-router.ts",
    'import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";',
    'import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";\nimport { getSupabaseAdminKey } from "./supabase-admin-key.ts";',
)
changed |= replace_exact(
    "supabase/functions/_shared/llm-router.ts",
    '    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,',
    '    getSupabaseAdminKey(),',
)

# Static guard: no active Task 4.1 source may restore the legacy generation flag semantics.
text = Path("supabase/functions/generate-reply/index.ts").read_text()
assert 'Deno.env.get("ENABLE_KB_ADAPTER") !== "false"' in text
assert 'enabled.add("R2");' in text
assert 'Deno.env.get("ESC_ENABLE_S0") !== "false"' in text
assert 'getSupabaseAdminKey()' in text

print("TASK4_1_PATCH_RESULT=" + ("CHANGED" if changed else "ALREADY_APPLIED"))
