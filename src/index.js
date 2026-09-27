export default {
async fetch(request, env) {
const url = new URL(request.url);

if (url.pathname === "/api/config") {
  return new Response(
    JSON.stringify({
      supabaseUrl: "https://xbhztvjdzqpsdjtwmpys.supabase.co",
      supabaseAnonKey: env.SUPABASE_ANON_KEY || ""
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=UTF-8"
      }
    }
  );
}

return env.ASSETS.fetch(request);

}
};
