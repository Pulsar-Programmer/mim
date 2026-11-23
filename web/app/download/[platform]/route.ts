import { downloadUrl } from "../../../lib/release";

export async function GET(_: Request, { params }: { params: Promise<{ platform: string }> }) {
  const url = await downloadUrl((await params).platform);
  if (!url) return new Response("Unknown platform", { status: 404 });
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" },
  });
}
