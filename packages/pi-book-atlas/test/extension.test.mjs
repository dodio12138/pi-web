import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { core } from "./helpers.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

/**
 * A stand-in for pi: records what the extension registers, plays its events,
 * and keeps one session branch the extension reads and appends to.
 */
async function fakePi(t, { autoEnable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-book-atlas-ext-"));
  const previous = process.env.PI_BOOK_ATLAS_DIR;
  process.env.PI_BOOK_ATLAS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_BOOK_ATLAS_DIR;
    else process.env.PI_BOOK_ATLAS_DIR = previous;
    try { core.openAtlas(root).store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const branch = [];
  const sent = [];
  const notices = [];
  let nextId = 1;
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getSettings: () => ({ bookAtlas: { autoEnable } }),
    getSessionName: () => "测试会话",
    appendEntry: (customType, data) => { branch.push({ type: "custom", id: `e${nextId++}`, parentId: branch.at(-1)?.id ?? null, customType, data }); },
    sendUserMessage: (content) => { sent.push(content); },
  };
  const ctx = {
    cwd: "/work/project",
    sessionManager: { getBranch: () => branch, getSessionId: () => "session-abc" },
    ui: { notify: (text, level) => notices.push({ text, level }) },
  };
  const { default: extension } = await jiti.import("../src/extension/index.ts");
  extension(pi);

  const emit = async (event, payload = {}) => {
    let result;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };
  const say = (role, content) => {
    const entry = { type: "message", id: `e${nextId++}`, parentId: branch.at(-1)?.id ?? null, timestamp: "2026-11-12T10:00:00.000Z", message: { role, content } };
    branch.push(entry);
    return entry.id;
  };
  const command = (args) => commands.get("atlas").handler(args, ctx);
  const tool = async (name, params) => {
    const result = await tools.get(name).execute("call-1", params, undefined, undefined, ctx);
    return JSON.parse(result.content[0].text);
  };
  const log = () => new core.ConversationLog(root);
  return { root, tools, commands, emit, say, command, tool, sent, notices, ctx, branch, log };
}

test("registers the four tools and /atlas; the read-only tools say so", async (t) => {
  const host = await fakePi(t);
  assert.deepEqual([...host.tools.keys()].sort(), ["atlas_apply_patch", "atlas_get_context", "atlas_read", "atlas_search"]);
  assert.ok(host.commands.has("atlas"));
  for (const name of ["atlas_search", "atlas_read", "atlas_get_context"]) assert.equal(host.tools.get(name).annotations?.readOnlyHint, true, name);
  assert.equal(host.tools.get("atlas_apply_patch").annotations?.readOnlyHint, undefined);
});

test("a learning session keeps each visible message exactly once; thinking and tool calls never", async (t) => {
  const host = await fakePi(t);
  const u1 = host.say("user", "先解释这本书涉及的自然状态概念");
  host.say("assistant", [{ type: "thinking", thinking: "内部推理" }, { type: "toolCall", id: "c1", name: "atlas_search", arguments: {} }]);
  host.say("toolResult", [{ type: "text", text: "工具原始输出" }]);
  const a1 = host.say("assistant", [{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "自然状态是没有共同权力时的处境。" }]);

  await host.emit("agent_settled", {});
  assert.equal(host.log().messages("session-abc").length, 0, "not a learning session yet");

  await host.command("on");
  await host.emit("agent_settled", {});
  await host.emit("agent_settled", {}); // a retry, a reconnect
  const kept = host.log().messages("session-abc");
  assert.deepEqual(kept.map((m) => [m.entry_id, m.role, m.text]), [[u1, "user", "先解释这本书涉及的自然状态概念"], [a1, "assistant", "自然状态是没有共同权力时的处境。"]]);
  assert.ok(!JSON.stringify(kept).includes("内部推理"));
  assert.ok(!JSON.stringify(kept).includes("工具原始输出"));
  assert.equal(kept[0].workspace, "/work/project");

  const u2 = host.say("user", "举个例子");
  await host.emit("agent_settled", {});
  assert.deepEqual(host.log().messages("session-abc").map((m) => m.entry_id), [u1, a1, u2]);
});

test("a resumed session catches up on messages from before, and /atlas off stops keeping new ones", async (t) => {
  const host = await fakePi(t);
  host.say("user", "旧消息");
  host.branch.push({ type: "custom", id: "mode", parentId: null, customType: "pi-book-atlas/mode", data: { enabled: true } });
  await host.emit("session_start", { reason: "resume" });
  assert.deepEqual(host.log().messages("session-abc").map((m) => m.text), ["旧消息"]);

  await host.command("off");
  host.say("user", "关闭后的消息");
  await host.emit("agent_settled", {});
  assert.deepEqual(host.log().messages("session-abc").map((m) => m.text), ["旧消息"]);
});

test("bookAtlas.autoEnable makes every session a learning session", async (t) => {
  const host = await fakePi(t, { autoEnable: true });
  host.say("user", "自动采集");
  await host.emit("agent_settled", {});
  assert.equal(host.log().messages("session-abc").length, 1);
});

test("$conversation cites this session's message, once per message; source_message_ids mark them organized", async (t) => {
  const host = await fakePi(t);
  await host.command("on");
  const u1 = host.say("user", "什么是自然状态");
  host.say("assistant", "没有共同权力时人人相互为敌的处境。");
  await host.emit("agent_settled", {});
  assert.equal(host.log().pending("session-abc").length, 2);

  const first = await host.tool("atlas_apply_patch", {
    operations: [{ op: "create_node", ref: "$n", fields: { type: "concept", title: "自然状态", summary: "没有共同权力时的处境", attribution: "ai_synthesis", source_refs: ["$conversation"] } }],
    source_message_ids: [u1],
    idempotency_key: `organize:session-abc:${u1}`,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const { store } = core.openAtlas(host.root);
  const node = store.nodes.get(first.created.$n);
  const source = store.sources.get(node.source_refs[0]);
  assert.equal(source.kind, "conversation");
  assert.deepEqual(source.locator, { session_id: "session-abc", message_id: u1 });
  assert.equal(source.granularity, "message");
  assert.deepEqual(host.log().pending("session-abc").map((m) => m.role), ["assistant"]);

  const second = await host.tool("atlas_apply_patch", {
    operations: [{ op: "update_node", id: node.id, changes: { body: "补充", source_refs: ["$conversation"] } }],
    source_message_ids: [u1],
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(store.sources.size, 1, "the same message's source is reused");
});

test("a refused patch leaves the messages pending, so organizing can simply be tried again", async (t) => {
  const host = await fakePi(t);
  await host.command("on");
  const u1 = host.say("user", "整理一下");
  await host.emit("agent_settled", {});
  const bad = await host.tool("atlas_apply_patch", {
    operations: [{ op: "bind_tag", target_id: "node-0000000000000", binding: { tag_id: "tag-0000000000000", coverage: "core", assigned_by: "human" } }],
    source_message_ids: [u1],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(host.log().pending("session-abc").map((m) => m.entry_id), [u1]);
});

test("/atlas organize asks the agent with the pending message ids and a stable idempotency key", async (t) => {
  const host = await fakePi(t);
  await host.command("organize");
  assert.match(host.notices.at(-1).text, /\/atlas on/);
  await host.command("on");
  const u1 = host.say("user", "为什么要服从国家");
  const a1 = host.say("assistant", "霍布斯的回答是……");
  await host.command("organize 侧重霍布斯");
  const prompt = host.sent.at(-1);
  assert.ok(prompt.includes(JSON.stringify([u1, a1])), prompt);
  assert.ok(prompt.includes(`organize:session-abc:${a1}`));
  assert.ok(prompt.includes("补充说明：侧重霍布斯"));
  assert.ok(/不要编造原文引文、页码或章节/.test(prompt));

  // The request and its run's reply are kept, but never queued for organizing.
  host.say("user", prompt);
  host.say("assistant", "已整理：新增节点");
  await host.emit("agent_settled", {});
  assert.deepEqual(host.log().pending("session-abc").map((m) => m.entry_id), [u1, a1]);

  host.log().markOrganized("session-abc", [u1, a1], "done");
  await host.command("organize");
  assert.match(host.notices.at(-1).text, /Nothing to organize/);
  const u3 = host.say("user", "那社会契约呢");
  await host.emit("agent_settled", {});
  assert.deepEqual(host.log().pending("session-abc").map((m) => m.entry_id), [u3], "a normal question after the run is pending again");
});

test("the prompt carries the Atlas rules and likely matches in learning sessions only", async (t) => {
  const host = await fakePi(t);
  const { store } = core.openAtlas(host.root, { create: true });
  store.applyPatch({ schema_version: 1, operations: [{ op: "create_node", fields: { type: "concept", title: "自然状态", attribution: "ai_synthesis" } }] });

  const event = (prompt) => ({ messageType: "user", prompt, systemPromptOptions: { sections: { [`pi-book-atlas`]: "stale" } } });
  const off = event("自然状态是什么");
  await host.emit("before_agent_start", off);
  assert.equal(off.systemPromptOptions.sections["pi-book-atlas"], undefined);

  await host.command("on");
  const on = event("自然状态是什么");
  await host.emit("before_agent_start", on);
  const section = on.systemPromptOptions.sections["pi-book-atlas"];
  assert.match(section, /Never invent quotations, page numbers or chapter locations/);
  assert.match(section, /Possibly relevant in the library[\s\S]*自然状态 \(node-/);
  const unrelated = event("今天天气不错");
  await host.emit("before_agent_start", unrelated);
  assert.doesNotMatch(unrelated.systemPromptOptions.sections["pi-book-atlas"], /Possibly relevant/);
});

test("search, read and context answer from the same library the patches wrote", async (t) => {
  const host = await fakePi(t);
  const made = await host.tool("atlas_apply_patch", { operations: [
    { op: "create_tag", ref: "$t", fields: { type: "topic", name: "自然法" } },
    { op: "create_book", ref: "$b", fields: { title: "利维坦", authors: ["霍布斯"], tag_bindings: [{ tag_id: "$t", coverage: "core", assigned_by: "ai_inference", source_refs: [] }] } },
    { op: "create_node", ref: "$n", fields: { type: "concept", title: "自然状态", summary: "没有共同权力时的处境", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$b", to_id: "$n", type: "expounds", attribution: "ai_synthesis" } },
  ] });
  assert.equal(made.ok, true, JSON.stringify(made));
  const hits = await host.tool("atlas_search", { query: "自然法", kinds: ["book"] });
  assert.equal(hits[0].id, made.created.$b);
  const read = await host.tool("atlas_read", { ids: [made.created.$n, "node-missing00000"] });
  assert.equal(read[made.created.$n].relations[0].other_title, "利维坦");
  assert.equal(read["node-missing00000"].error, "not found");
  const context = await host.tool("atlas_get_context", { question: "自然状态" });
  assert.equal(context.related[0].id, made.created.$n);
  assert.equal(context.books[0].title, "利维坦");
});

test("/atlas status, search, export and import report in words", async (t) => {
  const host = await fakePi(t);
  await host.tool("atlas_apply_patch", { operations: [{ op: "create_book", fields: { title: "控制论", authors: ["维纳"] } }] });
  await host.command("status");
  assert.match(host.notices.at(-1).text, /1 books · 0 nodes/);
  await host.command("search 控制论");
  assert.match(host.notices.at(-1).text, /控制论 · book · book-/);
  const file = join(host.root, "backup.json");
  await host.command(`export ${file}`);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).books.length, 1);
  await host.command(`import ${file}`);
  assert.match(host.notices.at(-1).text, /nothing new; 1 already there/);
});

test("a torn last line in a conversation log is skipped, and the next append starts a fresh line", async (t) => {
  const host = await fakePi(t);
  await host.command("on");
  host.say("user", "第一条");
  await host.emit("agent_settled", {});
  appendFileSync(join(host.root, "conversations", "session-abc.jsonl"), '{"type":"message","entry_id":"e9');
  host.say("user", "第二条");
  await host.emit("agent_settled", {});
  assert.deepEqual(host.log().messages("session-abc").map((m) => m.text), ["第一条", "第二条"]);
});
