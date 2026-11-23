export async function onRequestGet() {
  return new Response(JSON.stringify({ fallback: "embed" }), {
    status: 502,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
