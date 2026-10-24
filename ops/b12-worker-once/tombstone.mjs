// Deployed only during approved cleanup of the new executor, never the Worker.
Deno.serve(()=>Response.json({state:'DISABLED',worker_send_attempts:0},{status:410}));
