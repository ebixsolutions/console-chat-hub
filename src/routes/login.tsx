import { createFileRoute, useNavigate, useSearch, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  ssr: false,
  beforeLoad: async ({ search }) => {
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const target = search.redirect;
      if (typeof target === "string" && target.startsWith("/") && !target.startsWith("//")) {
        throw redirect({ href: target });
      }
      throw redirect({ to: "/console" });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const safeRedirect = (() => {
    const r = search.redirect;
    if (typeof r === "string" && r.startsWith("/") && !r.startsWith("//")) return r;
    return null;
  })();
  const postAuthTarget = safeRedirect ?? "/console";
  const oauthRedirectUri =
    typeof window !== "undefined"
      ? `${window.location.origin}${safeRedirect ?? ""}`
      : undefined;

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: oauthRedirectUri },
        });
        if (error) throw error;
      }
      navigate({ to: postAuthTarget });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: oauthRedirectUri ? { redirectTo: oauthRedirectUri } : undefined,
      });
      if (error) throw error;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google sign-in failed");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{mode === "signin" ? "Sign in" : "Create account"}</CardTitle>
          <CardDescription>Access your support console</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleEmail} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {mode === "signin" ? "Sign in" : "Sign up"}
            </Button>
          </form>
          <Button type="button" variant="outline" className="w-full" onClick={handleGoogle} disabled={loading}>
            Continue with Google
          </Button>
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="w-full text-sm text-muted-foreground hover:text-foreground"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
