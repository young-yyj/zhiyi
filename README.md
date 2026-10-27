# 芷译（Zhiyi）

> 自用 Chrome MV3 双语翻译扩展：英文网页按 `Alt+Z` 手动触发，在原文下方插入中文译文。底座 fork 自 [Kiss Translator](https://github.com/fishjar/kiss-translator)，只接 DeepSeek。

## 功能

- 网页整页翻译，原文/译文双语对照，可切换仅译文与还原
- 保留链接、加粗、斜体、代码块等行内格式；翻译失败段有质量校验与重试
- 手动触发（`Alt+Z`），不自动翻译英文页
- DeepSeek 单一服务；本地缓存 30 天，减少重复请求

## 构建

前置：Node 24、pnpm 11.7、Chrome/Edge（加载已解压扩展）。

```bash
pnpm install
pnpm build:chrome        # 默认最小构建（约 9 MB，不含本地 AI 资源）
# 完整构建（含本地 AI 资源，约 77 MB）：
DUALREAD_FULL=1 pnpm build:chrome
```

1. 打开 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择 `build/chrome/`。
2. 打开扩展设置 → 接口列表 → **DeepSeek** → 填写 API Key 并保存。
3. 英文网页按 `Alt+Z` 翻译，再按一次还原。

Key 只保存在浏览器扩展本地存储中，不会写入日志或本仓库。翻译文本会发送到 DeepSeek API。

## 目录

| 路径 | 说明 |
|---|---|
| `src/` | 扩展源码（设置、接口、页面翻译核心、缓存、质量校验） |
| `public/` | MV3 `manifest.json`、图标、`_locales` |
| `tools/` | 可选验证脚本（e2e mock / 站点实测 / S0 冒烟，构建不需要） |
| `config-overrides.js` | CRA webpack 覆写 |
| `build/chrome/` | 构建产物（不入库） |

## 许可证与归属

- 本项目 fork 自 **Kiss Translator v2.1.1**（上游 `dev@dd06742`），上游以 **GPL-3.0** 发布。
- 本衍生作品同样按 **GPL-3.0** 发布，见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
- 修改点：DeepSeek 单服务预设、手动触发、质量校验/重试、占位符守恒、默认最小构建、显示名「芷译」。
- 内部应用名仍为 `KISS Translator`（用于 CSS 类名与存储键兼容），显示名由 `_locales` 提供。
