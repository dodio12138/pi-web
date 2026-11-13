# pi-book-atlas

书籍、标签与知识图谱插件（Pi Book Atlas）。设计文档：`Pi_Book_Atlas_Development_v0.1.md`。

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 宿主确认 | agegr/pi-web（dodio12138 fork 的 `custom`），pi SDK 1.5.0 | 已确认；最小面板待做 |
| **P1 数据核心** | 数据模型、存储、补丁、标签、检索、备份 | **已完成**（本目录 `src/core`） |
| **P2 Agent 闭环** | pi 扩展：工具、`/atlas` 命令、消息采集、上下文；读书透镜、中图法分类 | **已完成**（`src/extension`，已在 pi-web 中端到端验证） |
| **P3 图谱界面** | pi-web 标签页、节点画板、详情编辑、选节点追问 | **已完成**（pi-web `components/atlas`、`app/api/atlas`，仅本 fork） |
| **P4 外部复用** | 资料包导出、游戏过滤、外部读取示例 | **已完成**（`src/core/pack.ts`、`examples/pack-lookup.mjs`） |

## 知识库目录

```
atlas.json            知识库 ID、schema 版本、全局修订号
books/<id>.md         书籍索引卡：YAML 元信息 + Markdown 正文
nodes/<id>.md         知识节点：YAML 元信息 + Markdown 正文
tags.json             标签词典
relations.json        节点与书籍之间带类型的关系
sources.json          来源记录
journal/              事务记录（崩溃恢复）与幂等键记录
.atlas.lock           库锁（运行中存在）
```

所有文件都是 UTF-8 文本，可以直接阅读、编辑、备份。手工改坏的文件不会被覆盖：打开时报告问题，相关对象拒绝修改，改好后 `reload()` 即可。

## 用法（核心模块）

```ts
import { openAtlas, search, exportBackup } from "pi-book-atlas/core";

const { store, report } = openAtlas("/path/to/atlas", { create: true });
// report.recovered: 启动时补完的事务；report.problems: 无法读取的文件

const result = store.applyPatch({
  schema_version: 1,
  idempotency_key: "session-1:message-7:extract-v1",
  operations: [
    { op: "create_tag", ref: "$t", fields: { type: "topic", name: "自然法", aliases: ["natural law"] } },
    { op: "create_book", ref: "$b", fields: { title: "利维坦", authors: ["霍布斯"],
      tag_bindings: [{ tag_id: "$t", coverage: "core", assigned_by: "ai_inference", source_refs: [] }] } },
  ],
});
// result.ok / result.created.$b / result.changed / result.conflicts

search(store, "自然法", { kinds: ["book"] });
// [{ id, kind, title, score, reasons: ["tag: 自然法 (core)"] }]
```

### 补丁操作

`create_book` `update_book` `create_node` `update_node` `create_tag` `update_tag` `merge_tags`
`create_relation` `update_relation` `create_source` `update_source` `bind_tag` `unbind_tag`
`archive` `restore`（以及备份导入专用的 `import_object`）。

同一补丁里新建的对象用 `ref: "$名字"` 命名，后面的操作用 `$名字` 引用。

### 保证

- **全有或全无**：一个补丁涉及的所有文件在一个事务里写入。崩溃后重开，库里要么是完整的新版本，要么是完整的旧版本（`test/recovery.test.mjs`）。
- **冲突检测**：`expected_revisions` 与当前修订号不一致时整个补丁被拒绝，什么都不写。
- **幂等**：相同幂等键 + 相同内容返回第一次的结果；相同键不同内容报冲突。重启后仍然有效。
- **引用完整**：标签、来源、关系两端都必须存在；标签父子不成环；合并后的标签自动重定向。
- **不重复**：同名同作者的书、同类型同名（含别名）的节点、同名（含别名）的标签、相同的关系，都会报 `duplicate` 并给出已有 ID。
- **单写入者**：同一进程内同一目录只有一个 store；另一个进程持有库锁时拒绝打开。

## 测试

```bash
npm test            # 在本目录
npm test            # 在 pi-web 根目录也会运行本包测试
```

## 安装（P2 起）

扩展通过 pi 的包机制加载，pi 命令行和 pi-web 都会用到它。在**运行 pi / pi-web 的那台机器**上，把本目录加入 pi 的设置 `~/.pi/agent/settings.json`：

```json
{
  "packages": ["/Users/levy/Documents/GitHub/pi-web/packages/pi-book-atlas"],
  "bookAtlas": { "root": "~/atlas", "autoEnable": false }
}
```

或者用命令 `pi install /path/to/packages/pi-book-atlas`。本地包不会自动安装依赖：在 pi-web 仓库里时 `js-yaml` 来自仓库根目录；单独拷出去用时，先在本目录运行一次 `npm install`。

| 设置 | 作用 | 默认 |
| --- | --- | --- |
| `PI_BOOK_ATLAS_DIR`（环境变量） | 知识库目录，优先级最高 | — |
| `bookAtlas.root` | 知识库目录（相对路径以 pi 数据目录为基准，支持 `~`） | `~/.pi/agent/atlas` |
| `bookAtlas.autoEnable` | 所有会话都当作学习会话 | `false` |

## 在 pi-web 里开启（按钮）

不用手改 settings.json：

1. **设置 › 常规 › 书籍知识库**：先「选择…」知识库目录，再打开「启用书籍知识库」。没有选目录时开关不能打开；清除目录会同时关闭。可选「所有会话默认开启学习模式」。
2. **在知识库目录里读书**：新会话的项目菜单里，「使用工作区路径」下面有「使用知识库目录」。在这个目录里开的会话自动是学习会话，不用 `/atlas on`。Agent 被告知知识库文件只能通过 `atlas_apply_patch` 修改。
3. **一本书一个会话**：知识图谱里选中一本书，点「开始本书会话」：在知识库目录新建会话，会话名是书名，并自动发送 `/atlas guide 书名`。之后按钮变成「打开本书会话」，回到同一个会话。对应关系保存在知识库目录的 `book-sessions.json`（不属于知识，不进资料包）。这个会话里没有提到别的书的问题，默认都是在问这本书。
4. **其他会话**：知识图谱工具栏的「开启学习模式」开关、「整理本次讨论」，点一下直接发送命令。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/atlas` 或 `/atlas status` | 知识库位置、数量、本会话是否在采集、待整理条数、有错误的文件 |
| `/atlas on` / `/atlas off` | 开启或关闭本会话的学习模式（记录在会话里，刷新、重开都保留） |
| `/atlas organize [补充说明]` | 让 Agent 把待整理的消息整理进知识库 |
| `/atlas guide <书名>` | 让 Agent 用八个读书透镜带你过一遍这本书，写进索引卡，并定好分类和核心标签 |
| `/atlas search <关键词>` | 直接查询 |
| `/atlas export <文件>` / `/atlas import <文件>` | 备份与恢复 |
| `/atlas pack <文件> [tags=…] [until=年份] [books=…] [notes]` | 导出给其他应用或游戏用的资料包 |

模型可用的工具：`atlas_search`、`atlas_read`、`atlas_get_context`（只读），`atlas_apply_patch`（写入）。

- **采集**：学习会话里，每次运行真正结束（`agent_settled`）时，保存用户消息和助手可见回答到 `conversations/<会话ID>.jsonl`；思考过程、工具调用和工具原始输出不保存。按消息 ID 和内容哈希去重，重连、重试、重开会话都不会重复。
- **整理**：`/atlas organize` 把待整理消息的 ID 交给 Agent；补丁成功后这些消息才算整理完，失败就保持待整理，再执行一次即可。整理请求本身和它那一轮的回复不会进入待整理。
- **来源**：补丁里写 `"$conversation"`，扩展自动生成指向本会话和消息的来源记录，同一条消息只生成一次。
- **提示**：学习会话里，系统提示带上知识库使用规则（先查后写、不编造引文页码、如实标注归属）、精简版读书透镜，以及和当前问题相关的已有知识。

## 书的分类与标签

每张书籍索引卡用「一个类目 + 几个词」定位：

- **中图法二级类目**：`classification: { scheme_id: "clc", scheme_version: "5", codes: ["D0"] }`。第一个是主类，跨领域的书最多再加两个。也可以写更细的分类号（如 `B502`），归到它所属的二级类目。写错的代码会被拒绝，并列出该大类下可选的类目（`src/core/clc.ts`）。
- **3–5 个核心标签**：用 `core` 覆盖度的标签补充类目说不清的主题、问题或方法。
- **可以更新**：讨论中对书的理解变了，用 `update_book` 改分类，用 `bind_tag` / `unbind_tag` / `merge_tags` 调整标签。
- **可以检索**：类目代码或名称能找到书（如「政治学」「伦理学有哪些书」「B5」），主类排在前面。

## 读书透镜

八个读书问题，从文脉工作台的书籍描述模型里挑出来。只保留能帮助理解、不需要全文也能讨论、并且能对应到知识节点的部分；书目版本、分类号体系、标注状态和书与书之间的关系都没有采用。定义在 `src/core/reading-guide.ts`。

| 透镜 | 问题 | 整理时决定什么 |
| --- | --- | --- |
| 核心问题 | 主要在回答哪类问题 | 书的入口问题、question 节点 |
| 讨论对象 | 讨论哪一层面的对象 | 同名概念是否分开 |
| 陈述性质 | 事实、假设、价值、规范还是虚构 | claim 的写法与归属 |
| 依据 | 凭什么这么说 | 来源类型与核验状态 |
| 表达行为 | 定义、论证、举例、建议…… | 节点类型与关系 |
| 组织方式 | 全书按什么展开 | 结构概览、阅读顺序 |
| 谁在说、什么态度 | 原文、注释、后人研究；赞同还是反对 | 归属、refutes/qualifies |
| 门槛与开放度 | 先要懂什么，有几种解释 | requires 关系、并列保留多种解释 |

每轮的系统提示只带透镜的问题和用途，不带可选答案，以节省 token。`/atlas guide` 会带上完整版和中图法类目表。

## 知识图谱界面（P3）

pi-web 顶栏的「知识」按钮打开右侧的「知识图谱」标签页。界面和 Agent 走同一个知识核心：同一进程里打开的是同一个 store，校验规则、修订号、写入锁都只有一套。知识库目录由服务端按设置解析，不接受客户端传入的路径。

- **视图**：本书（书和它直接关联的知识）、本次讨论（引用当前会话的知识）、跨书关联（被两本以上的书共同讨论的知识）、搜索。不会一次渲染整个库；卡片上的 `+n` 或双击可以展开相邻节点。
- **书籍与标签栏**：按书名、作者、分类、标签找书；多个标签组合筛选。面板窄时自动收成浮层。
- **画板**：拖动背景平移、滚轮缩放、拖动卡片调整位置。连线显示关系名称和方向，支持、反驳、限定用不同颜色。
- **布局**：位置按视图保存在 `layout.json`，不属于知识，不改修订号；编辑内容不会移动卡片。Agent 新增知识时只安排新卡片，原有卡片不动；「重排」才会重新排列整个视图。「从画板移除」只在当前视图隐藏，不删除知识。
- **跟随变化**：每 3 秒检查一次修订号，Agent 写入后画板自动刷新，新增和修改的卡片高亮，选中后取消。
- **详情**：编辑标题、概括、别名、Markdown 正文；书还可以编辑作者、中图法分类、入口问题。可以增删标签、连线、移除关系，查看来源，点「追溯讨论」打开来源会话。归档前会确认，归档后文件保留，可以恢复。
- **冲突**：保存时带上开始编辑时的修订号。期间 Agent 改过同一张卡片，保存会被拒绝并保留草稿；「合并最新版本」会让你没改的字段取最新值、你改过的字段保留草稿，两边都改过的字段会把另一版内容显示出来。
- **追问**：选中卡片后点「解释」「举例」「比较」「质疑」「应用练习」，会把卡片的 ID、标题和概括连同问题写进输入框，由你决定是否发送。按住 Shift 可以多选，然后一起比较。
- **整理**：「整理本次讨论」会在输入框里写入 `/atlas organize`。

## 资料包（P4）

资料包是一个离线 JSON 文件，给其他应用、问答系统或游戏使用。它和备份不同：备份是整个知识库，用来恢复；资料包只包含知识，不包含使用者本人的内容。

- **导出**：`/atlas pack <文件>`，或在知识图谱里点「导出资料包」（按当前的标签筛选）。`tags=` 只导出这些标签及其子标签下的内容。
- **格式**：`format: "pi-book-atlas/pack"`、`schema_version`、`exported_at`，以及标签、书、知识节点、关系，还有 `tag_index`（标签 ID → 书和知识，核心覆盖排在前面）。合并掉的旧标签 ID 通过 `tag_redirects` 仍能查到。
- **用途标记**：书是 `reading`（相关阅读）；知识是 `paraphrase`（观点转述）、`quotation`（直接引文，只有标注为引述、并有已核验的原文来源定位到页、节或章时才算）或 `setting`（游戏设定）。回答时可以据此说明哪句是引文、哪句是转述。
- **不包含**：对话记录、会话和消息 ID、对话类来源的标题、画板布局、本机路径（`file://` 链接）、已归档的内容；「我的理解」类笔记默认不包含，加 `notes` 才会导出。知识仍然标明来自哪些书、归属是谁、来源核验到什么程度。
- **游戏过滤**：`until=1700` 只保留该年及以前首次出版的书（书卡上的 `published_year`，公元前写负数）；`books=` 限定为某个角色读过的书。出版年份未知的书、不经由任何允许的书得到的知识都不会进入游戏资料包。
- **外部读取示例**：`examples/pack-lookup.mjs` 不依赖本插件，只读 JSON：

  ```bash
  node examples/pack-lookup.mjs atlas-pack.json 社会契约论
  ```

## 下一步

- 在实际使用的 pi-web 机器上安装扩展，用真实对话验证整个流程。
- 远程查询服务、MCP 服务、多人同步（设计文档列为首版之后）。
