import { resolveSupabaseAllowedHeaders, supabaseCorsHeaders } from "../../supabase/functions/_shared/supabase-cors.ts";
function eq(a:unknown,b:unknown,l:string){if(a!==b)throw new Error(`${l}: expected ${b}, got ${a}`);}
Deno.test("Supabase invoke headers allowed",()=>{const r="authorization, x-client-info, apikey, content-type, x-supabase-api-version";eq(resolveSupabaseAllowedHeaders(r),r,"headers");const o="https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app";const h=supabaseCorsHeaders(o,["https://console-chat-hub.lovable.app",o],r);eq(h["Access-Control-Allow-Origin"],o,"origin");eq(h["Access-Control-Allow-Headers"],r,"allow");});
Deno.test("unknown header rejected",()=>eq(resolveSupabaseAllowedHeaders("authorization, x-evil"),"","unknown"));
