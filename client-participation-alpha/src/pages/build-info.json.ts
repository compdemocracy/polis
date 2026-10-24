export const prerender = true

export function GET() {
  return new Response(JSON.stringify(process.env.POLIS_BUILD_INFO), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  })
}
