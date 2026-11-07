// Cloudflare Worker entry point.
//
// Static game assets are served by the assets binding. This handler only sees
// requests that no asset matches, so it owns the small dynamic surface:
//   /health      liveness and basic service info
//   /presence    WebSocket relay (not ported yet)

const BUILD_ID = 'pokeemerald-3d';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        build: BUILD_ID,
        presence: 'not_deployed',
      }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (url.pathname === '/presence') {
      return new Response('presence relay is not deployed yet\n', {
        status: 501,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
