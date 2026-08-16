/**
 * The twelve tools tera-orchestrator knows about — the source's seven, plus the
 * five P12 workstream 5 added.
 *
 * **These names are a contract**, and the contract had a hole. The orchestrator
 * prefixes them `comm_` and gates a *named* subset behind a confirmation via
 * `mutationTools` (`service-mcp-tools.ts:115`). That list read
 * `['sendEmail', 'sendSMS', 'sendSlack']` — and **no tool has ever been called
 * `sendSlack`**. The real names are `sendSlackMessage` and
 * `sendUrgentSlackAlert`, so both Slack sends, and `addNotificationToQueue`
 * with them, went through unconfirmed for the life of the service. An earlier
 * draft of this comment asserted the gate held; it did not. Fixed in
 * mentera_core alongside the new tools. See D102.
 *
 * The schemas are the source's, with two corrections:
 *
 *  - **`medspaId` is gone from every input schema.** The source advertises it
 *    as a parameter and then overrides whatever the caller sends with the
 *    `x-medspa-id` header (`mcp/index.ts:70-80`) — a fix for a real
 *    cross-tenant send. Advertising a parameter that is ignored invites a
 *    caller to rely on it; the tenant comes from the request, always.
 *  - `sendEmail` gains `message`, because the source's schema offers only
 *    `templateId` + `variables` and the underlying send accepts either.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  /**
   * True when calling this tool changes something a person would want to
   * confirm first — a send, a decision, a queued job.
   *
   * **Declared here, next to the tool, because the drift above happened by
   * declaring it somewhere else.** The orchestrator's own `mutationTools` array
   * lives in another repository and was never re-checked against these names.
   * Discovery now carries the answer, so a tool added here arrives already
   * gated.
   */
  mutation?: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const PRIORITY = {
  type: 'string',
  description: 'Priority of the message',
  enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'sendEmail',
    mutation: true,
    description: 'Send an email message to a recipient',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email address of the recipient' },
        subject: { type: 'string', description: 'Subject of the email' },
        message: { type: 'string', description: 'Body, when not using a template' },
        templateId: { type: 'string', description: 'Template id or key to render' },
        variables: { type: 'object', description: 'Variables to populate the template with' },
        providerId: { type: 'string', description: 'Provider sending on behalf of' },
        priority: PRIORITY,
      },
      required: ['to'],
    },
  },
  {
    name: 'sendSMS',
    mutation: true,
    description: 'Send an SMS message to a phone number',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Phone number of the recipient (with country code, e.g., +1234567890)',
        },
        message: { type: 'string', description: 'SMS message content' },
        templateId: { type: 'string', description: 'Optional template id or key' },
        variables: { type: 'object', description: 'Variables to populate the template with' },
        providerId: {
          type: 'string',
          description: 'Provider ID for provider-specific phone numbers',
        },
        priority: PRIORITY,
      },
      required: ['to'],
    },
  },
  {
    name: 'sendSlackMessage',
    mutation: true,
    description: 'Send a message to a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel to send the message to' },
        text: { type: 'string', description: 'Message content' },
        blocks: { type: 'array', description: 'Slack message blocks for rich formatting' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'sendUrgentSlackAlert',
    mutation: true,
    description: 'Send an urgent alert to Slack',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Alert title' },
        message: { type: 'string', description: 'Alert message' },
        severity: {
          type: 'string',
          description: 'Severity level of the alert',
          enum: ['low', 'medium', 'high', 'critical'],
        },
        channel: { type: 'string', description: 'Optional specific channel for the alert' },
      },
      required: ['title', 'message'],
    },
  },

  // ── P12 workstream 5 — the review surface ─────────────────────────────────
  // Tera gains "draft and queue a follow-up for approval" as a capability, and
  // Outreach gains Tera as an optional conversational review surface. Every one
  // of these is backed by the same `/v1` service the HTTP surface calls; none
  // reaches into the database on its own.
  {
    name: 'generateDraft',
    mutation: true,
    description:
      'Write a message for a recipient with the model and queue it for human approval. Does not send: the draft waits for a reviewer unless the tenant has configured otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          description: "The recipient's id in the vertical's own system (a patient id for medspa)",
        },
        recipientId: { type: 'string', description: 'The engine recipient id, if known' },
        channel: {
          type: 'string',
          description: 'Channel to write for',
          enum: ['email', 'sms', 'slack', 'push', 'webhook', 'in_app', 'voice'],
        },
        goal: { type: 'string', description: 'What the message should achieve' },
        promptPackKey: {
          type: 'string',
          description: 'Prompt pack to write with; defaults to core.content-generate',
        },
        context: { type: 'object', description: 'Facts the message may reference' },
        providerId: { type: 'string', description: 'Provider sending on behalf of' },
        priority: PRIORITY,
      },
      required: ['channel'],
    },
  },
  {
    name: 'listPendingApprovals',
    description: 'List messages waiting for approval, newest request first',
    inputSchema: {
      type: 'object',
      properties: {
        approverRef: {
          type: 'string',
          description: "Whose queue to read; defaults to the caller's own",
        },
        channel: { type: 'string', description: 'Only approvals on this channel' },
        priority: PRIORITY,
        page: { type: 'number', description: 'Page number, from 1' },
        pageSize: { type: 'number', description: 'Rows per page, up to 200' },
      },
    },
  },
  {
    name: 'approveMessage',
    mutation: true,
    description:
      'Approve a message that is waiting for review, which sends it. Optionally edit the body first.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'The approval to act on' },
        content: {
          type: 'string',
          description: 'Replacement body. When given, the message is edited and then approved.',
        },
        subject: { type: 'string', description: 'Replacement subject, with content' },
      },
      required: ['approvalId'],
    },
  },
  {
    name: 'listConversations',
    description: "A provider's message inbox — one entry per recipient, most recently active first",
    inputSchema: {
      type: 'object',
      properties: {
        providerId: {
          type: 'string',
          description: "Whose inbox to read; defaults to the caller's own",
        },
        search: { type: 'string', description: 'Filter by recipient name' },
        page: { type: 'number', description: 'Page number, from 1' },
        limit: { type: 'number', description: 'Conversations per page' },
      },
    },
  },
  {
    name: 'createCampaign',
    mutation: true,
    description:
      'Create a campaign against an existing audience and playbook. It is created as a DRAFT and sends nothing until it is launched.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Campaign name' },
        description: { type: 'string', description: 'What the campaign is for' },
        playbookKey: { type: 'string', description: 'Playbook that writes each message' },
        audienceId: { type: 'string', description: 'Audience to send to' },
        providerId: { type: 'string', description: 'Provider sending on behalf of' },
        context: { type: 'object', description: "Facts merged into every recipient's payload" },
      },
      required: ['name', 'playbookKey', 'audienceId'],
    },
  },

  {
    name: 'getQueueStatus',
    description: 'Get the status of notification queues',
    inputSchema: {
      type: 'object',
      properties: {
        queueName: { type: 'string', description: 'Optional specific queue name to check' },
      },
    },
  },
  {
    name: 'addNotificationToQueue',
    mutation: true,
    description: 'Add a notification to the queue for processing',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Type of notification',
          enum: ['EMAIL', 'SMS', 'SLACK', 'PUSH', 'WEBHOOK', 'IN_APP'],
        },
        payload: { type: 'object', description: 'Notification payload' },
        metadata: {
          type: 'object',
          description: 'Notification metadata including priority and scheduling',
          properties: {
            priority: PRIORITY,
            scheduledFor: { type: 'string' },
          },
        },
      },
      required: ['type', 'payload'],
    },
  },
  {
    name: 'clearFailedJobs',
    mutation: true,
    description: 'Clear failed jobs from the notification queue',
    inputSchema: {
      type: 'object',
      properties: {
        olderThan: {
          type: 'string',
          description: 'Clear jobs older than this timestamp (ISO format)',
        },
        limit: { type: 'number', description: 'Maximum number of jobs to clear' },
      },
    },
  },
];

export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name);

/**
 * The subset a caller should confirm before running. Published on discovery so
 * the orchestrator can stop maintaining its own copy — see the header, and D102.
 */
export const MCP_MUTATION_TOOL_NAMES = MCP_TOOLS.filter((t) => t.mutation).map((t) => t.name);
