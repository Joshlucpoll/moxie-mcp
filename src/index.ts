import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { buildUrl, buildAttachmentForm } from "./lib";

export interface Env {
  MOXIE_API_KEY: string;
  MOXIE_BASE_URL: string; // e.g. https://pod01.withmoxie.com/api/public
  MCP_LOGIN_PASSWORD: string; // single-user password for the OAuth login screen
  OAUTH_KV: KVNamespace; // token/grant storage for the OAuth provider
  OAUTH_PROVIDER: OAuthHelpers; // injected by OAuthProvider at runtime
  MoxieMCP: DurableObjectNamespace;
}

type FetchOpts = { query?: Record<string, unknown>; json?: unknown; form?: FormData };

async function moxie(env: Env, method: string, path: string, opts: FetchOpts = {}): Promise<string> {
  const headers: Record<string, string> = { "X-API-KEY": env.MOXIE_API_KEY };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form; // fetch sets multipart boundary
  }
  const res = await fetch(buildUrl(env.MOXIE_BASE_URL, path, opts.query), { method, headers, body });
  const text = await res.text();
  if (res.status === 429) throw new Error("Moxie rate limit: 100 requests / 5 min. Wait, then retry.");
  if (!res.ok) throw new Error(`Moxie ${res.status}: ${text}`);
  return text;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

// --- reusable nested schemas (kept loose where Moxie nests deeply) ---
const contact = z.object({
  firstName: z.string().optional(), lastName: z.string().optional(), role: z.string().optional(),
  phone: z.string().optional(), email: z.string().optional(), notes: z.string().optional(),
  defaultContact: z.boolean().optional(), invoiceContact: z.boolean().optional(), portalAccess: z.boolean().optional(),
});
const invoiceItem = z.object({
  description: z.string(), quantity: z.number(), rate: z.number(),
  taxable: z.boolean().optional(), projectName: z.string().optional(),
});
const answer = z.object({ fieldKey: z.string(), question: z.string(), answer: z.string() });

// exact-name reminder reused in write descriptions
const X = "Names (clientName/projectName/templateName/stageName/vendor/userEmail/etc.) must EXACTLY match existing records — look them up via a list/search tool first.";

type Tool = { name: string; description: string; shape: ZodRawShape; run: (env: Env, a: any) => Promise<string> };

const TOOLS: Tool[] = [
  // ---------- reads ----------
  { name: "clients_list", description: "List all clients (full objects). Use to discover exact client names.", shape: {},
    run: (e) => moxie(e, "GET", "/action/clients/list") },
  { name: "clients_search", description: "Search clients by name (starts-with), contact email, or contact name.", shape: { query: z.string() },
    run: (e, a) => moxie(e, "GET", "/action/clients/search", { query: a }) },
  { name: "contacts_search", description: "Search contacts by first/last/email. query optional.", shape: { query: z.string().optional() },
    run: (e, a) => moxie(e, "GET", "/action/contacts/search", { query: a }) },
  { name: "projects_search", description: "Search projects; query optionally filters by client name.", shape: { query: z.string().optional() },
    run: (e, a) => moxie(e, "GET", "/action/projects/search", { query: a }) },
  { name: "payable_invoices_search", description: "Search payable invoices; query optionally filters by client name.", shape: { query: z.string().optional() },
    run: (e, a) => moxie(e, "GET", "/action/payableInvoices/search", { query: a }) },
  { name: "email_templates_list", description: "List email template names.", shape: {}, run: (e) => moxie(e, "GET", "/action/emailTemplates/list") },
  { name: "invoice_templates_list", description: "List invoice template names.", shape: {}, run: (e) => moxie(e, "GET", "/action/invoiceTemplates/list") },
  { name: "vendors_list", description: "List vendor names.", shape: {}, run: (e) => moxie(e, "GET", "/action/vendors/list") },
  { name: "form_names_list", description: "List form-template names.", shape: {}, run: (e) => moxie(e, "GET", "/action/formNames/list") },
  { name: "pipeline_stages_list", description: "List pipeline stages [{id,label,hexColor,stageType}].", shape: {}, run: (e) => moxie(e, "GET", "/action/pipelineStages/list") },
  { name: "task_stages_list", description: "List project task/kanban stages.", shape: {}, run: (e) => moxie(e, "GET", "/action/taskStages/list") },
  { name: "users_list", description: "List workspace users (emails, roles, access).", shape: {}, run: (e) => moxie(e, "GET", "/action/users/list") },

  // ---------- writes ----------
  { name: "clients_create",
    description: `Create a client. Required: name; clientType (Client|Prospect); currency (ISO 4217). whoPaysCardFees ∈ Client|Freelancer|Split. ${X}`,
    shape: {
      name: z.string(), clientType: z.enum(["Client", "Prospect"]), currency: z.string(),
      initials: z.string().optional(), address1: z.string().optional(), address2: z.string().optional(),
      city: z.string().optional(), locality: z.string().optional(), postal: z.string().optional(),
      country: z.string().optional(), website: z.string().optional(), phone: z.string().optional(),
      color: z.string().optional(), taxId: z.string().optional(), leadSource: z.string().optional(), archive: z.boolean().optional(),
      paymentTerms: z.object({ paymentDays: z.number().optional(), latePaymentFee: z.number().optional(), hourlyAmount: z.number().optional(), whoPaysCardFees: z.enum(["Client", "Freelancer", "Split"]).optional() }).optional(),
      payInstructions: z.string().optional(), hourlyAmount: z.number().optional(), roundingIncrement: z.number().optional(),
      stripeClientId: z.string().optional(), notes: z.string().optional(), contacts: z.array(contact).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/clients/create", { json: a }) },

  { name: "contacts_create",
    description: `Create a contact (all fields optional). clientName (exact match) files it under that client. ${X}`,
    shape: { first: z.string().optional(), last: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), notes: z.string().optional(), clientName: z.string().optional(), defaultContact: z.boolean().optional(), portalAccess: z.boolean().optional(), invoiceContact: z.boolean().optional() },
    run: (e, a) => moxie(e, "POST", "/action/contacts/create", { json: a }) },

  { name: "invoices_create",
    description: `Create an invoice. Required: clientName, items. The client is NOT emailed unless you pass sendTo.send=true (with contacts + emailTemplateName; it 404s without a template). NOTE: the returned "status" is unreliable — Moxie stamps SENT even when no email goes out, so status is NOT proof of sending; the real signal is whether you set send=true. There is no API to void/delete an invoice (do it in the Moxie UI). ${X}`,
    shape: {
      clientName: z.string(), items: z.array(invoiceItem),
      invoiceNumber: z.string().optional(), templateName: z.string().optional(), dueDate: z.string().optional(),
      taxRate: z.number().optional(), discountPercent: z.number().optional(), paymentInstructions: z.string().optional(),
      sendTo: z.object({ send: z.boolean(), contacts: z.array(z.string()).optional(), emailTemplateName: z.string().optional() }).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/invoices/create", { json: a }) },

  { name: "expenses_create",
    description: `Create an expense. Required: currency (ISO 4217), paid, reimbursable. vendor/clientName exact-match if given. ${X}`,
    shape: {
      currency: z.string(), paid: z.boolean(), reimbursable: z.boolean(),
      date: z.string().optional(), amount: z.number().optional(), markupPercentage: z.number().optional(),
      category: z.string().optional(), billNo: z.string().optional(), description: z.string().optional(),
      notes: z.string().optional(), vendor: z.string().optional(), clientName: z.string().optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/expenses/create", { json: a }) },

  { name: "form_submissions_create",
    description: `Create a form submission. pipelineStageName (exact) creates a pipeline Opportunity. answers[] need fieldKey+question. ${X}`,
    shape: {
      formName: z.string().optional(), firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().optional(),
      phone: z.string().optional(), role: z.string().optional(), businessName: z.string().optional(), website: z.string().optional(),
      address1: z.string().optional(), address2: z.string().optional(), city: z.string().optional(), locality: z.string().optional(),
      postal: z.string().optional(), country: z.string().optional(), sourceUrl: z.string().optional(), leadSource: z.string().optional(),
      notes: z.string().optional(), pipelineStageName: z.string().optional(), answers: z.array(answer).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/formSubmissions/create", { json: a }) },

  { name: "projects_create",
    description: `Create a project. Required: name, clientName, feeSchedule (unless templateName). feeType ∈ Hourly|Fixed Price|Retainer|Per Item. portalAccess ∈ None|Overview|Full access|Read only. ${X}`,
    shape: {
      name: z.string(), clientName: z.string(), templateName: z.string().optional(),
      startDate: z.string().optional(), dueDate: z.string().optional(),
      portalAccess: z.enum(["None", "Overview", "Full access", "Read only"]).optional(), showTimeWorkedInPortal: z.boolean().optional(),
      feeSchedule: z.object({
        feeType: z.enum(["Hourly", "Fixed Price", "Retainer", "Per Item"]), amount: z.number().optional(),
        retainerSchedule: z.enum(["WEEKLY", "BI_WEEKLY", "MONTHLY", "QUARTERLY", "BI_ANNUALLY", "ANNUALLY"]).optional(),
        estimateMax: z.number().optional(), estimateMin: z.number().optional(), retainerStart: z.string().optional(),
        retainerTiming: z.enum(["ADVANCED", "ARREARS"]).optional(), retainerOverageRate: z.number().optional(), taxable: z.boolean().optional(),
      }).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/projects/create", { json: a }) },

  { name: "tasks_create",
    description: `Create a task. Required: name, clientName, projectName (owned by that client). tasks=subtask checklist; assignedTo=user emails. ${X}`,
    shape: {
      name: z.string(), clientName: z.string(), projectName: z.string(),
      status: z.string().optional(), description: z.string().optional(), dueDate: z.string().optional(), startDate: z.string().optional(),
      priority: z.number().optional(), tasks: z.array(z.string()).optional(), assignedTo: z.array(z.string()).optional(),
      customValues: z.record(z.string()).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/tasks/create", { json: a }) },

  { name: "deliverable_approve",
    description: `Approve a deliverable in Client Workflow/Approval status. All three required + exact. ${X}`,
    shape: { clientName: z.string(), projectName: z.string(), deliverableName: z.string() },
    run: (e, a) => moxie(e, "POST", "/action/deliverable/approve", { json: a }) },

  { name: "tickets_create",
    description: `Create a support ticket. Required: userEmail (known contact), ticketType (from Tickets settings), comment. ${X}`,
    shape: {
      userEmail: z.string(), ticketType: z.string(), comment: z.string(),
      subject: z.string().optional(), dueDate: z.string().optional(),
      formData: z.object({ answers: z.array(answer) }).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/tickets/create", { json: a }) },

  { name: "ticket_comments_create",
    description: `Add a comment to a ticket. All required. privateComment ignored for client contacts. ${X}`,
    shape: { userEmail: z.string(), ticketNumber: z.number(), comment: z.string(), privateComment: z.boolean().optional() },
    run: (e, a) => moxie(e, "POST", "/action/tickets/comments/create", { json: a }) },

  { name: "opportunities_create",
    description: `Create a pipeline opportunity. Required: name. stageName/clientName exact-match if given. ${X}`,
    shape: {
      name: z.string(), description: z.string().optional(), clientName: z.string().optional(), stageName: z.string().optional(),
      value: z.number().optional(), estCloseDate: z.string().optional(),
      leadInfo: z.record(z.any()).optional(),
      toDos: z.array(z.object({ item: z.string(), complete: z.boolean().optional(), dueDate: z.string().optional() })).optional(),
      customValues: z.record(z.string()).optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/opportunities/create", { json: a }) },

  { name: "time_entries_create",
    description: `Log a time entry. Required: timerStart, timerEnd (ISO-8601, end>start), userEmail. client/project/deliverable exact-match unless matching create* flag is true. ${X}`,
    shape: {
      timerStart: z.string(), timerEnd: z.string(), userEmail: z.string(),
      clientName: z.string().optional(), projectName: z.string().optional(), deliverableName: z.string().optional(), notes: z.string().optional(),
      createClient: z.boolean().optional(), createProject: z.boolean().optional(), createDeliverable: z.boolean().optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/timeWorked/create", { json: a }) },

  { name: "payments_create",
    description: `Apply a payment to an invoice. Required: date, amount (≤ owed), invoiceNumber. paymentType default OTHER. ${X}`,
    shape: {
      date: z.string(), amount: z.number(), invoiceNumber: z.string(),
      clientName: z.string().optional(),
      paymentType: z.enum(["STRIPE", "CHECK", "BANK_TRANSFER", "CASH", "VENMO", "PAYPAL", "ZELLE", "APP_PAYOUT", "CREDIT_CARD", "OTHER"]).optional(),
      referenceNumber: z.string().optional(), memo: z.string().optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/payment/create", { json: a }) },

  { name: "attachments_create",
    description: "Attach a file (base64) to an object. type ∈ CLIENT|PROJECT|DELIVERABLE|OPPORTUNITY|EXPENSE|TICKET. Returns a signed URL that expires in 15 min. Max 100MB.",
    shape: { type: z.enum(["CLIENT", "PROJECT", "DELIVERABLE", "OPPORTUNITY", "EXPENSE", "TICKET"]), id: z.string(), fileName: z.string(), fileBase64: z.string() },
    run: (e, a) => moxie(e, "POST", "/action/attachments/create", { form: buildAttachmentForm({ type: a.type, id: a.id }, { name: a.fileName, b64: a.fileBase64 }) }) },

  { name: "attachments_create_from_url",
    description: "Attach a file by HTTPS URL (Moxie fetches it). All fields required. Returns a signed URL that expires in 15 min.",
    shape: { type: z.enum(["CLIENT", "PROJECT", "DELIVERABLE", "OPPORTUNITY", "EXPENSE", "TICKET"]), id: z.string(), fileName: z.string(), fileUrl: z.string() },
    run: (e, a) => moxie(e, "POST", "/action/attachments/createFromUrl", { form: buildAttachmentForm({ type: a.type, id: a.id, fileName: a.fileName, fileUrl: a.fileUrl }) }) },

  { name: "calendar_create_or_update",
    description: "Create or update a calendar event. Reuse the same eventId to update/delete. start/endTime are ISO without TZ; timezone is the IANA zone. Invalid userEmail → workspace owner.",
    shape: {
      eventId: z.string(), startTime: z.string(), endTime: z.string(), timezone: z.string(), summary: z.string(),
      description: z.string().optional(), location: z.string().optional(), busy: z.boolean().optional(), userEmail: z.string().optional(),
    },
    run: (e, a) => moxie(e, "POST", "/action/calendar/createOrUpdate", { json: a }) },

  { name: "calendar_delete",
    description: "Delete a calendar event by the eventId used when creating it.",
    shape: { eventId: z.string() },
    run: (e, a) => moxie(e, "DELETE", `/action/calendar/${encodeURIComponent(a.eventId)}`) },
];

export class MoxieMCP extends McpAgent<Env> {
  server = new McpServer({ name: "moxie", version: "1.0.0" });

  async init() {
    const env = this.env;
    for (const t of TOOLS) {
      this.server.tool(t.name, t.description, t.shape, async (args: unknown) => {
        try {
          return ok(await t.run(env, args ?? {}));
        } catch (e) {
          return fail(e);
        }
      });
    }
  }
}

// Constant-time compare so the password check doesn't leak length/content via timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const htmlResp = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

function loginPage(oauthReqJson: string, clientName: string, error?: string): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moxie MCP — sign in</title>
<body style="font-family:system-ui;max-width:24rem;margin:4rem auto;padding:0 1rem">
<h2>Moxie MCP</h2>
<p><strong>${esc(clientName || "An application")}</strong> wants to connect to your Moxie workspace.</p>
${error ? `<p style="color:#b00">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
  <input type="hidden" name="oauthReq" value="${esc(oauthReqJson)}">
  <label>Password<br><input type="password" name="password" autofocus required style="width:100%;padding:.5rem;margin:.5rem 0"></label>
  <button type="submit" style="width:100%;padding:.6rem;margin-top:.5rem">Authorize</button>
</form></body>`;
}

// Default (non-API) handler: serves the OAuth authorization UI and a root info page.
const authHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/authorize") {
      if (req.method === "POST") {
        const form = await req.formData();
        const oauthReq = JSON.parse(String(form.get("oauthReq") ?? "{}"));
        if (!timingSafeEqual(String(form.get("password") ?? ""), env.MCP_LOGIN_PASSWORD)) {
          const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
          return htmlResp(loginPage(JSON.stringify(oauthReq), client?.clientName ?? "", "Incorrect password"), 401);
        }
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "josh",
          metadata: {},
          scope: oauthReq.scope ?? [],
          props: { login: "josh" },
        });
        return Response.redirect(redirectTo, 302);
      }
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
      const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
      return htmlResp(loginPage(JSON.stringify(oauthReq), client?.clientName ?? ""));
    }

    if (url.pathname === "/") return new Response("Moxie MCP server. Add as a custom connector in Claude; you'll be asked to sign in.", { status: 200 });
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiHandlers: {
    // `binding` must match the Durable Object binding in wrangler.jsonc (SDK default
    // is "MCP_OBJECT", which would 500 "Invalid binding").
    "/mcp": MoxieMCP.serve("/mcp", { binding: "MoxieMCP" }) as never,
    "/sse": MoxieMCP.serveSSE("/sse", { binding: "MoxieMCP" }) as never,
  },
  defaultHandler: authHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
