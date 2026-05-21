# Echo Trending

一个每小时更新的 GitHub 热门项目情报站：抓取近期热门仓库，生成中文深度解读，并发布到 GitHub Pages 静态网站。

## 本地运行

生成示例数据：

```bash
npm run sample
```

启动静态站：

```bash
npm run serve
```

访问：

```text
http://127.0.0.1:8787
```

## 生成真实日报

```bash
GITHUB_TOKEN=xxx npm run daily
```

默认按 `Asia/Shanghai` 生成日报日期，凌晨运行也会归到中国时区当天。需要调整时区可设置：

```bash
REPORT_TIMEZONE=Asia/Shanghai npm run daily
```

如果需要 LLM 深度解读，再设置：

```bash
OPENAI_API_KEY=xxx OPENAI_MODEL=你的模型名 npm run daily
```

不设置 OpenAI 环境变量时，脚本会使用 README、语言、stars、topics 等信息生成规则型摘要，保证流程可运行。

## 数据流

```text
GitHub Search API -> README/Languages -> structured analysis -> JSON report -> static site
```

报告文件会同时写入：

- `data/reports/YYYY-MM-DD.json`：原始归档
- `public/reports/YYYY-MM-DD.json`：网站读取
- `public/reports/index.json`：日报列表

默认只保留最近 90 天日报，避免 GitHub Pages artifact 和本地报告目录无限增长。可通过环境变量调整：

```bash
REPORT_RETENTION_DAYS=180 npm run daily
```

## 定时更新与发布

内容更新由 Codex 定时任务负责：每小时调研 GitHub 热门项目、搜广推前沿和 AI 资讯，生成更深的中文解读并提交到 `main`。GitHub Actions 只负责把 `public/` 发布到 GitHub Pages，避免自动脚本覆盖 Codex 生成的深度内容。

- Codex 定时任务：每小时生成一次最新日报
- GitHub Actions：`main` 有新提交时发布静态站
- 当天报告会覆盖同一个 `YYYY-MM-DD.json`，不会每小时新增一个历史文件
- 默认保留最近 90 天日报
- 手动发布入口：GitHub Actions -> Echo Trending Deploy -> Run workflow
- 发布分支：`gh-pages`

在 GitHub 仓库设置里启用 Pages：

1. Settings -> Pages
2. Build and deployment -> Source 选择 `Deploy from a branch`
3. Branch 选择 `gh-pages`，目录选择 `/ (root)`
4. 保存后，运行一次 workflow 即可拿到公开链接

当前仓库按 GitHub Pages 默认规则，公开地址通常是：

```text
https://eshener.github.io/echo-trending/
```

仓库不需要额外配置 OpenAI Secrets；深度解读由 Codex 定时任务生成。

## Netlify 发布

本目录仍保留 `netlify.toml` 作为手动备用发布配置。默认小时级自动更新使用 GitHub Pages，避免 Netlify production deploy credits 被小时级任务消耗。

如需临时回退到 Netlify，在 Netlify 新建站点时，配置：

- Base directory: 仓库根目录
- Build command: `npm run build`
- Publish directory: `public`

环境变量同样可配置 `OPENAI_API_KEY`、`OPENAI_MODEL`、`REPORT_TIMEZONE`。
