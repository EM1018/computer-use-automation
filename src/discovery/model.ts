/**
 * The model boundary. `ModelClient` is the seam discovery's tests mock out
 * (no API calls in the default/unit-test path — see test/discovery/) while
 * still exercising everything else (the real browser, real policy checks,
 * real escalation machinery) for real.
 *
 * Tool calling, not free-text parsing: the model's choice always comes back
 * as a validated `take_action` tool call, never text this module has to
 * regex apart.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DiscoveryActionSchema, type DiscoveryAction } from "../schema/discovery.js";
import type { Observation } from "./observe.js";

export interface NextActionParams {
  goal: string;
  observation: Observation;
  historyText: string;
  /** Set when the model's previous attempt THIS SAME TURN was rejected (malformed call, unknown ref, or policy block) and it must try again before the turn advances. */
  retryFeedback?: string;
}

export interface ModelDecision {
  action: DiscoveryAction;
  reasoning: string;
}

export interface ModelClient {
  nextAction(params: NextActionParams): Promise<ModelDecision>;
}

/** Thrown when the model's tool call can't be turned into a valid DiscoveryAction — a malformed call, not a page/policy problem. Callers retry a bounded number of times before giving up. */
export class ModelActionError extends Error {}

const TAKE_ACTION_TOOL: Anthropic.Tool = {
  name: "take_action",
  description:
    "Choose exactly one action to take on the current page. Target elements ONLY by the ref shown in the current accessibility snapshot (e.g. \"e3\") — never a CSS selector, XPath, or coordinates; a ref not present in the current snapshot does not exist as far as you're concerned.",
  input_schema: {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description: "One or two sentences: why this action, given the goal and what you currently observe.",
      },
      action: {
        type: "string",
        enum: ["click", "fill", "select", "navigate", "extract", "done", "stuck"],
        description: "The action to take.",
      },
      ref: {
        type: "string",
        description: "Element ref from the CURRENT snapshot, e.g. \"e5\". Required for click, fill, select, extract.",
      },
      value: { type: "string", description: "Text to type into the field. Required for fill." },
      option: { type: "string", description: "The option's visible text to select. Required for select." },
      url: { type: "string", description: "Absolute or relative URL to navigate to. Required for navigate." },
      output_name: {
        type: "string",
        description:
          "Short snake_case name for what this extracted value represents (e.g. \"account_status\"). Required for extract — mark a value as an output explicitly whenever it's something this capability should return to its caller.",
      },
      reason: {
        type: "string",
        description: "Why the goal is complete (for done), or why you cannot proceed (for stuck). Required for done and stuck.",
      },
    },
    required: ["reasoning", "action"],
  },
};

function buildSystemPrompt(goal: string): string {
  return [
    "You are operating a legacy web back-office application through a browser, on behalf of an operator, solely via the take_action tool.",
    "",
    `GOAL: ${goal}`,
    "",
    "Each turn you are shown the current URL, a TRIMMED accessibility snapshot (interactive and informative elements only, each carrying a ref like \"e3\"), and a screenshot as a second channel for anything that only shows up visually (a disabled control, an overlay, which of two similar forms is active).",
    "",
    "Rules:",
    "- Target elements ONLY by a ref shown in the CURRENT snapshot. Never invent a ref, a CSS selector, an XPath, or coordinates. Refs are only valid for the turn they were shown in.",
    "- Call extract(ref, output_name) explicitly whenever a value on the page is something this capability should hand back to its caller (a numeric figure, an identifier, a status or confirmation message). Do not assume this will be inferred later — if you don't extract it, it isn't captured.",
    "- Call done(reason) once, only when the goal is fully satisfied.",
    "- Call stuck(reason) if you cannot find a way to proceed — the page isn't what you expect, or everything you've tried has failed. Do not keep guessing at random elements; stuck() hands control to a human and that is the correct move when you are actually stuck.",
    "- An action may be refused by policy (for example, an irreversible action like closing an account). If refused, you will be told why on your next turn — pick a different action; do not retry the exact same one.",
    "- Exactly one action per turn.",
  ].join("\n");
}

function buildUserText(params: NextActionParams): string {
  const parts = [
    `Current URL: ${params.observation.url}`,
    "",
    "Accessibility snapshot:",
    params.observation.snapshotText,
    "",
    "History so far:",
    params.historyText,
  ];
  if (params.retryFeedback) {
    parts.push("", `IMPORTANT: ${params.retryFeedback}`);
  }
  return parts.join("\n");
}

export function parseModelAction(raw: unknown): ModelDecision {
  if (typeof raw !== "object" || raw === null) {
    throw new ModelActionError("tool call input was not an object");
  }
  const { reasoning, ...rest } = raw as Record<string, unknown>;
  const result = DiscoveryActionSchema.safeParse(rest);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`).join("; ");
    throw new ModelActionError(`invalid action: ${issues}`);
  }
  return { action: result.data, reasoning: typeof reasoning === "string" ? reasoning : "" };
}

export interface AnthropicModelClientOptions {
  apiKey?: string;
  /** Required when apiKey (or ANTHROPIC_API_KEY) is an organization-scoped key rather than one scoped to a single workspace — such a key needs to be told which workspace's budget/rate limits to draw from on every request. Falls back to ANTHROPIC_WORKSPACE_ID. */
  workspaceId?: string;
  model?: string;
  maxTokens?: number;
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly goalCache = new Map<string, string>();

  constructor(options: AnthropicModelClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY must be set (or apiKey passed explicitly) to use AnthropicModelClient");
    }
    const workspaceId = options.workspaceId ?? process.env["ANTHROPIC_WORKSPACE_ID"];
    this.client = new Anthropic({
      apiKey,
      ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
    });
    this.model = options.model ?? process.env["DISCOVERY_MODEL"] ?? "claude-sonnet-5";
    this.maxTokens = options.maxTokens ?? 1024;
  }

  async nextAction(params: NextActionParams): Promise<ModelDecision> {
    const system = this.systemPromptFor(params.goal);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: [TAKE_ACTION_TOOL],
      tool_choice: { type: "tool", name: "take_action" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildUserText(params) },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: params.observation.screenshot.toString("base64") },
            },
          ],
        },
      ],
    });

    const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (!toolUse) {
      throw new ModelActionError(`model response contained no take_action tool call (stop_reason: ${response.stop_reason ?? "unknown"})`);
    }
    return parseModelAction(toolUse.input);
  }

  private systemPromptFor(goal: string): string {
    const cached = this.goalCache.get(goal);
    if (cached) {
      return cached;
    }
    const prompt = buildSystemPrompt(goal);
    this.goalCache.set(goal, prompt);
    return prompt;
  }
}
