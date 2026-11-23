export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target || !target.startsWith("http")) {
    return new Response(JSON.stringify({ error: "Invalid URL" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const headers = new Headers({ "User-Agent": "Mozilla/5.0" });
  const range = context.request.headers.get("Range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(target, { headers, redirect: "follow" });
  const respHeaders = new Headers();
  respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
  respHeaders.set("Accept-Ranges", "bytes");
  respHeaders.set("Access-Control-Allow-Origin", "*");
  for (const h of ["Content-Length", "Content-Range"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  const dl = reqUrl.searchParams.get("download");
  if (dl) {
    respHeaders.set("Content-Disposition", `attachment; filename="${dl.replace(/["\\]/g, "")}"`);
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
