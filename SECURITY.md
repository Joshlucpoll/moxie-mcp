# Security notes

## Dependency audit

`npm audit` flags issues that are **not exploitable in this server's configuration**.
Run `npm audit --omit=dev` to see only what actually deploys to the Worker.

**No critical or high severity issues ship.** The high/critical findings from a plain
`npm audit` (`undici`, `ws`, `esbuild`) live inside `wrangler`/`miniflare` — the *local
dev simulator*. They never deploy: production runs on Cloudflare's `workerd` runtime, not
these npm packages. We track the latest `wrangler` major to keep that tooling current.

### Residual production findings (moderate/low) — accepted

All remaining findings are in features of the `agents` SDK (and its bundled Vercel `ai`
SDK) that this server **does not use**:

| Advisory | Why it doesn't apply here |
|----------|---------------------------|
| `agents` IDOR via header-based **email routing** | We only route `/mcp` and `/sse`. No email handler is registered. |
| `agents` reflected XSS in the **AI Playground** (×2, incl. OAuth callback) | The AI Playground UI is never mounted or exposed. |
| `ai` / `@ai-sdk/provider-utils` (low) | The Vercel AI SDK is a transitive dep of `agents`; this server never calls it. |

The clean fix (`agents@0.16+`) currently has an unresolvable peer-dependency graph
(`ai@^6` + `@cloudflare/ai-chat`). **Revisit the upgrade when that resolves** — at which
point the three `agents` advisories clear directly.

`jsondiffpatch` (XSS in its HTML diff formatter) is pinned to `^0.7.2` via `overrides` in
`package.json`, which resolves the advisory without the broken `agents` major bump.

## Secrets

`MOXIE_API_KEY` (and optional `MCP_AUTH_TOKEN`) are Cloudflare Worker secrets — never
committed. `MOXIE_BASE_URL` is a non-secret var. The local `.dev.vars` file is gitignored.

If `MCP_AUTH_TOKEN` is unset the `/mcp` and `/sse` endpoints are unauthenticated — set it
(or front the Worker with Cloudflare Access) for any non-trivial deployment.
