export type WidgetOriginCheck =
  | { ok: true; origin: string }
  | {
      ok: false;
      error:
        | "widget_origin_missing"
        | "widget_allowed_origins_unconfigured"
        | "widget_allowed_origin_invalid"
        | "widget_origin_not_allowed";
    };

function canonicalOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;

    const allowHttpLocalhost =
      Deno.env.get("WIDGET_ALLOW_HTTP_LOCALHOST") === "true";
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";

    if (url.protocol !== "https:" && !(allowHttpLocalhost && isLocalhost)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function requestWidgetOrigin(req: Request): string | null {
  const origin = req.headers.get("origin")?.trim();
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }

  const referer = req.headers.get("referer")?.trim();
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function validateWidgetOrigin(
  req: Request,
  allowedOrigins: unknown,
): WidgetOriginCheck {
  const requestOrigin = requestWidgetOrigin(req);
  if (!requestOrigin) {
    return { ok: false, error: "widget_origin_missing" };
  }

  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return { ok: false, error: "widget_allowed_origins_unconfigured" };
  }

  const canonicalAllowed = new Set<string>();
  for (const raw of allowedOrigins) {
    if (typeof raw !== "string" || raw.trim() === "" || raw.trim() === "*") {
      return { ok: false, error: "widget_allowed_origin_invalid" };
    }
    const canonical = canonicalOrigin(raw.trim());
    if (!canonical) {
      return { ok: false, error: "widget_allowed_origin_invalid" };
    }
    canonicalAllowed.add(canonical);
  }

  if (!canonicalAllowed.has(requestOrigin)) {
    return { ok: false, error: "widget_origin_not_allowed" };
  }

  return { ok: true, origin: requestOrigin };
}
