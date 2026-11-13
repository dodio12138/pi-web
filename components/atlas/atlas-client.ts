// Types and calls for /api/atlas, and the Chinese labels the panel shows.
// Only pure modules of the package are imported here: this runs in the browser.

export const NODE_TYPE_LABEL: Record<string, string> = {
  book: "书", concept: "概念", claim: "观点", method: "方法", skill: "技能", question: "问题", example: "例子",
};
export const RELATION_LABEL: Record<string, string> = {
  defines: "定义", explains: "解释", supports: "支持", refutes: "反驳", qualifies: "限定", requires: "需要先懂",
  exemplifies: "举例", compares: "对比", applies_to: "应用于", related_to: "相关",
  introduces: "提出", expounds: "阐述", adopts: "采用", criticizes: "批评", mentions: "提到", studied_in: "研读",
};
export const ATTRIBUTION_LABEL: Record<string, string> = {
  author_claim: "作者观点", quoted: "引述", later_interpretation: "后人解读", ai_synthesis: "AI 概括",
  user_understanding: "我的理解", game_setting: "虚构设定",
};
export const VERIFICATION_LABEL: Record<string, string> = {
  pending: "待核验", partial: "部分核验", verified: "已核验",
};
export const COVERAGE_LABEL: Record<string, string> = { core: "核心", discussed: "讨论", mentioned: "提及" };
export const KNOWLEDGE_RELATION_TYPES = ["explains", "supports", "refutes", "qualifies", "requires", "exemplifies", "compares", "applies_to", "defines", "related_to"];
export const BOOK_RELATION_TYPES = ["expounds", "introduces", "adopts", "criticizes", "mentions"];
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
}
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
