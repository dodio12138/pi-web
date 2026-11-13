// Types and calls for /api/atlas, and the Chinese labels the panel shows.
// Only pure modules of the package are imported here: this runs in the browser.

export const NODE_TYPE_LABEL: Record<string, string> = {
  book: "书", concept: "概念", claim: "观点", method: "方法", skill: "技能", question: "问题", example: "例子",
};
export const RELATION_LABEL: Record<string, string> = {
  supports: "支持", refutes: "反驳", answers: "回答", explains: "解释", requires: "前提", develops: "发展自", related_to: "相关",
  expounds: "阐述", criticizes: "批评", mentions: "提到", studied_in: "研读",
};
/** Types from before the trim, shown as what they fold into (the files keep them). */
const LEGACY_RELATION: Record<string, string> = {
  defines: "explains", exemplifies: "explains", applies_to: "explains", qualifies: "refutes", compares: "related_to", introduces: "expounds", adopts: "expounds",
};
export const canonicalRelation = (type: string): string => LEGACY_RELATION[type] ?? type;
export const relationLabel = (type: string): string => RELATION_LABEL[canonicalRelation(type)] ?? type;
/** Drawn without an arrow: no direction to show. */
export const isSymmetricRelation = (type: string): boolean => canonicalRelation(type) === "related_to";
export const ATTRIBUTION_LABEL: Record<string, string> = {
  author_claim: "作者观点", quoted: "引述", later_interpretation: "后人解读", ai_synthesis: "AI 概括",
  user_understanding: "我的理解", game_setting: "虚构设定",
};
export const VERIFICATION_LABEL: Record<string, string> = {
  pending: "待核验", partial: "部分核验", verified: "已核验",
};
export const COVERAGE_LABEL: Record<string, string> = { core: "核心", discussed: "讨论", mentioned: "提及" };
export const KNOWLEDGE_RELATION_TYPES = ["supports", "refutes", "answers", "explains", "requires", "develops", "related_to"];
export const BOOK_RELATION_TYPES = ["expounds", "criticizes", "mentions"];
/** What each relation means, for the picker. */
export const RELATION_HINT: Record<string, string> = {
  supports: "这条是那条的论据", refutes: "这条反对那条（只是限定时在备注里写「限定：…」）", answers: "这条回答那个问题",
  explains: "这条解释那条，包括定义、举例、应用", requires: "理解这条要先懂那条", develops: "这条在那条的基础上发展而来",
  related_to: "说不出具体关系时才用", expounds: "书中阐述了它", criticizes: "书批评了它", mentions: "书只是提到",
};
export const NODE_TYPES = ["concept", "claim", "method", "skill", "question", "example"];

export interface AtlasBook { id: string; title: string; authors: string[]; classes: string[]; tags: string[]; knowledge: number; updated_at: string }
export interface AtlasTag { id: string; name: string; type: string; aliases: string[]; count: number }
export interface AtlasOverview {
  root: string;
  exists: boolean;
  revision?: number;
  counts?: { books: number; nodes: number; tags: number; relations: number };
  books?: AtlasBook[];
  tags?: AtlasTag[];
  problems?: string[];
}
export interface GraphCard {
  id: string; kind: "book" | "node"; type: string; title: string; summary: string; tags: string[];
  verification: string; attribution: string | null; subtitle: string; revision: number; updated_at: string; more: number;
  /** In a book's view with a table of contents: the chapter it comes from (null: a supplement) and the exact entry. */
  chapter?: string | null; place?: string | null;
  evidence?: "text" | "sources" | "note" | "inferred" | null;
  sources?: { title: string; kind: string; url: string | null; verification: string }[];
}
/** What backs a card, as its badge says it. */
export const EVIDENCE_LABEL: Record<string, string> = { text: "原文", sources: "有出处", note: "我的", inferred: "推断" };
export const EVIDENCE_HINT: Record<string, string> = {
  text: "有书中原文作依据",
  sources: "有网页、研究或书目资料作依据",
  note: "你自己的笔记或理解",
  inferred: "只有 AI 的推断或对话，没有可查的出处",
};
export interface GraphSpine {
  book_id: string; source: string; note: string | null;
  columns: { id: string | null; title: string | null; chapters: { id: string; title: string; sections: { id: string; title: string }[] }[] }[];
}
export interface GraphEdge { id: string; from: string; to: string; type: string; attribution: string; note: string | null }
export interface AtlasGraph {
  key: string; outline?: GraphSpine | null; cards: GraphCard[]; edges: GraphEdge[]; truncated: boolean; revision: number;
  positions: Record<string, { x: number; y: number }>; hidden: string[];
}
export interface ObjectView {
  object: Record<string, unknown> & { id: string; title?: string; revision: number };
  tags: { id: string; name: string; coverage: string }[];
  relations: { id: string; type: string; direction: "out" | "in"; other_id: string; other_title: string; attribution: string; note?: string }[];
  sources: { id: string; kind: string; title: string; verification: string; locator?: Record<string, string>; url?: string }[];
}
export interface PatchResult {
  ok: boolean;
  created?: Record<string, string>;
  errors?: { op_index: number; path: string; message: string }[];
  conflicts?: { kind: string; id?: string; existing_id?: string; message: string; expected?: number; actual?: number }[];
}

export type GraphView = "book" | "session" | "cross" | "search";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !("ok" in body)) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const atlasApi = {
  overview: () => fetch("/api/atlas?op=overview", { cache: "no-store" }).then(json<AtlasOverview>),
  revision: () => fetch("/api/atlas?op=revision", { cache: "no-store" }).then(json<{ revision?: number; version?: number; exists?: boolean }>),
  graph: (q: { view: GraphView; book_id?: string; session_id?: string; q?: string; tags?: string[]; expand?: string[] }) => {
    const params = new URLSearchParams({ op: "graph", view: q.view });
    if (q.book_id) params.set("book_id", q.book_id);
    if (q.session_id) params.set("session_id", q.session_id);
    if (q.q) params.set("q", q.q);
    if (q.tags?.length) params.set("tags", q.tags.join(","));
    if (q.expand?.length) params.set("expand", q.expand.join(","));
    return fetch(`/api/atlas?${params}`, { cache: "no-store" }).then(json<AtlasGraph>);
  },
  read: (id: string) => fetch(`/api/atlas?op=read&id=${encodeURIComponent(id)}`, { cache: "no-store" }).then(json<ObjectView>),
  post: <T>(body: unknown) => fetch("/api/atlas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json<T>),
  patch: (operations: unknown[], expected_revisions?: Record<string, number>) =>
    atlasApi.post<PatchResult>({ op: "patch", patch: { schema_version: 1, operations, ...(expected_revisions ? { expected_revisions } : {}) } }),
  layout: (change: { view?: string; positions?: Record<string, { x: number; y: number } | null>; hide?: { view: string; ids: string[] }; show?: { view: string; ids: string[] } }) =>
    atlasApi.post<{ ok: boolean }>({ op: "layout", change }),
};

/** One line saying why a patch was refused. */
export function patchProblem(result: PatchResult): string {
  const conflict = result.conflicts?.[0];
  if (conflict?.kind === "revision") return "这张卡片已被别处修改（可能是 Agent）。你的草稿还在，可以合并最新版本后再保存。";
  if (conflict) return conflict.message;
  const error = result.errors?.[0];
  return error ? `${error.path ? `${error.path}: ` : ""}${error.message}` : "保存失败";
}

/** What an action on selected cards puts into the composer: the ids and content travel with the question (§3.3). */
export function askText(action: string, cards: { id: string; type: string; title: string; summary: string }[]): string {
  const lines = cards.map((c) => `- ${c.title}（${NODE_TYPE_LABEL[c.type] ?? c.type}，${c.id}）${c.summary ? `：${c.summary}` : ""}`);
  const target = cards.length > 1 ? "这些知识点" : "这个知识点";
  const ask: Record<string, string> = {
    解释: `请解释${target}。`,
    举例: `请为${target}举一个具体的例子。`,
    比较: `请比较${target}的异同。`,
    质疑: `请对${target}提出最有力的质疑和反例。`,
    应用练习: `请就${target}出一道应用练习题，等我回答后再点评。`,
  };
  return `[知识图谱 · ${action}]\n${lines.join("\n")}\n${ask[action] ?? `${action}：${target}。`}需要时用 atlas_read 读取完整内容。\n`;
}
