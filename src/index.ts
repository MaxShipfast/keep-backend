/**
 * Keep scan backend — Cloudflare Worker.
 *
 * POST /scan  { imageBase64: string, mediaType?: 'image/jpeg' | 'image/png' }
 *   -> { food, proteinG, calories, carbsG, portion, confidence }
 *
 * Env vars:
 *   OPENAI_API_KEY  — required (set with `npx wrangler secret put OPENAI_API_KEY`)
 *   APP_TOKEN       — optional shared secret; when set, requests must send
 *                     Authorization: Bearer <APP_TOKEN>
 *   MODEL           — optional, defaults to gpt-5-mini
 */

export interface Env {
  OPENAI_API_KEY: string;
  APP_TOKEN?: string;
  MODEL?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MEAL_SCHEMA = {
  name: 'meal_estimate',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      food: { type: 'string', description: 'Short name of the dish, e.g. "Grilled chicken salad"' },
      proteinG: { type: 'integer', description: 'Estimated grams of protein in the visible portion' },
      calories: { type: 'integer', description: 'Estimated total calories' },
      carbsG: { type: 'integer', description: 'Estimated grams of carbohydrates' },
      portion: { type: 'string', description: 'Human-readable portion estimate, e.g. "1.5 cups"' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['food', 'proteinG', 'calories', 'carbsG', 'portion', 'confidence'],
    additionalProperties: false,
  },
} as const;

const SYSTEM = `You estimate nutrition from a single food photo for a protein-tracking app whose users are on GLP-1 medications (small portions are common — do not assume standard serving sizes; estimate what is actually visible).
Rules:
- Estimate the VISIBLE portion only.
- Protein accuracy matters most; calories and carbs are secondary.
- If the image is not food, set food to "Not food detected", all numbers to 0, confidence "low".`;

/**
 * Per-IP rate limit. In-memory per isolate — not airtight (isolates recycle,
 * multiple POPs), but it blunts token-extraction abuse and costs nothing.
 * Belt-and-suspenders: also set a monthly spend limit in the OpenAI dashboard.
 * If real abuse appears, upgrade to Cloudflare WAF rate rules or Durable Objects.
 */
const RATE_LIMIT = 20; // scans per IP per 10 minutes
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    if (hits.size > 10_000) hits.clear(); // bound memory
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/terms')) {
      return new Response(url.pathname === '/privacy' ? PRIVACY_HTML : TERMS_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    if (url.pathname !== '/scan' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404);
    }

    if (env.APP_TOKEN) {
      const auth = request.headers.get('Authorization') ?? '';
      if (auth !== `Bearer ${env.APP_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (rateLimited(ip)) return json({ error: 'Too many scans — try again in a few minutes' }, 429);

    if (!env.OPENAI_API_KEY) return json({ error: 'Server not configured' }, 500);

    let body: { imageBase64?: string; mediaType?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const imageBase64 = body.imageBase64 ?? '';
    if (!imageBase64 || imageBase64.length > 8_000_000) {
      return json({ error: 'imageBase64 missing or too large (max ~6MB image)' }, 400);
    }
    const mediaType = body.mediaType === 'image/png' ? 'image/png' : 'image/jpeg';

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.MODEL ?? 'gpt-5-mini',
        max_completion_tokens: 2000,
        response_format: { type: 'json_schema', json_schema: MEAL_SCHEMA },
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
              { type: 'text', text: 'Estimate this meal.' },
            ],
          },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const detail = await openaiRes.text();
      return json({ error: 'Vision model error', detail: detail.slice(0, 300) }, 502);
    }

    const data = (await openaiRes.json()) as {
      choices: Array<{ message: { content: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return json({ error: 'No structured result from model' }, 502);

    try {
      return json(JSON.parse(content), 200);
    } catch {
      return json({ error: 'Model returned invalid JSON' }, 502);
    }
  },
};

const PAGE_STYLE = `<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0A0E15;color:#F2F5FA;max-width:680px;margin:0 auto;padding:48px 24px;line-height:1.65}
  h1{font-size:26px;letter-spacing:-.02em}h2{font-size:17px;margin-top:28px}
  p,li{color:#95A0B4;font-size:15px}a{color:#3D7BFF}
</style>`;

const PRIVACY_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keep — Privacy Policy</title>${PAGE_STYLE}</head><body>
<h1>Keep — Privacy Policy</h1>
<p>Effective: August 2026</p>
<h2>The short version</h2>
<p>Your health data stays on your phone. Keep has no accounts and no server database of user data.</p>
<h2>Data stored on your device</h2>
<p>Your quiz answers (medication, injection day, weight, training habits, goal), logged meals, workouts, weigh-ins, and scores are stored locally on your device only. Deleting the app deletes this data. We cannot access it.</p>
<h2>Meal photos</h2>
<p>When you scan a meal, the photo is sent over an encrypted connection to our server, which forwards it to OpenAI's API to estimate nutrition. The photo is processed transiently and is not stored by Keep. It is subject to OpenAI's API data policies, which do not use API data for model training by default.</p>
<h2>Purchases</h2>
<p>Subscriptions are processed by Apple. We never see your payment details. Purchase state may be managed by RevenueCat, our subscription infrastructure provider, using an anonymous identifier.</p>
<h2>Analytics</h2>
<p>We collect anonymous usage events (for example, that a scan happened) to improve the app. No health values, photos, or personal identifiers are included.</p>
<h2>Not medical advice</h2>
<p>Keep provides general nutrition tracking. It is not medical advice. Always follow your prescriber's instructions.</p>
<h2>Contact</h2>
<p>Questions: <a href="mailto:info@shipfast.agency">info@shipfast.agency</a></p>
</body></html>`;

const TERMS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keep — Terms of Use</title>${PAGE_STYLE}</head><body>
<h1>Keep — Terms of Use</h1>
<p>Effective: August 2026</p>
<h2>Service</h2>
<p>Keep is a nutrition-tracking app for people on GLP-1 medications. Nutrition estimates are AI-generated approximations and may be inaccurate. Keep is not a medical device and provides no medical advice; consult your prescriber for medical decisions.</p>
<h2>Subscriptions</h2>
<p>Keep Pro is an auto-renewing subscription billed through your Apple ID (yearly with a free trial, or weekly). It renews unless cancelled at least 24 hours before the period ends. Manage or cancel anytime in your device Settings. Apple's standard <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">EULA</a> applies.</p>
<h2>Acceptable use</h2>
<p>Don't abuse, reverse-engineer, or resell the service or its scanning API.</p>
<h2>Liability</h2>
<p>The service is provided "as is" without warranties. To the maximum extent permitted by law, our liability is limited to the amount you paid in the last 12 months.</p>
<h2>Contact</h2>
<p><a href="mailto:info@shipfast.agency">info@shipfast.agency</a></p>
</body></html>`;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
