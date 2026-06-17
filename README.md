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
npx wrangler secret put MOXIE_API_KEY
# Optional bearer gate for the MCP endpoint itself:
npx wrangler secret put MCP_AUTH_TOKEN
```

`MOXIE_BASE_URL` is a plain var in `wrangler.jsonc` — change the pod (`pod00…`) to yours.

## Run & deploy

```bash
cp .dev.vars.example .dev.vars   # fill in, then:
npm run dev        # local at http://localhost:8787/mcp
npm test           # helper self-checks
npm run typecheck
npm run deploy     # → https://moxie-mcp.<subdomain>.workers.dev/mcp
```

## Connect a client

Point any MCP client at the deployed `/mcp` URL. For the
[mcp-remote](https://www.npmjs.com/package/mcp-remote) bridge (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "moxie": { "command": "npx", "args": ["mcp-remote", "https://moxie-mcp.<subdomain>.workers.dev/mcp"] }
  }
}
```

If `MCP_AUTH_TOKEN` is set, add `--header "Authorization: Bearer <token>"` to the args.

## Notes

- **Exact-name rule:** write tools reference other records by exact name. Call a
  `*_list` / `*_search` tool first and copy the value verbatim — the #1 cause of failures.
- **Rate limit:** 100 requests / 5 min → tools surface a clear 429 message.
- **Auth:** this ships with a single workspace key + optional shared bearer. For
  multi-user OAuth, swap the `fetch` gate for the Workers OAuth Provider from the
  Cloudflare guide. _(ponytail: skipped — add when more than one person needs scoped access.)_
- **Attachments:** `attachments_create` takes base64 (no local FS on Workers);
  `attachments_create_from_url` is preferred when the file is already at an HTTPS URL.
  Signed URLs returned expire after 15 min.
