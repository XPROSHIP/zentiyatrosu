export async function onRequestGet(context) {
  const url = new URL("/catalog.json", context.request.url);
  return context.env.ASSETS.fetch(url);
}
