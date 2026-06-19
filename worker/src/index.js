const ALLOWED_ORIGINS = [
  'https://prachidpatel.github.io',
  'http://localhost:8080',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed ? origin : ALLOWED_ORIGINS[0]) });
    }

    if (!allowed) {
      return new Response(JSON.stringify({ error: 'origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'invalid date' }), {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    const nasaUrl = `https://api.nasa.gov/planetary/apod?api_key=${env.NASA_API_KEY}&date=${date}&hd=false`;

    let nasaRes;
    try {
      nasaRes = await fetch(nasaUrl, { signal: AbortSignal.timeout(8000) });
    } catch {
      return new Response(JSON.stringify({ error: 'nasa upstream timed out' }), {
        status: 504,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }
    const body = await nasaRes.text();

    return new Response(body, {
      status: nasaRes.status,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  },
};
