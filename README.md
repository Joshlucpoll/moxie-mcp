# Moxie MCP server

A remote [MCP](https://modelcontextprotocol.io) server for the [Moxie](https://withmoxie.com)
Public API, deployable to **Cloudflare Workers** (per the
[Cloudflare remote MCP guide](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/)).
Exposes all 29 documented Moxie endpoints as MCP tools — clients, contacts, projects,
tasks, invoices, payments, expenses, time entries, opportunities, tickets, calendar, and attachments.

## How it works

`src/index.ts` defines a `McpAgent` (Durable Object) running an `McpServer`. Tools are
data-driven from a single `TOOLS` table; each call proxies to Moxie with the `X-API-KEY`
header. Two transports are mounted:

- `POST /mcp` — streamable HTTP (use this for new clients)
- `GET /sse` — SSE (legacy clients)

## Configure

Get `MOXIE_API_KEY` + `MOXIE_BASE_URL` from Moxie:
**Workspace settings → Connected Apps → Integrations → Enable Custom Integration**.

```bash
npm install

# Secrets (encrypted, per Cloudflare):
npx wrangler secret put MOXIE_API_KEY       # your Moxie workspace API key
npx wrangler secret put MCP_LOGIN_PASSWORD  # password you'll type when connecting

# One-time: KV namespace for OAuth tokens (already created if id is in wrangler.jsonc):
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
```

`MOXIE_BASE_URL` is a plain var in `wrangler.jsonc` — change the pod to yours.

### Auth

The server is an OAuth 2.1 provider (`@cloudflare/workers-oauth-provider`): `/mcp` and
`/sse` require a valid token, and connecting clients hit a login screen that checks
`MCP_LOGIN_PASSWORD`. This is what makes it usable as a **Claude custom connector**
(claude.ai / Desktop / mobile), which authenticate via OAuth, not static headers.

## Run & deploy

```bash
cp .dev.vars.example .dev.vars   # fill in, then:
npm run dev        # local at http://localhost:8787/mcp
npm test           # helper self-checks
npm run typecheck
npm run deploy     # → https://moxie-mcp.<subdomain>.workers.dev/mcp
```

## Connect a client

**Claude custom connector (cross-platform — claude.ai, Desktop, mobile, Cowork):**
Settings → Connectors → Add custom connector → paste the deployed `/mcp` URL
(`https://moxie-mcp.<subdomain>.workers.dev/mcp`). Claude runs the OAuth flow and shows
the login screen; enter your `MCP_LOGIN_PASSWORD`. Requires a Pro/Max/Team/Enterprise plan.

**Claude Code** speaks HTTP MCP natively and will do the same OAuth flow:

```bash
claude mcp add --transport http moxie https://moxie-mcp.<subdomain>.workers.dev/mcp
```

**Clients that only support stdio** (e.g. older Claude Desktop) need the
[mcp-remote](https://www.npmjs.com/package/mcp-remote) bridge, which handles the OAuth login:

```json
{
  "mcpServers": {
    "moxie": { "command": "npx", "args": ["-y", "mcp-remote", "https://moxie-mcp.<subdomain>.workers.dev/mcp"] }
  }
}
```

## Notes

- **Exact-name rule:** write tools reference other records by exact name. Call a
  `*_list` / `*_search` tool first and copy the value verbatim — the #1 cause of failures.
- **Rate limit:** 100 requests / 5 min → tools surface a clear 429 message.
- **Auth:** OAuth 2.1 via `@cloudflare/workers-oauth-provider`, gated by a single
  `MCP_LOGIN_PASSWORD` login (one user). For real multi-user access, swap the password
  screen in `authHandler` for an upstream IdP (GitHub/Google) per the Cloudflare guide.
- **Attachments:** `attachments_create` takes base64 (no local FS on Workers);
  `attachments_create_from_url` is preferred when the file is already at an HTTPS URL.
  Signed URLs returned expire after 15 min.
