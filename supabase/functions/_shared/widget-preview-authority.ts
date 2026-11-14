/** JWT is verified by Auth; browser actor/company/preview fields never grant authority. */
export async function previewActorClient(req: Request, createClient: any, url: string, anon: string) {
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return null;
  const client = createClient(url,anon,{global:{headers:{Authorization:authorization,Origin:req.headers.get("origin") ?? ""}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const {data,error}=await client.auth.getUser(authorization.replace(/^Bearer\s+/i,""));
  return error || !data?.user?.id ? null : {client,actorId:data.user.id};
}
