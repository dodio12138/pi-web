"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtlasCanvas } from "./AtlasCanvas";
import { AtlasDetail } from "./AtlasDetail";
import { layeredLayout, placeCards, type Point } from "./atlas-layout";
import { askText, atlasApi, type AtlasGraph, type AtlasOverview, type GraphView } from "./atlas-client";
import { fetchAtlasSettings, saveAtlasSettings, type AtlasSettingsState } from "./AtlasSettings";
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
  /** Sends a command to the current chat; false when it cannot right now. */
  onSend: (text: string) => boolean;
  /** Opens the book's own session, or starts it; resolves to a problem to show, or null. */
  onOpenBook?: (book: { id: string; title: string }) => Promise<string | null>;
  onOpenSession?: (sessionId: string) => void;
}

const VIEWS: { key: GraphView; label: string }[] = [
  { key: "book", label: "本书" },
  { key: "session", label: "本次讨论" },
  { key: "cross", label: "跨书关联" },
  { key: "search", label: "搜索" },
];

const PREFS_KEY = "pi-atlas-panel";

export function AtlasPanel({ active, sessionId, onInsert, onSend, onOpenBook, onOpenSession }: Props) {
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
  const [packOpen, setPackOpen] = useState(false);
  // The extension's switch and whether this session learns (null: no session yet).
  const [setup, setSetup] = useState<AtlasSettingsState | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [packUntil, setPackUntil] = useState("");
  const [packNotes, setPackNotes] = useState(false);
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
      // A view seen for the first time gets the tidy rows; later, new cards fill in around the user's arrangement.
      const placed = Object.keys(next.positions).length === 0 ? layeredLayout(next.cards, next.edges) : placeCards(next.cards, next.edges, next.positions);
      setPositions({ ...next.positions, ...placed });
      setGraph(next);
      if (Object.keys(placed).length) void atlasApi.layout({ view: next.key, positions: placed });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [graphQuery, ready]);

  const loadSetup = useCallback(async () => setSetup(await fetchAtlasSettings(sessionId)), [sessionId]);
  useEffect(() => { if (active) void loadSetup(); }, [active, loadSetup]);
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
        // Messages are kept as each turn ends: the count to organize moves without a commit.
        void loadSetup();
      } catch { /* next tick */ }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, overview?.exists, loadGraph, loadOverview, loadSetup]);

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
    const placed = layeredLayout(graph.cards, graph.edges);
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

  // The pack follows the tag filter on screen; a year makes it a game pack.
  const packUrl = () => {
    const params = new URLSearchParams({ op: "pack" });
    if (tagIds.length) params.set("tags", tagIds.join(","));
    if (packUntil.trim()) params.set("until", packUntil.trim());
    if (packNotes) params.set("notes", "1");
    return `/api/atlas?${params}`;
  };
  const packYearOk = !packUntil.trim() || /^-?\d+$/.test(packUntil.trim());

  const send = (text: string, done?: string) => {
    if (!onSend(text)) { setStatus("正在回复，等这一轮结束再试"); return false; }
    if (done) setStatus(done);
    return true;
  };

  // The session's mode is a session entry the command writes: read it back once it has run.
  const toggleLearning = () => {
    const on = !setup?.learning;
    if (send(on ? "/atlas on" : "/atlas off", on ? "已开启学习模式" : "已关闭学习模式")) {
      window.setTimeout(() => void loadSetup(), 1200);
      window.setTimeout(() => void loadSetup(), 4000);
    }
  };

  const enableAtlas = async () => {
    setEnabling(true);
    try {
      setSetup(await saveAtlasSettings({ installed: true }));
      setStatus("已启用：新建的会话会加载书籍知识库");
      void loadOverview();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setEnabling(false);
    }
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
  if (setup && !setup.installed) {
    return (
      <div className="atlas-empty">
        <p>书籍知识库还没有启用。</p>
        <p className="atlas-dim">启用后，会话里可以开启学习模式：讨论会被记录，整理成书、知识节点和标签，显示在这里。</p>
        <button type="button" className="atlas-btn atlas-btn-primary" disabled={enabling} onClick={() => void enableAtlas()}>{enabling ? "启用中…" : "启用书籍知识库"}</button>
        <p className="atlas-dim">知识库目录：<span className="atlas-mono">{setup.root}</span>（可在设置 › 常规里修改）</p>
        {status && <p className="atlas-status">{status}</p>}
      </div>
    );
  }
  if (!overview.exists) {
    return (
      <div className="atlas-empty">
        <p>还没有知识库。</p>
        <p className="atlas-dim atlas-mono">{overview.root}</p>
        <p className="atlas-dim">在会话里开启学习模式后，第一次整理时会自动创建；也可以现在就创建。</p>
        <div className="atlas-row" style={{ justifyContent: "center" }}>
          {sessionId && !setup?.learning && <button type="button" className="atlas-btn atlas-btn-primary" onClick={toggleLearning}>在本会话开启学习模式</button>}
          <button type="button" className="atlas-btn" onClick={() => void createLibrary()}>创建知识库</button>
        </div>
        {setup?.installed && <p className="atlas-dim">扩展已启用。如果本会话是启用之前打开的，需要重新打开会话才会加载。</p>}
        {status && <p className="atlas-status">{status}</p>}
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
        {sessionId && setup?.installed && (setup.readingSession ? (
          <span className="atlas-chip atlas-reading" title="这个会话在知识库目录里：对话自动记录，可以整理进知识库">● 读书会话</span>
        ) : (setup.autoEnable && setup.learning) ? null : (
          <button
            type="button"
            className={`atlas-btn${setup.learning ? " is-on" : ""}`}
            onClick={toggleLearning}
            aria-pressed={Boolean(setup.learning)}
            title={setup.learning ? "本会话在学习模式：消息会被记录，可以整理进知识库。点击关闭" : "开启后，本会话的消息会被记录，可以整理进知识库"}
          >{setup.learning ? "● 学习模式" : "开启学习模式"}</button>
        ))}
        <button
          type="button"
          className="atlas-btn"
          disabled={!sessionId || !setup?.learning}
          onClick={() => send("/atlas organize", "已发送整理请求")}
          title={!setup?.learning ? "先开启学习模式" : setup.pending ? `还有 ${setup.pending} 条消息没进知识库：让 Agent 整理` : "本次讨论都已在知识库里"}
        >整理本次讨论{setup?.learning && setup.pending ? `（${setup.pending}）` : ""}</button>
        <button type="button" className="atlas-btn" onClick={() => void rearrange()} title="按层次重新排列：书在上，直接相关的知识在下一行，再往外的在更下面">重排</button>
        <span className="atlas-pop-anchor">
          <button type="button" className={`atlas-btn${packOpen ? " is-on" : ""}`} onClick={() => setPackOpen((v) => !v)} aria-expanded={packOpen} title="导出给其他应用或游戏用的资料包">导出资料包</button>
          {packOpen && (
            <div className="atlas-pop" role="dialog" aria-label="导出资料包">
              <div className="atlas-dim">
                {tagIds.length
                  ? `按当前标签筛选：${(overview.tags ?? []).filter((t) => tagIds.includes(t.id)).map((t) => t.name).join("、")}（含子标签）`
                  : "全部书和知识（在左侧选标签可以缩小范围）"}
              </div>
              <label className="atlas-pop-row">
                游戏截止年代
                <input value={packUntil} onChange={(e) => setPackUntil(e.target.value)} placeholder="如 1700，公元前写负数" inputMode="numeric" />
              </label>
              {packUntil.trim() && <div className="atlas-dim">只包含该年及以前出版的书、以及经由这些书得到的知识；年代未知的书不包含。</div>}
              <label className="atlas-pop-check">
                <input type="checkbox" checked={packNotes} onChange={(e) => setPackNotes(e.target.checked)} />
                包含「我的理解」类笔记
              </label>
              <div className="atlas-dim">不会包含：对话记录、会话 ID、画板布局、本机路径。</div>
              <div className="atlas-row">
                <a className={`atlas-btn atlas-btn-primary${packYearOk ? "" : " is-disabled"}`} href={packYearOk ? packUrl() : undefined} download onClick={() => packYearOk && setPackOpen(false)}>下载 JSON</a>
                {!packYearOk && <span className="atlas-dim">年代要写整数</span>}
              </div>
            </div>
          )}
        </span>
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
            onOpenBook={onOpenBook ? (book) => void onOpenBook(book).then((problem) => setStatus(problem ?? "")) : undefined}
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
