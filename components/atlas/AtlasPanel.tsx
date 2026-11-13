"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtlasCanvas } from "./AtlasCanvas";
import { AtlasDetail } from "./AtlasDetail";
import { placeCards, type Point } from "./atlas-layout";
import { askText, atlasApi, type AtlasGraph, type AtlasOverview, type GraphView } from "./atlas-client";
import "./atlas.css";

// The knowledge graph tab (Pi Book Atlas, P3). Books and tags on the left,
// the canvas in the middle, the selected card's details on the right. It
// shows one part of the library at a time (a book, this conversation, what
// books share, or a search), follows the Agent's changes as they are
// committed, and sends selected cards into the chat with their ids.

interface Props {
  active: boolean;
  sessionId: string | null;
  onInsert: (text: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

const VIEWS: { key: GraphView; label: string }[] = [
  { key: "book", label: "本书" },
  { key: "session", label: "本次讨论" },
  { key: "cross", label: "跨书关联" },
  { key: "search", label: "搜索" },
];

const PREFS_KEY = "pi-atlas-panel";

export function AtlasPanel({ active, sessionId, onInsert, onOpenSession }: Props) {
  const [overview, setOverview] = useState<AtlasOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<GraphView>("book");
  const [bookId, setBookId] = useState<string | null>(null);
  const [bookFilter, setBookFilter] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [expand, setExpand] = useState<string[]>([]);
  const [graph, setGraph] = useState<AtlasGraph | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [showBooks, setShowBooks] = useState(true);
  // In a narrow panel the books column floats over the canvas: closed until asked for.
  const panelRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [booksOverlay, setBooksOverlay] = useState(false);
  const sidebarVisible = narrow ? booksOverlay : showBooks;
  const [status, setStatus] = useState<string>("");
  const seenRef = useRef<{ revision: number; cards: Map<string, number> } | null>(null);
  const changeRef = useRef<string>("");
  const selectedRef = useRef<string[]>([]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Remember the view and book between visits.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as { view?: GraphView; bookId?: string; showBooks?: boolean };
      if (saved.view) setView(saved.view);
      if (saved.bookId) setBookId(saved.bookId);
      if (typeof saved.showBooks === "boolean") setShowBooks(saved.showBooks);
    } catch { /* optional */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify({ view, bookId, showBooks })); } catch { /* optional */ }
  }, [view, bookId, showBooks]);

  const loadOverview = useCallback(async () => {
    try {
      const next = await atlasApi.overview();
      setOverview(next);
      setError(null);
      if (next.exists && next.books?.length) setBookId((id) => (id && next.books!.some((b) => b.id === id) ? id : next.books![0].id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const graphQuery = useMemo(() => ({
    view,
    book_id: view === "book" ? bookId ?? undefined : undefined,
    session_id: view === "session" ? sessionId ?? undefined : undefined,
    q: view === "search" ? submitted : undefined,
    tags: tagIds,
    expand,
  }), [view, bookId, sessionId, submitted, tagIds, expand]);
  const ready = overview?.exists && (view !== "book" || bookId) && (view !== "session" || sessionId) && (view !== "search" || submitted || tagIds.length);

  const loadGraph = useCallback(async () => {
    if (!ready) { setGraph(null); return; }
    try {
      const next = await atlasApi.graph(graphQuery);
      // New and changed cards since the user last saw this view glow until selected.
      // Only a library change marks cards: opening neighbours shows old knowledge, not new.
      const seen = seenRef.current;
      if (seen && seen.revision !== next.revision) {
        const changed = next.cards.filter((c) => seen.cards.get(c.id) !== c.revision && !selectedRef.current.includes(c.id)).map((c) => c.id);
        if (changed.length) setFresh((prev) => new Set([...prev, ...changed]));
      }
      seenRef.current = { revision: next.revision, cards: new Map(next.cards.map((c) => [c.id, c.revision])) };
      // Place only cards without a saved position, and save where they went.
      const placed = placeCards(next.cards, next.edges, next.positions);
      setPositions({ ...next.positions, ...placed });
      setGraph(next);
      if (Object.keys(placed).length) void atlasApi.layout({ view: next.key, positions: placed });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [graphQuery, ready]);

  useEffect(() => { if (active) void loadOverview(); }, [active, loadOverview]);
  // A different view starts fresh: nothing glows, expansions reset.
  useEffect(() => { seenRef.current = null; setFresh(new Set()); setSelected([]); }, [view, bookId, sessionId, submitted]);
  useEffect(() => { setExpand([]); }, [view, bookId, sessionId, submitted]);
  useEffect(() => { if (active) void loadGraph(); }, [active, loadGraph]);

  // Follow commits (the Agent's included) while the tab is visible.
  useEffect(() => {
    if (!active || !overview?.exists) return;
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await atlasApi.revision();
        const token = `${r.revision}:${r.version}`;
        if (changeRef.current && token !== changeRef.current && !stopped) {
          setStatus("知识库已更新");
          void loadOverview();
          void loadGraph();
        }
        changeRef.current = token;
      } catch { /* next tick */ }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, overview?.exists, loadGraph, loadOverview]);

  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(""), 2500);
    return () => window.clearTimeout(t);
  }, [status]);

  const onMove = (id: string, p: Point) => {
    setPositions((prev) => ({ ...prev, [id]: p }));
    void atlasApi.layout({ view: graph?.key, positions: { [id]: p } }).then(() => setStatus("布局已保存")).catch(() => setStatus("布局保存失败"));
  };

  const rearrange = async () => {
    if (!graph) return;
    const cleared = Object.fromEntries(graph.cards.map((c) => [c.id, null]));
    await atlasApi.layout({ view: graph.key, positions: cleared });
    const placed = placeCards(graph.cards, graph.edges, {});
    setPositions(placed);
    await atlasApi.layout({ view: graph.key, positions: placed });
    setStatus("已重新排列");
  };

  const hide = async (id: string) => {
    if (!graph) return;
    await atlasApi.layout({ hide: { view: graph.key, ids: [id] } });
    setSelected((s) => s.filter((x) => x !== id));
    void loadGraph();
  };
  const showHidden = async () => {
    if (!graph?.hidden.length) return;
    await atlasApi.layout({ show: { view: graph.key, ids: graph.hidden } });
    void loadGraph();
  };

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 520));
    observer.observe(el);
    return () => observer.disconnect();
  }, [overview?.exists]);

  const select = (ids: string[]) => {
    setSelected(ids);
    if (ids.length) setFresh((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
  };

  const ask = (action: string) => {
    const cards = (graph?.cards ?? []).filter((c) => selected.includes(c.id));
    if (cards.length) onInsert(askText(action, cards));
  };

  const createLibrary = async () => {
    await atlasApi.post({ op: "create" });
    void loadOverview();
  };

  const newNode = async () => {
    const title = window.prompt("新知识点的标题");
    if (!title?.trim()) return;
    const ops: unknown[] = [{ op: "create_node", ref: "$n", fields: { type: "concept", title: title.trim(), attribution: "user_understanding" } }];
    if (view === "book" && bookId) ops.push({ op: "create_relation", fields: { from_id: bookId, to_id: "$n", type: "expounds", attribution: "user_understanding" } });
    const result = await atlasApi.patch(ops);
    if (!result.ok) { setStatus(result.conflicts?.[0]?.message ?? result.errors?.[0]?.message ?? "创建失败"); return; }
    const id = result.created?.$n;
    if (id && view !== "book") setExpand((e) => [...e, id]);
    await loadGraph();
    if (id) select([id]);
  };

  const books = (overview?.books ?? []).filter((b) => !bookFilter.trim() || `${b.title} ${b.authors.join(" ")} ${b.classes.join(" ")} ${b.tags.join(" ")}`.toLowerCase().includes(bookFilter.trim().toLowerCase()));
  const currentBook = overview?.books?.find((b) => b.id === bookId);
  const detailId = selected.length === 1 ? selected[0] : null;

  if (error && !overview) return <div className="atlas-empty">知识库读取失败：{error}</div>;
  if (!overview) return <div className="atlas-empty atlas-dim">载入中…</div>;
  if (!overview.exists) {
    return (
      <div className="atlas-empty">
        <p>还没有知识库。</p>
        <p className="atlas-dim atlas-mono">{overview.root}</p>
        <p className="atlas-dim">在对话里输入 <code>/atlas on</code> 开启学习会话，或者直接在这里创建。</p>
        <button type="button" className="atlas-btn atlas-btn-primary" onClick={() => void createLibrary()}>创建知识库</button>
      </div>
    );
  }

  return (
    <div className="atlas-panel" ref={panelRef}>
      <div className="atlas-toolbar">
        <button type="button" className={`atlas-btn atlas-btn-icon${sidebarVisible ? " is-on" : ""}`} onClick={() => (narrow ? setBooksOverlay((v) => !v) : setShowBooks((v) => !v))} title="书籍与标签" aria-label="书籍与标签" aria-pressed={sidebarVisible}>☰</button>
        <div className="atlas-seg" role="tablist" aria-label="视图">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={view === v.key ? "is-on" : ""} onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </div>
        {view === "search" && (
          <form className="atlas-search" onSubmit={(e) => { e.preventDefault(); setSubmitted(query.trim()); }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="概念、问题、书名…" />
          </form>
        )}
        <span style={{ flex: 1 }} />
        {status && <span className="atlas-status">{status}</span>}
        <button type="button" className="atlas-btn" onClick={() => void newNode()} title="新建一个知识点">+ 节点</button>
        <button type="button" className="atlas-btn" onClick={() => onInsert("/atlas organize")} title="把本次讨论整理进知识库">整理本次讨论</button>
        <button type="button" className="atlas-btn" onClick={() => void rearrange()} title="重新排列这个视图里的所有卡片">重排</button>
        {graph && graph.hidden.length > 0 && <button type="button" className="atlas-btn" onClick={() => void showHidden()}>显示已移除（{graph.hidden.length}）</button>}
      </div>

      <div className="atlas-body">
        {sidebarVisible && (
          <nav className="atlas-sidebar" aria-label="书籍与标签">
            <input className="atlas-filter" value={bookFilter} onChange={(e) => setBookFilter(e.target.value)} placeholder="找书：书名、作者、分类" />
            <div className="atlas-books">
              {books.length === 0 && <div className="atlas-dim">没有书</div>}
              {books.map((b) => (
                <button key={b.id} type="button" className={`atlas-book${b.id === bookId && view === "book" ? " is-on" : ""}`} onClick={() => { setBookId(b.id); setView("book"); if (narrow) setBooksOverlay(false); }}>
                  <span className="atlas-book-title">{b.title}</span>
                  <span className="atlas-book-sub">{[b.authors.join("、"), b.classes[0]].filter(Boolean).join(" · ")}</span>
                  {b.tags.length > 0 && <span className="atlas-book-tags">{b.tags.join(" · ")}</span>}
                </button>
              ))}
            </div>
            <div className="atlas-tags">
              <div className="atlas-tags-head">
                <span>标签筛选</span>
                {tagIds.length > 0 && <button type="button" className="atlas-link" onClick={() => setTagIds([])}>清除</button>}
              </div>
              <div className="atlas-row atlas-wrap">
                {(overview.tags ?? []).filter((t) => t.count > 0).slice(0, 60).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`atlas-chip atlas-chip-btn${tagIds.includes(t.id) ? " is-on" : ""}`}
                    onClick={() => setTagIds((ids) => (ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id]))}
                    aria-pressed={tagIds.includes(t.id)}
                  >{t.name}<span className="atlas-dim">{t.count}</span></button>
                ))}
              </div>
            </div>
            <div className="atlas-dim atlas-counts">
              {overview.counts?.books} 本书 · {overview.counts?.nodes} 个节点 · r{overview.revision}
            </div>
          </nav>
        )}

        <div className="atlas-main">
          {!ready ? (
            <div className="atlas-empty atlas-dim">
              {view === "book" && "先在左边选一本书。"}
              {view === "session" && "当前没有打开的会话。"}
              {view === "search" && "输入关键词，或选择标签。"}
            </div>
          ) : graph && graph.cards.length === 0 ? (
            <div className="atlas-empty atlas-dim">
              {view === "session" ? "本次讨论还没有整理进知识库的内容。点「整理本次讨论」。" : view === "cross" ? "还没有被多本书共同讨论的知识。" : "这里还没有内容。"}
            </div>
          ) : graph ? (
            <>
              {view === "book" && currentBook && (
                <div className="atlas-crumb">《{currentBook.title}》{currentBook.classes.length > 0 && <span className="atlas-dim"> · {currentBook.classes.join("；")}</span>}</div>
              )}
              <AtlasCanvas
                cards={graph.cards}
                edges={graph.edges}
                positions={positions}
                selected={selected}
                fresh={fresh}
                onSelect={select}
                onMove={onMove}
                onExpand={(id) => setExpand((e) => (e.includes(id) ? e : [...e, id]))}
              />
              {graph.truncated && <div className="atlas-note">只显示了部分卡片，用标签缩小范围。</div>}
              {selected.length > 1 && (
                <div className="atlas-multi">
                  <span>已选 {selected.length} 张</span>
                  {["比较", "解释", "质疑"].map((a) => <button key={a} type="button" className="atlas-btn" onClick={() => ask(a)}>{a}</button>)}
                </div>
              )}
            </>
          ) : (
            <div className="atlas-empty atlas-dim">载入中…</div>
          )}
        </div>

        {detailId && (
          <AtlasDetail
            key={detailId}
            id={detailId}
            tags={overview.tags ?? []}
            cards={graph?.cards ?? []}
            onAsk={ask}
            onSelect={(id) => {
              if (graph && !graph.cards.some((c) => c.id === id)) setExpand((e) => [...e, id]);
              select([id]);
            }}
            onHide={(id) => void hide(id)}
            onChanged={() => { void loadOverview(); void loadGraph(); }}
            onOpenSession={onOpenSession}
            onClose={() => setSelected([])}
          />
        )}
      </div>
    </div>
  );
}
