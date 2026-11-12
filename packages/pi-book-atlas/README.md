# pi-book-atlas

书籍、标签与知识图谱插件（Pi Book Atlas）。设计文档：`Pi_Book_Atlas_Development_v0.1.md`。

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 宿主确认 | agegr/pi-web（dodio12138 fork 的 `custom`），pi SDK 1.5.0 | 已确认；最小面板待做 |
| **P1 数据核心** | 数据模型、存储、补丁、标签、检索、备份 | **已完成**（本目录 `src/core`） |
| P2 Agent 闭环 | pi 扩展：工具、`/atlas` 命令、消息采集、上下文 | 未开始 |
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

## 下一步（P2）

- `pi` 扩展：`atlas_search` / `atlas_read` / `atlas_apply_patch` / `atlas_get_context` 工具，`/atlas` 命令。
- 消息采集：`message_end` / `agent_settled` 事件，按消息 ID 与内容哈希去重。
- 文脉工作台导入：需要工作台导出的 JSON 确定字段映射（设计文档 §13）。
