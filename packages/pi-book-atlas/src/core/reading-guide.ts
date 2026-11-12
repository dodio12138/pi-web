// Reading lenses: eight questions for reading a book well, selected from the
// 文脉 workbench's description model (its 23 attributes, unit layers and
// stances). They guide the Agent when it discusses a book and decide how what
// it learns is organized; they are not a form to fill in. Kept: what helps
// understanding, can be discussed without the full text, and maps onto
// knowledge nodes. Left out: catalogue and edition data, style and difficulty
// grades that need the full text, classification codes, the annotation-status
// machinery, and relations between books.

export interface ReadingLens {
  key: string;
  label: string;
  /** The question to ask of the book. */
  question: string;
  /** Answers to choose from (several may hold). */
  options: string[];
  /** What the answer decides when organizing knowledge. */
  organizes: string;
}

export const READING_LENSES: readonly ReadingLens[] = [
  {
    key: "questions",
    label: "核心问题",
    question: "这本书主要在回答哪类问题？",
    options: ["是什么", "如何产生", "如何运行", "如何变化", "如何认识", "如何行动", "如何分配", "如何共处", "如何选择", "有何价值"],
    organizes: "写成书的入口问题；尚未回答的写成 question 节点",
  },
  {
    key: "objects",
    label: "讨论对象",
    question: "它讨论的是哪一层面的对象？",
    options: ["个人", "关系", "家庭", "群体", "组织", "社会", "自然", "人工系统", "观念", "符号"],
    organizes: "同名概念在不同层面含义不同时，分开节点或写清适用层面",
  },
  {
    key: "statements",
    label: "陈述性质",
    question: "这句话是什么性质的陈述？",
    options: ["事实陈述", "理论假设", "形式命题", "价值评价", "规范主张", "信念主张", "虚构设定"],
    organizes: "写进 claim 节点的正文；价值、规范、信念不当作事实，虚构设定的归属用 game_setting 或注明出自虚构",
  },
  {
    key: "evidence",
    label: "依据",
    question: "凭什么这么说？",
    options: ["观察记录", "实验测量", "历史文献", "形式推导", "作者解释", "传统经典", "神圣启示", "制度授权"],
    organizes: "决定来源类型与核验状态；只有作者解释或模型概括时保持 pending",
  },
  {
    key: "acts",
    label: "表达行为",
    question: "这一段在做什么？",
    options: ["定义", "解释", "论证", "举例", "叙述", "描写", "建议", "指令", "规定", "提问"],
    organizes: "定义→concept；论证→claim 加 supports/refutes；举例→example 加 exemplifies；建议、指令→method；提问→question",
  },
  {
    key: "organization",
    label: "组织方式",
    question: "全书按什么展开？",
    options: ["按时间", "按因果", "按论证", "按步骤", "按分类", "按主题", "按空间", "按人物", "按事项"],
    organizes: "写成书的结构概览，帮助决定先读哪里、节点之间用什么关系",
  },
  {
    key: "voice",
    label: "谁在说、什么态度",
    question: "这是作者原文、注释引文、注者判断还是后人研究？态度是赞同、反对、质疑还是对照？",
    options: ["作者正文", "注释引文", "注者判断", "后人研究", "赞同", "反对", "质疑", "对照", "未表态"],
    organizes: "决定归属：作者正文→author_claim（须有来源），注释引文→quoted，注者判断、后人研究→later_interpretation；反对、质疑写成 refutes/qualifies 关系",
  },
  {
    key: "threshold",
    label: "门槛与开放度",
    question: "读懂它需要先懂什么？它有多抽象？是否存在多种合理解释？",
    options: ["无要求", "基础", "进阶", "专业", "研究", "单一解释", "多种解释", "高度开放"],
    organizes: "前置知识写成 requires 关系；存在多种解释时并列保留，不合并成一个摘要",
  },
];

/**
 * The lenses as a prompt section. The compact form (for every turn of a
 * learning session) leaves out the answer lists to keep the prompt short;
 * the full form (for a guided pass over one book) includes them.
 */
export function readingLensPrompt({ options = false }: { options?: boolean } = {}): string {
  const lines = READING_LENSES.map((lens) => `- ${lens.label}：${lens.question}${options ? `（${lens.options.join("、")}）` : ""}→ ${lens.organizes}`);
  return ["读书透镜：讨论或整理一本书时，按这些问题去看；答不出就留空，不要为了完整而编造。", ...lines].join("\n");
}

/** The section a book card gets for its lens notes: headings the Agent fills in. */
export function readingLensTemplate(): string {
  return ["## 读书透镜", "", ...READING_LENSES.map((lens) => `### ${lens.label}\n\n（${lens.question}）\n`)].join("\n");
}
