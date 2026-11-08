# pi-web 定制版（dodio12138/pi-web）

这是 [agegr/pi-web](https://github.com/agegr/pi-web) 的 fork，在原版基础上加了一套像素 HUD 风格的外观和几项长代码相关的改进。原版的功能和用法见 [README](./README.md)。

## 分支

| 分支 | 用途 |
| --- | --- |
| `main` | 跟随上游，不做改动，用于同步更新和提 PR |
| `custom` | 定制版，所有改动都在这里 |

## 改了什么

### 外观
- **星海（Starward）配色**：深空蓝底、浅天蓝的标题栏和描边，在「设置 › 常规 › 外观」里选择。
- **像素 HUD 风格**：一个独立于配色的「风格」设置，可以叠加在任何配色上。效果包括：
  - 像素中文字体（[Fusion Pixel](https://github.com/TakWolf/fusion-pixel-font)，OFL 授权），只在开启时才下载；
  - 直角边框、标题栏色条、CRT 扫描线；
  - 刻度式滑块、指示灯式开关、悬停时反色的图标按钮；
  - 输入框里是更粗的块状光标，比整行略矮；
  - 风格和配色互不影响，比如「暖沙 + 像素 HUD」也能用。

### 项目与工作区
- **工作区**：在「设置 › 常规 › 工作区」指定一个放项目的文件夹（比如 `~/Documents/GitHub`），和放日常对话的默认目录（`~/pi-cwd/日期`）分开。新会话里 AI 会知道这个位置：你让它克隆仓库、新建项目又没说放哪时，它会建在工作区里。
- **在其他目录继续**：会话菜单里的「在其他目录继续…」（快捷键 M）。在弹出的目录选择器里选好或新建文件夹（默认打开工作区），当前对话就会作为那个文件夹里的新会话继续，侧边栏会归到对应项目下；原会话保持不变。适合看到一个项目、克隆下来改，或者参考它新建项目时使用。

### 代码块
- **折叠**：按缩进识别代码块的层级，可以折叠函数体、括号块；适用于 Python、JS、Go、JSON、YAML 等。折叠后显示「⋯ N 行」，行号保持不变。
- **自动折叠长代码**：超过 40 行的代码块在生成结束后自动折叠较大的块，JSON 保留顶层 key，class 保留方法签名。生成过程中不折叠。

### 性能
- **长代码流式输出更流畅**：生成过程中，纯代码块不再每来一块数据就被 Markdown 解析器从头解析；正在输出的代码按 64 行分段，只更新最后一段。这部分已经单独提交给上游：[agegr/pi-web#1589](https://github.com/agegr/pi-web/pull/1589)。

## 使用

```bash
git clone -b custom https://github.com/dodio12138/pi-web.git
cd pi-web
npm ci
npm run dev   # http://127.0.0.1:30141
```

## 同步上游

```bash
git fetch upstream
git checkout main && git merge upstream/main && git push origin main
git checkout custom && git merge main
```
