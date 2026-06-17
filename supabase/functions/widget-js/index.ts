import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async () => {
  const js = await Deno.readTextFile(
    new URL("./chat.js", import.meta.url),
  );
  return new Response(js, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
  });
});
