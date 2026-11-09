import type { Logger } from 'pino';
import {
  AiFeatureConfig,
  agentJoinedLine,
  chatAiMode,
  detectLocale,
  isGreetingOnly,
  mahaHandoverLine,
  mahaIntro,
  withinChatAiHours,
  type MahaDeliverJob,
  type MahaLocale,
  type MessageNew,
} from '@yiji/shared-types';

/**
 * MAHA IN THE CHAT (owner, 2026-11-09). The gateway half: it is the only
 * service that can both write a message and put it on an open widget, so every
 * message Maha's flow produces is written and broadcast here. The workers ask
 * the AI and hand the decision over through the `maha` queue.
 *
 * The rules (see packages/shared-types/src/maha.ts for the whole story):
 *  - a session starts with Maha only if the vendor's mode is `auto`, it is
 *    inside her hours and under her monthly budget;
 *  - while `ai_active`, nothing is routed and no alert rings, and agents may
 *    not send - somebody must turn Maha off first;
 *  - a handover says so to the customer, restarts the response-time clock,
 *    rings the new-chat alert and starts the NORMAL routing ladder;
 *  - the agent's first message after a handover is preceded, once, by
 *    "<first name> from customer service is with you".
 *
 * EVERY failure here falls back to the old behaviour - routing and the alert -
 * because a customer nobody answers is the one outcome that is never allowed.
 */

export interface MahaState {
  vendorId: string | null;
  assignedAgent: string | null;
  active: boolean;
  replies: number;
  handoverAt: string | null;
  agentJoinedAt: string | null;
}

export interface MahaDeps {
  directus: {
    getMahaState(conversationId: string): Promise<MahaState | null>;
    setMahaState(conversationId: string, patch: Record<string, unknown>): Promise<void>;
    persistMessage(input: {
      conversationId: string;
      senderType: 'agent';
      content: string;
      automatedSource?: 'maha' | 'maha_handover' | 'agent_joined';
    }): Promise<{ id: string; createdAt: string }>;
    latestVisibleMessage(
      conversationId: string,
    ): Promise<{ id: string; senderType: string; senderUser: string | null } | null>;
    userFirstName(userId: string): Promise<string | null>;
    recentCustomerTexts(conversationId: string, limit?: number): Promise<string[]>;
  };
  /** The vendor's AI settings (raw, as stored); parsed here. */
  readConfig(vendorId: string | null): Promise<Record<string, unknown>>;
  /** Maha's spend this month for the vendor, SAR. */
  spendSar(vendorId: string | null): Promise<number>;
  emitToConversation(conversationId: string, event: string, payload: unknown): void;
  emitToAgents(event: string, payload: unknown): void;
  enqueueRouting(conversationId: string): Promise<void>;
  enqueueMahaReply(conversationId: string, forMessageId: string): Promise<void>;
  enqueueWatchdog(conversationId: string, forMessageId: string): Promise<void>;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

const EV = {
  messageNew: 'message:new',
  inboxActivity: 'inbox:activity',
  conversationChanged: 'conversation:changed',
} as const;

function parseConfig(raw: Record<string, unknown>) {
  try {
    return AiFeatureConfig.parse(raw);
  } catch {
    return AiFeatureConfig.parse({});
  }
}

/** Does Maha take a NEW session for this vendor right now? */
export async function mahaTakesSession(deps: MahaDeps, vendorId: string | null): Promise<boolean> {
  try {
    const cfg = parseConfig(await deps.readConfig(vendorId));
    if (chatAiMode(cfg) !== 'auto') return false;
    if (!withinChatAiHours(cfg, (deps.now ?? (() => new Date()))())) return false;
    if (cfg.chatAiMonthlyCapSar > 0 && (await deps.spendSar(vendorId)) >= cfg.chatAiMonthlyCapSar) {
      return false;
    }
    return true;
  } catch (err) {
    deps.logger.warn({ err }, 'maha: could not read the settings - agents take this chat');
    return false;
  }
}

/** The vendor's mode, for Assist drafts (`off` when unreadable). */
export async function mahaMode(
  deps: Pick<MahaDeps, 'readConfig'>,
  vendorId: string | null,
): Promise<'off' | 'assist' | 'auto'> {
  try {
    return chatAiMode(parseConfig(await deps.readConfig(vendorId)));
  } catch {
    return 'off';
  }
}

async function localeOf(
  deps: MahaDeps,
  conversationId: string,
  extra?: string,
): Promise<MahaLocale> {
  const texts = extra ? [extra] : [];
  try {
    texts.push(...(await deps.directus.recentCustomerTexts(conversationId, 5)));
  } catch {
    /* Arabic by default */
  }
  return detectLocale(texts);
}

async function postAutomated(
  deps: MahaDeps,
  conversationId: string,
  content: string,
  source: 'maha' | 'maha_handover' | 'agent_joined',
): Promise<void> {
  const saved = await deps.directus.persistMessage({
    conversationId,
    senderType: 'agent',
    content,
    automatedSource: source,
  });
  const payload: MessageNew & { maha?: string } = {
    id: saved.id,
    conversationId,
    senderType: 'agent',
    content,
    attachments: [],
    createdAt: saved.createdAt,
    automated: true,
    maha: source,
  };
  deps.emitToConversation(conversationId, EV.messageNew, payload);
  deps.emitToAgents(EV.inboxActivity, { conversationId, silent: true });
}

/**
 * A customer message arrived. Returns `true` when Maha has the chat - the
 * caller must then NOT route it, NOT ring the alert and NOT send the welcome.
 */
export async function onCustomerMessage(
  deps: MahaDeps,
  input: {
    conversationId: string;
    messageId: string;
    text: string;
    hasAttachments: boolean;
    /** This message starts a session (new chat or reopened one). */
    sessionStart: boolean;
    vendorId: string | null;
  },
): Promise<boolean> {
  const { conversationId } = input;
  const state = await deps.directus.getMahaState(conversationId);
  if (!state) return false; // no Maha fields here, or unreadable: as before

  let active = state.active;
  if (input.sessionStart) {
    active = await mahaTakesSession(deps, input.vendorId ?? state.vendorId);
    try {
      await deps.directus.setMahaState(conversationId, {
        ai_active: active,
        ai_replies: 0,
        ai_handover_at: null,
        ai_handover_reason: null,
        ai_handover_summary: null,
        ai_agent_joined_at: null,
      });
    } catch (err) {
      deps.logger.warn(
        { err, conversationId },
        'maha: could not start the session - agents take it',
      );
      return false;
    }
    if (!active) return false;
    try {
      const locale = await localeOf(deps, conversationId, input.text);
      await postAutomated(deps, conversationId, mahaIntro(locale), 'maha');
    } catch (err) {
      deps.logger.warn({ err, conversationId }, 'maha: introduction not sent');
    }
    // "السلام عليكم" alone: the introduction already asked how to help.
    if (!input.hasAttachments && isGreetingOnly(input.text)) return true;
  } else if (!active) {
    return false;
  }

  try {
    await deps.enqueueMahaReply(conversationId, input.messageId);
    await deps.enqueueWatchdog(conversationId, input.messageId);
    return true;
  } catch (err) {
    /* Maha cannot be asked: a person takes it, now. */
    deps.logger.warn({ err, conversationId }, 'maha: could not queue the answer - handing over');
    await handover(deps, conversationId, { reason: 'ai_error:queue', summary: null });
    return true;
  }
}

/**
 * Hand the chat to people. `announce` = tell the customer (Maha's handover);
 * an agent turning Maha off says nothing and keeps the chat (`assignTo`).
 */
export async function handover(
  deps: MahaDeps,
  conversationId: string,
  opts: { reason: string; summary: string | null; announce?: boolean; assignTo?: string | null },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const announce = opts.announce ?? true;
  if (announce) {
    try {
      const locale = await localeOf(deps, conversationId);
      await postAutomated(deps, conversationId, mahaHandoverLine(locale), 'maha_handover');
    } catch (err) {
      deps.logger.warn({ err, conversationId }, 'maha: handover line not sent');
    }
  }
  try {
    await deps.directus.setMahaState(conversationId, {
      ai_active: false,
      ai_handover_at: now,
      ai_handover_reason: opts.reason,
      ai_handover_summary: opts.summary,
      ai_agent_joined_at: null,
      ...(opts.assignTo ? { assigned_agent: opts.assignTo } : {}),
      /* THE RESPONSE-TIME CLOCK STARTS NOW (owner, 2026-11-09): the SLA sweep
         recomputes the deadline from session_started_at. */
      session_started_at: now,
      first_responded_at: null,
      first_response_due_at: null,
      first_response_breached_at: null,
    });
  } catch (err) {
    deps.logger.warn({ err, conversationId }, 'maha: handover state not saved');
  }
  deps.emitToConversation(conversationId, EV.conversationChanged, { conversationId });
  if (opts.assignTo) {
    deps.emitToAgents(EV.inboxActivity, { conversationId, silent: true });
    return;
  }
  // The new-chat alert, exactly as a customer message rings it today.
  deps.emitToAgents(EV.inboxActivity, { conversationId, senderType: 'customer' });
  try {
    await deps.enqueueRouting(conversationId);
  } catch (err) {
    deps.logger.warn({ err, conversationId }, 'maha: routing not queued after handover');
  }
  deps.logger.info({ conversationId, reason: opts.reason }, 'maha handed over');
}

/** The workers' decision, delivered to the chat. */
export async function deliver(deps: MahaDeps, job: MahaDeliverJob): Promise<void> {
  const { conversationId, forMessageId } = job;
  const state = await deps.directus.getMahaState(conversationId);
  if (!state?.active) return; // an agent took it, or it was already handed over
  const latest = await deps.directus.latestVisibleMessage(conversationId);
  /* Answer only the newest customer message: if the customer wrote again the
     newer job answers both; if anyone replied since, this one is stale. */
  if (!latest || latest.id !== forMessageId) return;
  if (job.kind === 'watchdog') {
    await handover(deps, conversationId, { reason: 'ai_timeout', summary: null });
    return;
  }
  if (job.action === 'reply' && job.reply?.trim()) {
    await postAutomated(deps, conversationId, job.reply.trim(), 'maha');
    try {
      await deps.directus.setMahaState(conversationId, { ai_replies: state.replies + 1 });
    } catch (err) {
      deps.logger.warn({ err, conversationId }, 'maha: reply count not saved');
    }
    return;
  }
  await handover(deps, conversationId, {
    reason: job.reason?.trim() || 'needs_person',
    summary: job.kind === 'deliver' ? (job.summary ?? null) : null,
  });
}

/**
 * Before an agent's message is written. `blocked` while Maha has the chat -
 * the portal locks the box too, this is the backstop. After a handover, the
 * agent's first message is introduced by name, once.
 */
export async function beforeAgentMessage(
  deps: MahaDeps,
  input: { conversationId: string; agentId: string },
): Promise<{ blocked: boolean }> {
  const state = await deps.directus.getMahaState(input.conversationId);
  if (!state) return { blocked: false };
  if (state.active) return { blocked: true };
  if (state.handoverAt && !state.agentJoinedAt) {
    try {
      // Stamped FIRST so two quick sends cannot both introduce the agent.
      await deps.directus.setMahaState(input.conversationId, {
        ai_agent_joined_at: (deps.now ?? (() => new Date()))().toISOString(),
      });
      const name = await deps.directus.userFirstName(input.agentId);
      if (name) {
        const locale = await localeOf(deps, input.conversationId);
        await postAutomated(
          deps,
          input.conversationId,
          agentJoinedLine(locale, name),
          'agent_joined',
        );
      }
    } catch (err) {
      deps.logger.warn({ err, conversationId: input.conversationId }, 'maha: joined line not sent');
    }
  }
  return { blocked: false };
}

/**
 * The per-chat switch. OFF = the agent takes the chat (assigned to them if
 * nobody has it), silently. ON = Maha answers again from the next customer
 * message - or straight away when the customer is the one waiting.
 */
export async function setMaha(
  deps: MahaDeps,
  input: { conversationId: string; on: boolean; agentId: string },
): Promise<{ ok: boolean; error?: string }> {
  const state = await deps.directus.getMahaState(input.conversationId);
  if (!state) return { ok: false, error: 'maha_unavailable' };
  if (!input.on) {
    if (!state.active) return { ok: true };
    await handover(deps, input.conversationId, {
      reason: 'agent_took_over',
      summary: null,
      announce: false,
      assignTo: state.assignedAgent ? null : input.agentId,
    });
    return { ok: true };
  }
  if (state.active) return { ok: true };
  if ((await mahaMode(deps, state.vendorId)) === 'off') return { ok: false, error: 'maha_off' };
  await deps.directus.setMahaState(input.conversationId, {
    ai_active: true,
    ai_replies: 0,
    ai_handover_at: null,
    ai_handover_reason: null,
    ai_handover_summary: null,
    ai_agent_joined_at: null,
  });
  deps.emitToConversation(input.conversationId, EV.conversationChanged, {
    conversationId: input.conversationId,
  });
  deps.emitToAgents(EV.inboxActivity, { conversationId: input.conversationId, silent: true });
  const latest = await deps.directus.latestVisibleMessage(input.conversationId);
  if (latest?.senderType === 'customer') {
    await deps.enqueueMahaReply(input.conversationId, latest.id);
    await deps.enqueueWatchdog(input.conversationId, latest.id);
  }
  return { ok: true };
}
