# AI Proxy (Vercel + Cloudflare Workers)

This project exposes a public chat completions endpoint that proxies requests to Hack Club AI.

- Upstream endpoint: `https://ai.hackclub.com/proxy/v1/chat/completions`
- Upstream auth: `Authorization: Bearer <HACK_CLUB_AI_API_KEY>` (server-side only)
- Public endpoint: no API key required
- Default model: `z-ai/glm-5.1` (used when request body does not include `model`)

## Endpoints

- Vercel: `POST /api/v1/chat/completions`
- Cloudflare Worker: `POST /v1/chat/completions`

## Request format

Send an OpenAI-compatible chat completions JSON payload.

```bash
curl https://<your-domain>/api/v1/chat/completions \
	-H "Content-Type: application/json" \
	-d '{
		"messages": [
			{"role": "user", "content": "Tell me a joke."}
		]
	}'
```

If `model` is omitted, the proxy sends:

```json
{
	"model": "z-ai/glm-5.1"
}
```

## Environment variables

- `HACK_CLUB_AI_API_KEY` (required)
- `HACKCLUB_BASE_URL` (optional, defaults to `https://ai.hackclub.com/proxy/v1/chat/completions`)

Use `.env.example` as reference.

## Deploy on Vercel

1. Import this repo in Vercel.
2. Set `HACK_CLUB_AI_API_KEY` in Project Settings -> Environment Variables.
3. Deploy.
4. Use `https://<your-vercel-domain>/api/v1/chat/completions`.

## Deploy on Cloudflare Workers

1. Install dependencies:

```bash
npm install
```

2. Set secret:

```bash
npx wrangler secret put HACK_CLUB_AI_API_KEY
```

3. Deploy:

```bash
npm run deploy:cf
```

4. Use `https://<your-worker-domain>/v1/chat/completions`.