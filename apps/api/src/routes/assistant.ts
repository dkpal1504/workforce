/**
 * The assistant endpoints. Read-only against the app, draft-only against the world.
 *
 * Each route returns `assisted: false` with the deterministic template when the model is off or
 * unreachable — the UI renders the same card either way, so nothing looks broken and nothing is
 * blocked. `POST /usage` records what a human did with a draft, which is the only honest measure of
 * whether this feature earns its place.
 */

import { Router, type Request } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { CONVERSATION_ROLES, canAccessJobOrder, type ConversationActor } from "../services/conversationScope";
import { briefFactsFor } from "../services/jobOrderContext";
import { assistantConfig, assistantReady, chatComplete, listModels } from "../services/assistantClient";
import { buildBriefPrompt, buildDraftPrompt, buildSummaryPrompt, templateBrief, type BriefFacts } from "../services/assistantPrompts";

export const assistantRouter = Router();

assistantRouter.use(requireAuth);

function actorOf(req: Request): ConversationActor {
  const user = req.user!;
  return { id: user.id, role: user.role, departmentId: user.departmentId, sectionId: user.sectionId, sectionScope: user.sectionScope };
}

/** GET /api/assistant/status — what the deployment actually has. Admin sees the endpoint's models. */
assistantRouter.get("/status", async (req, res) => {
  const cfg = assistantConfig();
  if (req.user!.role !== "ADMIN") {
    return res.json({ enabled: cfg.enabled, ready: assistantReady(cfg) });
  }
  const models = cfg.baseUrl ? await listModels(cfg) : { ok: false, models: [], detail: "ASSISTANT_BASE_URL is not set" };
  res.json({
    enabled: cfg.enabled,
    ready: assistantReady(cfg),
    baseUrl: cfg.baseUrl || null,
    model: cfg.model,
    isPrivate: cfg.baseUrl ? require("../services/assistantClient").isPrivateHost(cfg.baseUrl) : null,
    endpoint: models,
  });
});

/** GET /api/job-orders/:id/conversation/brief — the card at the top of a thread. */
assistantRouter.get("/job-orders/:id/conversation/brief", requireRoles(...CONVERSATION_ROLES), async (req, res) => {
  const jobOrderId = Number(req.params.id);
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return res.status(access.code === "JOB_ORDER_NOT_FOUND" ? 404 : 403).json({ error: "Not available.", code: access.code });

  const facts = await briefFactsFor(jobOrderId);
  if (!facts) return res.status(404).json({ error: "Job Order not found." });

  const template = templateBrief(facts);
  const cfg = assistantConfig();
  if (!assistantReady(cfg)) {
    return res.json({ facts: factChips(facts), template, brief: template, assisted: false, reason: cfg.enabled ? "NO_ENDPOINT" : "DISABLED" });
  }
  const answer = await chatComplete(buildBriefPrompt(facts), cfg);
  await recordUsage({ userId: req.user!.id, action: "BRIEF", jobOrderId, model: answer.ok ? answer.model : cfg.model, outcome: answer.ok ? "RETURNED" : "FAILED", answer });
  if (!answer.ok) return res.json({ facts: factChips(facts), template, brief: template, assisted: false, reason: answer.reason });
  res.json({ facts: factChips(facts), template, brief: answer.text, assisted: true, model: answer.model });
});

/** GET /api/conversations/:id/summary — three bullets for a long thread. */
assistantRouter.get("/conversations/:id/summary", requireRoles(...CONVERSATION_ROLES), async (req, res) => {
  const threadId = Number(req.params.id);
  const thread = await prisma.jobOrderThread.findUnique({
    where: { id: threadId },
    select: {
      jobOrderId: true,
      messages: { orderBy: { seq: "desc" }, take: 20, select: { seq: true, kind: true, authorRole: true, body: true } },
    },
  });
  if (!thread) return res.status(404).json({ error: "Thread not found." });
  const access = await canAccessJobOrder(actorOf(req), thread.jobOrderId);
  if (!access.ok) return res.status(403).json({ error: "Not available.", code: access.code });

  const messages = thread.messages
    .slice()
    .reverse()
    .map((message) => ({ seq: message.seq, kind: message.kind, role: message.authorRole, body: message.body }));
  const cfg = assistantConfig();
  if (!assistantReady(cfg) || messages.length < 2) {
    return res.json({ bullets: null, assisted: false, reason: messages.length < 2 ? "TOO_SHORT" : "DISABLED" });
  }
  const facts = await briefFactsFor(thread.jobOrderId);
  const answer = await chatComplete(
    buildSummaryPrompt({
      jobOrder: `${access.jobOrder.code} · ${access.jobOrder.name}`,
      messages,
      facts: facts ? { schedule: facts.scheduleBand, burn_pct: facts.burnPct, quantity_complete_pct: facts.qtyCompletePct } : {},
    }),
    cfg
  );
  await recordUsage({ userId: req.user!.id, action: "SUMMARY", threadId, jobOrderId: thread.jobOrderId, model: answer.ok ? answer.model : cfg.model, outcome: answer.ok ? "RETURNED" : "FAILED", answer });
  if (!answer.ok) return res.json({ bullets: null, assisted: false, reason: answer.reason });
  res.json({ bullets: answer.text, assisted: true, model: answer.model });
});

/** POST /api/job-orders/:id/conversation/draft {kind} — text for the composer, never sent by us. */
assistantRouter.post("/job-orders/:id/conversation/draft", requireRoles(...CONVERSATION_ROLES), async (req, res) => {
  const jobOrderId = Number(req.params.id);
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return res.status(access.code === "JOB_ORDER_NOT_FOUND" ? 404 : 403).json({ error: "Not available.", code: access.code });
  const kind = String(req.body?.kind ?? "FOLLOW_UP").toUpperCase();
  const facts = await briefFactsFor(jobOrderId);
  if (!facts) return res.status(404).json({ error: "Job Order not found." });

  const cfg = assistantConfig();
  if (!assistantReady(cfg)) {
    return res.json({ draft: templateDraft(kind, facts), assisted: false, reason: cfg.enabled ? "NO_ENDPOINT" : "DISABLED" });
  }
  const answer = await chatComplete(
    buildDraftPrompt({
      kind,
      facts,
      messages: facts.lastMessages,
      authorRole: req.user!.role,
      ownerName: facts.lastMessages.length ? "the Job Order owner" : "the Job Order owner",
      ownerRole: "Job Order Owner",
    }),
    cfg
  );
  await recordUsage({ userId: req.user!.id, action: `DRAFT_${kind}`, jobOrderId, model: answer.ok ? answer.model : cfg.model, outcome: answer.ok ? "RETURNED" : "FAILED", answer });
  if (!answer.ok) return res.json({ draft: templateDraft(kind, facts), assisted: false, reason: answer.reason });
  res.json({ draft: answer.text, assisted: true, model: answer.model });
});

/** POST /api/assistant/usage — a human's verdict on a draft. */
assistantRouter.post("/usage", requireRoles(...CONVERSATION_ROLES), async (req, res) => {
  const outcome = ["ACCEPTED", "EDITED", "DISCARDED"].includes(String(req.body?.outcome)) ? String(req.body.outcome) : null;
  if (!outcome) return res.status(400).json({ error: "outcome must be ACCEPTED, EDITED or DISCARDED." });
  const action = String(req.body?.action ?? "DRAFT").slice(0, 40);
  await prisma.assistantUsage.create({
    data: {
      userId: req.user!.id,
      action,
      jobOrderId: Number.isInteger(Number(req.body?.jobOrderId)) ? Number(req.body.jobOrderId) : null,
      threadId: Number.isInteger(Number(req.body?.threadId)) ? Number(req.body.threadId) : null,
      model: String(req.body?.model ?? "unknown").slice(0, 120),
      outcome,
    },
  });
  res.json({ ok: true });
});

function factChips(facts: BriefFacts) {
  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
  return [
    { label: "Burn", value: `${pct(facts.burnPct)} ${facts.hoursBand}` },
    { label: "Schedule", value: facts.scheduleBand.replace(/_/g, " ") },
    { label: "Quantity", value: pct(facts.qtyCompletePct) },
    { label: "Since booking", value: facts.daysSinceActivity === null ? "never" : `${facts.daysSinceActivity}d` },
    { label: "Unapproved", value: `${facts.unapprovedHours}h` },
    { label: "Promises overdue", value: String(facts.promisesOverdue) },
  ];
}

/** The template draft: the same shape as the model's, without the prose. */
function templateDraft(kind: string, facts: BriefFacts): string {
  const qty = facts.qtyCompletePct === null ? "no recorded quantity" : `${Math.round(facts.qtyCompletePct * 100)}% complete`;
  const late = facts.daysToEnd !== null && facts.daysToEnd < 0 ? `, ${Math.abs(facts.daysToEnd)} day(s) past the planned end` : "";
  if (kind === "ESCALATION") {
    return `${facts.code} is ${qty}${late} with ${facts.burnPct === null ? "no budget hours in force" : `${Math.round(facts.burnPct * 100)}% of budget hours booked`}. I need a decision on the re-sequence this week so the next milestone does not slip further. Please confirm the date you will commit to.`;
  }
  if (kind === "INSTRUCTION") {
    return `Please confirm the remaining scope on ${facts.code} (${qty}${late}) and the crew you have on it this week. Report back with the date the next milestone will be met and anything blocking it.`;
  }
  return `Following up on ${facts.code}: ${qty}${late}. Please reply with where the work stands, what is blocking it, and the date you expect the next milestone to be met.`;
}

async function recordUsage(input: {
  userId: number;
  action: string;
  jobOrderId?: number | null;
  threadId?: number | null;
  model: string;
  outcome: string;
  answer: { ok: boolean; promptTokens?: number | null; completionTokens?: number | null; latencyMs?: number } | { ok: false; reason: string };
}): Promise<void> {
  await prisma.assistantUsage
    .create({
      data: {
        userId: input.userId,
        action: input.action,
        jobOrderId: input.jobOrderId ?? null,
        threadId: input.threadId ?? null,
        model: input.model || "unknown",
        outcome: input.outcome,
        promptTokens: input.answer.ok ? input.answer.promptTokens ?? null : null,
        completionTokens: input.answer.ok ? input.answer.completionTokens ?? null : null,
        latencyMs: input.answer.ok ? input.answer.latencyMs ?? null : null,
      },
    })
    .catch(() => undefined);
}
