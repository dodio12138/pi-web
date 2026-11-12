import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildContext,
  ConversationLog,
  describe,
  exportBackup,
  importBackup,
  openAtlas,
  search,
  type AtlasStore,
  type ObjectKind,
  type Operation,
  type PatchRequest,
} from "../core/index";

// Pi Book Atlas as a pi extension (P2): the model gets atlas_* tools over the
// shared knowledge library, /atlas manages it, and a learning session's
// visible messages are kept so knowledge can be organized from them and cite
// them. It runs the same in the pi CLI and in pi-web, which loads pi
// extensions as they are.

const MODE_ENTRY = "pi-book-atlas/mode";
/** First line of the request /atlas organize sends: that run is about the library, not new knowledge. */
const ORGANIZE_HEADER = "整理本次讨论进知识库（Pi Book Atlas）。";
const SECTION = "pi-book-atlas";

interface Settings {
  root?: string;
  autoEnable?: boolean;
}

/** Where the library lives: PI_BOOK_ATLAS_DIR, else settings bookAtlas.root, else <agent dir>/atlas. */
export function resolveAtlasRoot(settings: Settings, env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = getAgentDir();
  const configured = env.PI_BOOK_ATLAS_DIR || settings.root;
  if (!configured) return join(agentDir, "atlas");
  if (configured === "~" || configured.startsWith("~/")) return join(process.env.HOME ?? "", configured.slice(1));
  return isAbsolute(configured) ? configured : resolve(agentDir, configured);
}

/** What a person could read of a message: user text, the assistant's text parts. Never thinking or tool calls. */
export function visibleText(message: { role?: string; content?: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const GUIDANCE = `This is a learning session connected to the user's book and knowledge library (Pi Book Atlas). Use the atlas_* tools:
- Look before writing: atlas_get_context or atlas_search for the books, concepts and questions in play; atlas_read for an object's full text, relations and sources.
- Write with atlas_apply_patch. Prefer updating an existing node over creating one; a refused duplicate names the existing id to update. One node per knowledge point that can be explained, searched or applied on its own (concept, claim, method, skill, question, example). Small talk and confirmations make no node.
- Reuse existing tags (search first; a duplicate name or alias is refused with the existing id). Mark coverage honestly: core, discussed or mentioned.
- Relations say what they mean: supports, refutes, qualifies, requires, explains… use related_to only when nothing more precise holds. A challenge to a view is a new refutes/qualifies relation, not an overwrite.
- Attribution and evidence: your own explanations are ai_synthesis with verification pending; author_claim only with a source that shows it. Never invent quotations, page numbers or chapter locations: without the text, give a paraphrase and mark it unverified.
- Cite this conversation with the source ref "$conversation" (created for you). Pass the message ids the knowledge came from as source_message_ids.`;

function guidanceWithHints(store: AtlasStore | null, prompt: string | undefined): string {
  if (!store || !prompt?.trim()) return GUIDANCE;
  const hits = search(store, prompt, { kinds: ["node", "book"], limit: 5 }).filter((h) => h.score >= 100);
  if (hits.length === 0) return GUIDANCE;
  const lines = hits.map((h) => `- ${h.title} (${h.id}, ${h.kind}; ${h.reasons.join(", ")})`);
  return `${GUIDANCE}\n\nPossibly relevant in the library (atlas_read for details):\n${lines.join("\n")}`;
}

export default function piBookAtlas(pi: ExtensionAPI) {
  // One library per process, shared by every session (the store hands out one writer per folder).
  let opened: { store: AtlasStore; log: ConversationLog; root: string } | null = null;

  const settings = (): Settings => {
    const value = (pi.getSettings() as Record<string, unknown>).bookAtlas;
    return value && typeof value === "object" ? (value as Settings) : {};
  };

  const atlas = () => {
    if (opened) return opened;
    const root = resolveAtlasRoot(settings());
    try {
      const { store } = openAtlas(root, { create: true });
      opened = { store, log: new ConversationLog(root), root };
      return opened;
    } catch (error) {
      throw new Error(`The Atlas library at ${root} could not be opened: ${(error as Error).message}`);
    }
  };

  /** A session is a learning session once /atlas on was given on its branch, or by default with bookAtlas.autoEnable. */
  const enabled = (ctx: ExtensionContext): boolean => {
    let state: boolean | null = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY) state = Boolean((entry.data as { enabled?: boolean } | undefined)?.enabled);
    }
    return state ?? Boolean(settings().autoEnable);
  };

  /** Stores the branch's visible messages not stored yet. Safe to call any number of times. */
  const capture = (ctx: ExtensionContext): number => {
    if (!enabled(ctx)) return 0;
    const { log } = atlas();
    const messages = [];
    // The organize request and the replies of its run are kept like any visible
    // message, but there is nothing in them to organize.
    const housekeeping: string[] = [];
    let inOrganizeRun = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const role = (entry.message as { role?: string }).role;
      if (role !== "user" && role !== "assistant") continue;
      const text = visibleText(entry.message as { content?: unknown });
      if (role === "user") inOrganizeRun = text.startsWith(ORGANIZE_HEADER);
      if (!text) continue;
      if (inOrganizeRun) housekeeping.push(entry.id);
      messages.push({ entry_id: entry.id, parent_id: entry.parentId, role, text, timestamp: entry.timestamp ?? null, machine: hostname(), workspace: ctx.cwd } as const);
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const fresh = log.capture(sessionId, messages);
    log.markOrganized(sessionId, housekeeping, "atlas-organize-request");
    return fresh.length;
  };

  const lastUserEntryId = (ctx: ExtensionContext): string | null => {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i];
      if (entry.type === "message" && (entry.message as { role?: string }).role === "user") return entry.id;
    }
    return null;
  };

  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });

  // ---- capture -----------------------------------------------------------

  // A run is over only when pi settles: retries, compaction and queued
  // follow-ups have finished (§9.2). Capture never sends anything to the model.
  pi.on("agent_settled", async (_event, ctx) => {
    try { capture(ctx); } catch { /* reported by /atlas status */ }
  });
  // A resumed session catches up on what it said before.
  pi.on("session_start", async (_event, ctx) => {
    try { capture(ctx); } catch { /* reported by /atlas status */ }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled(ctx)) {
      delete event.systemPromptOptions.sections[SECTION];
      return;
    }
    let store: AtlasStore | null = null;
    try { store = atlas().store; } catch { store = null; }
    event.systemPromptOptions.sections[SECTION] = guidanceWithHints(store, event.messageType === "user" ? event.prompt : undefined);
  });

  // ---- tools -------------------------------------------------------------

  const kinds = Type.Optional(Type.Array(Type.Union([Type.Literal("book"), Type.Literal("node"), Type.Literal("tag")]), { description: "Object kinds to search (default: book, node, tag)" }));

  pi.registerTool({
    name: "atlas_search",
    label: "Atlas search",
    description: "Search the user's book and knowledge library (books, knowledge nodes, tags) by title, alias, tag, entry question or text. Every hit says what it matched.",
    promptSnippet: "Search the book and knowledge library",
    parameters: Type.Object({
      query: Type.String({ description: "Words, a title, a tag name or a question. Empty with filters lists matches." }),
      kinds,
      tag_ids: Type.Optional(Type.Array(Type.String(), { description: "Only objects bound to all of these tags" })),
      book_id: Type.Optional(Type.String({ description: "Only this book and the knowledge related to it" })),
      expand_neighbors: Type.Optional(Type.Boolean({ description: "Also return objects one relation away" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, params) {
      const { store } = atlas();
      return json(search(store, params.query, { ...params, kinds: params.kinds as ObjectKind[] | undefined }));
    },
  });

  pi.registerTool({
    name: "atlas_read",
    label: "Atlas read",
    description: "Read library objects by id: full fields and Markdown body, revision, tags by name, relations with the other end's title, and sources with their verification.",
    promptSnippet: "Read books, nodes or tags from the knowledge library by id",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
    annotations: { readOnlyHint: true },
    async execute(_id, params) {
      const { store } = atlas();
      return json(Object.fromEntries(params.ids.map((id) => [id, describe(store, id) ?? { error: "not found" }])));
    },
  });

  pi.registerTool({
    name: "atlas_get_context",
    label: "Atlas context",
    description: "Gather what the library knows about a question or selected objects: related knowledge with summaries and evidence status, the books behind it, relations among them and open questions, within a size budget.",
    promptSnippet: "Gather library knowledge relevant to a question",
    parameters: Type.Object({
      question: Type.Optional(Type.String()),
      selected_ids: Type.Optional(Type.Array(Type.String(), { description: "Objects the user selected; included in full" })),
      book_id: Type.Optional(Type.String()),
      budget_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 20000 })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, params) {
      const { store } = atlas();
      return json(buildContext(store, params));
    },
  });

  pi.registerTool({
    name: "atlas_apply_patch",
    label: "Atlas update",
    description: `Change the knowledge library in one all-or-nothing patch. Operations (each an object with "op"):
create_book {ref?, fields:{title, authors?, entry_questions?, tag_bindings?, source_refs?, body?}} · update_book {id, changes}
create_node {ref?, fields:{type: concept|claim|method|skill|question|example, title, summary?, aliases?, body?, attribution, tag_bindings?, source_refs?}} · update_node {id, changes}
create_tag {ref?, fields:{type: domain|topic|question|method, name, definition?, aliases?, parent_ids?}} · update_tag {id, changes} · merge_tags {from_ids, into_id}
create_relation {ref?, fields:{from_id, to_id, type, attribution, scope?, note?, source_refs?}} · update_relation {id, changes}
create_source {ref?, fields:{kind, title, url?, granularity, locator?}} · bind_tag {target_id, binding:{tag_id, coverage: core|discussed|mentioned, assigned_by: human|source_checked|ai_inference, reason?}} · unbind_tag {target_id, tag_id} · archive {id} · restore {id}
Name new objects with ref "$name" and refer to them as "$name" later in the same patch. "$conversation" is a source for this conversation, created when used.
Relation types: defines explains supports refutes qualifies requires exemplifies compares applies_to related_to; from a book: introduces expounds adopts criticizes mentions studied_in.
Attribution: author_claim quoted later_interpretation ai_synthesis user_understanding game_setting. Verification: pending partial verified.
A refused patch writes nothing and says why: duplicates name the existing id, revision conflicts give the current revision.`,
    promptSnippet: "Add or update books, knowledge nodes, tags and relations in the library",
    parameters: Type.Object({
      operations: Type.Array(Type.Object({ op: Type.String() }, { additionalProperties: true }), { minItems: 1 }),
      expected_revisions: Type.Optional(Type.Record(Type.String(), Type.Integer(), { description: "Revisions you read (from atlas_read) for objects you change" })),
      idempotency_key: Type.Optional(Type.String()),
      source_message_ids: Type.Optional(Type.Array(Type.String(), { description: "Ids of the conversation messages this knowledge came from" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, log } = atlas();
      const sessionId = ctx.sessionManager.getSessionId();
      const operations = params.operations as unknown as Operation[];
      const usesConversation = JSON.stringify(operations).includes('"$conversation"');
      const definesConversation = operations.some((op) => (op as { ref?: string }).ref === "$conversation");
      if (usesConversation && !definesConversation) {
        const messageId = params.source_message_ids?.at(-1) ?? lastUserEntryId(ctx);
        const existing = [...store.sources.values()].find((s) => s.kind === "conversation" && s.locator?.session_id === sessionId && s.locator?.message_id === messageId);
        if (existing) {
          // Point $conversation at the source already made for this message.
          const swap = (value: unknown): unknown => (value === "$conversation" ? existing.id : Array.isArray(value) ? value.map(swap)
            : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)])) : value);
          operations.splice(0, operations.length, ...(operations.map(swap) as Operation[]));
        } else {
          operations.unshift({
            op: "create_source",
            ref: "$conversation",
            fields: {
              kind: "conversation",
              title: `对话 ${pi.getSessionName() ?? sessionId} · ${new Date().toISOString().slice(0, 10)}`,
              granularity: messageId ? "message" : "none",
              ...(messageId ? { locator: { session_id: sessionId, message_id: messageId } } : {}),
            },
          });
        }
      }
      const request: PatchRequest = {
        schema_version: 1,
        operations,
        ...(params.expected_revisions ? { expected_revisions: params.expected_revisions } : {}),
        ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
        ...(params.source_message_ids ? { source_message_ids: params.source_message_ids } : {}),
      };
      const result = store.applyPatch(request);
      // The messages it came from are organized only once their knowledge is stored.
      if (result.ok && params.source_message_ids?.length) {
        try { capture(ctx); } catch { /* still marked below */ }
        log.markOrganized(sessionId, params.source_message_ids, params.idempotency_key ?? `patch:${result.workspace_revision}`);
      }
      return json(result);
    },
  });

  // ---- /atlas ------------------------------------------------------------

  pi.registerCommand("atlas", {
    description: "Book Atlas: status | on | off | organize [note] | search <words> | export <file> | import <file>",
    handler: async (args, ctx) => {
      const [sub = "status"] = args.trim().split(/\s+/).filter(Boolean);
      const arg = args.trim().slice(sub.length).trim();
      const notify = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
      try {
        switch (sub) {
          case "status": {
            const { store, log, root } = atlas();
            const sessionId = ctx.sessionManager.getSessionId();
            const on = enabled(ctx);
            notify([
              `Atlas: ${root}`,
              `${store.books.size} books · ${store.nodes.size} nodes · ${store.tags.size} tags · ${store.relations.size} relations · revision ${store.meta.workspace_revision}`,
              `This session: ${on ? "learning (messages are kept)" : "not a learning session (/atlas on)"}${on ? ` · ${log.messages(sessionId).length} kept, ${log.pending(sessionId).length} to organize` : ""}`,
              ...(store.problems.length ? [`Files with errors: ${store.problems.map((p) => p.file).join(", ")}`] : []),
            ].join("\n"), store.problems.length ? "warning" : "info");
            return;
          }
          case "on":
          case "off": {
            pi.appendEntry(MODE_ENTRY, { enabled: sub === "on" });
            const kept = sub === "on" ? capture(ctx) : 0;
            notify(sub === "on" ? `Learning session on: messages are kept in the Atlas${kept ? ` (${kept} so far)` : ""}.` : "Learning session off: new messages are no longer kept.");
            return;
          }
          case "organize": {
            if (!enabled(ctx)) {
              notify("Turn the learning session on first: /atlas on", "warning");
              return;
            }
            capture(ctx);
            const { log } = atlas();
            const sessionId = ctx.sessionManager.getSessionId();
            const pending = log.pending(sessionId);
            if (pending.length === 0) {
              notify("Nothing to organize: every kept message is already in the Atlas.");
              return;
            }
            const ids = pending.map((m) => m.entry_id);
            const lines = pending.slice(-12).map((m) => `- ${m.entry_id} (${m.role}): ${m.text.replace(/\s+/g, " ").slice(0, 80)}`);
            pi.sendUserMessage([
              ORGANIZE_HEADER,
              `待整理的消息（${pending.length} 条${pending.length > 12 ? "，仅列出最近 12 条" : ""}）：`,
              ...lines,
              "",
              "先用 atlas_get_context / atlas_search 查找已有的书籍、节点和标签，再用一个 atlas_apply_patch 提交：补充已有节点，必要时新建节点、标签和关系，来源引用 \"$conversation\"。",
              `调用时 source_message_ids 设为 ${JSON.stringify(ids)}，idempotency_key 设为 "organize:${sessionId}:${ids.at(-1)}"。`,
              "纯确认或闲聊不建节点；不要编造原文引文、页码或章节。完成后用一两句话告诉我新增和修改了什么。",
              ...(arg ? [`补充说明：${arg}`] : []),
            ].join("\n"));
            return;
          }
          case "search": {
            const { store } = atlas();
            const hits = search(store, arg, { limit: 10 });
            notify(hits.length ? hits.map((h) => `${h.title} · ${h.kind} · ${h.id} · ${h.reasons.join(", ")}`).join("\n") : `No matches for "${arg}"`);
            return;
          }
          case "export": {
            if (!arg) { notify("Usage: /atlas export <file.json>", "warning"); return; }
            const { store } = atlas();
            const path = resolve(ctx.cwd, arg);
            writeFileSync(path, `${JSON.stringify(exportBackup(store), null, 2)}\n`);
            notify(`Exported ${store.books.size} books and ${store.nodes.size} nodes to ${path}`);
            return;
          }
          case "import": {
            if (!arg) { notify("Usage: /atlas import <file.json>", "warning"); return; }
            const { store } = atlas();
            const report = importBackup(store, JSON.parse(readFileSync(resolve(ctx.cwd, arg), "utf8")));
            const added = Object.entries(report.added).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing new";
            notify([
              `Imported: ${added}; ${report.reused.length} already there.`,
              ...(report.conflicts.length ? [`${report.conflicts.length} conflicts (kept the library's version): ${report.conflicts.map((c) => c.id).join(", ")}`] : []),
              ...(report.invalid_refs.length ? [`${report.invalid_refs.length} skipped for missing references`] : []),
              ...(report.patch && !report.patch.ok ? ["The import was refused: nothing was written."] : []),
            ].join("\n"), report.conflicts.length || report.invalid_refs.length ? "warning" : "info");
            return;
          }
          default:
            notify("Usage: /atlas status | on | off | organize [note] | search <words> | export <file> | import <file>", "warning");
        }
      } catch (error) {
        notify(`Atlas: ${(error as Error).message}`, "error");
      }
    },
  });
}
