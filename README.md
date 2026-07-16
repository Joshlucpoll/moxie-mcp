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

## Available MCP actions

The server exposes the following 29 MCP tools. Arguments described as names (such as
`clientName`, `projectName`, `templateName`, `stageName`, vendor names, and user emails)
must exactly match the corresponding record in Moxie. Use a list or search tool first
when you do not already know the exact value.

### Read and discovery tools

| MCP tool | What it can do | Moxie endpoint |
| --- | --- | --- |
| `clients_list` | List all clients as full objects and discover exact client names. | `GET /action/clients/list` |
| `clients_search` | Search clients by a name prefix, contact email, or contact name. Requires `query`. | `GET /action/clients/search` |
| `contacts_search` | Search contacts by first name, last name, or email. The `query` filter is optional. | `GET /action/contacts/search` |
| `projects_search` | Search projects, optionally filtering by client name. | `GET /action/projects/search` |
| `payable_invoices_search` | Search payable invoices, optionally filtering by client name. | `GET /action/payableInvoices/search` |
| `email_templates_list` | List available email template names. | `GET /action/emailTemplates/list` |
| `invoice_templates_list` | List available invoice template names. | `GET /action/invoiceTemplates/list` |
| `vendors_list` | List available vendor names. | `GET /action/vendors/list` |
| `form_names_list` | List available form-template names. | `GET /action/formNames/list` |
| `pipeline_stages_list` | List pipeline stages, including ID, label, color, and stage type. | `GET /action/pipelineStages/list` |
| `task_stages_list` | List project task/Kanban stages. | `GET /action/taskStages/list` |
| `users_list` | List workspace users, including emails, roles, and access. | `GET /action/users/list` |

### Create, update, and delete tools

| MCP tool | What it can do | Required inputs | Moxie endpoint |
| --- | --- | --- | --- |
| `clients_create` | Create a client or prospect, optionally with address, payment terms, notes, and contacts. | `name`, `clientType`, `currency` | `POST /action/clients/create` |
| `contacts_create` | Create a contact, optionally assigning it to an existing client. | None | `POST /action/contacts/create` |
| `invoices_create` | Create an invoice and optionally email it using `sendTo.send=true`, contacts, and an email template. | `clientName`, `items` | `POST /action/invoices/create` |
| `expenses_create` | Create an expense, optionally assigning a vendor and client. | `currency`, `paid`, `reimbursable` | `POST /action/expenses/create` |
| `form_submissions_create` | Create a form submission and optionally create a pipeline opportunity by supplying `pipelineStageName`. | None | `POST /action/formSubmissions/create` |
| `projects_create` | Create a project from project details or a template, with an optional fee schedule and portal settings. | `name`, `clientName`; `feeSchedule` unless using `templateName` | `POST /action/projects/create` |
| `tasks_create` | Create a project task with optional status, dates, priority, checklist subtasks, assignees, and custom values. | `name`, `clientName`, `projectName` | `POST /action/tasks/create` |
| `deliverable_approve` | Approve a deliverable that is in Client Workflow/Approval status. | `clientName`, `projectName`, `deliverableName` | `POST /action/deliverable/approve` |
| `tickets_create` | Create a support ticket with optional subject, due date, and form answers. | `userEmail`, `ticketType`, `comment` | `POST /action/tickets/create` |
| `ticket_comments_create` | Add a public or private comment to an existing ticket. Private comments are ignored for client contacts. | `userEmail`, `ticketNumber`, `comment` | `POST /action/tickets/comments/create` |
| `opportunities_create` | Create a pipeline opportunity with optional client, stage, value, close date, lead data, to-dos, and custom values. | `name` | `POST /action/opportunities/create` |
| `time_entries_create` | Log time for a user against an optional client, project, or deliverable; missing records can be created with the corresponding `create*` flags. | `timerStart`, `timerEnd`, `userEmail` | `POST /action/timeWorked/create` |
| `payments_create` | Apply a payment to an invoice, with an optional payment type, reference number, and memo. | `date`, `amount`, `invoiceNumber` | `POST /action/payment/create` |
| `attachments_create` | Upload a base64-encoded file (up to 100 MB) to a client, project, deliverable, opportunity, expense, or ticket. | `type`, `id`, `fileName`, `fileBase64` | `POST /action/attachments/create` |
| `attachments_create_from_url` | Ask Moxie to fetch an HTTPS file and attach it to a client, project, deliverable, opportunity, expense, or ticket. | `type`, `id`, `fileName`, `fileUrl` | `POST /action/attachments/createFromUrl` |
| `calendar_create_or_update` | Create a calendar event or update it by reusing its `eventId`. Supports description, location, busy state, timezone, and workspace user assignment. | `eventId`, `startTime`, `endTime`, `timezone`, `summary` | `POST /action/calendar/createOrUpdate` |
| `calendar_delete` | Delete a calendar event using the `eventId` supplied when it was created. | `eventId` | `DELETE /action/calendar/{eventId}` |

Attachment tools return signed URLs that expire after 15 minutes. Moxie's API does not
provide a tool to void or delete an invoice; that action must be completed in the Moxie UI.

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
