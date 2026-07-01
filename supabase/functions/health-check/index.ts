export default async (req: Request, env: any, ctx: any) => {
  return new Response(JSON.stringify({
    ok: true,
    time: new Date().toISOString(),
    has_url: !!env.SUPABASE_URL,
    has_key: !!env.SUPABASE_ANON_KEY,
    has_secret: !!env.SUPABASE_SERVICE_ROLE_KEY,
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
