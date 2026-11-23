export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target || !target.startsWith("http")) {
    return new Response(JSON.stringify({ error: "Invalid URL" }), { status: 400 });
  }
  const upstream = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "image/jpeg",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
