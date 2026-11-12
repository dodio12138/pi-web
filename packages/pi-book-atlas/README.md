# pi-book-atlas

书籍、标签与知识图谱插件（Pi Book Atlas）。设计文档：`Pi_Book_Atlas_Development_v0.1.md`。

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 宿主确认 | agegr/pi-web（dodio12138 fork 的 `custom`），pi SDK 1.5.0 | 已确认；最小面板待做 |
| **P1 数据核心** | 数据模型、存储、补丁、标签、检索、备份 | **已完成**（本目录 `src/core`） |
| **P2 Agent 闭环** | pi 扩展：工具、`/atlas` 命令、消息采集、上下文 | **已完成**（`src/extension`，已在 pi-web 中端到端验证） |
| P3 图谱界面 | pi-web 标签页、节点画板、详情编辑 | 未开始 |
| P4 外部导出 | 游戏与问答资料包 | 未开始 |

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

## 使用

| 命令 | 作用 |
| --- | --- |
| `/atlas` 或 `/atlas status` | 知识库位置、数量、本会话是否在采集、待整理条数、有错误的文件 |
| `/atlas on` / `/atlas off` | 开启或关闭本会话的学习模式（记录在会话里，刷新、重开都保留） |
| `/atlas organize [补充说明]` | 让 Agent 把待整理的消息整理进知识库 |
| `/atlas search <关键词>` | 直接查询 |
| `/atlas export <文件>` / `/atlas import <文件>` | 备份与恢复 |

模型可用的工具：`atlas_search`、`atlas_read`、`atlas_get_context`（只读），`atlas_apply_patch`（写入）。

- **采集**：学习会话里，每次运行真正结束（`agent_settled`）时，保存用户消息和助手可见回答到 `conversations/<会话ID>.jsonl`；思考过程、工具调用和工具原始输出不保存。按消息 ID 和内容哈希去重，重连、重试、重开会话都不会重复。
- **整理**：`/atlas organize` 把待整理消息的 ID 交给 Agent；补丁成功后这些消息才算整理完，失败就保持待整理，再执行一次即可。整理请求本身和它那一轮的回复不会进入待整理。
- **来源**：补丁里写 `"$conversation"`，扩展自动生成指向本会话和消息的来源记录，同一条消息只生成一次。
- **提示**：学习会话里，系统提示带上知识库使用规则（先查后写、不编造引文页码、如实标注归属），以及和当前问题相关的已有知识。

## 下一步（P3）

- pi-web 里的「知识图谱」标签页：书籍和标签栏、节点画板、详情编辑、选中节点继续提问。
- 文脉工作台导入：需要工作台导出的 JSON 确定字段映射（设计文档 §13）。
