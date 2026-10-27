<h1 align="center">芷译 · Zhiyi</h1>

<p align="center">Chrome MV3 双语翻译扩展：在英文网页按 <kbd>Alt+Z</kbd>，即可在原文下方插入中文译文，保留原有排版与格式。</p>

<p align="center">
  <a href="https://github.com/young-yyj/zhiyi/releases/latest"><img src="https://img.shields.io/github/v/release/young-yyj/zhiyi?label=version&color=blue" alt="version"></a>
  <img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome MV3">
  <img src="https://img.shields.io/github/license/young-yyj/zhiyi?color=green" alt="GPL-3.0">
</p>

<p align="center">
  <a href="https://github.com/young-yyj/zhiyi/releases/latest"><strong>下载最新版</strong></a> ·
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#构建">构建</a> ·
  <a href="#许可证与归属">许可证</a>
</p>

---

## ✨ 功能

- **双语对照**：在原文下方插入中文译文，可切换仅译文与一键还原。
- **保留格式**：链接、加粗、斜体、代码块等行内格式保持原样；占位符守恒校验防止错位。
- **质量重试**：空译 / 同文 / 长度异常时自动小批重试、单段重试，坏结果不写缓存。
- **手动触发**：英文网页不会自动翻译，按 `Alt+Z` 执行，再按一次还原。
- **AI 翻译**：默认使用 DeepSeek，也可选小米 MiMo（支持 Token Plan 订阅）；本地缓存 30 天。

## 📦 安装

1. 从 [Releases](https://github.com/young-yyj/zhiyi/releases/latest) 下载 `zhiyi-chrome-*.zip` 并解压。
2. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压目录。
3. 打开扩展设置 → 接口列表 → **DeepSeek**（或 **XiaomiMimo**）→ 填写 API Key 并保存，再在「网页翻译 → 全局规则」里选中要用的服务。

> 当前发布包为最小构建（约 9 MB），不含本地 AI 资源；需要完整构建请从源码构建并设置 `DUALREAD_FULL=1`。

## 🚀 使用

1. 打开任意英文网页。
2. 按 `Alt+Z` 翻译，译文出现在原文下方；再按一次 `Alt+Z` 还原。
3. 可在扩展设置中调整译文样式、目标语言与缓存。

## 🔧 构建

前置：Node 24、pnpm 11.7。

```bash
pnpm install
pnpm build:chrome        # 默认最小构建（约 9 MB）
DUALREAD_FULL=1 pnpm build:chrome   # 完整构建（含本地 AI 资源，约 77 MB）
```

构建产物在 `build/chrome/`，按上面的「加载已解压的扩展程序」安装。

## 📁 目录

| 路径 | 说明 |
|---|---|
| `src/` | 扩展源码：设置、DeepSeek 接口、页面翻译核心、缓存与质量校验 |
| `public/` | MV3 `manifest.json`、图标、`_locales` |
| `tools/` | 可选验证脚本（e2e mock / 站点实测 / 冒烟），构建不需要 |
| `config-overrides.js` | CRA webpack 覆写 |
| `build/chrome/` | 构建产物（不入库） |

## 🔒 隐私

- API Key 只保存在浏览器扩展本地存储中，不会写入日志或本仓库。
- 翻译文本会发送到您所选的服务（DeepSeek 或小米 MiMo）；除此之外没有其他数据上传。

## 📄 许可证与归属

- 本项目 fork 自 [Kiss Translator](https://github.com/fishjar/kiss-translator) v2.1.1（上游 `dev@dd06742`）。
- 本衍生作品按 **GPL-3.0** 发布，见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
- 修改点：DeepSeek 主用预设（可选小米 MiMo）、手动触发、质量校验/重试、占位符守恒、默认最小构建、显示名「芷译」、自有图标与悬浮球外观。
- 内部应用名仍为 `KISS Translator`（用于 CSS 类名与存储键兼容），显示名由 `_locales` 提供。

---

<p align="center"><sub>个人项目，与上游及 DeepSeek 无隶属关系。</sub></p>
