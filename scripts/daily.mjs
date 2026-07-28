#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzip } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicReportsDir = path.join(rootDir, "public", "reports");
const dataReportsDir = path.join(rootDir, "data", "reports");
const publicPayloadsDir = path.join(publicReportsDir, "payloads");
const publicIndexHtmlPath = path.join(rootDir, "public", "index.html");
const gzipAsync = promisify(gzip);
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const args = parseArgs(process.argv.slice(2));
const reportTimezone = process.env.REPORT_TIMEZONE || "Asia/Shanghai";
const today = localDate(reportTimezone);
const reportDate = args.date || today;
const limit = Number(args.limit || process.env.TRENDING_LIMIT || 12);
const days = Number(args.days || process.env.TRENDING_DAYS || 7);
const language = args.language || process.env.TRENDING_LANGUAGE || "";
const frontierLimit = Number(process.env.FRONTIER_LIMIT || 22);
const newsLimit = Number(process.env.AI_NEWS_LIMIT || 20);
const reportRetentionDays = Number(args.retentionDays || process.env.REPORT_RETENTION_DAYS || 90);

await fs.mkdir(publicReportsDir, { recursive: true });
await fs.mkdir(dataReportsDir, { recursive: true });

if (args.sample) {
  const sample = makeSampleReport(reportDate);
  await writeReport(sample);
  await pruneOldReports(reportDate);
  await updateIndex();
  console.log(`Sample report written: ${reportDate}`);
  process.exit(0);
}

const report = await buildReport({ reportDate, limit, days, language });
await writeReport(report);
await pruneOldReports(reportDate);
await updateIndex();
console.log(`Report written: ${reportDate} (${report.items.length} repos)`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--sample") parsed.sample = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) parsed[key] = true;
      else {
        parsed[key] = next;
        i += 1;
      }
    }
  }
  return parsed;
}

async function buildReport({ reportDate, limit, days, language }) {
  const since = offsetDate(reportDate, -days);
  const languageQuery = language ? ` language:${language}` : "";
  const query = `pushed:>=${since} stars:>100 archived:false${languageQuery}`;
  const previousReport = await readExistingReport(reportDate);
  let repoSource = await fetchTrendingRepos({ limit, language }).catch(async (error) => ({
    provider: `GitHub Trending daily failed: ${String(error.message || error).slice(0, 120)}`,
    repos: [],
  }));
  if ((repoSource.repos || []).length < limit) {
    const searchRepos = await fetchSearchRepos({ query, limit }).catch(() => []);
    const mergedRepos = mergeReposByFullName([...(repoSource.repos || []), ...searchRepos]).slice(0, limit);
    repoSource = {
      provider:
        repoSource.repos?.length
          ? `${repoSource.provider} + GitHub Search API supplement`
          : `GitHub Search API (${repoSource.provider})`,
      repos: mergedRepos,
    };
  }
  const repos = repoSource.repos || [];
  const items = [];

  for (const [index, repo] of repos.entries()) {
    const fullName = repo.full_name;
    const previousItem = previousReport?.items?.find((item) => item.repo?.fullName === fullName);
    const stableRepo = mergeRepoWithPrevious(repo, previousItem?.repo);
    const previousLanguages = previousItem?.repo?.languages || {};
    const [readme, languages] = await Promise.all([
      fetchReadme(fullName, stableRepo.default_branch),
      fetchLanguages(fullName),
    ]);
    const stableLanguages = Object.keys(languages || {}).length ? languages : previousLanguages;
    const generatedAnalysis = await analyzeRepo({ repo: stableRepo, readme, languages: stableLanguages });
    const analysis = preserveEditorialAnalysis(previousItem?.analysis, generatedAnalysis);
    items.push({
      rank: index + 1,
      repo: normalizeRepo(stableRepo, stableLanguages, reportDate),
      analysis,
      evidence: {
        readmeExcerpt: trimText(cleanMarkdown(readme || repo.description || ""), 900),
        githubUrl: stableRepo.html_url,
      },
    });
  }

  const [frontier, aiNews] = await Promise.all([
    buildFrontierSection(frontierLimit),
    buildAiNewsSection(newsLimit),
  ]);
  const anthropic = buildAnthropicSection(aiNews);
  const searchAdsRec = buildSearchAdsRecSection(frontier);

  return {
    date: reportDate,
    generatedAt: new Date().toISOString(),
    source: {
      provider: `${repoSource.provider} + AIHOT + official AI feeds + Anthropic official pages + big-tech engineering blogs + Codex manual deep rewrite`,
      query,
      since,
      limit,
      language: language || "all",
      editorialReview: buildEditorialReview({ reportDate, frontier, aiNews }),
    },
    summary: buildExecutiveSummary(items, frontier, aiNews),
    items,
    frontier,
    aiNews,
    anthropic,
    searchAdsRec,
  };
}

async function readExistingReport(reportDate) {
  for (const filePath of [
    path.join(dataReportsDir, `${reportDate}.json`),
    path.join(publicReportsDir, `${reportDate}.json`),
  ]) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      // Existing reports are an optional quality fallback for transient API gaps.
    }
  }
  return null;
}

async function fetchTrendingRepos({ limit, language }) {
  const languagePath = language ? `/${encodeURIComponent(language)}` : "";
  const url = `https://github.com/trending${languagePath}?since=daily`;
  const html = await fetchText(url);
  const candidates = parseGitHubTrending(html).slice(0, Math.max(limit * 2, limit));
  if (!candidates.length) throw new Error("GitHub Trending page returned no repositories");

  const settled = await Promise.allSettled(
    candidates.map(async (candidate) => {
      try {
        const repo = await githubJson(`https://api.github.com/repos/${candidate.fullName}`);
        repo.trending = candidate;
        return repo;
      } catch {
        return repoFromTrendingCandidate(candidate);
      }
    }),
  );
  const repos = settled
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .slice(0, limit);
  if (!repos.length) throw new Error("GitHub Trending metadata fetch returned no repositories");
  return { provider: "GitHub Trending daily", repos };
}

function repoFromTrendingCandidate(candidate) {
  const [owner, name] = candidate.fullName.split("/");
  return {
    full_name: candidate.fullName,
    name,
    owner: {
      login: owner,
      avatar_url: `https://github.com/${owner}.png`,
    },
    html_url: `https://github.com/${candidate.fullName}`,
    description: candidate.description || "",
    stargazers_count: candidate.stars || candidate.starsToday || 0,
    forks_count: candidate.forks || 0,
    open_issues_count: 0,
    language: candidate.language || "",
    topics: [],
    license: null,
    pushed_at: new Date().toISOString(),
    created_at: "",
    default_branch: "main",
    trending: candidate,
  };
}

async function fetchSearchRepos({ query, limit }) {
  const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query,
  )}&sort=stars&order=desc&per_page=${Math.max(limit * 2, limit)}`;
  const search = await githubJson(searchUrl);
  return search.items || [];
}

function mergeReposByFullName(repos) {
  const seen = new Set();
  const merged = [];
  for (const repo of repos) {
    const key = repo.full_name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(repo);
  }
  return merged;
}

function parseGitHubTrending(html) {
  return [...html.matchAll(/<article[\s\S]*?<\/article>/g)]
    .map((match) => match[0])
    .map((article) => {
      const href = article.match(/<h2[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<\/a>/)?.[1] || "";
      const fullName = cleanupXml(href).replace(/^\/+/, "").replace(/\s+/g, "");
      const starsToday = Number((article.match(/([\d,]+)\s+stars today/i)?.[1] || "0").replaceAll(",", ""));
      const stars = extractRepoLinkCount(article, fullName, "stargazers");
      const forks = extractRepoLinkCount(article, fullName, "forks");
      const description =
        article
          .match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1]
          ?.replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "";
      const language = cleanupXml(article.match(/itemprop="programmingLanguage">([^<]+)</)?.[1] || "");
      return { fullName, stars, forks, starsToday, description, language };
    })
    .filter((item) => /^[^/\s]+\/[^/\s]+$/.test(item.fullName));
}

function extractRepoLinkCount(article, fullName, endpoint) {
  const pattern = new RegExp(`href="/${escapeRegExp(fullName)}/${endpoint}"[\\s\\S]*?</svg>\\s*([\\d,]+)</a>`, "i");
  return Number((article.match(pattern)?.[1] || "0").replaceAll(",", ""));
}

async function githubJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "echo-trending",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": browserUserAgent,
      Accept: "application/rss+xml, application/atom+xml, text/xml, text/plain, */*",
    },
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": browserUserAgent,
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!response.ok) throw new Error(`Fetch JSON failed ${response.status}: ${url}`);
  return response.json();
}

async function fetchReadme(fullName, defaultBranch = "main") {
  try {
    const data = await githubJson(`https://api.github.com/repos/${fullName}/readme`);
    if (!data.content) return "";
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    const branches = uniqueList([defaultBranch, "main", "master"]);
    const names = ["README.md", "readme.md", "README.rst", "README"];
    for (const branch of branches) {
      for (const name of names) {
        try {
          return await fetchText(`https://raw.githubusercontent.com/${fullName}/${branch}/${name}`);
        } catch {
          // Try the next conventional README path.
        }
      }
    }
    return "";
  }
}

async function fetchLanguages(fullName) {
  try {
    return await githubJson(`https://api.github.com/repos/${fullName}/languages`);
  } catch {
    return {};
  }
}

async function analyzeRepo({ repo, readme, languages }) {
  const fallback = fallbackAnalysis({ repo, readme, languages });
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return codexResearchRefresh({ repo, readme, languages, fallback });

  try {
    const prompt = buildPrompt({ repo, readme, languages });
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL,
        input: prompt,
      }),
    });
    if (!response.ok) throw new Error(await response.text());

    const payload = await response.json();
    const output = extractResponseText(payload);
    const parsed = JSON.parse(output);
    return mergeAnalysis(fallback, parsed, "llm");
  } catch (error) {
    return {
      ...fallback,
      method: "fallback",
      note: `LLM analysis failed, used deterministic analysis: ${String(error.message || error).slice(0, 160)}`,
    };
  }
}

function preserveEditorialAnalysis(previousAnalysis, generatedAnalysis) {
  const previousMethod = String(previousAnalysis?.method || "");
  const generatedMethod = String(generatedAnalysis?.method || "");
  if (!previousAnalysis || !previousMethod.includes("manual-deep-update")) return generatedAnalysis;
  if (!generatedMethod || generatedMethod === "llm") return generatedAnalysis;
  return {
    ...previousAnalysis,
    method: previousAnalysis.method,
    maturity: {
      ...(previousAnalysis.maturity || {}),
      ...(generatedAnalysis?.maturity || {}),
    },
    score: generatedAnalysis?.score ?? previousAnalysis.score,
  };
}

function codexResearchRefresh({ repo, readme, languages, fallback }) {
  const lens = specializeLens(repo, inferProjectLens({ repo, readme, languages }));
  const profile = extractRepoProfile({ repo, readme, languages });
  const primaryLang = Object.keys(languages)[0] || repo.language || "unknown";
  const project = repo.full_name;
  const teamFit = lens.bestFit || describeTeamFit(lens, repo);
  const landingPath = lens.safeEntry
    ? `${lens.safeEntry}；先保留人工复核、指标记录和回滚路径。`
    : describeLandingPath(lens, repo, profile);
  const productionRisk = describeProductionRisk(lens, repo);
  const watchSignal = describeWatchSignal(lens, repo, profile);
  const decisionQuestion = describeDecisionQuestion(lens, repo);
  const architectureMechanism = `架构机制：${lens.coreMechanism}；阅读时把 ${primaryLang} 代码入口、数据/配置形态、自动化脚本和边界条件连起来看，而不是只看 README 的安装示例。`;
  const applicableTeams = `适用团队：${teamFit}`;
  const adoptionPath = `落地路径：${landingPath}`;
  const riskLine = `生产风险：${productionRisk}`;
  const decisionLine = `决策问题：${decisionQuestion}`;
  const watchLine = `观察信号：${watchSignal}`;

  const architectureSignals = [
    architectureMechanism,
    applicableTeams,
    adoptionPath,
    riskLine,
    decisionLine,
    watchLine,
  ];

  const deepDive = {
    strategicValue: `${project} 的价值不应按 star 数直接外推；更合理的读法是把它当作 ${lens.domain} 的工程样本，判断其机制是否能降低你现有链路的复杂度、人工成本或质量波动。`,
    implementationPath: [
      landingPath,
      `用一个可回放样本验证 ${lens.successMetric}，同时记录接入时间、失败样本和回滚步骤。`,
      `只在指标改善、维护 owner 明确、风险可隔离后，再从旁路验证扩大到核心流程。`,
    ],
    productionConcerns: [
      productionRisk,
      `与现有 ${primaryLang} / ${profile.installSurface} 工具链的耦合要先做最小集成验证。`,
      repo.open_issues_count > 300 ? "当前 open issues 偏高，必须抽查最近 issue 的响应质量和 release 节奏。" : "社区负载相对可控，但仍要关注 breaking change、license 和长期维护信号。",
    ],
    decisionQuestions: [
      decisionQuestion,
      `如果两周 spike 只能证明“能跑”，不能证明 ${lens.successMetric} 改善，是否应降级为观察项？`,
      "谁负责上线后的升级、告警、回滚和安全审计？",
    ],
    recommendedAction: `进入观察/试点池：${landingPath}`,
  };

  return {
    ...fallback,
    category: lens.domain,
    method: lens.editorialMethod || "codex-research-refresh",
    oneLiner: sharpenOneLiner(repo, lens, fallback.oneLiner),
    whyItMatters: `${fallback.whyItMatters} 这次更新更值得关注的是其可迁移机制：${lens.coreMechanism} 能否被拆成小样本验证，而不是把项目整体搬进生产。`,
    engineeringRead: `${primaryLang} · ${profile.installSurface}。建议按“入口示例 -> 数据/配置 -> 失败处理 -> CI/release -> issue 反例”的顺序读；重点回答 ${decisionQuestion}`,
    architectureSignals,
    valueHypothesis: [
      `如果团队确实存在「${lens.userPain}」，${project} 的收益应体现为 ${lens.successMetric} 的改善。`,
      `适合先复制机制、接口或治理方式，不适合未验证成本就全量迁移。`,
      `若 ${lens.badFit}，它更适合作为资料样本，而不是生产依赖。`,
    ],
    technicalTakeaways: [
      `先抓 ${lens.inspectFirst}，再决定 spike 范围。`,
      `图解字段应突出 ${lens.coreMechanism} 如何把 ${lens.userPain} 转成 ${lens.businessValue}。`,
      `验收时同时记录正样本、失败样本、成本、延迟和维护 owner。`,
    ],
    adoptionRisks: deepDive.productionConcerns,
    suggestedUseCases: deepDive.implementationPath,
    watchSignals: [
      watchSignal,
      `release note 是否持续解释 ${lens.coreMechanism} 的演进，而不只是功能堆叠。`,
      `issue/讨论区是否出现与你的目标场景相似的真实案例和失败反馈。`,
    ],
    deepDive,
    diagram: {
      ...fallback.diagram,
      title: `${repo.name} 工业级采用图解`,
      caption: `${lens.domain} · ${primaryLang} · ${compact(repo.stargazers_count)} stars`,
      summary: `用 ${lens.coreMechanism} 解决 ${lens.userPain}，先经由 ${lens.safeEntry} 验证 ${lens.successMetric}，再决定是否扩大。`,
      nodes: [
        { label: "架构机制", detail: lens.coreMechanism, type: "core" },
        { label: "适用团队", detail: teamFit, type: "input" },
        { label: "落地路径", detail: landingPath, type: "integration" },
        { label: "观察信号", detail: watchSignal, type: "measure" },
      ],
      links: ["机制拆解", "试点验证", "指标放大"],
      poster: {
        ...fallback.diagram.poster,
        headline: lens.domain,
        thesis: `把「${lens.userPain}」通过「${lens.coreMechanism}」转化为「${lens.businessValue}」。`,
        lanes: [
          { label: "架构机制", detail: lens.coreMechanism, type: "core", step: "01", signal: lens.inspectFirst },
          { label: "适用团队", detail: teamFit, type: "input", step: "02", signal: lens.bestFit },
          { label: "落地路径", detail: landingPath, type: "integration", step: "03", signal: lens.safeEntry },
          { label: "观察信号", detail: watchSignal, type: "measure", step: "04", signal: lens.successMetric },
        ],
        adoption: [
          { label: "试点入口", detail: lens.safeEntry },
          { label: "验收指标", detail: lens.successMetric },
          { label: "生产风险", detail: productionRisk },
          { label: "决策问题", detail: decisionQuestion },
        ],
        warning: lens.badFit,
      },
    },
  };
}

function specializeLens(repo, lens) {
  const overrides = {
    "pascalorg/editor": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "建筑 3D 编辑器 / WebGPU 空间设计工具",
      userPain: "建筑、空间规划和低代码工具团队想在浏览器里创建、编辑和分享 3D 项目，但传统 CAD/BIM 工具重、协作慢，纯展示型 WebGL 又缺少可维护的编辑模型",
      coreMechanism: "Turborepo monorepo 将 core 场景状态、Zustand store、节点 schema、空间查询、事件总线、React Three Fiber/WebGPU viewer、编辑器面板和内置节点 registry 拆成独立包",
      safeEntry: "先把它当作空间编辑器内核样本，选一个非生产户型或展厅 demo 验证节点注册、选择/拖拽、场景序列化、WebGPU 兼容和分享链路",
      businessValue: "让前端团队用组件化方式搭建 3D 建筑编辑体验，降低从静态 3D 展示走向可编辑工作台的原型成本",
      successMetric: "场景加载时间、编辑操作延迟、撤销/重做正确率、节点扩展工时、WebGPU fallback 覆盖、移动端可用性和导出失败率",
      inspectFirst: "先看 @pascal-app/core 的 schema/registry、viewer 渲染生命周期、editor direct manipulation、内置 nodes 插件边界和状态持久化格式",
      bestFit: "建筑 SaaS、空间可视化、数字孪生原型、在线展厅和需要自定义 3D 编辑器的产品工程团队",
      badFit: "需要成熟 CAD 精度、BIM 协同、工程算量、多人实时编辑或强监管交付图纸的场景",
      primaryRisk: "WebGPU、浏览器内存、几何精度、模型导入导出和编辑状态一致性会决定能否生产化；上线前必须建立格式兼容、回滚和视觉回归验证。",
    },
    "andrewyng/aisuite": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "多模型调用适配层 / Agent API 抽象",
      userPain: "AI 应用团队同时接 OpenAI、Anthropic、Google、本地 Ollama 或其他 provider 时，模型 API、错误处理、成本统计和切换实验经常分散在业务代码里",
      coreMechanism: "轻量 Python 包在统一 Chat Completions 接口之上增加 Agents API，并把 OpenWorker 桌面 coworker 迁移为独立仓库，形成 provider adapter 与本地任务执行的分层边界",
      safeEntry: "先在内部评测脚本和非关键 Agent 原型里接入，固定 3 个模型、同一 prompt 集和同一错误恢复策略，对比输出质量、延迟、成本和 provider 失败时的降级",
      businessValue: "降低多模型试验和供应商切换成本，让团队把模型选择从硬编码迁移到可观测、可回放的实验层",
      successMetric: "provider 切换工时、请求失败率、成本归因完整性、模型输出差异、工具调用兼容率和敏感数据出境检查通过率",
      inspectFirst: "先看 provider adapter、Agents API schema、异常映射、流式输出、工具调用兼容、密钥注入和 OpenWorker 迁移边界",
      bestFit: "需要多模型横评、BYOK 桌面助手、教学实验或早期 Agent 平台的 Python 团队",
      badFit: "强依赖单一厂商高级特性、已有成熟模型网关、需要企业级审计计费或高并发 SLA 的生产流量",
      primaryRisk: "统一接口容易掩盖不同模型的工具语义、上下文限制和安全策略差异；生产前必须保留 provider-specific 配置、日志脱敏和降级路径。",
    },
    "affaan-m/ECC": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "Agent Harness 优化系统 / 跨工具技能与记忆层",
      userPain: "Claude Code、Codex、Cursor、OpenCode 等 Agent 使用中，技能、记忆、研究优先级、安全规则和任务节奏分散在个人习惯里，难以复制到团队流程",
      coreMechanism: "通过 skills、instincts、memory、安全约束和 research-first workflow 组织 agent harness 的输入与行为，把提示词经验变成可安装、可复用、可迁移的工作层",
      safeEntry: "先选择一个高频低风险任务，比如 PR 总结、文档更新或 issue triage，把 ECC 作为外层工作流约束，记录上下文补充次数、误操作和人工修正",
      businessValue: "把个人 Agent 使用经验沉淀成版本化流程，减少每次任务重新解释规则、补上下文和修正输出格式的成本",
      successMetric: "任务完成率、上下文遗漏数、review 返工率、危险命令拦截、技能复用次数、人工接管率和跨工具迁移成功率",
      inspectFirst: "先看 skill 目录结构、memory 写入规则、安全策略、安装脚本、跨 host 兼容说明和是否会覆盖本地已有 Agent 规范",
      bestFit: "已经高频使用 coding agent、任务类型重复且愿意维护本地技能库的研发效能、技术负责人和高级个人开发者",
      badFit: "期望无人值守改核心代码、没有 review 纪律、权限敏感仓库或已有严格内部 Agent 平台约束的团队",
      primaryRisk: "外部 harness 会把作者偏好带入本地流程；必须先做权限审查、命令边界、memory 脱敏和与团队规范的冲突检查。",
    },
    "huggingface/speech-to-speech": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "本地语音 Agent 管线 / Realtime API 兼容后端",
      userPain: "团队要做语音助手、机器人或实时客服原型时，VAD、STT、LLM、TTS、打断、延迟和模型部署通常各自成链，难以快速替换和本地化",
      coreMechanism: "模块化 VAD-STT-LLM-TTS 流水线通过 OpenAI Realtime 兼容 WebSocket 暴露服务，每个组件可替换，可接 hosted provider、HF Inference、vLLM 或 llama.cpp，并已用于 Reachy Mini 机器人对话后端",
      safeEntry: "先用固定语音任务和内网测试设备做离线/半实时试点，分别压测字幕/转写、端到端延迟、打断、噪声、模型切换和本地硬件资源",
      businessValue: "让语音 Agent 从 demo 变成可组合工程管线，便于在隐私、本地部署和模型成本之间做可量化取舍",
      successMetric: "端到端首响应延迟、轮次完成率、STT 词错率、TTS 自然度、打断成功率、GPU/CPU 占用、崩溃率和每小时成本",
      inspectFirst: "先看 WebSocket 协议兼容、组件接口、endpoint swap、队列/流式处理、音频缓冲、Reachy Mini 生产使用说明和安全配置",
      bestFit: "机器人、语音客服、教育陪伴、无障碍输入和需要开源/本地化语音 Agent 的研究工程团队",
      badFit: "医疗法律专业转写、强噪声生产环境、需要电话级 SLA 或缺少语音质量评测能力的场景",
      primaryRisk: "实时语音系统的失败会被延迟、误识别、打断错位和隐私录音同时放大；必须分场景建立音频留存、人工接管和质量回放。",
    },
    "virgiliojr94/book-to-skill": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "文档到 Agent Skill 转换器 / 知识资产编译链",
      userPain: "技术书、PDF、EPUB、DOCX、HTML 和内部文档很难直接进入 Claude Code/Codex 工作流，人工整理 skill 又耗时且容易漏掉引用与结构",
      coreMechanism: "解析多格式资料，抽取章节结构、关键概念和参考材料，生成符合 Agent Skills open standard 的 skill 目录，使代码助手在工作时可按技能加载知识",
      safeEntry: "先用一本授权技术书或内部低敏手册生成 skill，检查章节映射、引用可追溯、摘要准确性、触发规则和在真实编码任务中的上下文命中率",
      businessValue: "把静态学习资料编译成可调用知识工具，降低培训、迁移指南、框架手册和团队实践沉淀的整理成本",
      successMetric: "解析成功率、引用准确率、skill 触发准确率、上下文命中率、人工校对时间、版权合规通过率和后续维护成本",
      inspectFirst: "先看格式解析器、chunk 策略、skill manifest、引用保留、失败文件处理、许可证提示和对 Claude/Codex/Copilot host 的兼容",
      bestFit: "内部培训、框架迁移、复杂手册问答、读书会和需要把长文档转成 Agent 工作流的工程团队",
      badFit: "未授权商业书籍、需要逐字准确引用、强合规知识库或没有人工校对 owner 的生产问答场景",
      primaryRisk: "自动生成 skill 会压缩和重写原文，容易产生遗漏、版权和过期知识风险；必须保留来源、校对清单和更新周期。",
    },
    "paperswithbacktest/awesome-systematic-trading": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "系统化交易资源目录 / 量化研究入口",
      userPain: "量化学习者和小型投研团队寻找库、策略、论文、课程和回测框架时信息分散，容易把未经验证的策略、数据源或工具当成可交易资产",
      coreMechanism: "社区维护的 awesome list 汇总研究库、实盘/回测包、机构策略、书籍、博客和教程，并通过分类目录把学习、开发和运行系统化交易策略的材料连接起来",
      safeEntry: "只作为研究入口，先抽样验证 10 个库/策略的维护状态、许可证、数据源、回测假设和幸存者偏差，不接真实资金或自动下单",
      businessValue: "缩短量化研究资料搜集时间，帮助团队建立工具候选池和策略复盘阅读清单",
      successMetric: "链接可用率、条目更新时间、策略复现实验数、回测假设记录完整性、数据授权检查和人工复核通过率",
      inspectFirst: "先看分类结构、最近 PR、策略来源、回测框架条目、数据源说明、免责声明和中文/英文资源重复质量",
      bestFit: "量化学习、内部投研资料库、策略原型、课程建设和低风险市场观察团队",
      badFit: "自动交易、合规投顾、真实资金风控、未经授权数据采集或把 awesome 条目直接当投资建议",
      primaryRisk: "目录无法验证收益真实性，交易策略还会受到过拟合、费用、滑点、数据偏差和合规限制影响；所有采用都必须停在研究辅助层。",
    },
    "microsoft/agent-governance-toolkit": {
      editorialMethod: "manual-deep-update-2026-07-28",
      domain: "AI Agent 治理工具包 / 零信任与执行沙箱",
      userPain: "企业把 Agent 接入工具、浏览器、代码库和业务系统后，策略执行、身份、沙箱、审计、可靠性和 OWASP Agentic 风险经常落在应用团队各自实现",
      coreMechanism: "Python 工具包围绕 policy enforcement、zero-trust identity、execution sandboxing、可靠性工程和 OWASP Agentic Top 10 建立可复用治理层，目标是一包接入多种 Agent 框架",
      safeEntry: "先在一个内部只读 Agent 或低风险自动化上试点，把工具调用、身份、策略拒绝、沙箱日志和失败恢复接入现有安全审计",
      businessValue: "把 Agent 安全从 prompt 约束提升到工程控制面，便于安全、平台和业务团队用同一套策略评估上线资格",
      successMetric: "策略命中率、误拒率、越权拦截、沙箱逃逸测试、审计日志完整性、恢复时间、OWASP 控制覆盖和接入工时",
      inspectFirst: "先看 policy schema、identity binding、sandbox 边界、日志格式、框架适配、public preview 破坏性变更和 OWASP 映射证据",
      bestFit: "准备让 Agent 进入生产工具链、需要合规审计和统一安全基线的企业平台、安全工程和研发效能团队",
      badFit: "纯个人 demo、无写权限只读助手、已有成熟内部 Agent control plane 或不能接受 preview API 变化的生产系统",
      primaryRisk: "治理工具包仍处 public preview；不要把覆盖清单等同于安全证明，必须配合红队、权限最小化、人工确认和发布门禁。",
    },
    "bojieli/ai-agent-book": {
      domain: "AI Agent 工程教材 / 方法论知识库",
      userPain: "团队在落地 Agent 时容易只堆 prompt、工具和 demo，缺少对规划、记忆、工具调用、评测、安全和工程边界的系统理解",
      coreMechanism: "开源书稿、按章示例代码、PDF 构建物、Agent 设计原理和工程实践案例，把分散经验组织成可学习、可复盘、可引用的知识库",
      safeEntry: "把它作为团队读书会和 Agent 方案评审基线，选择 2 个章节映射到现有业务 Agent，产出本地检查清单",
      businessValue: "降低 Agent 项目从概念到工程方案的沟通成本，让产品、算法、平台和安全团队对关键取舍有共同语言",
      successMetric: "章节完成率、方案评审缺陷减少、评测清单覆盖率、工具权限问题发现数和试点方案返工率",
      inspectFirst: "先看目录、工具调用章节、评测/安全章节、示例代码可运行性、引用来源和是否覆盖你当前 Agent 的失败模式",
      bestFit: "正在建立 Agent 平台、内部培训、技术负责人评审和从 demo 走向生产治理的团队",
      badFit: "希望直接复制代码上线、缺少实践任务承接，或只需要某个框架 API 教程的场景",
      primaryRisk: "教材会滞后于模型和平台变化；必须把书中原则转成本地评测、权限、日志和回滚规范，而不是把结论当静态标准。",
    },
    "tirth8205/code-review-graph": {
      domain: "本地代码知识图谱 / Agent 上下文压缩层",
      userPain: "AI 代码审查和修改经常把大量无关文件塞进上下文，既浪费 token，也容易漏掉真实依赖、调用链和历史约束",
      coreMechanism: "本地扫描代码库，抽取符号、依赖、调用关系和文件语义，向 MCP/CLI 暴露可查询图谱，让 coding agent 按任务取相关上下文",
      safeEntry: "先在只读代码审查和文档问答中接入，比较人工选文件、全文检索和图谱检索的上下文命中率",
      businessValue: "降低大仓库 Agent 使用成本，提高审查定位、影响面分析和重构前理解速度",
      successMetric: "相关文件召回率、无关上下文比例、token 消耗、审查缺陷命中率、索引更新时间和误导性依赖数",
      inspectFirst: "先看语言支持、增量索引、符号解析精度、MCP 权限、缓存位置、benchmark 方法和大仓库性能",
      bestFit: "大型单仓、多语言服务、代码审查平台、研发效能和重度使用 coding agent 的团队",
      badFit: "仓库很小、语言解析不受支持、代码权限敏感但无法本地隔离，或期望图谱替代测试和人工 review",
      primaryRisk: "过期索引和错误依赖边会误导 Agent；生产使用必须绑定 commit sha、增量刷新、可解释检索结果和人工复核。",
    },
    "kvcache-ai/ktransformers": {
      domain: "异构 LLM 推理优化 / 本地大模型运行时",
      userPain: "团队想在有限 GPU/CPU 资源上体验或部署大模型，但标准推理框架难以同时利用异构硬件、KV cache、量化和算子替换",
      coreMechanism: "可替换算子、异构 CPU/GPU 调度、KV cache 优化、量化/稀疏策略和模型适配层，让特定 LLM 在消费级或混合硬件上获得更高吞吐",
      safeEntry: "先用固定模型和固定提示集做离线 benchmark，只验证吞吐、显存、首 token 延迟和输出一致性，不直接接生产服务",
      businessValue: "为低成本私有化推理、研发实验和端侧/边缘原型提供可调优路径，减少对单一云 GPU 配置的依赖",
      successMetric: "tokens/s、TTFT、P95 延迟、显存峰值、CPU 占用、输出一致性、崩溃率和模型适配工时",
      inspectFirst: "先看支持模型清单、算子替换边界、KV cache 策略、量化格式、驱动依赖、benchmark 脚本和 issue 中的硬件失败案例",
      bestFit: "模型平台、私有化推理、研究工程和愿意做硬件/算子调优的团队",
      badFit: "需要稳定 SLA、模型频繁切换、缺少底层推理 owner，或无法接受输出一致性和驱动兼容性验证成本",
      primaryRisk: "推理优化收益强依赖模型、硬件、驱动和 batch 形态；没有回归评测和降级路径时，很容易把性能优化变成稳定性风险。",
    },
    "rohitg00/ai-engineering-from-scratch": {
      domain: "AI 工程从零实践 / 端到端学习路线",
      userPain: "工程师想从模型、数据、RAG、Agent、部署和评测完整理解 AI 应用，但碎片教程难以串成可交付工程能力",
      coreMechanism: "课程式仓库、从零实现的模块、实验 notebook/代码、部署与评测路径，把 AI 工程拆成可运行的小单元",
      safeEntry: "挑与团队当前项目最接近的 2 个模块复现，要求记录数据假设、评测指标、成本和失败样本",
      businessValue: "缩短非算法工程师进入 AI 应用开发的时间，并为内部培训建立可复制材料",
      successMetric: "模块复现率、学习者提交质量、评测理解度、从样例迁移到业务原型的周期和代码返工率",
      inspectFirst: "先看模块目录、依赖版本、数据集来源、评测方法、部署示例和最近维护节奏",
      bestFit: "AI 工程培训、内部 bootcamp、初级到中级工程师转型和原型团队",
      badFit: "需要生产级框架模板、监管行业直接上线，或只追求某个模型 API 快速接入",
      primaryRisk: "学习型实现通常牺牲生产健壮性；迁移时必须补齐安全、观测、数据治理、成本控制和测试。",
    },
    "KnockOutEZ/wigolo": {
      domain: "本地 Web 研究 MCP / Coding Agent 外部上下文入口",
      userPain: "Coding agent 做 issue 修复和技术调研时需要搜索、抓网页、读文档，但云搜索 API 成本、密钥和隐私边界经常阻碍接入",
      coreMechanism: "本地优先的 search/fetch/crawl/research MCP 服务，向 Agent 暴露网页检索和抓取能力，并尽量避免外部 API key 依赖",
      safeEntry: "先限制域名和只读抓取，用公开技术文档任务验证召回质量、引用准确性和失败恢复",
      businessValue: "让 Agent 在缺少专用 API 的场景下补齐外部资料检索能力，降低一次性调研和文档查证成本",
      successMetric: "检索命中率、引用可追溯率、抓取失败率、单任务耗时、误导来源比例和权限违规次数",
      inspectFirst: "先看搜索后端、robots/速率限制、缓存、MCP schema、域名 allowlist、日志脱敏和结果排序逻辑",
      bestFit: "开发者文档问答、开源 issue 调研、内部知识补链和需要本地控制的 Agent 平台团队",
      badFit: "需要强时效新闻、付费/登录内容、合规审计严格但无抓取策略，或把网页结果直接当事实来源",
      primaryRisk: "网页抓取质量不稳定且容易混入低可信来源；必须保留来源 URL、时间戳、引用审查和域名策略。",
    },
    "andrewrabert/jellium-desktop": {
      domain: "Jellyfin 桌面客户端 / 自托管媒体体验层",
      userPain: "自托管媒体用户希望获得比浏览器更稳定的桌面播放、系统集成和快捷入口，但官方生态未必覆盖所有桌面体验细节",
      coreMechanism: "桌面壳、Jellyfin API 登录、媒体库浏览、播放器集成、本地设置和跨平台打包，把 Web 媒体服务包装成原生桌面入口",
      safeEntry: "先在个人或内部非关键媒体库试用，验证登录、转码、字幕、播放进度同步和更新机制",
      businessValue: "改善自托管媒体的日常使用体验，也可作为小型 Electron/Tauri 桌面壳集成服务的样本",
      successMetric: "登录成功率、播放启动时间、字幕同步、崩溃率、CPU/GPU 占用、自动更新成功率",
      inspectFirst: "先看认证存储、播放器后端、Jellyfin API 兼容、离线缓存、打包签名和隐私日志",
      bestFit: "自托管用户、家庭媒体、小型桌面客户端学习和需要包装现有 Web 服务的团队",
      badFit: "企业级 DRM、复杂权限审计、多租户媒体管理或需要官方长期支持的场景",
      primaryRisk: "非官方客户端的风险在 API 兼容、凭据存储、播放稳定性和更新信任链；不要直接用于敏感账号或关键媒体资产。",
    },
    "github/copilot-sdk": {
      domain: "GitHub Copilot Agent SDK / 应用内编码助手集成层",
      userPain: "工具厂商和内部平台想把 Copilot Agent 能力嵌进自己的应用或服务，但需要统一会话、权限、上下文和审计接口",
      coreMechanism: "跨平台 SDK、Agent 会话抽象、上下文传入、工具/服务集成和 GitHub Copilot 能力封装，让第三方应用可调用编码助手工作流",
      safeEntry: "先在只读代码解释、PR 辅助或内部开发者工具中试点，不让 SDK 直接写生产分支",
      businessValue: "把 Copilot 从 IDE 扩展为平台能力，降低代码智能嵌入内部系统的集成成本",
      successMetric: "任务完成率、上下文命中率、权限拦截率、审计完整性、开发者采纳率和错误补丁率",
      inspectFirst: "先看认证方式、权限模型、上下文 schema、写操作边界、日志/审计、版本承诺和 GitHub 产品依赖",
      bestFit: "开发者平台、代码审查系统、内部 IDE/门户和已经采购 GitHub Copilot 的企业",
      badFit: "不使用 GitHub 生态、代码不能出特定边界，或希望完全自托管模型与 Agent 执行层",
      primaryRisk: "SDK 会把代码上下文、用户身份和写操作连在一起；必须先明确权限、日志脱敏、分支保护和人工 review。",
    },
    "PostHog/posthog": {
      domain: "产品数据平台 / 自驱动产品实验系统",
      userPain: "产品团队把 analytics、session replay、feature flag、A/B 实验、错误追踪和 AI observability 分散在多套工具里，难以形成闭环",
      coreMechanism: "事件采集、用户行为分析、回放、特性开关、实验、错误追踪、数据仓库和 AI 产品观测统一在同一平台",
      safeEntry: "先接一个低风险产品面或内部工具，只打通事件 schema、feature flag 和一个 A/B 实验，不迁移全部数据栈",
      businessValue: "缩短从用户行为信号到实验决策的路径，让产品、工程和增长在同一数据上下文中迭代",
      successMetric: "事件完整率、实验周期、flag 回滚时间、回放定位时间、数据延迟、成本和团队查询自助率",
      inspectFirst: "先看部署形态、数据保留、事件 schema、实验统计方法、权限、成本模型和与现有数据仓库的同步",
      bestFit: "SaaS、增长团队、产品工程和希望自托管或统一产品数据工具链的组织",
      badFit: "强监管数据无脱敏方案、已有成熟埋点平台且迁移成本高，或团队没有实验 owner",
      primaryRisk: "产品数据平台的风险在隐私、埋点质量、统计误读和工具蔓延；上线前必须定义事件治理和实验决策规则。",
    },
    "microsoft/terminal": {
      domain: "Windows 终端基础设施 / 开发者入口",
      userPain: "Windows 开发者需要稳定整合 PowerShell、WSL、远程 shell、多标签、字体渲染和配置同步，而传统控制台体验割裂",
      coreMechanism: "终端宿主、伪控制台、GPU 文本渲染、profile 配置、标签/窗格、命令面板和 Windows console host 演进聚合在同一仓库",
      safeEntry: "作为桌面开发基础设施观察项，重点验证团队标准 profile、WSL/SSH 工作流和辅助功能兼容",
      businessValue: "提升 Windows 工程环境一致性，降低开发者在 shell、WSL 和远程环境之间切换的摩擦",
      successMetric: "启动耗时、渲染稳定性、profile 配置一致性、崩溃率、可访问性问题和团队环境配置时间",
      inspectFirst: "先看 release note、配置 schema、WT/console host 边界、WSL/SSH 集成、字体渲染和企业部署策略",
      bestFit: "Windows/WSL 开发团队、企业开发环境管理和需要统一终端体验的平台团队",
      badFit: "非 Windows 主力团队、需要浏览器式云 IDE，或期望终端替代完整开发环境管理",
      primaryRisk: "终端是高频基础工具，任何配置、快捷键或渲染回归都会放大影响；企业采用要保留版本锁定和回滚。",
    },
    "AstrBotDevs/AstrBot": {
      domain: "多平台聊天 Agent 框架 / IM 机器人运行时",
      userPain: "团队想把 LLM Agent 接入 QQ、Telegram、Discord、企业 IM 等渠道，但插件、模型、权限和消息状态容易分散且难治理",
      coreMechanism: "多 IM 适配、LLM provider、插件系统、会话状态、工具调用和管理后台组合成可扩展聊天机器人框架",
      safeEntry: "先接内部低风险群聊，只开放问答、摘要和只读工具，保留人工管理员和敏感词/权限控制",
      businessValue: "降低多渠道 Agent 机器人搭建成本，为社群运营、内部助手和客服原型提供统一底座",
      successMetric: "消息成功率、响应延迟、插件失败率、越权调用次数、人工接管率、内容安全拦截率",
      inspectFirst: "先看平台适配器、插件权限、模型密钥存储、消息日志、管理员机制和敏感内容处理",
      bestFit: "开发者社区、内部助手、轻量客服、社群运营和愿意维护插件权限的团队",
      badFit: "金融/医疗客服、无人审核外部群、强合规消息留存或需要企业级 SLA 的场景",
      primaryRisk: "IM Agent 容易触发隐私、越权、群聊误发和模型成本失控；必须限制工具、脱敏日志并保留人工接管。",
    },
    "1jehuang/jcode": {
      domain: "Coding Agent Harness / 本地代码执行编排",
      userPain: "个人和小团队想让 Agent 执行编码任务，但需要比聊天窗口更明确的任务状态、命令边界、文件修改和失败恢复",
      coreMechanism: "命令行 harness、任务会话、模型交互、文件修改、shell 执行和上下文管理，形成可循环的本地 coding agent 工作台",
      safeEntry: "先在文档、测试生成或小型 bugfix 上试用，要求每次输出 diff、命令记录和可回滚分支",
      businessValue: "把 coding agent 使用从临时对话变成可复盘任务流程，适合低风险自动化和个人效率提升",
      successMetric: "任务完成率、测试通过率、错误补丁率、人工接管次数、命令失败恢复和上下文遗漏次数",
      inspectFirst: "先看文件编辑策略、shell 权限、模型配置、日志、git 集成、失败回滚和敏感信息处理",
      bestFit: "个人高级开发者、小型团队、内部 agent 实验和已有 review 纪律的研发环境",
      badFit: "无人值守改生产代码、权限敏感仓库、缺少测试，或希望用 harness 替代工程 review",
      primaryRisk: "本地执行 Agent 会放大误改文件、危险命令和凭据泄露；必须配合分支隔离、测试和人工审查。",
    },
    "trycua/cua": {
      domain: "Computer Use 基础设施 / 跨 OS Agent 执行与评测",
      userPain: "Computer-use Agent 从单机 demo 扩展到训练、评测和批量执行时，需要跨操作系统驱动、隔离环境、数据采集和可复现 benchmark",
      coreMechanism: "开源驱动、跨 OS 桌面控制、虚拟化/沙箱、任务数据生成、评测基准和执行编排，把 GUI 操作能力平台化",
      safeEntry: "先在离线桌面任务和公开应用上评测，不接入真实账号、付款、生产后台或不可逆操作",
      businessValue: "为 GUI Agent 训练评测、RPA 替代和跨平台自动化提供底层执行环境，减少手写 UI 脚本的脆弱性",
      successMetric: "任务完成率、误点击率、环境恢复成功率、跨 OS 一致性、采样成本、人工接管率",
      inspectFirst: "先看支持 OS、隔离策略、截图/动作记录、benchmark 定义、凭据处理、并发调度和失败恢复",
      bestFit: "Agent 平台、桌面自动化、GUI benchmark、训练数据生成和需要跨 OS 控制的研究工程团队",
      badFit: "高风险交易、登录敏感系统、验证码/反自动化场景，或没有人工确认的生产写操作",
      primaryRisk: "GUI Agent 的错误动作成本高且难完全预测；必须用隔离环境、动作白名单、可回放日志和人工确认控制风险。",
    },
    "1c7/chinese-independent-developer": {
      domain: "独立开发者产品目录 / 创业机会雷达",
      userPain: "产品、增长、投资和独立开发者社区想观察中国独立开发者正在做什么，但项目分散在个人站、App、GitHub 和社交平台，缺少可持续更新的样本库",
      coreMechanism: "社区维护的项目清单、状态标记、开发者入口、按时间追加的产品条目和 Pull Request/Issue 更新机制，把碎片化产品样本沉淀为可浏览目录",
      safeEntry: "只把它作为选题、竞品和生态观察源，抽样 20 个项目回到官网、应用商店或仓库核验状态、收入线索、维护频率和用户反馈",
      businessValue: "帮助团队发现小而真实的产品需求、独立开发者分布、AI 工具落地方式和可合作/可学习的轻量产品形态",
      successMetric: "新增条目频率、项目可访问率、关闭/缺乏维护比例、分类准确率、可联系开发者比例和样本复核通过率",
      inspectFirst: "先看最近新增条目、项目状态定义、贡献规则、重复/失效链接处理、子版面划分和是否能导出结构化清单",
      bestFit: "独立开发者、增长研究、产品机会扫描、开发者关系和早期项目观察团队",
      badFit: "需要严格商业尽调、生产依赖选型、实时融资数据库或未经复核就批量采集个人信息的场景",
      primaryRisk: "目录型项目最大风险是时效性、来源噪声和隐私边界；使用时必须二次核验项目状态、联系方式和数据授权。",
    },
    "OpenCut-app/OpenCut": {
      domain: "开源视频编辑器 / 创作者工具链",
      userPain: "创作者、教育团队和增长团队需要低成本、可自托管或可改造的视频剪辑工具，但闭源剪辑软件在自动化、模板化和私有部署上受限",
      coreMechanism: "Web/桌面视频时间线、素材管理、剪辑状态、导出管线、前端交互层和媒体处理后端组合，复刻 CapCut 类工作流的核心编辑体验",
      safeEntry: "先用内部低风险短视频模板验证导入、剪切、字幕、导出、性能和素材版权，不替换正式非线编流程",
      businessValue: "降低批量短视频和教学内容制作门槛，为模板化剪辑、品牌素材库和 Agent 辅助视频生成提供可改造底座",
      successMetric: "导入成功率、时间线操作延迟、导出成功率、字幕/音频同步误差、模板复用率、人工修正轮次和崩溃率",
      inspectFirst: "先看时间线数据模型、媒体转码依赖、导出格式、素材路径管理、离线/桌面封装、失败恢复和许可证",
      bestFit: "内容增长、开发者教育、课程、内部培训和需要可定制视频工作台的小团队",
      badFit: "广播级剪辑、复杂调色/音频生产、版权来源不清或没有人工终审的自动发布链路",
      primaryRisk: "视频编辑器的真实成本在性能、导出稳定性、素材授权和跨平台兼容；生产前必须建立人工终审、版本回滚和素材来源治理。",
    },
    "Nutlope/hallmark": {
      domain: "AI 前端设计技能 / 反模板化生成约束",
      userPain: "产品和前端团队用 Claude Code、Cursor 或 Codex 生成页面时，经常得到同质化卡片、紫蓝渐变、空洞 hero 和无法落地的“AI 味”界面",
      coreMechanism: "用设计 skill 固定宏观结构选择、20 个主题、4 类动词、57 个 slop test gate 和 emit 前自我批评，把生成前端从风格随机漂移改成可审查约束系统",
      safeEntry: "先对一个内部页面做 build/audit 两种模式对照，只让它产出候选稿和 punch list，再由设计/前端人工合并",
      businessValue: "减少 AI 生成界面的同质化返工，让团队把品牌、信息架构、响应式和可访问性约束前置给 coding agent",
      successMetric: "设计 review 返工率、移动端布局缺陷、组件复用率、可访问性问题、生成后手工修改时间和品牌一致性评分",
      inspectFirst: "先看 skill 指令、slop gate 清单、主题/动词定义、audit 输出格式、示例页面和与本地设计系统的冲突点",
      bestFit: "已经让 coding agent 生成页面、但缺少设计约束和前端验收 rubric 的产品工程、增长页和内部工具团队",
      badFit: "已有成熟设计系统且组件严格受控，或希望绕过设计评审直接上线生成页面的场景",
      primaryRisk: "外部设计 skill 会携带作者审美偏好；必须和本地品牌 token、组件库、可访问性检查和人工设计评审一起使用。",
    },
    "mattpocock/skills": {
      domain: "工程师技能库 / AI 辅助开发方法",
      userPain: "个人工程经验分散在提示词和笔记里，难以转成可执行、可复用的 AI 工作流",
      coreMechanism: "面向真实工程任务的技能说明、上下文约束、命令模式和可复制实践清单，把资深工程师的隐性判断沉淀为 agent 可读取流程",
      safeEntry: "挑 2 个团队高频任务，把对应技能改写成本地规范并在真实 PR 中验证一次",
      businessValue: "把资深工程师经验产品化，减少 Agent 使用中的上下文遗漏、输出漂移和 review 返工",
      successMetric: "技能调用成功率、PR 返工率、上下文补充次数、任务完成时间、review 缺陷和维护 owner 清晰度",
      inspectFirst: "先看技能粒度、触发条件、验证步骤、失败处理和与本地测试/CI/review 流程的衔接",
      bestFit: "已引入 AI 编码、希望沉淀团队实践的工程平台、技术负责人和高频任务 owner",
      badFit: "没有统一代码规范，或把技能当一次性提示词集合照搬而不做本地化",
      primaryRisk: "外部技能直接照搬会与本地架构、权限、测试要求和发布流程冲突；需要版本 owner 持续维护。",
    },
    "moeru-ai/airi": {
      domain: "自托管 AI 伴侣 / 实时虚拟角色运行时",
      userPain: "创作者、AI VTuber 和虚拟角色团队想把实时语音、Live2D/VRM、记忆、游戏控制和多端客户端整合到可自托管角色系统里",
      coreMechanism: "Web/macOS/Windows 客户端、实时语音聊天、角色状态、模型/工具连接、Live2D/VRM 表现层、Minecraft/Factorio 等环境交互和本地可控部署组合",
      safeEntry: "先用公开角色和低风险频道做离线/私域 demo，验证延迟、打断、记忆、内容安全、模型费用和人工接管，不接入真实粉丝私聊或付费服务",
      businessValue: "为 AI 直播、虚拟客服、教育陪伴和游戏内角色原型提供可改造底座，降低从聊天 demo 到多模态角色体验的集成成本",
      successMetric: "端到端语音延迟、轮次完成率、角色一致性、记忆错误率、内容安全拦截率、崩溃率、模型成本和人工接管次数",
      inspectFirst: "先看模型适配、语音管线、角色记忆、客户端权限、插件/游戏控制边界、内容安全策略和多端打包质量",
      bestFit: "AI VTuber、虚拟角色、教育陪伴、游戏交互原型和愿意做内容安全治理的创作者工具团队",
      badFit: "未成年人陪伴、医疗/心理咨询、强情感依赖、无人审核直播或无法承担内容安全与隐私责任的场景",
      primaryRisk: "实时陪伴系统会同时暴露隐私、情感依赖、内容安全、模型成本和平台风控；生产前必须设置年龄/场景边界、人工接管、日志脱敏和安全策略。",
    },
    "Dicklesworthstone/destructive_command_guard": {
      domain: "Agent 命令安全护栏 / 本地 shell 防误操作",
      userPain: "Coding agent 能执行 shell 后，误删文件、错误 git reset、危险 rm/chmod/chown 或未确认的破坏性命令会把一次自动化任务变成不可恢复事故",
      coreMechanism: "Rust CLI/守护检查、危险命令模式识别、git/shell 操作拦截、策略配置和 agent 前置执行路径，把本地命令风险转成可审计 gate",
      safeEntry: "先在个人仓库或非核心工作区启用提示/阻断模式，记录被拦截命令、误报和绕过流程，再推广到团队 agent 环境",
      businessValue: "降低 AI 编码和自动化运维中的破坏性误操作概率，为团队引入 agent 写权限提供最小安全底座",
      successMetric: "危险命令拦截率、误报率、绕过次数、事故减少、开发者接受度、策略维护成本和审计日志完整性",
      inspectFirst: "先看规则库、命令解析方式、git 操作识别、配置粒度、绕过机制、日志留存和与 Codex/Claude Code/Cursor 的接入点",
      bestFit: "允许 agent 执行本地命令、但尚未建立完善 sandbox/权限/审计的工程团队和个人重度用户",
      badFit: "已经在强 sandbox、只读工具或远端受控执行环境中运行，且不允许本地 hook 影响开发体验的场景",
      primaryRisk: "命令护栏不能替代备份、分支保护和沙箱；规则误报会导致绕过，漏报又会造成虚假安全感。",
    },
    "openinterpreter/openinterpreter": {
      domain: "低成本模型 Coding Agent / 本地解释器执行层",
      userPain: "团队希望用 DeepSeek、Kimi、Qwen 等低成本模型完成代码修改和终端任务，但普通聊天式助手缺少文件、命令、上下文和失败恢复的执行框架",
      coreMechanism: "Rust/终端 agent、ACP/模型适配、命令执行、文件编辑、上下文压缩和低成本模型优化，把本地开发任务封装成可交互执行循环",
      safeEntry: "先在只读问答、文档修订或测试生成任务上对比低成本模型与高端模型，禁止生产凭据和破坏性 shell 操作",
      businessValue: "降低 coding agent 的单位任务成本，让研发效能团队评估多模型路由、离线辅助和低风险自动化任务池",
      successMetric: "任务完成率、人工接管率、单任务成本、P95 延迟、错误补丁率、命令失败恢复和上下文遗漏次数",
      inspectFirst: "先看模型 provider 配置、ACP 支持、命令权限、日志脱敏、文件 diff 机制、失败恢复和与现有 IDE/CI 的衔接",
      bestFit: "有模型网关、多模型评测和人工 review 的研发效能、平台工程或个人高级开发者",
      badFit: "代码权限敏感、无法容忍低成本模型不稳定输出，或希望无人值守修改生产代码的场景",
      primaryRisk: "低成本模型会放大工具误用、上下文缺失和错误补丁风险；必须配合权限最小化、diff review、测试和回滚。",
    },
    "HKUDS/DeepTutor": {
      domain: "终身个性化 AI Tutor / 多 Agent 教学系统",
      userPain: "学习产品需要长期跟踪学习者知识状态、生成个性化解释和练习，但通用聊天机器人缺少课程目标、记忆、评估和教学路径控制",
      coreMechanism: "多 Agent 教学编排、RAG/知识库、学习者画像、CLI/交互工具、长期记忆和个性化反馈循环，把 tutoring 从问答推进到持续学习路径",
      safeEntry: "先在单门课程或内部培训材料上做只读辅导试点，保留教师/专家复核，不让系统单独决定成绩或学习诊断",
      businessValue: "为教育产品、企业培训和自学工具提供个性化辅导样本，降低答疑、练习生成和学习路径调整的人工成本",
      successMetric: "学习完成率、练习正确率、知识点覆盖、解释满意度、幻觉率、教师修正率和长期记忆准确性",
      inspectFirst: "先看知识库接入、学习者状态 schema、Agent 分工、评估逻辑、引用保真、数据隐私和人工覆写路径",
      bestFit: "有结构化课程、题库、教师复核和数据隐私 owner 的教育科技、内部培训与学习平台团队",
      badFit: "高风险考试评分、医疗/心理学习诊断、未成年人场景无监护设计，或缺少课程质量 owner",
      primaryRisk: "AI Tutor 的错误解释和记忆偏差会长期影响学习路径；必须保留来源引用、教师复核、隐私边界和纠错机制。",
    },
    "HenryNdubuaku/maths-cs-ai-compendium": {
      domain: "AI/ML 研究工程教材 / 知识体系工程",
      userPain: "工程师转向 AI/ML 研究时，数学、计算机科学和现代 AI 材料分散且符号密集，难以建立从直觉到实现的连续路径",
      coreMechanism: "开源在线教材、章节化知识结构、数学/CS/AI 贯通叙事、现实语境解释和持续更新的学习路线，把个人笔记转成可浏览知识资产",
      safeEntry: "选 2-3 个章节作为内部学习小组材料，要求学员复述概念、运行配套代码并提交勘误，而不是直接替代正式课程",
      businessValue: "帮助工程团队补齐 AI/ML 基础共识，缩短新人进入模型、数据和研究讨论的时间",
      successMetric: "章节完成率、概念测验正确率、代码运行成功率、勘误处理速度、学习路径留存和面试/项目迁移效果",
      inspectFirst: "先看目录结构、符号约定、代码示例、引用来源、更新节奏、许可证和是否覆盖团队目标岗位所需能力",
      bestFit: "AI/ML 转岗培训、研究工程师学习小组、技术社区和需要长期维护学习材料的团队",
      badFit: "需要权威教材认证、严格课程评估、生产代码依赖或只想快速刷题的场景",
      primaryRisk: "个人教材的准确性、完整性和更新节奏必须持续复核；用于团队培训时需要专家审校和勘误流程。",
    },
    "Shubhamsaboo/awesome-llm-apps": {
      domain: "LLM App 样例目录 / Agent 与 RAG 原型库",
      userPain: "团队想快速理解 Agent、RAG、多模态和工具调用能落到哪些应用，但从零找样例、跑依赖、判断质量很耗时",
      coreMechanism: "100+ 可运行 AI Agent/RAG 应用、分类目录、示例代码、模型/框架适配和 clone-customize-ship 路径，把应用模式沉淀为原型库",
      safeEntry: "先挑 3 个与业务相近的样例在沙箱运行，只复制架构模式和评测清单，不直接复制凭据、prompt 或第三方数据接入",
      businessValue: "缩短 AI 应用 discovery 和 demo 周期，让产品、工程和销售能用真实样例讨论可行性、成本和风险",
      successMetric: "样例可运行率、依赖安装耗时、模式复用率、原型到生产改造成本、模型费用和安全审查缺陷",
      inspectFirst: "先看目录分类、依赖版本、数据/密钥处理、是否有评测和失败样例、许可证与近期维护情况",
      bestFit: "AI 应用原型、内部 hackathon、售前 demo、Agent/RAG 架构学习和产品机会扫描团队",
      badFit: "直接作为生产模板、处理敏感数据、缺少安全 review，或期望样例代码天然具备可扩展性",
      primaryRisk: "awesome 类目录容易过期且质量不均；必须逐项核验依赖、密钥、数据权限、模型成本和许可证。",
    },
    "coreyhaines31/marketingskills": {
      domain: "营销 Agent 技能库 / 增长工作流知识资产",
      userPain: "增长和营销团队想让 AI 处理 CRO、copywriting、SEO、analytics 和 growth engineering，但缺少统一输入、品牌约束和效果复盘模板",
      coreMechanism: "按营销任务组织的 Claude Code / AI agent skills、rubric、文案/SEO/分析流程和可复制工作流，把增长经验转成版本化技能资产",
      safeEntry: "先选一个低风险 landing page、SEO brief 或 analytics audit，让技能产出草稿和检查表，由营销 owner 审核后才进入发布",
      businessValue: "把分散的营销操作标准化，减少 brief 补充、文案返工和分析遗漏，为增长团队建立可复盘 AI 工作流",
      successMetric: "草稿采纳率、文案修改轮次、SEO issue 命中率、转化实验产出数、品牌合规缺陷和人工审核耗时",
      inspectFirst: "先看每个 skill 的输入假设、品牌语气约束、数据来源、输出模板、禁用场景和与现有 CMS/analytics 的边界",
      bestFit: "有品牌规范、实验节奏和人工审批的增长、内容、SEO 与开发者营销团队",
      badFit: "高度监管行业文案、无品牌审核、自动发布生产页面，或把外部增长建议当作业务事实的场景",
      primaryRisk: "营销 skill 容易生成过度承诺、SEO 噪声和品牌不一致内容；必须保留人工审批、事实核查和实验闭环。",
    },
    "YimMenu/YimMenuV2": {
      domain: "游戏 Mod / 逆向工程风险样本",
      userPain: "游戏 Mod 和逆向工程社区需要实验性菜单验证客户端行为，但这类工具经常触碰反作弊、服务条款、账号安全和多人游戏公平性边界",
      coreMechanism: "GTA V Enhanced 注入式菜单、FSL/version.dll、外部 injector、BattlEye 禁用参数、运行时 Hook 和本地菜单交互组合",
      safeEntry: "只在离线、授权、隔离账号和测试环境中阅读源码或做逆向学习，不进入公共会话、不规避反作弊、不影响其他玩家",
      businessValue: "对安全研究和游戏工程团队的价值主要是理解客户端注入、反作弊边界、Mod 生态和风险提示，而不是可采用生产能力",
      successMetric: "源码可读性、隔离环境可复现性、法律/条款评审结论、账号风险、反作弊触发、卸载回滚和研究记录完整性",
      inspectFirst: "先看注入路径、反作弊说明、FSL 依赖、网络/公共会话影响、许可证、issue 中的封号/脱同步反馈和安全免责声明",
      bestFit: "授权安全研究、游戏客户端逆向教学、反作弊工程学习和离线 Mod 风险评估",
      badFit: "公共在线游戏、账号主号、绕过反作弊、商业化外挂、或任何会影响其他玩家和平台规则的场景",
      primaryRisk: "该类项目具有明显服务条款、账号安全、公平性和合规风险；日报中应作为风险样本观察，不建议下载运行或用于线上游戏。",
    },
    "AIEraDev/Clypra": {
      domain: "Tauri 视频编辑器 / 本地创作软件",
      userPain: "个人创作者和轻量内容团队想要免费、本地、跨平台的视频编辑体验，同时保留比纯 Web 工具更好的文件系统与桌面集成",
      coreMechanism: "Tauri 桌面壳、React/TypeScript 编辑界面、时间线状态、素材导入、媒体预览、导出任务和本地权限边界",
      safeEntry: "先在单人本地创作场景验证常见格式、时间线流畅度、导出质量和崩溃恢复，不处理关键商业素材",
      businessValue: "给开源视频编辑生态补一个轻量桌面入口，适合被二次开发成教学、增长模板或内部素材整理工具",
      successMetric: "格式兼容率、预览帧率、导出耗时、崩溃恢复、安装包体积、跨平台一致性和素材路径错误率",
      inspectFirst: "先看 Tauri 权限、媒体处理依赖、时间线 schema、导出实现、文件路径管理和 release 包质量",
      bestFit: "独立创作者、内部内容工具、教学原型和愿意参与开源改造的桌面应用团队",
      badFit: "需要多人协作、云端审片、专业调色音频或企业级素材权限管理的生产线",
      primaryRisk: "桌面视频工具会遇到格式、性能、权限和平台差异；没有稳定导出与崩溃恢复前不应进入核心内容流程。",
    },
    "par274/sharpemu": {
      domain: "游戏主机模拟器 / 低层系统实验",
      userPain: "系统软件和游戏技术研究者想理解 PlayStation 5 级别主机的运行时、图形、I/O 和指令仿真边界，但可运行、可验证的开源样本很少",
      coreMechanism: "实验性模拟器框架、指令/系统调用建模、图形与音频接口探索、游戏镜像加载、调试日志和兼容性样本积累",
      safeEntry: "只作为低层系统学习和兼容性研究样本，先跑自有/授权 homebrew 或测试样本，不期待运行商业游戏",
      businessValue: "帮助工程师学习现代主机抽象、模拟器架构和跨平台调试方法，也为长期兼容性社区提供早期代码基线",
      successMetric: "homebrew 运行成功率、系统调用覆盖、崩溃可定位性、帧率、兼容性列表完整度和测试样本可复现性",
      inspectFirst: "先看 CPU/OS/GPU 抽象范围、测试 ROM、日志、依赖、法律说明、兼容性列表和 issue 中的失败样例",
      bestFit: "模拟器开发者、系统软件学习、图形栈研究和授权测试样本驱动的开源社区",
      badFit: "希望稳定运行商业游戏、规避版权/DRM、或把实验性模拟器当作终端用户产品",
      primaryRisk: "模拟器项目同时有技术成熟度和版权边界风险；必须限定授权样本、明确兼容性预期并避免传播受保护内容。",
    },
    "hasaneyldrm/exercises-dataset": {
      domain: "健身动作数据集 / 产品原型数据层",
      userPain: "健身 App、训练计划工具和动作识别团队需要带肌群、器械、缩略图和动画的动作库，但从零整理数据成本高且授权边界复杂",
      coreMechanism: "结构化动作数据、肌群/器械标签、动画 GIF、缩略图、JSON/静态资源分发和可直接接入前端的目录组织",
      safeEntry: "先用于内部原型、搜索筛选和训练计划草稿，正式上线前逐项核验动作名称、图片授权、医学安全提示和本地化文案",
      businessValue: "缩短健身内容产品的冷启动时间，让搜索、推荐、训练计划生成和动作详情页快速形成可测试样机",
      successMetric: "动作覆盖率、标签准确率、图片加载成功率、授权核验比例、用户搜索命中率和教练复核缺陷数",
      inspectFirst: "先看数据 schema、资源路径、许可证、动作分类、肌群/器械枚举、缺失字段和是否有来源说明",
      bestFit: "健身产品原型、训练计划工具、动作搜索、教学演示和非诊疗类健康内容团队",
      badFit: "医疗康复建议、付费内容库直接商用、缺少教练复核或需要高精度运动姿态标注的场景",
      primaryRisk: "健身数据集的主要风险是授权、动作安全和标签准确性；商业上线前必须做来源核验、专业复核和免责声明。",
    },
    "simplex-chat/simplex-chat": {
      domain: "隐私即时通讯 / 去标识化消息网络",
      userPain: "安全、法律、记者、社区或高隐私用户需要端到端加密通信，但又不希望账号、手机号、全局用户 ID 或社交图谱成为可关联元数据",
      coreMechanism: "无全局用户标识、队列式消息中继、双向连接、端到端加密、多端客户端、群组/文件/语音能力和可自托管 server 组合",
      safeEntry: "先在一个高隐私但低业务风险的小组试点，只验证设备迁移、联系人建立、群组、备份和中继可用性",
      businessValue: "把通信隐私从内容加密扩展到元数据最小化，降低身份关联和平台侧社交图谱暴露",
      successMetric: "消息送达率、建联成功率、多端同步稳定性、备份恢复时间、用户迁移成本、server 可观测性",
      inspectFirst: "先看协议白皮书、server 部署、队列生命周期、联系人建立流程、移动端通知、备份/恢复和安全审计记录",
      bestFit: "隐私敏感社群、调查协作、合规保密沟通、开源安全团队和愿意教育用户的新型通讯产品团队",
      badFit: "需要企业通讯录、统一账号体系、强管理员审计、消息留存或与主流 IM 深度互通的组织",
      primaryRisk: "去标识化会提高可用性和治理成本；联系人恢复、垃圾信息治理、通知可靠性和合规留存要求必须提前评估。",
    },
    "calesthio/OpenMontage": {
      domain: "Agentic 视频生产 / 多工具创作流水线",
      userPain: "内容团队想把脚本、素材、配音、剪辑、字幕和封面从手工串联变成可回放的候选稿生产线",
      coreMechanism: "12 条生产流水线、工具注册、素材状态管理、Agent skills、FFmpeg/生成模型适配和人工审稿关口",
      safeEntry: "选一类低风险视频模板，只让 Agent 产出候选稿，不接自动发布",
      businessValue: "缩短素材处理周期、提高版本生成能力，并把创作流程中的失败点显性化",
      successMetric: "端到端完成率、人工修改轮次、单条视频成本、素材复用率、审稿通过率",
      inspectFirst: "先看 pipeline 配置、工具注册、素材目录、失败日志、模型密钥和人工审批点",
      bestFit: "增长、品牌、开发者内容、课程和内部培训团队，且有稳定模板和素材授权",
      badFit: "素材版权不清、品牌审核薄弱或希望跳过人工终审直接发布",
      primaryRisk: "版权、肖像权、品牌一致性、长任务中断、模型费用和错误成片回滚必须先治理。",
    },
    "msitarzewski/agency-agents": {
      domain: "角色化 Agent 工作流 / Prompt 组织资产",
      userPain: "增长、产品和工程小团队想把常见 AI 分工、审核标准和交付模板沉淀下来，但缺少稳定的输入、权限边界和复核机制",
      coreMechanism: "角色 prompt、任务说明、交付物模板、命令入口和可复制目录结构，把人的分工经验转成 Agent 可读取的操作资产",
      safeEntry: "选一个非核心 PR、社区运营或竞品分析任务，固定输入资料和验收 rubric，让两名成员交叉复核输出",
      businessValue: "把一次性提示词变成可版本化、可复盘的团队流程资产，降低上下文遗漏和交付格式漂移",
      successMetric: "返工率、上下文补充次数、review 缺陷、角色复用次数、输出格式一致性和越权建议数量",
      inspectFirst: "先看 agent 定义、命令入口、交付模板、本地化指南、任务日志、失败处理、上下文注入和权限说明",
      bestFit: "已经高频使用 Claude/Codex、任务类型重复、愿意维护本地 prompt/skill 版本的增长、产品和工程小团队",
      badFit: "希望照搬外部 persona 替代本地 review、安全门禁、品牌规范或生产决策流程",
      primaryRisk: "外部角色设定会携带作者偏好，容易与本地品牌、安全、代码规范和审批流程冲突；没有版本 owner 时 prompt 资产会快速过期。",
    },
    "soxoj/maigret": {
      domain: "OSINT 用户名枚举 / 安全与风控线索采集",
      userPain: "安全、反欺诈、信任与安全或调查团队需要跨大量公开站点收集用户名线索，但人工搜索不可复现、覆盖不稳定、容易遗漏来源证据",
      coreMechanism: "站点规则库、用户名探测、响应特征判断、结果去重、报告导出和命令行批处理，把公开账号线索转成可复核 dossier",
      safeEntry: "只在授权的安全调查、品牌保护或自查场景使用，先对已知测试账号跑离线基准，保留来源 URL 和误报样本",
      businessValue: "降低公开信息线索收集成本，为账号冒用、钓鱼溯源、攻击面观察和信任安全 triage 提供初筛素材",
      successMetric: "有效命中率、误报率、站点覆盖、请求失败率、证据可追溯率、单次扫描耗时和封禁/限流事件",
      inspectFirst: "先看站点规则、请求限流、代理/重试、报告 schema、误报标注、法律/平台条款提示和批量运行日志",
      bestFit: "有授权边界、人工复核和证据留存流程的安全研究、反欺诈、品牌保护与 OSINT 教学团队",
      badFit: "未授权人肉搜索、批量骚扰、生产级身份验证或任何缺少合规审查的用户画像场景",
      primaryRisk: "OSINT 工具容易触碰隐私、平台条款、误报和滥用边界；必须限定授权范围、速率、用途和人工判断责任。",
    },
    "ripienaar/free-for-dev": {
      domain: "开发者免费层目录 / 云服务采购前雷达",
      userPain: "开发者和早期团队需要快速找到 SaaS/PaaS/IaaS 免费层，但配额、试用期限、地区、信用卡要求和服务条款经常变化",
      coreMechanism: "社区维护的分类目录、服务条目、免费额度说明、PR 更新和人工审核，把分散供应商信息收敛为可浏览索引",
      safeEntry: "只把它作为候选源，选 3-5 个服务后回到官方 pricing/docs 验证额度、限制、地区和数据留存条款",
      businessValue: "缩短工具选型和原型搭建时间，帮助团队在采购前建立低成本实验清单",
      successMetric: "条目新鲜度、官方链接可用率、免费额度准确率、替换成本、供应商锁定风险和数据迁移路径",
      inspectFirst: "先看目录分类、最近 PR、条目审核规则、官方链接、变更频率和是否覆盖你的地区/合规需求",
      bestFit: "个人开发、开源项目、早期原型、教学实验和非敏感内部工具",
      badFit: "生产 SLA、受监管数据、长期核心依赖或无法承担免费层突然变更的业务",
      primaryRisk: "免费层会随供应商策略变化而失效；生产前必须验证官方条款、备份、限流、升级价格和迁移路径。",
    },
    "logto-io/logto": {
      domain: "身份认证与授权 / SaaS 与 AI 应用 IAM",
      userPain: "SaaS、AI 应用和内部平台需要 OIDC/OAuth、组织、角色、机器身份和多租户治理，但自研身份系统容易在安全、合规和扩展上失控",
      coreMechanism: "OIDC/OAuth2、用户池、组织/角色权限、管理控制台、SDK、API 资源、M2M 应用和自托管/云部署组合",
      safeEntry: "先接一个低风险内部工具或新业务租户，验证登录、组织权限、token 生命周期、审计和回滚，不迁移核心账号库",
      businessValue: "把身份能力从业务代码剥离出来，缩短 AI/SaaS 应用接入 SSO、组织权限和机器访问控制的周期",
      successMetric: "登录成功率、token 错误率、权限误配、SDK 接入耗时、审计覆盖、迁移失败率和安全告警响应",
      inspectFirst: "先看 OIDC/OAuth 兼容性、RBAC/组织模型、迁移工具、SDK、审计日志、密钥轮换、备份恢复和安全公告",
      bestFit: "需要快速搭建 B2B SaaS、AI 应用、内部平台或多租户权限体系，且有安全/平台 owner 的团队",
      badFit: "已有成熟 IAM、强监管认证流程复杂、无法承担身份迁移风险或缺少安全运维 owner",
      primaryRisk: "身份系统是高 blast radius 基础设施；必须先处理迁移回滚、密钥管理、审计、可用性和权限模型误配。",
    },
    "ZhuLinsen/daily_stock_analysis": {
      domain: "LLM 投研工作台 / 多源行情自动化",
      userPain: "个人或小团队需要把行情、新闻、指标、策略解释和定时推送聚合成可复盘的投研流程",
      coreMechanism: "行情数据源、新闻抓取、LLM 总结/推理、决策看板、定时任务和通知推送组合",
      safeEntry: "只读观察组合或历史回测日报，不接自动下单",
      businessValue: "把分散信息收敛成可追踪的投研记录，减少人工扫新闻和整理指标的时间",
      successMetric: "数据缺失率、新闻引用可追溯率、预测校准度、误报率、推送准时率",
      inspectFirst: "先看数据源、缓存/重试、prompt、免责声明、推送配置和历史输出样例",
      bestFit: "量化学习、个人投研、内部市场观察和低风险信息看板",
      badFit: "需要合规投顾、自动交易、真实资金风控或机构级数据授权",
      primaryRisk: "LLM 投资结论容易放大数据错误和叙事偏差，必须保留来源、置信度和人工决策边界。",
    },
    "garrytan/gstack": {
      domain: "Claude Code 管理栈 / 创业公司角色化工作流",
      userPain: "小团队希望把 CEO、设计、工程管理、发布、文档和 QA 等角色知识沉淀成可复用 Agent 工具",
      coreMechanism: "23 个意见化工具、角色提示、命令入口、任务交接规范和 Claude Code 工作流约束",
      safeEntry: "挑一个非核心 PR 或发布任务，验证角色分工是否减少上下文遗漏",
      businessValue: "把创始人/负责人经验转成可执行流程，提升小团队决策和交付节奏",
      successMetric: "返工率、review 缺陷、任务交接次数、文档补齐率、发布遗漏数",
      inspectFirst: "先看每个工具的输入输出、权限假设、适用场景和与本地流程冲突点",
      bestFit: "已经重度使用 Claude Code、任务类型重复且愿意维护本地工作流的创业团队",
      badFit: "组织角色、代码规范或发布流程与原作者假设差异很大",
      primaryRisk: "照搬个人工作流会把隐性偏好固化到团队流程，必须先做本地化和权限约束。",
    },
    "xbtlin/ai-berkshire": {
      domain: "Claude Code 投研 Agent / 价值投资研究框架",
      userPain: "投研个人或小团队希望把公司资料、财报、估值、反方观点和大师方法论整理成可复盘研究流程",
      coreMechanism: "多 Agent 并行研究、价值投资 rubric、资料抓取/整理、交叉质询、投资备忘录和 Claude Code 工作流",
      safeEntry: "只做历史公司研究复盘或观察名单，不连接券商、不生成自动交易指令",
      businessValue: "减少资料整理和观点遗漏，把投研假设、反证和结论沉淀成可追踪记录",
      successMetric: "来源可追溯率、人工修正率、反方观点覆盖、估值假设复核耗时、研究结论复盘命中率",
      inspectFirst: "先看 prompt/rubric、数据来源、引用保真、免责声明、输出模板和人工确认点",
      bestFit: "个人投研、内部市场观察、投资教育和低风险研究自动化团队",
      badFit: "需要持牌投顾、自动交易、实时风控或无法验证数据来源的投资决策",
      primaryRisk: "投研 Agent 容易把叙事、幻觉和过期数据包装成确定结论，必须保留来源、置信度和人工决策边界。",
    },
    "commaai/openpilot": {
      domain: "自动驾驶辅助系统 / 车端实时控制",
      userPain: "车主、自动驾驶研究者和车载系统团队希望在真实道路上获得可迭代的驾驶辅助能力，但原厂 ADAS 封闭且车型适配、感知、控制和安全验证成本高",
      coreMechanism: "车端摄像头感知、模型推理、车辆接口适配、纵横向控制、驾驶员监控、日志回传、仿真/回放和车型安全策略",
      safeEntry: "只在官方支持车型、合规地区和受控道路条件下评估，先做离线日志回放、仿真和人工接管演练",
      businessValue: "提供可研究、可迭代的端到端 ADAS 样本，让车端模型、数据闭环和安全策略可被工程团队观察",
      successMetric: "接管率、车道保持稳定性、制动/加速舒适性、感知失败样本、驾驶员监控触发、回归测试通过率",
      inspectFirst: "先看车型支持矩阵、safety model、车辆接口、模型发布、日志回放工具、事故/issue 记录和地区法规边界",
      bestFit: "自动驾驶研究、车载系统学习、ADAS 数据闭环研究和有安全 owner 的硬件实验团队",
      badFit: "无安全驾驶员、未支持车型、商用运输、法律边界不清或希望跳过仿真直接路测",
      primaryRisk: "真实车辆控制涉及人身安全、法规、保险和车型差异；任何采用都必须把人工接管、日志复盘和禁用条件放在首位。",
    },
    "Robbyant/lingbot-map": {
      domain: "流式 3D 重建 / 空间智能基础模型",
      userPain: "机器人、AR、数字孪生或空间计算团队需要从连续传感器数据恢复可用 3D 场景，但传统 SLAM/重建链路容易受稀疏视角、实时性和泛化能力限制",
      coreMechanism: "feed-forward 3D foundation model、流式数据输入、场景表示恢复、相机/传感器序列融合和下游导航/理解接口",
      safeEntry: "先用公开数据集和一条内部录制路线做离线重建，对比传统 SLAM、NeRF/3DGS 和目标业务的几何误差",
      businessValue: "缩短空间数据从采集到可理解场景的路径，为机器人导航、室内地图、AR 内容和仿真资产生成提供候选底座",
      successMetric: "几何误差、重建完整度、时延、显存/算力、跨场景泛化、动态物体失败率",
      inspectFirst: "先看输入模态、模型权重、训练数据、推理成本、坐标系/尺度处理、失败样例和与 ROS/仿真工具的接口",
      bestFit: "机器人感知、空间计算、AR/VR、数字孪生和需要快速场景建图的研究型工程团队",
      badFit: "要求安全级定位、强实时闭环控制、数据域与训练集差异很大或没有 3D 评测能力",
      primaryRisk: "3D 基础模型的错位、尺度漂移和动态场景失败会被下游导航放大，生产前必须建立离线评测和人工复核。",
    },
    "cupy/cupy": {
      domain: "GPU 数值计算 / NumPy-SciPy 兼容加速层",
      userPain: "科学计算、推荐特征、仿真和机器学习预处理团队已有大量 NumPy/SciPy 代码，但 CPU 性能或数据搬运成为瓶颈",
      coreMechanism: "NumPy/SciPy 兼容 API、CUDA/ROCm 后端、GPU array、kernel fusion、自定义 CUDA kernel、稀疏矩阵和与 RAPIDS/PyTorch 生态互通",
      safeEntry: "选一段热点 NumPy/SciPy 计算做旁路迁移，先测端到端耗时而不是只测单个算子",
      businessValue: "在较低改造成本下释放 GPU 计算能力，适合把批处理、仿真、特征工程和离线实验从 CPU 扩展到 GPU",
      successMetric: "端到端加速比、GPU 利用率、CPU-GPU 拷贝占比、显存峰值、数值误差、部署镜像体积",
      inspectFirst: "先看目标算子覆盖、CUDA/ROCm 版本、内存池、stream、稀疏/FFT 支持和与现有 Python 包的兼容性",
      bestFit: "已有 GPU 资源、NumPy/SciPy 代码占比高、能 profile 数据搬运成本的数据科学和高性能计算团队",
      badFit: "数据规模很小、算子不受支持、部署环境无 GPU 或瓶颈在 IO/网络而不是数值计算",
      primaryRisk: "GPU 迁移收益常被数据拷贝、显存、版本矩阵和数值差异抵消，必须用真实 workload profile 验证。",
    },
    "altic-dev/FluidVoice": {
      domain: "本地语音输入 / macOS 离线听写",
      userPain: "开发者、写作者和重度知识工作者想用语音输入替代键盘，但云端听写在隐私、延迟、网络和上下文切换上不稳定",
      coreMechanism: "macOS 原生应用、本地 ASR 模型、全局快捷键、音频捕获、文本注入、模型下载/更新和离线推理优化",
      safeEntry: "先在个人非敏感写作和代码注释场景试用，记录识别准确率、延迟、热键冲突和 CPU/GPU 占用",
      businessValue: "把语音输入变成低摩擦本地工作流，减少云端依赖并提升长文本草稿和操作记录效率",
      successMetric: "词错误率、首字延迟、长句稳定性、资源占用、隐私边界、用户日活输入量",
      inspectFirst: "先看模型来源和许可证、音频权限、文本注入方式、离线数据留存、崩溃恢复和 Apple Silicon 性能",
      bestFit: "macOS 个人效率、隐私敏感写作、客服草稿、会议记录后处理和无障碍输入场景",
      badFit: "需要多人管理、企业审计、专业医疗/法律转写或强噪声环境下高准确率",
      primaryRisk: "本地 ASR 的准确率、模型许可、权限申请和资源占用决定长期可用性；敏感语音仍需明确本地留存策略。",
    },
    "HKUDS/Vibe-Trading": {
      domain: "交易研究 Agent / 投资决策辅助",
      userPain: "个人交易者和投研团队想把行情、新闻、技术指标、策略解释和执行建议串成可对话流程，但容易把模型输出误当成确定性交易信号",
      coreMechanism: "行情/新闻数据接入、策略 prompt、技术指标计算、Agent 推理、交易计划输出、回测/复盘和风险提示",
      safeEntry: "只做历史回放、模拟盘或观察名单分析，不接真实下单，不把单次模型建议作为交易指令",
      businessValue: "把分散的交易资料整理、假设生成和复盘记录自动化，帮助人类更快发现可验证假设",
      successMetric: "数据延迟、来源可追溯率、回测一致性、建议命中/误报、最大回撤、人工覆写率",
      inspectFirst: "先看数据源、回测框架、交易 API 权限、prompt/rubric、风险披露、日志和人工确认点",
      bestFit: "投资教育、模拟交易、个人研究助手和内部市场观察团队",
      badFit: "自动交易、真实资金托管、合规投顾、无法验证数据来源或缺少风险控制的场景",
      primaryRisk: "交易 Agent 会放大幻觉、过拟合、延迟数据和情绪化决策，必须把它限定为研究辅助并保留人工决策。",
    },
    "ByteByteGoHq/system-design-101": {
      domain: "系统设计知识库 / 工程教育资产",
      userPain: "工程师、面试候选人和内部培训团队需要用可视化方式理解复杂系统，但碎片化资料难以形成结构化学习路径",
      coreMechanism: "图解化章节、系统组件模式、可分享案例、社区维护、面试主题索引和跨平台内容分发",
      safeEntry: "选一条内部培训路径，把其中 3-5 个图解案例映射到本公司真实架构复盘",
      businessValue: "把抽象架构模式转成可讨论、可复用的共同语言，降低新人理解分布式系统的门槛",
      successMetric: "学习完成率、复盘质量、概念测验正确率、真实设计 review 命中率、内容更新频率",
      inspectFirst: "先看目录结构、图解来源、许可证、贡献流程、内容更新节奏和与内部架构案例的映射成本",
      bestFit: "工程培训、面试准备、架构评审前置学习和技术社区运营",
      badFit: "需要生产代码、公司私有架构细节或高级研究级分布式系统证明的场景",
      primaryRisk: "图解容易把真实系统复杂度简化过度，培训时必须补充约束、反例、容量指标和事故案例。",
    },
    "usestrix/strix": {
      domain: "AI 安全测试 Agent / 应用漏洞发现与修复",
      userPain: "应用安全团队需要持续发现和修复业务逻辑、接口、认证和前端漏洞，但人工渗透测试覆盖有限、修复闭环慢",
      coreMechanism: "AI hacker agent、目标扫描、浏览器/API 操作、漏洞假设生成、验证、补丁建议和安全报告输出",
      safeEntry: "只在授权测试环境和 staging 域名运行，先限定只读扫描与 PoC 生成，不允许破坏性写操作",
      businessValue: "把安全测试从周期性人工项目扩展为持续辅助流程，提高低成本覆盖和修复建议速度",
      successMetric: "有效漏洞率、误报率、严重级别分布、复现成功率、修复耗时、越权/破坏性操作拦截数",
      inspectFirst: "先看授权边界、扫描动作空间、浏览器隔离、凭据处理、报告证据、补丁生成方式和审计日志",
      bestFit: "有安全 owner、staging 环境、漏洞管理流程和人工复核机制的 SaaS/平台团队",
      badFit: "未授权目标、生产破坏性测试、无安全复核或希望让 Agent 自动提交高风险修复",
      primaryRisk: "安全 Agent 可能触发越权、数据破坏、误报和合规问题，必须限定范围、动作和人工确认。",
    },
    "diegosouzapw/OmniRoute": {
      domain: "多模型网关 / Coding Agent 路由与压缩层",
      userPain: "开发者同时使用 Claude Code、Codex、Cursor、Cline、Copilot 等工具时，需要统一模型入口、供应商切换、免费额度利用和 token 成本控制",
      coreMechanism: "OpenAI 兼容网关、160+ provider 路由、模型别名、请求压缩、自动 fallback、用量策略和面向 coding assistant 的 endpoint 适配",
      safeEntry: "先接入个人或内部非核心 coding workflow，只代理只读/低风险请求，记录每个 provider 的成功率、延迟、成本和输出差异",
      businessValue: "降低模型切换摩擦和 token 成本，让团队能按任务类型动态选择 Claude/GPT/Gemini 或免费模型池",
      successMetric: "请求成功率、P95 延迟、单位任务 token 成本、fallback 命中率、输出回归差异、凭据泄露事件数",
      inspectFirst: "先看密钥存储、请求日志脱敏、压缩策略、provider fallback、错误重试、速率限制和与各 coding assistant 的兼容层",
      bestFit: "重度使用多种 coding agent、能承担网关运维并愿意做输出回归评测的研发效能或平台团队",
      badFit: "强合规代码、无法接受第三方中转、没有密钥治理，或希望用免费模型替代所有高可靠生产任务",
      primaryRisk: "模型网关会集中凭据、源码上下文和供应商路由决策；压缩也可能破坏关键上下文，必须做日志脱敏、回放评测和回滚策略。",
    },
    "browser-use/video-use": {
      domain: "Coding Agent 视频编辑 / 可编程媒体流水线",
      userPain: "内容团队想让 coding agent 直接改视频、生成剪辑脚本、处理素材和输出候选版本，但传统视频编辑器不适合自动化回放与审计",
      coreMechanism: "把视频时间线、素材引用、剪辑操作、字幕/音频处理和导出步骤封装成 agent 可调用的代码化编辑工作流",
      safeEntry: "选一个内部低风险短视频模板，只让 Agent 生成候选剪辑和修改 diff，由人工在发布前终审",
      businessValue: "把视频改稿从手工拖拽转成可复现脚本，降低批量版本、A/B 素材和多语言视频的制作成本",
      successMetric: "候选稿生成时间、人工修改轮次、导出成功率、素材引用错误率、品牌审核通过率、单条视频成本",
      inspectFirst: "先看时间线数据模型、FFmpeg/渲染依赖、素材路径管理、失败回滚、导出质量和人工审稿关口",
      bestFit: "增长、开发者关系、课程、内部培训和有固定模板的视频内容团队",
      badFit: "版权来源不清、品牌审核严格但无终审 owner，或需要广播级非线编能力的生产线",
      primaryRisk: "视频 Agent 容易误用素材、破坏时间线、生成品牌不一致内容；必须保留素材授权、版本 diff、人工终审和导出回滚。",
    },
    "Mebus/cupp": {
      domain: "密码画像安全工具 / 授权口令审计样本生成",
      userPain: "安全团队在授权红队、口令审计或员工安全培训中，需要根据公开个人线索生成候选弱口令字典，评估真实弱口令暴露风险",
      coreMechanism: "命令行问答收集姓名、生日、昵称、伴侣、宠物、公司等画像线索，再组合常见变体、年份、符号和 leet 规则生成候选字典",
      safeEntry: "只在书面授权的自有账号、靶场或培训环境使用，先用合成身份样本验证规则覆盖和误用防护",
      businessValue: "帮助安全团队把弱口令教育从抽象提示转成可复现证据，推动密码策略、MFA 和泄露口令检测落地",
      successMetric: "候选覆盖率、误报/滥用拦截、生成规模、审计耗时、MFA 覆盖率、弱口令整改率",
      inspectFirst: "先看输入字段、组合规则、输出规模限制、许可证、合法授权提示和是否会保存敏感个人资料",
      bestFit: "有授权边界、红队流程、隐私审查和整改闭环的安全团队或教学靶场",
      badFit: "未授权账号测试、个人画像骚扰、生产爆破或任何缺少法律/合规审查的场景",
      primaryRisk: "口令画像工具天然具备滥用风险；必须限制授权范围、速率、日志留存和使用者责任，不能把生成字典等同于可执行攻击许可。",
    },
    "google/agents-cli": {
      domain: "Google Cloud Agent 开发 CLI / Skills 分发与部署链路",
      userPain: "团队想把 coding assistant 从写代码扩展到创建、评估和部署 Google Cloud 上的 AI agents，但云权限、技能模板和部署步骤分散",
      coreMechanism: "CLI、skills、Google Cloud agent 模板、评估/部署命令和面向多种 coding assistant 的上下文封装",
      safeEntry: "先用只读或沙箱 GCP 项目创建一个 demo agent，验证本地 CLI、服务账号权限、部署产物和清理脚本",
      businessValue: "把 agent 创建、评测、上线和文档上下文标准化，降低团队在 Google Cloud 上试点 agent 的集成成本",
      successMetric: "从模板到部署耗时、权限最小化覆盖、评测通过率、部署失败率、资源清理完整性、审计日志可读性",
      inspectFirst: "先看服务账号权限、生成的 IaC/配置、评测命令、日志、回滚/删除路径和与现有 GCP 组织策略的冲突",
      bestFit: "已经使用 Google Cloud、正在建设 AI agent 平台或需要让多种 coding assistant 共享云端 agent 开发规范的团队",
      badFit: "没有 GCP 治理、不能创建沙箱项目，或希望 Agent 直接操作生产云资源",
      primaryRisk: "云 Agent CLI 会放大 IAM、费用和资源残留问题；必须从沙箱、最小权限、预算告警和可审计部署开始。",
    },
    "roboflow/supervision": {
      domain: "计算机视觉工具库 / 标注到部署的后处理层",
      userPain: "视觉团队在检测、分割、跟踪和计数场景中，经常重复编写标注可视化、结果过滤、数据集转换和视频流后处理代码",
      coreMechanism: "Python CV 工具库封装 detection/segmentation 结果对象、annotator、tracker、dataset I/O、zone 计数和模型推理后处理",
      safeEntry: "选一个离线视频或图片评测集，把现有 YOLO/RT-DETR/SAM 输出接入 supervision，只替换可视化和后处理层",
      businessValue: "减少视觉原型到 demo 的胶水代码，让模型评估、错误样本复盘和业务规则验证更快闭环",
      successMetric: "集成耗时、标注/可视化一致性、FPS、后处理错误率、数据集转换成功率、人工复核效率",
      inspectFirst: "先看结果对象 schema、tracker/annotator 性能、视频处理内存、模型生态兼容和版本变更对现有 pipeline 的影响",
      bestFit: "计算机视觉原型、工业检测、零售客流、交通分析和需要快速展示/复盘模型输出的团队",
      badFit: "强实时嵌入式部署、已经有成熟 C++ 后处理栈，或需要安全级视觉认证的场景",
      primaryRisk: "CV 工具库通常不决定模型准确率；生产收益取决于后处理性能、数据漂移监控、视频流稳定性和与现有推理服务的边界。",
    },
    "ogulcancelik/herdr": {
      domain: "终端 Agent 多路复用器 / 本地开发任务编排",
      userPain: "开发者需要在同一个终端里同时管理多个 agent、任务和上下文，但直接并行运行容易造成目录混乱、输出交错和人工接管困难",
      coreMechanism: "终端内 agent multiplexer、任务会话、命令路由、输出聚合和面向本地 coding workflow 的轻量编排界面",
      safeEntry: "先用只读调研、测试生成或文档修订任务试跑两个会话，禁止并行写同一文件并记录合并成本",
      businessValue: "把多 agent 探索从多个窗口切换收敛为可观察工作台，提高并行搜索、方案比较和人工接管效率",
      successMetric: "任务完成率、上下文切换次数、输出冲突率、人工合并耗时、误写文件次数、会话恢复成功率",
      inspectFirst: "先看会话隔离、工作目录策略、日志持久化、终止/恢复、并行写文件防护和与 shell/编辑器的兼容性",
      bestFit: "重度使用 coding agents、任务可拆分且有工程师最终 review/合并的个人或小型研发团队",
      badFit: "权限敏感代码库、任务强顺序依赖、缺少 git 工作区隔离或没有 review 纪律的团队",
      primaryRisk: "多路复用会放大上下文漂移和文件冲突；需要工作区隔离、明确任务边界和人工合并检查。",
    },
    "mauriceboe/TREK": {
      domain: "自托管协同旅行规划 / 个人云产品",
      userPain: "家庭、朋友或小团队旅行规划分散在表格、聊天、地图、预算和清单里，难以协同和复盘",
      coreMechanism: "自托管 Web/PWA、实时协作、交互地图、SSO、预算、packing list、行程对象模型和权限控制",
      safeEntry: "先部署给一个非敏感旅行计划，验证多人编辑、移动端离线体验、地图成本和备份恢复",
      businessValue: "把碎片化旅行协同收敛为一个可共享工作区，并给自托管个人云增加高频生活场景",
      successMetric: "多人编辑冲突率、移动端完成率、地图加载延迟、预算/清单使用率、备份恢复时间",
      inspectFirst: "先看实时同步模型、地图 provider、SSO/权限、PWA 缓存、数据导出和容器部署路径",
      bestFit: "自托管爱好者、家庭/小团队协同、旅行社区和需要私有化行程数据的组织",
      badFit: "需要企业级商旅审批、供应商预订整合或对地图/协同 SLA 要求很高的场景",
      primaryRisk: "旅行数据涉及位置、时间和同行人隐私；地图 API 成本、实时协作冲突和备份恢复要先验证。",
    },
    "aws/agent-toolkit-for-aws": {
      domain: "AWS 官方 Agent 工具包 / 云操作 MCP 与 Skills",
      userPain: "企业想让 Agent 安全地理解和操作 AWS，但自建 MCP/skills 容易缺少权限边界、服务覆盖和官方维护承诺",
      coreMechanism: "AWS 支持的 MCP servers、skills、plugins、服务 API 封装、最小权限配置和面向云资源的 Agent 工具分发",
      safeEntry: "只启用只读账号和低风险服务，把资源查询、成本解释或 IaC 辅助作为首个试点",
      businessValue: "降低 Agent 接入 AWS 的集成成本，为云平台团队建立可审计的官方工具白名单",
      successMetric: "只读任务完成率、越权拦截率、权限策略覆盖、审计日志完整性、人工接管耗时",
      inspectFirst: "先看每个 MCP server/skill 的 IAM 权限、写操作边界、日志、版本发布和与现有云治理的冲突点",
      bestFit: "已经使用 AWS 且正在建设内部 Agent 平台、云成本助手、DevOps 助手或 IaC 辅助的团队",
      badFit: "没有云权限治理、希望让 Agent 直接改生产资源或缺少审计/回滚流程",
      primaryRisk: "云 Agent 会放大 IAM、成本、误操作和供应链风险；必须先做只读、最小权限、审计和人工确认。",
    },
    "alibaba/page-agent": {
      domain: "浏览器内 GUI Agent / Web 自动化执行层",
      userPain: "Agent 需要操作复杂网页界面，但传统 DOM 脚本和截图点击都难以稳定表达页面状态、动作和失败原因",
      coreMechanism: "页面内 JavaScript agent、DOM/视觉状态抽取、自然语言动作映射、浏览器执行上下文和可观测操作日志",
      safeEntry: "选择内部低风险后台或测试页面，只做只读导航、表单草稿和截图验收，不直接提交生产变更",
      businessValue: "把 GUI 操作从脆弱脚本转为可解释的 Agent 执行层，补齐无 API 系统的自动化入口",
      successMetric: "任务完成率、误点击率、页面状态识别准确率、人工接管率、P95 操作时延",
      inspectFirst: "先看页面状态 schema、动作空间、沙箱/权限、错误恢复、日志和对动态前端框架的兼容性",
      bestFit: "内部运营后台、QA 自动化、RPA 替代和 Agent 浏览器平台团队",
      badFit: "页面包含高风险交易、验证码/反自动化限制或缺少人工确认的生产写操作",
      primaryRisk: "GUI Agent 的误操作、状态误判和权限扩散风险高，必须限制域名、动作和提交权限。",
    },
    "IceWhaleTech/CasaOS": {
      domain: "个人云操作系统 / 自托管家庭基础设施",
      userPain: "个人和小团队想运行 NAS、媒体、备份、下载和家庭自动化服务，但容器、网络和存储配置门槛高",
      coreMechanism: "Web 控制台、应用商店、Docker/服务编排、存储与账号管理、家庭网络入口和轻量运维界面",
      safeEntry: "先在家庭实验室或备用设备上部署非关键服务，验证备份、升级、权限和远程访问边界",
      businessValue: "把自托管从命令行运维降到产品化入口，扩大个人数据和家庭服务的本地控制能力",
      successMetric: "应用安装成功率、升级失败率、备份恢复时间、资源占用、远程访问安全事件",
      inspectFirst: "先看应用商店来源、容器权限、数据目录、备份恢复、远程访问和安全公告响应",
      bestFit: "自托管爱好者、家庭服务器、小型工作室和需要低门槛私有云的场景",
      badFit: "需要企业级 SLA、多租户隔离、合规审计或无人值守生产环境",
      primaryRisk: "个人云把数据、网络入口和第三方容器集中在一起，供应链、备份和公网暴露要先治理。",
    },
    "opendatalab/MinerU": {
      domain: "文档解析到 LLM 数据层 / Agentic Workflow 入口",
      userPain: "PDF、Office 和复杂版面文档难以稳定转成可检索、可引用、可进入 RAG/Agent 的结构化数据",
      coreMechanism: "版面分析、OCR/表格/公式解析、文档结构恢复、Markdown/JSON 输出和批处理管线",
      safeEntry: "选一批非敏感历史文档做离线解析评测，只进入只读 RAG 索引，不直接覆盖原始文档",
      businessValue: "降低企业知识库、科研资料和合同/报告进入 LLM 工作流的前处理成本",
      successMetric: "解析成功率、表格/公式准确率、引用定位准确率、人工修正耗时、批处理吞吐",
      inspectFirst: "先看版面模型、OCR 依赖、输出 schema、失败样本、GPU/CPU 成本和与现有 RAG 索引的接入方式",
      bestFit: "知识库、科研、法务、金融报告、教育资料和 Agent 文档处理平台团队",
      badFit: "扫描质量差、强合规敏感文档无脱敏流程或需要 100% 自动抽取正确性的场景",
      primaryRisk: "文档解析错误会被下游 RAG 放大，必须保留原文引用、置信度、人工校验和失败回退。",
    },
    "bytedance/deer-flow": {
      domain: "长周期 SuperAgent Harness / 多 Agent 任务执行",
      userPain: "研究、编码和内容生成任务需要跨分钟到小时运行，但普通 Agent 容易丢状态、失控或难以接管",
      coreMechanism: "sandbox、memory、tool、skill、subagent、message gateway 和长任务状态机协同",
      safeEntry: "先用公开资料研究或内部脚手架生成做旁路任务，禁用高风险写操作",
      businessValue: "提高长任务完成率，把研究、代码和产物生成纳入可观测的 Agent 编排层",
      successMetric: "任务完成率、人工接管率、上下文恢复成功率、沙箱失败率、单位任务成本",
      inspectFirst: "先看任务状态、消息网关、工具权限、沙箱隔离、memory schema 和失败恢复",
      bestFit: "研究助手、开发者平台、自动化内容生产和内部 Agent 平台团队",
      badFit: "任务边界不清、缺少审计日志或无法容忍长任务偶发错误",
      primaryRisk: "长周期 Agent 会放大权限、成本、状态污染和失败恢复问题，必须先定义中止/回滚机制。",
    },
    "koala73/worldmonitor": {
      domain: "OSINT 情报看板 / 全球态势监控",
      userPain: "团队需要把新闻、地缘政治、基础设施和事件信号聚合到一个可扫读态势界面",
      coreMechanism: "多源新闻聚合、AI 摘要、地理/事件分类、监控看板和统一态势 UI",
      safeEntry: "只接公开来源和低风险主题，作为人工研判前的线索池",
      businessValue: "缩短信号发现时间，帮助安全、运营、供应链或公共事务团队建立早期预警",
      successMetric: "来源覆盖率、去重率、误报率、引用可追溯率、事件更新延迟",
      inspectFirst: "先看来源列表、抓取频率、去重逻辑、地理标注、引用保真和权限边界",
      bestFit: "OSINT、风险监控、企业安全、供应链和新闻情报团队",
      badFit: "需要保密情报、强 SLA 或没有人工复核的自动决策场景",
      primaryRisk: "公开新闻聚合容易产生误报、偏见和来源污染，必须保留引用、时间戳和人工确认。",
    },
    "palmier-io/palmier-pro": {
      domain: "AI 原生桌面视频编辑器 / macOS 创作工具",
      userPain: "视频创作者希望在本地编辑器里直接调用生成、剪辑、配音和 MCP 工具，而不是在多个 SaaS 间搬运素材",
      coreMechanism: "Swift/macOS 原生 UI、视频时间线、AI 模型连接、MCP/Claude 集成和本地素材工作区",
      safeEntry: "个人创作或内部素材粗剪，不处理敏感客户素材",
      businessValue: "减少素材导入导出和工具切换成本，把 AI 生成能力嵌进桌面编辑流程",
      successMetric: "导入成功率、时间线稳定性、生成等待时间、崩溃率、人工修正次数",
      inspectFirst: "先看媒体处理管线、文件权限、模型凭据、MCP 工具边界和导出质量",
      bestFit: "macOS 创作者、内部内容团队和 AI 视频原型团队",
      badFit: "需要多人协作、企业 DAM 集成或严格审计的品牌生产线",
      primaryRisk: "桌面媒体工具的稳定性、素材隐私、模型费用和导出一致性决定真实可用性。",
    },
    "anthropics/claude-plugins-official": {
      domain: "Claude Code 插件目录 / 官方能力分发",
      userPain: "团队需要判断哪些 Claude Code 插件值得信任、如何安装、如何治理更新和权限",
      coreMechanism: "Anthropic 管理的插件目录、质量准入、插件元数据、安装入口和 MCP/skill 能力分发",
      safeEntry: "只读插件评估清单，先安装低权限插件并记录权限差异",
      businessValue: "降低插件发现和信任成本，为企业 Claude Code 工作流建立可审计白名单",
      successMetric: "插件可用率、权限最小化程度、更新频率、安装失败率、安全审查通过率",
      inspectFirst: "先看插件 manifest、权限、来源、版本、安装脚本和官方维护边界",
      bestFit: "已经在企业内推广 Claude Code 的平台工程、安全和研发效能团队",
      badFit: "希望无审查安装第三方插件或缺少插件生命周期 owner",
      primaryRisk: "插件会扩大工具权限和供应链风险，必须建立白名单、版本锁定和撤销流程。",
    },
    "shanraisshan/claude-code-best-practice": {
      domain: "Agentic Engineering 方法库 / Claude Code 实践",
      userPain: "团队从 vibe coding 过渡到工程化 Agent 使用时，缺少上下文工程、命令、技能和复盘规范",
      coreMechanism: "最佳实践文档、命令模式、skills、agentic workflow、上下文工程和案例沉淀",
      safeEntry: "抽 2-3 条与本地流程匹配的实践，在真实 PR 中验证一次",
      businessValue: "减少 Agent 使用中的上下文遗漏、返工和不可复现输出",
      successMetric: "任务一次通过率、补充上下文次数、review 缺陷、技能复用次数",
      inspectFirst: "先看实践粒度、触发条件、与本地测试/CI/review 的衔接和过期风险",
      bestFit: "已经使用 Claude Code 且想建立团队级操作规范的研发组织",
      badFit: "没有统一工程流程或把外部最佳实践当作强制规范照搬",
      primaryRisk: "实践库容易随 Claude Code 能力快速过期，必须持续复盘并做本地化。",
    },
    "revfactory/harness": {
      domain: "Agent Harness 生成器 / 领域团队编排",
      userPain: "复杂任务需要临时组织多个专业 Agent，但手工写角色、技能和交接规则成本高",
      coreMechanism: "meta-skill 根据领域目标设计 Agent 团队、生成专用技能、定义交接和验证边界",
      safeEntry: "选择一个只读分析或文档生成任务，让 harness 产出团队配置后人工复核",
      businessValue: "把 Agent 团队设计从一次性提示词变成可复用、可审查的工程资产",
      successMetric: "生成技能可用率、交接缺陷、任务完成率、人工修改量、越权风险",
      inspectFirst: "先看 meta-skill 输出格式、权限假设、验证清单和失败回退路径",
      bestFit: "多角色研究、产品设计、代码迁移和复杂运营流程自动化团队",
      badFit: "任务简单、领域知识不足或不愿维护生成后的技能资产",
      primaryRisk: "自动生成 Agent 团队会放大错误角色假设，必须人工审查权限、目标和验证标准。",
    },
    "jamiepine/voicebox": {
      domain: "开源 AI 语音工作室 / 本地语音生成",
      userPain: "创作者和产品团队需要克隆、听写和生成语音，但希望保留本地控制和可替换模型",
      coreMechanism: "TTS/ASR 模型、voice clone、CUDA/MLX 推理、本地 UI 和音频处理管线",
      safeEntry: "用授权样本做内部旁白或原型配音，不处理未经授权的人声",
      businessValue: "降低语音内容生产和原型成本，同时保留本地部署与模型切换空间",
      successMetric: "相似度、WER、生成延迟、显存占用、失败率、授权样本覆盖",
      inspectFirst: "先看模型许可证、音频样本管理、推理后端、导出格式和滥用防护",
      bestFit: "播客、课程、游戏、无障碍和内部内容原型团队",
      badFit: "缺少声音授权、需要企业级审计或对声音一致性有广播级要求",
      primaryRisk: "声音克隆涉及授权、欺诈和品牌安全，必须限制样本来源并保留水印/审计策略。",
    },
    "JCodesMore/ai-website-cloner-template": {
      domain: "AI 网站复刻脚手架 / 前端原型自动化",
      userPain: "设计和前端团队想快速把参考站点转成可编辑原型，但手工拆布局、样式和组件耗时",
      coreMechanism: "网页抓取、截图/DOM 提取、AI coding agent、Next.js/React/shadcn/Tailwind 模板和生成命令",
      safeEntry: "只复刻公开参考站的布局结构，用于内部原型，不复制品牌资产和受版权保护素材",
      businessValue: "缩短竞品拆解、原型搭建和组件草稿生成时间",
      successMetric: "首屏还原度、移动端适配、组件可维护性、生成后修正时间、版权风险项",
      inspectFirst: "先看抓取边界、生成 prompt、组件结构、样式 token、素材处理和合规提示",
      bestFit: "增长页、内部工具原型、竞品研究和设计工程团队",
      badFit: "直接复制上线、绕过授权或需要高保真交互/无障碍质量",
      primaryRisk: "网站克隆容易触碰版权、商标、隐私和反爬边界，必须限定为学习和内部原型。",
    },
    "every-app/open-seo": {
      domain: "开源 SEO 增长情报工作台 / Agent 可接入营销数据层",
      userPain: "增长、内容和开发者关系团队需要把关键词研究、站点审计、反链分析和 Google Search Console 数据从昂贵 SaaS 里拆出来，变成可自托管、可被 Agent 调用的工作流",
      coreMechanism: "TypeScript Web 应用、DataForSEO API、Google Search Console MCP、站点审计、关键词/反链对象模型、自托管部署和预置 Agent skills",
      safeEntry: "先接一个非核心站点，只做只读关键词、反链和技术 SEO 审计，不让 Agent 自动改页面或提交 sitemap",
      businessValue: "降低 SEO 工具成本，把增长数据纳入可审计的内部工作台，并让 Agent 能按固定技能生成诊断和内容机会清单",
      successMetric: "API 成本/站点、关键词覆盖率、审计误报率、GSC 数据同步成功率、人工复核通过率、Agent 建议采纳率",
      inspectFirst: "先看 DataForSEO/GSC 凭据管理、MCP 权限、站点抓取边界、任务队列、成本控制和自托管数据备份",
      bestFit: "有多个内容站、开发者文档站或增长落地页，且愿意维护自托管数据和 API 成本预算的团队",
      badFit: "只做一次性 SEO 体检、没有 GSC/API 权限治理，或希望 Agent 自动发布/改写生产页面",
      primaryRisk: "SEO 数据来自第三方 API 和搜索平台，成本、配额、抓取合规、凭据泄露和错误建议上线都要前置治理。",
    },
    "apple/container": {
      domain: "Apple Silicon 容器运行时 / 本地开发基础设施",
      userPain: "Mac 开发者需要接近 Linux 的容器体验，但又希望利用轻量虚拟机隔离、OCI 镜像和 Apple Silicon 性能",
      coreMechanism: "Swift CLI、轻量 Linux VM、OCI image pull/run、虚拟网络、卷挂载、进程生命周期和 macOS 权限边界",
      safeEntry: "把一个非核心 Linux 服务或 CLI 测试环境迁到本地容器，旁路对比 Docker Desktop/Colima 的启动、网络和文件性能",
      businessValue: "减少本地环境漂移，让 Apple Silicon 开发机更稳定地承载 Linux 构建、测试和调试任务",
      successMetric: "冷启动时间、镜像兼容率、文件 I/O、网络连通率、资源占用、开发者回滚时间",
      inspectFirst: "先看 VM 生命周期、OCI 兼容层、网络/volume 配置、rootless 边界和与现有 CI 镜像的差异",
      bestFit: "以 Mac 为主力开发机、Linux 服务较多、愿意维护本地开发平台规范的工程团队",
      badFit: "强依赖 Docker Desktop 插件生态、复杂 compose 编排或企业设备策略不允许虚拟化扩展",
      primaryRisk: "容器兼容性、虚拟网络、文件系统一致性和企业安全策略会决定它能否替代现有本地运行时。",
    },
    "interviewstreet/hiring-agent": {
      domain: "招聘评估 Agent / 简历结构化与公平性解释",
      userPain: "招聘团队想把 PDF 简历解析、GitHub 信号、岗位匹配和解释性评分统一成可复核流程",
      coreMechanism: "PDF 解析、候选人结构化数据、GitHub enrichment、岗位 rubric、评分模型、解释输出和人工复核队列",
      safeEntry: "只做历史简历离线回放和面试官辅助摘要，不让 Agent 直接淘汰候选人",
      businessValue: "缩短筛简历时间，提高候选人信息整理一致性，并把评分理由显性化供招聘团队复核",
      successMetric: "解析成功率、人工修正率、不同群体误差、面试官一致性、候选人申诉率、合规审查通过率",
      inspectFirst: "先看 rubric、特征来源、GitHub 信号权重、解释模板、敏感属性处理和人工覆写路径",
      bestFit: "有明确岗位能力模型、历史面试反馈和合规 owner 的招聘平台或内部 HR 工具团队",
      badFit: "缺少公平性评估、想用黑盒分数替代招聘判断或候选人来源高度多样但标注不足",
      primaryRisk: "招聘评分涉及偏见、劳动合规、候选人隐私和可解释性，必须把 Agent 限定为辅助而非最终决策者。",
    },
    "flutter/flutter": {
      domain: "跨端 UI SDK / 产品交付基础设施",
      userPain: "产品团队希望用一套工程体系覆盖移动、桌面、Web 和嵌入式界面，同时保持性能与设计一致性",
      coreMechanism: "Dart 框架、Skia/Impeller 渲染、widget tree、热重载、平台通道、插件生态和多端构建工具链",
      safeEntry: "先选一个内部工具或新业务轻客户端，用同一设计系统验证 iOS/Android/Web 的交付效率和体验差异",
      businessValue: "降低多端重复开发成本，提升 UI 一致性、原型速度和长期组件复用能力",
      successMetric: "多端缺陷率、首屏性能、包体积、组件复用率、平台特性接入成本、升级回归时间",
      inspectFirst: "先看渲染后端、平台插件、状态管理选择、CI 构建矩阵和目标端性能 profile",
      bestFit: "新产品、多端一致性要求高、团队能接受 Dart/Flutter 工程规范的业务线",
      badFit: "深度依赖原生平台控件、已有成熟原生团队或需要极低包体积/极强平台定制",
      primaryRisk: "跨端收益会被插件质量、原生桥接、性能调优和团队学习成本抵消，需要用真实页面验证。",
    },
    "andreknieriem/headunit-revived": {
      domain: "车载投屏 / Android Auto Headunit",
      userPain: "用户或设备团队需要在平板、车机或备用设备上显示 Android Auto，而不是依赖原厂车机",
      coreMechanism: "Android app、USB/Wi-Fi headunit 会话、屏幕投射、输入事件转发、音频/权限处理和设备兼容矩阵",
      safeEntry: "只在静态测试台或非驾驶场景验证连接、分辨率、触控和断连恢复",
      businessValue: "让旧车机、测试设备或开发场景获得 Android Auto 体验，降低硬件替换和调试门槛",
      successMetric: "连接成功率、断线恢复、触控延迟、音频路由稳定性、机型覆盖、崩溃率",
      inspectFirst: "先看 Android 权限、连接协议、Play 商店分发、设备白名单、日志和断连重连处理",
      bestFit: "车载应用测试、个人设备改造、Android Auto 兼容性验证和低风险实验环境",
      badFit: "正式车载安全场景、驾驶中高交互需求或无法接受设备/系统版本差异",
      primaryRisk: "车载场景必须优先考虑驾驶安全、系统权限、连接稳定性和地区法规，不能按普通移动 app 采用。",
    },
    "stablyai/orca": {
      domain: "并行 Coding Agent 桌面 / Agent Development Environment",
      userPain: "工程师想同时调度多个 coding agent、复用自己的订阅和跨桌面/移动端接管任务，但现有工具缺少统一工作台",
      coreMechanism: "桌面/移动客户端、agent session 编排、多供应商 agent 接入、任务队列、工作区状态和人工接管界面",
      safeEntry: "选择一个只读调研或低风险文档/测试任务，让两个 Agent 并行执行并人工合并结果",
      businessValue: "提高多任务探索速度，把 agent 调度、观察和接管从分散终端收敛到一个可管理界面",
      successMetric: "任务完成率、人工合并耗时、冲突率、上下文恢复成功率、单位任务成本、误改回滚次数",
      inspectFirst: "先看工作区隔离、凭据保存、agent 适配器、任务日志、并行写文件冲突和移动端权限边界",
      bestFit: "已经重度使用多种 coding agent、任务可拆分且有工程师负责最终合并的研发团队",
      badFit: "代码库权限敏感、任务依赖强顺序执行或缺少 review/回滚机制",
      primaryRisk: "并行 Agent 会放大文件冲突、上下文漂移、订阅成本和凭据泄露风险，必须先限制工作区和写权限。",
    },
    "google-labs-code/design.md": {
      domain: "设计系统上下文规范 / Agent 可读品牌资产",
      userPain: "Coding Agent 生成界面时缺少稳定的品牌、视觉 token、组件语义和设计原则上下文，导致每次输出风格漂移",
      coreMechanism: "DESIGN.md 规范、YAML tokens、Markdown 设计原则、组件/语义约束和 Agent 可持久读取的设计系统文件",
      safeEntry: "为一个内部产品或设计系统生成 DESIGN.md，再让 Agent 改一个小页面对比前后风格一致性",
      businessValue: "把设计系统从人工解释转成机器可读上下文，提高 AI 生成界面的品牌一致性和可维护性",
      successMetric: "token 命中率、设计 review 返工率、组件复用率、视觉漂移问题数、文档更新成本",
      inspectFirst: "先看 front matter schema、token 粒度、语义规则、组件示例和与现有 design token 源的同步方式",
      bestFit: "有明确品牌规范、组件库和 AI 前端生成需求的设计工程/产品工程团队",
      badFit: "设计系统尚未沉淀、token 来源不统一或希望用文档替代设计 review",
      primaryRisk: "DESIGN.md 一旦陈旧会把过期视觉规范传播给 Agent，必须建立从设计源到代码仓库的同步责任。",
    },
    "Flowseal/zapret-discord-youtube": {
      domain: "网络可达性工具 / 流量绕行配置集合",
      userPain: "用户在特定网络环境下访问 Discord、YouTube 或 Telegram Desktop 等服务不稳定，需要本地化的连通性实验工具",
      coreMechanism: "zapret 规则、平台脚本、流量分流配置、域名/协议匹配、桌面启动器和社区维护的可达性参数",
      safeEntry: "只在合规的个人网络排障环境中阅读配置结构，不把规则下发到公司设备或生产网络",
      businessValue: "帮助理解网络阻断、协议特征和桌面客户端连通性问题，为合规网络诊断提供样本",
      successMetric: "配置可读性、平台兼容性、失败回滚、误伤率、规则更新频率、合规审查结论",
      inspectFirst: "先看脚本权限、规则来源、系统修改点、卸载路径、目标域名和地区/网络合规边界",
      bestFit: "个人网络诊断、协议学习或受控实验环境，且使用者理解当地法律和服务条款",
      badFit: "企业网络、受监管环境、绕过访问控制或任何缺少授权的网络操作",
      primaryRisk: "这类工具可能触碰网络合规、服务条款、系统安全和地区法律边界，企业场景应只做风险观察。",
    },
    "kunchenguid/no-mistakes": {
      domain: "Git 发布防错 / 开发者命令护栏",
      userPain: "开发者在 push 前容易遗漏分支、远端、未提交文件、测试状态或危险命令确认，导致错误发布或污染远端仓库",
      coreMechanism: "Git hook/CLI 包装、push 前检查、工作区状态扫描、分支/远端确认、规则配置和跨平台命令入口",
      safeEntry: "先在个人仓库或非核心团队启用提示模式，只记录会拦截哪些 push，不直接阻断",
      businessValue: "降低误推、漏测和错误分支发布概率，把依赖个人记忆的发布前检查变成统一护栏",
      successMetric: "误推次数、阻断准确率、开发者绕过率、CI 失败率、规则误报、安装维护成本",
      inspectFirst: "先看 hook 安装方式、规则可配置性、跨平台 shell 兼容、CI 环境识别和一键绕过审计",
      bestFit: "小团队、开源维护者或缺少统一 pre-push/pre-commit 规范的代码库",
      badFit: "已有成熟分支保护、CI gate 和发布平台，或规则误报会严重打断开发节奏",
      primaryRisk: "本地护栏不能替代服务器端分支保护和 CI；规则过严会导致开发者绕过，规则过松又没有实际收益。",
    },
    "teslamate-org/teslamate": {
      domain: "IoT 数据记录 / 自托管观测",
      userPain: "车联网个人数据留存、可视化和自动化分析",
      coreMechanism: "数据采集、时序存储、Grafana 仪表盘、容器化部署和第三方 API 连接",
      safeEntry: "个人或小团队自托管数据日志环境",
      businessValue: "长期数据可见性、设备行为分析和自动化触发",
      successMetric: "数据完整率、同步延迟、备份恢复时间、API 变更影响",
      inspectFirst: "先看采集任务、数据库 schema、Grafana dashboard、Docker compose 和备份路径",
      bestFit: "需要自主管理设备/车辆数据且能承担自托管运维",
      badFit: "缺少部署 owner 或无法接受第三方 API 变更风险",
      primaryRisk: "隐私数据、账号授权、API 变更和长期备份恢复需要前置治理。",
    },
    "music-assistant/server": {
      domain: "边缘媒体服务 / 家庭自动化",
      userPain: "多音乐源、多播放器和家庭自动化之间的统一控制",
      coreMechanism: "服务端编排、插件连接器、媒体库索引、设备发现和播放状态同步",
      safeEntry: "家庭实验室或低风险内网媒体环境",
      businessValue: "媒体体验一致性、设备复用和本地控制能力",
      successMetric: "设备兼容率、播放稳定性、索引刷新延迟、账号授权失败率",
      inspectFirst: "先看 provider 插件、队列状态、设备发现、认证存储和恢复机制",
      bestFit: "有多源媒体和多设备统一控制需求",
      badFit: "需要企业级 SLA 或无法接受家庭网络不稳定",
      primaryRisk: "账号授权、协议差异、网络抖动和边缘设备资源会决定真实体验。",
    },
    "alibaba/zvec": {
      domain: "本地向量数据库 / RAG 基础设施",
      userPain: "RAG、Agent 记忆或端内检索需要低延迟、轻量级向量索引",
      coreMechanism: "嵌入式向量索引、HNSW/相似度检索、进程内查询和轻量持久化边界",
      safeEntry: "离线评测、桌面应用或边缘 RAG 旁路索引",
      businessValue: "降低检索延迟、部署复杂度和外部服务依赖",
      successMetric: "recall@K、P95 查询延迟、内存占用、索引构建时间、崩溃恢复",
      inspectFirst: "先看索引结构、更新/删除语义、持久化、并发模型和 benchmark 数据",
      bestFit: "数据规模可控且更重视本地低延迟和部署简单性",
      badFit: "需要分布式扩展、复杂过滤、强一致写入或成熟托管运维",
      primaryRisk: "索引正确性、更新一致性、内存上限和崩溃恢复不能只靠 benchmark 判断。",
    },
    "rmyndharis/OpenWA": {
      domain: "消息 API 网关 / 自托管集成",
      userPain: "把 WhatsApp 通讯接入客服、通知或自动化流程",
      coreMechanism: "会话登录、API 网关、消息队列/回调、限流和自托管运行时",
      safeEntry: "低风险通知、内部客服沙箱或人工可接管流程",
      businessValue: "降低消息集成成本、提升自动化触达和客服响应速度",
      successMetric: "送达率、失败重试率、账号风控事件、人工接管率、审计完整性",
      inspectFirst: "先看登录态管理、webhook、限流、错误重试、凭据存储和容器部署",
      bestFit: "已有合规消息场景且能接受自托管维护",
      badFit: "缺少合规审查、账号风控策略或人工接管机制",
      primaryRisk: "非官方消息集成要重点关注账号风控、隐私、审计、限流和服务条款变化。",
    },
    "DeusData/codebase-memory-mcp": {
      domain: "代码智能 / MCP 记忆基础设施",
      userPain: "Coding Agent 每次任务都要重新读取仓库，token 成本高且跨文件依赖容易丢失",
      coreMechanism: "静态代码索引、持久知识图谱、MCP 工具接口、跨语言符号解析和低延迟查询",
      safeEntry: "选一个中型服务仓库，接入只读 MCP 查询，旁路比较 Agent 定位文件和解释依赖的准确率",
      businessValue: "降低 Agent 上下文成本，提高代码问答、影响面分析和变更定位稳定性",
      successMetric: "首次定位耗时、token 消耗、符号命中率、错误引用率、索引更新时间",
      inspectFirst: "先看索引构建入口、语言 parser、图谱 schema、MCP tool 定义和缓存失效策略",
      bestFit: "多仓库维护、代码审查、迁移改造或 Agent coding 平台团队",
      badFit: "仓库很小、权限无法隔离或不允许把源码索引暴露给 Agent",
      primaryRisk: "源码权限、索引陈旧、跨语言解析错误和 MCP 工具越权要先治理。",
    },
    "n0-computer/iroh": {
      domain: "点对点网络 / 边缘连接基础设施",
      userPain: "设备、边缘节点或本地优先应用在 NAT、动态 IP 和跨网络连接下可靠性不足",
      coreMechanism: "基于 dial key 的寻址、Rust 模块化网络栈、直连/中继连接协商和能力封装",
      safeEntry: "先用两个受控节点做文件同步或设备控制链路，旁路记录连接建立、重连和降级行为",
      businessValue: "减少中心化网关依赖，让边缘协作、本地优先应用和设备连接更容易落地",
      successMetric: "连接成功率、P95 建连耗时、断线恢复时间、中继占比、端到端吞吐",
      inspectFirst: "先看 endpoint/key 管理、relay/discovery、连接状态机、错误重试和安全模型",
      bestFit: "边缘计算、本地优先协作、P2P 文件同步或设备互联团队",
      badFit: "强监管网络、必须全量经企业代理审计或没有网络故障排查 owner",
      primaryRisk: "NAT 差异、密钥生命周期、中继成本和企业网络策略可能决定真实可用性。",
    },
    "Panniantong/Agent-Reach": {
      domain: "Agent 外部信息采集 / 多平台浏览工具",
      userPain: "Agent 需要读取 Twitter、Reddit、YouTube、GitHub、Bilibili、小红书等平台，但官方 API 成本和限制高",
      coreMechanism: "CLI 工具封装、多平台读取/搜索适配、网页解析、结果归一化和无 API key 工作流",
      safeEntry: "选 3 个公开信息源做研究助手旁路任务，禁止自动发帖和账号操作，只评估读取质量",
      businessValue: "降低舆情、竞品、开源生态和内容研究的资料收集成本",
      successMetric: "可访问率、去重率、引用可追溯率、解析失败率、单次任务耗时",
      inspectFirst: "先看平台适配器、登录态处理、限流/重试、输出 schema 和来源引用保真",
      bestFit: "研究、增长、开发者关系、开源情报和 Agent 数据采集团队",
      badFit: "需要稳定 SLA、强合规审计或涉及私域/敏感账号自动化",
      primaryRisk: "平台条款、账号风控、反爬变化、隐私边界和引用可追溯性是生产前置条件。",
    },
    "mukul975/Anthropic-Cybersecurity-Skills": {
      domain: "Agent 安全技能库 / 安全运营知识工程",
      userPain: "安全团队希望把 ATT&CK、NIST、ATLAS、D3FEND 等框架转成可被 Claude Code、Codex、Copilot 等 Agent 调用的结构化技能",
      coreMechanism: "按安全域组织的技能文件、框架映射、检测/响应流程、工具提示边界和跨平台 Agent skill 标准",
      safeEntry: "先选威胁狩猎、漏洞 triage 或事件响应中的一个低风险流程，作为只读辅助技能接入",
      businessValue: "减少安全分析上下文装配成本，提高告警研判、证据收集和处置建议的一致性",
      successMetric: "误报降噪率、研判耗时、MITRE 映射准确率、人工复核通过率、越权/误操作次数",
      inspectFirst: "先看技能目录、框架映射表、输入输出边界、权限提示、审计记录和与现有 SOAR/SIEM 的接入方式",
      bestFit: "有成熟安全流程、人工复核机制和框架化知识资产的 SOC、DevSecOps 或红蓝队平台团队",
      badFit: "想让 Agent 自动执行高危处置、缺少审计闭环或安全知识库尚未标准化",
      primaryRisk: "安全技能会放大 Agent 行为边界问题，必须限制凭据、网络、写操作和外部命令，并保留人工确认。",
    },
    "obra/superpowers": {
      domain: "Agentic 软件工程方法 / 技能框架",
      userPain: "团队把 AI 编码当聊天工具使用，缺少可复用流程、检查点和质量门禁",
      coreMechanism: "技能文件、强制流程、任务分解、验证清单和可迁移的工程方法约束",
      safeEntry: "挑一个低风险维护任务，把调研、实现、验证、复盘写成技能并在两名工程师间复用",
      businessValue: "把个人提示词经验沉淀为团队级工程流程，降低 Agent 产出不稳定性",
      successMetric: "返工率、漏测率、任务交接成本、技能复用次数、review 缺陷密度",
      inspectFirst: "先看技能触发规则、检查清单、失败处理、与现有 CI/review 流程的衔接",
      bestFit: "已经在用 Coding Agent 且想治理工程流程的研发效能团队",
      badFit: "没有统一开发流程、任务高度探索或团队不愿维护流程资产",
      primaryRisk: "过度流程化会拖慢简单任务，技能陈旧也会把坏习惯固化。",
    },
    "google-research/timesfm": {
      domain: "时间序列基础模型 / 预测建模",
      userPain: "需求、流量、库存、容量或告警预测需要跨场景迁移，但传统模型每个业务都要单独调参",
      coreMechanism: "预训练时间序列基础模型、patch 输入表示、零样本/少样本预测和批量推理接口",
      safeEntry: "选一组已有基线的离线时间序列，比较 TimesFM 与 Prophet/ARIMA/LightGBM 的误差和稳定性",
      businessValue: "缩短预测建模周期，为容量规划、供应链和运营指标提供统一预测基座",
      successMetric: "MAE/MAPE/sMAPE、冷启动序列表现、预测区间覆盖、推理成本、异常期鲁棒性",
      inspectFirst: "先看模型输入频率限制、上下文窗口、外生变量支持、batch 推理和评测脚本",
      bestFit: "有大量同构指标、需要快速预测基线的数据科学或平台团队",
      badFit: "强依赖可解释特征、业务规律突变或需要严格因果解释",
      primaryRisk: "分布漂移、节假日/促销外生因素、异常点和成本曲线必须纳入评测。",
    },
    "RocketChat/Rocket.Chat": {
      domain: "企业通讯 / 自托管协作平台",
      userPain: "高安全或受监管团队需要可自托管、可审计、可扩展的实时通讯系统",
      coreMechanism: "实时消息服务、权限/频道模型、应用集成、联邦/合规能力和容器化部署",
      safeEntry: "先在一个非核心团队试点 SSO、审计、备份和移动端体验，再评估替换范围",
      businessValue: "把敏感协作数据留在可控环境，同时保留机器人、工单和业务系统集成能力",
      successMetric: "消息延迟、移动端活跃、SSO 成功率、审计完整率、升级回滚时间",
      inspectFirst: "先看部署拓扑、数据库/文件存储、权限模型、应用市场、安全公告和迁移工具",
      bestFit: "政企、医疗、制造、金融或需要私有化通讯的团队",
      badFit: "只需要轻量 IM 或没有平台运维、安全和合规 owner",
      primaryRisk: "升级、移动端兼容、插件安全、消息留存和合规审计会形成长期运维负担。",
    },
    "continuedev/continue": {
      domain: "开源 Coding Agent / IDE 助手",
      userPain: "企业想把代码助手接入自有模型、私有知识和开发流程，但 SaaS 助手权限与可控性不足",
      coreMechanism: "IDE 插件、模型路由、上下文提供器、代码编辑 Agent、规则/索引和本地配置体系",
      safeEntry: "选一个内部仓库做只读问答和小补丁试点，对比定位准确率、diff 质量和开发者接管体验",
      businessValue: "在可控模型和代码权限下提升开发、迁移、测试和代码理解效率",
      successMetric: "采纳率、回滚率、review 缺陷、上下文命中率、单任务成本",
      inspectFirst: "先看 context provider、模型配置、索引策略、权限边界、telemetry 和 IDE 支持矩阵",
      bestFit: "需要私有化/多模型 Coding Agent 的平台工程或研发效能团队",
      badFit: "缺少模型网关、代码权限治理或开发者不愿改变 IDE 工作流",
      primaryRisk: "代码泄露、错误补丁、模型供应不稳定和插件升级兼容性需要前置评估。",
    },
    "penpot/penpot": {
      domain: "开源设计协作 / 设计工程平台",
      userPain: "设计系统和产品协作依赖封闭工具，代码团队难以自托管、扩展和审计设计资产",
      coreMechanism: "Web 设计编辑器、协作状态、组件/样式系统、文件存储和前后端分离服务",
      safeEntry: "先迁移一个非核心设计系统或内部工具项目，验证组件、导出、权限和协作延迟",
      businessValue: "让设计资产进入可控部署和开放格式，降低设计与代码协作的供应商锁定",
      successMetric: "设计文件打开耗时、协作冲突率、组件复用率、导出可用性、迁移成本",
      inspectFirst: "先看存储模型、实时协作、导入导出、权限、备份恢复和插件/扩展边界",
      bestFit: "重视开放设计系统、自托管和设计工程衔接的产品研发团队",
      badFit: "高度依赖既有 Figma 生态插件、外部设计伙伴或无设计平台 owner",
      primaryRisk: "协作性能、格式兼容、插件生态和设计师迁移成本会决定采用成败。",
    },
    "krahets/hello-algo": {
      domain: "算法教育 / 多语言知识工程",
      userPain: "团队算法基础培训缺少可运行、多语言、可视化且持续维护的材料",
      coreMechanism: "统一章节结构、动画图解、多语言代码实现、在线构建和社区翻译维护",
      safeEntry: "选一条数据结构学习路径接入内部培训，要求学员运行代码并提交错题/改进反馈",
      businessValue: "把算法培训从静态文档变成可运行、可本地化、可持续更新的学习资产",
      successMetric: "完成率、练习通过率、代码运行成功率、翻译缺陷、内容更新周期",
      inspectFirst: "先看章节 schema、多语言代码一致性、构建脚本、贡献流程和版本发布节奏",
      bestFit: "工程培训、校园招聘、内部学院和技术社区运营团队",
      badFit: "目标是生产依赖或高级算法研究，而不是基础教学和知识沉淀",
      primaryRisk: "内容维护、翻译一致性、代码过期和学习效果评估需要长期 owner。",
    },
    "mattpocock/skills": {
      domain: "工程师技能库 / AI 辅助开发方法",
      userPain: "个人工程经验分散在提示词和笔记里，难以转成可执行、可复用的 AI 工作流",
      coreMechanism: "面向真实工程任务的技能说明、上下文约束、命令模式和可复制实践清单",
      safeEntry: "挑 2 个团队高频任务，把对应技能改写成本地规范并在真实 PR 中验证一次",
      businessValue: "把资深工程师经验产品化，减少 Agent 使用中的上下文遗漏和输出漂移",
      successMetric: "技能调用成功率、PR 返工率、上下文补充次数、任务完成时间",
      inspectFirst: "先看技能粒度、触发条件、与本地技术栈差异、验证步骤和维护成本",
      bestFit: "已引入 AI 编码、希望沉淀团队实践的工程平台或技术负责人",
      badFit: "没有统一代码规范或把技能当一次性提示词集合使用",
      primaryRisk: "外部技能直接照搬会与本地架构、权限和测试要求冲突。",
    },
  };
  return overrides[repo.full_name] ? { ...lens, ...overrides[repo.full_name] } : lens;
}

function sharpenOneLiner(repo, lens, fallbackLine) {
  const base = repo.description || fallbackLine || repo.full_name;
  if (lens.domain.includes("AI Agent")) return `${base}；关键看工具边界、上下文持久化、权限和失败接管是否可治理。`;
  if (lens.domain.includes("数据")) return `${base}；关键看索引/查询机制、数据一致性和嵌入式运行成本。`;
  if (lens.domain.includes("开发者工具")) return `${base}；关键看它能否稳定缩短构建、测试、调试或自动化链路。`;
  if (lens.domain.includes("学习")) return `${base}；关键看内容 schema、评测、翻译和社区审校如何形成长期闭环。`;
  if (lens.domain.includes("API")) return `${base}；关键看目录治理、可用性校验和来源合规，而不是条目数量。`;
  return `${base}；关键看 ${lens.coreMechanism} 是否能被小范围验证。`;
}

function describeTeamFit(lens, repo) {
  if (lens.domain.includes("学习")) return "开发者教育、内部工程学院、技术社区和需要长期维护课程/认证的团队。";
  if (lens.domain.includes("API")) return "做内容聚合、资源目录、原型调研或外部能力扫描的团队。";
  if (lens.domain.includes("开发者工具")) return "有明确构建、测试、浏览器自动化、编译或交付瓶颈的工程平台团队。";
  if (lens.domain.includes("云原生")) return "有平台 owner、可观测性体系和非核心环境试点窗口的基础设施团队。";
  if (lens.domain.includes("数据")) return "需要本地向量检索、低延迟查询、RAG 记忆或嵌入式索引的 AI/数据平台团队。";
  if (lens.domain.includes("机器学习")) return "有离线评测、算力预算和模型服务经验的语音/多模态/推荐实验团队。";
  if (lens.domain.includes("AI Agent")) return "已有标准化人工流程、权限边界和审计需求的 Agent/自动化平台团队。";
  return `${repo.language || "多技术栈"} 团队中已有明确痛点、且能安排小样本验证的工程组。`;
}

function describeLandingPath(lens, repo, profile) {
  if (lens.domain.includes("学习")) return "抽一条课程或知识路径，先复刻目录规范、校验脚本和审稿流程，再接入学习记录。";
  if (lens.domain.includes("API")) return "抽样 20 个条目做可用性、授权、地域和刷新频率检查，再决定是否进入内部目录。";
  if (repo.full_name === "swc-project/swc") return "先选一个 Babel/TS 编译最慢的包做影子构建，对比构建耗时、source map、插件兼容和回滚成本。";
  if (repo.full_name === "puppeteer/puppeteer") return "先把一个高频浏览器验收或抓取任务迁到无头浏览器流水线，补齐截图、trace、重试和隔离策略。";
  if (repo.full_name === "cypress-io/cypress") return "先挑一条核心前端回归路径做稳定性基线，度量 flaky 率、调试耗时和 CI 资源。";
  if (repo.full_name === "alibaba/zvec") return "先用离线 embedding 样本构建本地索引，对比 HNSW 召回、内存、P95 查询和更新成本。";
  if (repo.full_name === "OpenBMB/VoxCPM") return "先用内部多语言语音样本做离线 A/B，验证音色一致性、延迟、版权和人工质检成本。";
  if (repo.full_name === "rmyndharis/OpenWA") return "先接入一个低风险通知或客服沙箱，验证登录态、限流、审计和失败重发。";
  return `围绕 ${profile.headings[0] || lens.safeEntry} 做最小 spike，把接入面限定在非核心路径。`;
}

function describeProductionRisk(lens, repo) {
  if (repo.full_name === "meshery/meshery") return "控制面会触达多集群和服务网格，权限、资源漂移和插件质量会放大故障半径。";
  if (repo.full_name === "teslamate-org/teslamate") return "个人/车联网数据涉及隐私和长期留存，部署、备份、API 变更和图表口径都要可恢复。";
  if (repo.full_name === "music-assistant/server") return "家庭/边缘设备依赖多服务和音频协议，网络抖动、账号授权和设备兼容会影响体验。";
  if (repo.full_name === "Universal-Debloater-Alliance/universal-android-debloater-next-generation") return "ADB 去包有误删和设备差异风险，必须保留可回滚清单和机型白名单。";
  if (lens.domain.includes("开发者工具")) return "工具链替换容易引入插件不兼容、调试信息丢失和 CI 差异，需要影子运行。";
  if (lens.domain.includes("AI Agent")) return "Agent/API 网关类项目必须先处理凭据、越权、审计、重试和人工接管。";
  if (lens.domain.includes("数据")) return "索引正确性、更新一致性、内存上限和崩溃恢复不能只靠 benchmark 判断。";
  return lens.primaryRisk;
}

function describeDecisionQuestion(lens, repo) {
  if (repo.full_name === "iptv-org/iptv") return "我们需要的是可审计的公共频道目录，还是会不必要地承担版权、地域和可用性维护责任？";
  if (repo.full_name === "freeCodeCamp/freeCodeCamp") return "我们是否有足够内容 owner 持续维护课程，而不是只复制一个庞大的内容仓库？";
  if (repo.full_name === "alibaba/zvec") return "本地向量库的低延迟收益是否足以覆盖功能、可观测性和生态成熟度差距？";
  if (repo.full_name === "OpenBMB/VoxCPM") return "语音质量提升是否能在目标语言、目标音色和合规授权下稳定复现？";
  return `它解决的是「${lens.userPain}」的主矛盾，还是只会给现有流程增加新的维护面？`;
}

function describeWatchSignal(lens, repo, profile) {
  if (repo.full_name === "swc-project/swc") return "插件兼容矩阵、Next/Vite/TypeScript 生态适配、release breaking change 和构建性能基准。";
  if (repo.full_name === "cypress-io/cypress") return "flaky issue 收敛、浏览器版本支持、CI 云服务边界和组件测试生态更新。";
  if (repo.full_name === "meshery/meshery") return "CNCF 生态集成、适配器健康度、open issues 收敛和真实多集群案例。";
  if (repo.full_name === "alibaba/zvec") return "HNSW 参数、召回/延迟曲线、内存占用、持久化能力和 RAG 框架适配。";
  if (repo.full_name === "OpenBMB/VoxCPM") return "多语言样本质量、克隆相似度、推理成本、许可证和社区失败案例。";
  return `${lens.successMetric}、最近 release 质量、issue 响应速度和 ${profile.installSurface} 的集成反馈。`;
}

function buildPrompt({ repo, readme, languages }) {
  return [
    "你是面向工程团队和技术管理者的开源项目研究员。",
    "请基于仓库元数据和 README 输出严格 JSON，不要使用 Markdown。",
    "字段：oneLiner, whyItMatters, engineeringRead, architectureSignals, valueHypothesis, technicalTakeaways, adoptionRisks, suggestedUseCases, watchSignals, deepDive, diagram, maturity, score。",
    "数组字段：architectureSignals/valueHypothesis/technicalTakeaways/adoptionRisks/suggestedUseCases/watchSignals。",
    "deepDive 是对象，包含 strategicValue、implementationPath、productionConcerns、decisionQuestions、recommendedAction；其中 implementationPath/productionConcerns/decisionQuestions 是数组。",
    "diagram 是对象，包含 title、caption、nodes、links；nodes 为 4 个节点，每个节点包含 label、detail、type；links 为 3 条连接文案。",
    "maturity 是对象，包含 community、maintenance、production、complexity 四个 0-100 分数。",
    "要求：避免空话；从架构、生态、落地成本、生产风险、适合什么团队采用几个角度给出判断；score 为 0-100 整数；每条建议都要能指导工程决策。",
    "",
    `仓库：${repo.full_name}`,
    `描述：${repo.description || ""}`,
    `语言：${JSON.stringify(languages)}`,
    `Stars：${repo.stargazers_count}, Forks：${repo.forks_count}, Issues：${repo.open_issues_count}`,
    `Topics：${(repo.topics || []).join(", ")}`,
    `最近推送：${repo.pushed_at}`,
    "",
    "README：",
    trimText(readme || "", 11000),
  ].join("\n");
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function fallbackAnalysis({ repo, readme, languages }) {
  const topLanguages = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
  if (!topLanguages.length && repo.language) topLanguages.push(repo.language);
  const topics = repo.topics || [];
  const profile = extractRepoProfile({ repo, readme, languages });
  const pushedDays = daysBetween(new Date(repo.pushed_at), new Date());
  const freshness = pushedDays <= 3 ? "维护非常活跃" : pushedDays <= 14 ? "近期仍在活跃迭代" : "需要确认近期维护强度";
  const issuePressure =
    repo.open_issues_count > 500
      ? "Issue 压力偏高，说明需求旺盛但也可能意味着维护负担重"
      : repo.open_issues_count > 120
        ? "Issue 数量中高，需要观察维护响应速度"
        : "Issue 压力相对可控";
  const lens = inferProjectLens({ repo, readme, languages });
  const activity = buildActivityProfile({ repo, pushedDays, issuePressure, freshness });

  return {
    method: "deterministic",
    category: lens.domain,
    oneLiner: buildOneLiner({ repo, lens, profile }),
    whyItMatters: buildWhyItMatters({ repo, lens, profile, activity }),
    engineeringRead: buildEngineeringRead({ repo, lens, profile, topLanguages, topics, activity }),
    architectureSignals: uniqueList([
      `${lens.domain}：${lens.marketRole}`,
      topLanguages.length ? `代码形态：${topLanguages.join(" / ")}，${lens.codeReadingAngle}` : `代码形态不明显，优先看目录结构和 ${lens.codeReadingAngle}`,
      profile.headings.length ? `README 目录信号：${profile.headings.slice(0, 3).join(" / ")}` : profile.uniqueSignal,
      topics.length ? `生态标签：${topics.slice(0, 5).join(", ")}` : "",
    ]),
    valueHypothesis: uniqueList([
      lens.valueFrame,
      `${lens.bestFit} 时，它的收益最容易被验证；${lens.badFit} 时，容易只留下维护成本。`,
      `用 ${lens.successMetric} 做验证指标，比单看 stars 更靠谱。`,
    ]),
    technicalTakeaways: uniqueList([
      profile.uniqueSignal,
      activity.communityRead,
      `${lens.inspectFirst}，再决定是否值得做 spike。`,
    ]),
    adoptionRisks: uniqueList([
      activity.issueRead,
      lens.primaryRisk,
      repo.license?.spdx_id ? `License 是 ${repo.license.spdx_id}，仍需确认二次分发和商用边界。` : "缺少明确 license，进入企业场景前要先过合规检查。",
    ]),
    suggestedUseCases: buildSuggestedUseCases({ repo, lens, profile }),
    watchSignals: buildWatchSignals({ lens, activity, profile }),
    deepDive: buildDeepDive({ repo, lens, profile, activity }),
    diagram: buildProjectDiagram({ repo, lens, topLanguages, topics }),
    maturity: buildMaturity({ repo, lens }),
    score: scoreRepo(repo),
  };
}

function mergeAnalysis(fallback, parsed, method) {
  const merged = {
    ...fallback,
    ...(parsed || {}),
    method,
  };
  merged.deepDive = {
    ...fallback.deepDive,
    ...(parsed?.deepDive || {}),
  };
  merged.diagram = normalizeDiagram(parsed?.diagram, fallback.diagram);
  merged.maturity = {
    ...fallback.maturity,
    ...(parsed?.maturity || {}),
  };
  for (const key of ["community", "maintenance", "production", "complexity"]) {
    merged.maturity[key] = clampScore(merged.maturity[key]);
  }
  merged.score = clampScore(merged.score);
  return merged;
}

function extractRepoProfile({ repo, readme, languages }) {
  const clean = cleanMarkdown(readme || repo.description || "");
  const headings = [...String(readme || "").matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map((match) => cleanMarkdown(match[1]))
    .filter(Boolean)
    .filter((heading) => heading.length <= 60)
    .slice(0, 6);
  const sentences = clean
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 24 && item.length <= 220);
  const firstSentence = sentences[0] || repo.description || "";
  const topics = repo.topics || [];
  const languageShare = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name]) => name);
  const installSurface = inferInstallSurface(`${readme || ""} ${repo.description || ""}`);
  const uniqueSignal = firstSentence
    ? trimText(firstSentence, 220)
    : topics.length
      ? `仓库主要围绕 ${topics.slice(0, 4).join("、")} 展开。`
      : "README 给出的定位信号较少，需要先读目录和示例补足上下文。";
  return {
    clean,
    headings,
    firstSentence,
    installSurface,
    uniqueSignal,
    languageShare,
  };
}

function inferInstallSurface(text) {
  const lower = text.toLowerCase();
  if (lower.includes("docker")) return "容器化部署";
  if (lower.includes("npm install") || lower.includes("pnpm") || lower.includes("yarn")) return "Node 包/前端工程";
  if (lower.includes("pip install") || lower.includes("uv ")) return "Python 包/脚本";
  if (lower.includes("cargo")) return "Rust CLI/库";
  if (lower.includes("brew install")) return "本机 CLI 工具";
  if (lower.includes("api") || lower.includes("sdk")) return "API/SDK 接入";
  return "阅读型或源码集成";
}

function buildActivityProfile({ repo, pushedDays, issuePressure, freshness }) {
  const forkRatio = Math.max(1, Math.round(repo.stargazers_count / Math.max(repo.forks_count, 1)));
  const stage =
    repo.stargazers_count >= 100000
      ? "超级公共资产"
      : repo.stargazers_count >= 30000
        ? "成熟热门项目"
        : repo.stargazers_count >= 8000
          ? "快速扩散项目"
          : "早期观察项目";
  const communityRead =
    forkRatio <= 8
      ? `stars/forks 比约 ${forkRatio}，说明不只是围观，已经有较多二次整理、镜像或改造需求。`
      : forkRatio <= 18
        ? `stars/forks 比约 ${forkRatio}，关注度高于深度改造，适合先看 issue 和使用案例。`
        : `stars/forks 比约 ${forkRatio}，热度可能偏“收藏型”，要警惕真实采用深度不足。`;
  const issueRead =
    repo.open_issues_count > 500
      ? `${issuePressure}；对企业采用来说，这通常意味着需求面广，但维护响应要单独抽样检查。`
      : repo.open_issues_count > 120
        ? `${issuePressure}；建议抽查最近 20 个 issue，看维护者是否在做收敛。`
        : `${issuePressure}；如果 release 节奏稳定，试点阻力会小很多。`;
  return { forkRatio, stage, freshness, issueRead, communityRead };
}

function inferProjectLens({ repo, readme, languages }) {
  const topicText = (repo.topics || []).join(" ").toLowerCase();
  const text = `${repo.full_name} ${repo.description || ""} ${topicText} ${cleanMarkdown(readme || "").slice(0, 3600)} ${Object.keys(languages).join(" ")}`.toLowerCase();
  const lenses = [
    {
      domain: "学习平台 / 内容社区",
      keys: [
        ...weighted(["freecodecamp", "free-programming-books", "developer-roadmap", "roadmap", "curriculum"], 9),
        ...weighted(["education", "learn", "course", "certification", "book", "books", "tutorial", "resource", "learning resources"], 4),
      ],
      marketRole: "把知识生产、学习路径和社区协作沉淀成可维护资产",
      userPain: "团队培训、知识库沉淀或学习路径设计",
      coreMechanism: "内容结构、贡献流程、质量校验和社区运营",
      safeEntry: "内部培训材料、学习路径或知识库导航",
      businessValue: "知识复用、人才培养速度和文档质量",
      primaryRisk: "内容规模越大，版本同步、质量审校和本地化成本越高。",
      codeReadingAngle: "内容组织、校验脚本、贡献规范",
      inspectFirst: "先看目录规范、贡献流程和自动化校验，而不是只看代码语言",
      valueFrame: "它更适合作为“内容系统怎么规模化”的样本，而不是当作普通依赖库引入。",
      bestFit: "需要设计学习体系、知识库或社区贡献机制",
      badFit: "只想找一段现成代码或快速复制项目结构",
      successMetric: "内容更新频率、贡献者响应、目录可维护性",
    },
    {
      domain: "API / 资源目录",
      keys: [
        ...weighted(["public-apis", "awesome-python", "awesome"], 9),
        ...weighted(["api", "apis", "list", "directory", "collection", "catalog", "curated"], 5),
      ],
      marketRole: "把外部能力做成可发现、可筛选的资源地图",
      userPain: "原型阶段找数据源、第三方能力或集成灵感",
      coreMechanism: "分类、索引、准入规则和社区维护",
      safeEntry: "原型验证、竞品调研或外部能力扫描",
      businessValue: "缩短调研时间、拓宽方案池和降低试错成本",
      primaryRisk: "资源目录的核心风险是时效性：API 下线、限流、计费变化会让条目迅速过期。",
      codeReadingAngle: "目录结构、条目准入规则、自动校验脚本",
      inspectFirst: "先抽样验证条目可用性、认证方式和更新机制",
      valueFrame: "价值不在代码复杂度，而在它能不能成为稳定的外部能力索引。",
      bestFit: "需要快速拼原型、做数据源扫描或补齐方案备选",
      badFit: "希望直接拿来支撑生产链路",
      successMetric: "条目可用率、分类准确度、最近更新比例",
    },
    {
      domain: "AI Agent / LLM 工程",
      keys: weighted(["agent", "agents", "llm", "rag", "prompt", "mcp", "model", "openai", "anthropic", "inference", "assistant", "ai"], 4),
      marketRole: "把模型能力包装成可接入工作流的执行单元",
      userPain: "AI 应用编排、工具接入或模型调用复杂度",
      coreMechanism: "模型接口、工具协议、上下文管理或推理工作流",
      safeEntry: "内部效率工具或旁路助手",
      businessValue: "研发效率、自动化覆盖率和人工操作节省",
      primaryRisk: "模型成本、幻觉、权限边界和可观测性必须前置设计。",
      codeReadingAngle: "工具边界、权限模型、状态管理、失败重试",
      inspectFirst: "先看工具调用边界、上下文注入方式和日志可观测性",
      valueFrame: "如果它把 Agent 从 demo 推向可治理工作流，就值得进入重点观察。",
      bestFit: "已有明确人工流程、且失败可回滚",
      badFit: "流程本身还没有标准化，或权限边界不清楚",
      successMetric: "任务完成率、人工接管率、单次任务成本",
    },
    {
      domain: "开发者工具 / 工程效率",
      keys: weighted(["cli", "developer", "devtool", "framework", "build", "lint", "test", "package", "sdk", "compiler"], 4),
      marketRole: "压缩工程流程中的等待、配置和重复操作",
      userPain: "构建、调试、交付或依赖管理的效率瓶颈",
      coreMechanism: "命令行、插件系统、构建管线或 SDK 抽象",
      safeEntry: "个人或小团队工作流",
      businessValue: "交付周期、故障恢复速度和工程一致性",
      primaryRisk: "与现有工具链冲突、迁移成本和团队学习曲线会决定真实收益。",
      codeReadingAngle: "命令入口、配置解析、插件点、缓存策略",
      inspectFirst: "先跑最小命令，再看配置文件、缓存目录和失败信息是否可理解",
      valueFrame: "它的价值应体现在少配、快跑、好回滚，而不是多一个工具名。",
      bestFit: "团队已有重复手工流程或低效构建链路",
      badFit: "现有流程稳定且迁移会打断多人协作",
      successMetric: "冷启动耗时、构建耗时、配置行数、回滚成本",
    },
    {
      domain: "数据基础设施 / 数据库",
      keys: weighted(["database", "sql", "vector", "storage", "cache", "postgres", "analytics", "warehouse", "stream"], 4),
      marketRole: "处理数据读写、查询、索引或分析链路中的结构性成本",
      userPain: "数据存取、检索、分析或状态管理复杂度",
      coreMechanism: "存储引擎、查询层、索引结构或数据管道",
      safeEntry: "离线分析、影子流量或只读链路",
      businessValue: "查询性能、数据可靠性和运维成本",
      primaryRisk: "数据一致性、备份恢复、容量规划和线上延迟不能靠 README 承诺判断。",
      codeReadingAngle: "数据模型、索引策略、故障恢复、迁移路径",
      inspectFirst: "先读数据模型和故障恢复说明，再做只读链路压测",
      valueFrame: "只有能降低数据链路的复杂度或成本，才值得进入生产评估。",
      bestFit: "瓶颈清楚、数据可回放、可做影子验证",
      badFit: "主链路强一致要求高但缺少恢复演练",
      successMetric: "P95 延迟、恢复时间、数据正确率、运维负担",
    },
    {
      domain: "前端 / 产品体验",
      keys: weighted(["react", "vue", "ui", "css", "component", "design", "frontend", "web", "app"], 3),
      marketRole: "把交互、组件和产品交付速度连接起来",
      userPain: "产品界面交付、组件复用或交互体验一致性",
      coreMechanism: "组件体系、渲染框架、状态管理或设计规范",
      safeEntry: "新页面、内部工具或低风险模块",
      businessValue: "迭代速度、体验一致性和前端维护成本",
      primaryRisk: "生态锁定、包体积、可访问性和移动端适配要提前评估。",
      codeReadingAngle: "组件边界、状态流、样式隔离、可访问性",
      inspectFirst: "先看组件 API、样式约束和移动端行为",
      valueFrame: "它应帮助团队更稳定地交付体验，而不是只换一套视觉外壳。",
      bestFit: "新页面、内部工具或组件治理有明确需求",
      badFit: "产品形态还没稳定，或已有设计系统冲突明显",
      successMetric: "复用率、包体积、交互一致性、缺陷回归数",
    },
    {
      domain: "云原生 / 基础设施",
      keys: weighted(["kubernetes", "docker", "infra", "cloud", "server", "proxy", "observability", "monitor", "deploy"], 4),
      marketRole: "把部署、运行和观测问题平台化",
      userPain: "部署、弹性、监控或平台化运维复杂度",
      coreMechanism: "控制面、运行时、网络代理或可观测性采集",
      safeEntry: "测试环境、旁路监控或非核心服务",
      businessValue: "系统稳定性、资源利用率和运维效率",
      primaryRisk: "运维复杂度、故障半径、权限模型和升级路径会放大试点风险。",
      codeReadingAngle: "控制面、配置模型、权限隔离、观测出口",
      inspectFirst: "先看安装/卸载路径、权限需求和故障时的降级方式",
      valueFrame: "基础设施项目的价值在稳定性和可治理性，不在功能清单长度。",
      bestFit: "非核心服务或测试环境能先承接试点",
      badFit: "缺少平台运维 owner 或没有回滚窗口",
      successMetric: "部署耗时、故障恢复、资源利用率、告警质量",
    },
    {
      domain: "机器学习 / 数据科学",
      keys: weighted(["machine learning", "ml", "training", "pytorch", "tensorflow", "embedding", "benchmark", "model"], 4),
      marketRole: "降低实验、训练、评测或模型封装的摩擦",
      userPain: "模型训练、评测、数据处理或实验复现成本",
      coreMechanism: "训练管线、数据集处理、评测基线或模型封装",
      safeEntry: "离线实验、评测平台或研究原型",
      businessValue: "模型迭代效率、效果提升和实验可信度",
      primaryRisk: "数据偏差、评测失真、算力成本和线上迁移难度需要单独验证。",
      codeReadingAngle: "数据处理、评测基线、训练参数、复现实验",
      inspectFirst: "先复现实验或最小 benchmark，再谈集成",
      valueFrame: "它是否值得跟进，取决于能不能缩短实验闭环或提高评测可信度。",
      bestFit: "离线评测或可控数据集上的对比实验",
      badFit: "没有可复现基线，或者线上迁移路径不明确",
      successMetric: "复现实验成本、指标提升、训练/推理成本",
    },
  ];
  const matched =
    lenses
      .map((lens) => ({
        ...lens,
        score: lens.keys.reduce((sum, key) => sum + (keywordHit(text, key.term) ? key.weight : 0), 0),
      }))
      .sort((a, b) => b.score - a.score)[0] || fallbackLens();
  if (!matched.score) return fallbackLens();
  const stage =
    repo.stargazers_count >= 100000
      ? "生态标杆"
      : repo.stargazers_count >= 30000
        ? "成熟扩散"
        : repo.stargazers_count >= 8000
          ? "快速破圈"
          : "观察期";
  return { ...matched, stage };
}

function weighted(terms, weight) {
  return terms.map((term) => ({ term, weight }));
}

function keywordHit(text, term) {
  const escaped = escapeRegExp(term.toLowerCase());
  if (term.length <= 3 || term.includes("-")) {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
  }
  return text.includes(term.toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueList(items) {
  const seen = new Set();
  return items
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.replace(/\d+/g, "#").slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function compact(value = 0) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function fallbackLens() {
  return {
    domain: "通用开源工程",
    marketRole: "补齐某类工程能力或协作方式",
    userPain: "现有流程中的重复劳动或能力缺口",
    coreMechanism: "模块化封装、自动化流程或生态集成",
    safeEntry: "非核心路径验证",
    businessValue: "效率、稳定性或能力补齐",
    primaryRisk: "维护强度、适配成本和真实场景收益要先验证。",
    codeReadingAngle: "入口示例、模块边界、错误处理",
    inspectFirst: "先看 examples、issues 和 release notes 判断生产成熟度",
    valueFrame: "它需要回答一个朴素问题：是否让现有系统更简单，而不是更热闹。",
    bestFit: "已有明确痛点且能小范围试点",
    badFit: "只是因为热门而缺少真实场景",
    successMetric: "接入成本、稳定性、维护成本",
    stage: "观察期",
  };
}

function buildOneLiner({ repo, lens, profile }) {
  const description = repo.description || profile.firstSentence || "";
  if (!description) return `${repo.full_name} 是一个偏 ${lens.domain} 的开源项目。`;
  if (lens.domain.includes("API")) return `${description} 重点不是“代码库”，而是一个可复用的外部能力索引。`;
  if (lens.domain.includes("学习")) return `${description} 更像一套内容生产和社区协作系统。`;
  if (lens.domain.includes("AI")) return `${description} 需要从 Agent 可治理性和工具边界去读。`;
  return description;
}

function buildWhyItMatters({ repo, lens, profile, activity }) {
  const popularity = `${compact(repo.stargazers_count)} stars / ${compact(repo.forks_count)} forks`;
  const readmeHook = profile.headings.length ? `README 把重点放在「${profile.headings[0]}」` : profile.uniqueSignal;
  if (lens.domain.includes("学习") || lens.domain.includes("API")) {
    return `${repo.full_name} 的热度来自“可持续维护的公共资料面”：${popularity}，${activity.freshness}。${readmeHook}，说明它的价值更多在分类、治理和更新节奏，而不是某个单点技术实现。`;
  }
  if (lens.domain.includes("AI")) {
    return `${repo.full_name} 值得看，是因为 AI 项目真正的分水岭已经从“能跑 demo”转向“能被治理、能接工具、能失败恢复”。当前 ${popularity}，${activity.freshness}，足够进入 Agent 工程雷达。`;
  }
  return `${repo.full_name} 处在 ${activity.stage} 区间：${popularity}，${activity.freshness}。${readmeHook}，适合判断它是否能在 ${lens.userPain} 上形成真实工程收益。`;
}

function buildEngineeringRead({ repo, lens, profile, topLanguages, topics, activity }) {
  const lang = topLanguages.length ? topLanguages.join(" / ") : repo.language || "未知技术栈";
  const topicText = topics.length ? topics.slice(0, 5).join("、") : "未显式标注主题";
  return `${lang} · ${profile.installSurface} · ${topicText}。阅读顺序建议变成：${lens.inspectFirst}；再用 ${lens.successMetric} 去量化，而不是只看 README 截图和 star 数。${activity.communityRead}`;
}

function buildSuggestedUseCases({ repo, lens, profile }) {
  const shortName = repo.name || repo.full_name;
  if (lens.domain.includes("学习")) {
    return [
      `把 ${shortName} 当作内容体系样本，先拆目录层级和贡献规范。`,
      `抽样 ${profile.headings[0] || "核心栏目"} 下的 3 个条目，看它如何处理版本、语言和重复内容。`,
      `记录 ${shortName} 的自动化校验、翻译规范和贡献回收机制，这些才决定内容能否长期不烂。`,
    ];
  }
  if (lens.domain.includes("API")) {
    return [
      `用 ${shortName} 做外部能力扫描，先筛认证方式、免费额度和最近更新。`,
      `从 ${profile.headings[0] || "主目录"} 里选 5 个条目做可用性抽检，记录失败原因和替代源。`,
      `把 ${shortName} 的分类法映射到自己的产品原型需求，而不是直接依赖条目长期可用。`,
    ];
  }
  return [
    `先把 ${shortName} 放进 ${lens.safeEntry}，做一个可回滚 spike。`,
    `围绕 ${shortName} 的 ${lens.successMetric} 定义 1-2 个验收指标。`,
    `把 ${shortName} 的 ${lens.primaryRisk.replace(/[。.]$/, "")} 写进试点风险清单。`,
  ];
}

function buildWatchSignals({ lens, activity, profile }) {
  return uniqueList([
    activity.issueRead,
    profile.headings.length ? `README 是否继续扩展「${profile.headings[0]}」相关能力。` : "",
    `是否出现围绕 ${lens.domain} 的真实案例、适配器、基准测试或反面反馈。`,
  ]);
}

function buildDeepDive({ repo, lens, profile, activity }) {
  return {
    strategicValue: `${lens.valueFrame} 对 ${repo.full_name} 来说，真正需要判断的是：它能否把「${lens.userPain}」变成可复用流程，而不是把一次性热度转化成长期维护负担。`,
    implementationPath: [
      `先读 ${profile.headings.slice(0, 2).join(" / ") || "README 定位和 examples"}，找出它承诺解决的主场景。`,
      `用 ${lens.safeEntry} 做最小验证，不要一开始改造主链路。`,
      `把结果写成 ${lens.successMetric} 的前后对比，再决定观察、试点或放弃。`,
    ],
    productionConcerns: [
      activity.issueRead,
      lens.primaryRisk,
      `${activity.freshness}，但仍要看最近 release 是否包含 breaking change、迁移说明或长期规划。`,
    ],
    decisionQuestions: [
      `它解决的是 ${lens.userPain}，还是只是在制造新的流程？`,
      `${lens.bestFit} 这个条件在你的团队里是否成立？`,
      `如果 ${lens.badFit}，是否应该只收藏观察而不进入试点？`,
    ],
    recommendedAction:
      repo.stargazers_count > 30000 && !lens.domain.includes("API") && !lens.domain.includes("学习")
        ? `进入重点观察池：围绕 ${lens.successMetric} 安排一次小 spike。`
        : `进入资料/趋势观察池：先沉淀可借鉴模式，再决定是否试点。`,
  };
}

function buildProjectDiagram({ repo, lens, topLanguages, topics }) {
  const primaryLang = topLanguages[0] || repo.language || "Code";
  const nodes = [
    {
      label: "场景痛点",
      detail: lens.userPain,
      type: "input",
    },
    {
      label: "核心机制",
      detail: lens.coreMechanism,
      type: "core",
    },
    {
      label: "接入方式",
      detail: `${primaryLang} 生态${topics?.[0] ? `，围绕 ${topics[0]} 扩展` : "，需验证集成面"}`,
      type: "integration",
    },
    {
      label: "产出价值",
      detail: lens.businessValue,
      type: "output",
    },
  ];
  return {
    title: "项目蓝图海报",
    caption: `${lens.domain} · ${lens.stage} · ${primaryLang}`,
    summary: `把「${lens.userPain}」通过「${lens.coreMechanism}」转化为「${lens.businessValue}」。`,
    nodes,
    links: ["识别需求", "封装能力", "进入业务"],
    poster: {
      eyebrow: "Project Blueprint",
      headline: lens.domain,
      subhead: `${repo.full_name} · ${lens.stage} · ${primaryLang}`,
      thesis: `把「${lens.userPain}」通过「${lens.coreMechanism}」转化为「${lens.businessValue}」。`,
      metrics: [
        { label: "Stars", value: compact(repo.stargazers_count), note: "社区关注" },
        { label: "Forks", value: compact(repo.forks_count), note: "二次采用" },
        { label: "Issues", value: compact(repo.open_issues_count), note: "维护压力" },
        { label: "Stack", value: primaryLang, note: "主技术栈" },
      ],
      lanes: nodes.map((node, index) => ({
        ...node,
        step: `0${index + 1}`,
        signal:
          index === 0
            ? lens.bestFit
            : index === 1
              ? lens.codeReadingAngle
              : index === 2
                ? lens.safeEntry
                : lens.successMetric,
      })),
      adoption: [
        { label: "试点入口", detail: lens.safeEntry },
        { label: "验收指标", detail: lens.successMetric },
        { label: "阅读顺序", detail: lens.inspectFirst },
        { label: "主要风险", detail: lens.primaryRisk },
      ],
      warning: `不适合场景：${lens.badFit}`,
    },
  };
}

function normalizeDiagram(input, fallback) {
  const diagram = input && typeof input === "object" ? input : fallback;
  const nodes = Array.isArray(diagram.nodes) ? diagram.nodes.slice(0, 4) : fallback.nodes;
  const links = Array.isArray(diagram.links) ? diagram.links.slice(0, 3) : fallback.links;
  return {
    title: diagram.title || fallback.title,
    caption: diagram.caption || fallback.caption,
    summary: diagram.summary || fallback.summary || "",
    nodes: nodes.length === 4 ? nodes : fallback.nodes,
    links: links.length === 3 ? links : fallback.links,
    poster: normalizePoster(diagram.poster, fallback.poster),
  };
}

function normalizePoster(input, fallback = {}) {
  const poster = input && typeof input === "object" ? input : fallback;
  return {
    eyebrow: poster.eyebrow || fallback.eyebrow || "Project Blueprint",
    headline: poster.headline || fallback.headline || "",
    subhead: poster.subhead || fallback.subhead || "",
    thesis: poster.thesis || fallback.thesis || "",
    metrics: Array.isArray(poster.metrics) ? poster.metrics.slice(0, 4) : fallback.metrics || [],
    lanes: Array.isArray(poster.lanes) ? poster.lanes.slice(0, 4) : fallback.lanes || [],
    adoption: Array.isArray(poster.adoption) ? poster.adoption.slice(0, 4) : fallback.adoption || [],
    warning: poster.warning || fallback.warning || "",
  };
}

function buildMaturity({ repo, lens }) {
  const community = Math.min(100, Math.round(Math.log10(Math.max(repo.stargazers_count, 1)) * 22));
  const maintenance = Math.max(30, Math.min(100, 100 - daysBetween(new Date(repo.pushed_at), new Date()) * 3));
  const production = Math.max(
    28,
    Math.min(95, Math.round(community * 0.42 + maintenance * 0.38 + (repo.license ? 16 : 4) - (repo.open_issues_count > 500 ? 10 : 0))),
  );
  const complexityBase = lens.domain.includes("基础设施") || lens.domain.includes("数据库") ? 72 : 55;
  const complexity = Math.max(25, Math.min(95, complexityBase + (repo.open_issues_count > 300 ? 12 : 0)));
  return { community, maintenance, production, complexity };
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function buildFrontierSection(maxItems) {
  const arxivPromise = fetchArxivFrontierItems(maxItems);
  const industryPromise = fetchIndustryFrontierItems(maxItems * 2);
  const [arxivResult, industryResult] = await Promise.allSettled([arxivPromise, industryPromise]);

  const arxivItems = arxivResult.status === "fulfilled" ? arxivResult.value : [];
  const industryItems = industryResult.status === "fulfilled" ? industryResult.value : [];
  const industryTarget = Math.min(maxItems, Math.max(16, Math.ceil(maxItems * 0.85)));
  const selected = ensureFrontierPriorityCoverage(pickUniqueItems(
    [
      ...industryItems.slice(0, industryTarget),
      ...arxivItems.slice(0, Math.max(0, maxItems - industryTarget)),
      ...industryItems,
      ...arxivItems,
    ],
    maxItems,
  ), industryItems, maxItems).map((item, index) => {
    const interpretation = normalizeFrontierInterpretation(item);
    return {
      ...item,
      interpretation,
      diagram: buildFrontierDiagram(item, interpretation),
      rank: index + 1,
    };
  });

  const sourceNotes = [];
  if (industryItems.length) sourceNotes.push("Big Tech Engineering/RSS");
  if (arxivItems.length) sourceNotes.push("arXiv API");
  if (arxivResult.status === "rejected") sourceNotes.push(`arXiv fallback: ${String(arxivResult.reason?.message || arxivResult.reason).slice(0, 80)}`);
  if (industryResult.status === "rejected") sourceNotes.push(`industry fallback: ${String(industryResult.reason?.message || industryResult.reason).slice(0, 80)}`);

  return {
    title: "搜广推技术前沿",
    subtitle: "混合跟踪搜索、广告、推荐、排序、召回相关的新论文和大厂工程实践。",
    source: sourceNotes.length ? sourceNotes.join(" + ") : "fallback",
    items: selected.length ? selected : fallbackFrontierItems(),
  };
}

function ensureFrontierPriorityCoverage(selected, industryItems, maxItems) {
  const prioritySources = ["Meituan Tech", "Tencent Cloud Developer", "Alibaba Cloud Developer", "Salesforce Engineering"];
  const covered = new Set(selected.map((item) => item.source).filter(Boolean));
  const next = [...selected];
  for (const source of prioritySources) {
    if (covered.has(source)) continue;
    const candidate = industryItems.find((item) => item.source === source && !next.some((selectedItem) => normalizeTitle(selectedItem.title) === normalizeTitle(item.title)));
    if (!candidate) continue;
    if (next.length < maxItems) {
      next.push(candidate);
    } else {
      const replaceIndex = findFrontierCoverageReplacementIndex(next, prioritySources);
      if (replaceIndex === -1) continue;
      covered.delete(next[replaceIndex].source);
      next[replaceIndex] = candidate;
    }
    covered.add(source);
  }
  return next.slice(0, maxItems);
}

function findFrontierCoverageReplacementIndex(items, prioritySources) {
  const priority = new Set(prioritySources);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].sourceType === "paper") return index;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!priority.has(items[index].source)) return index;
  }
  return -1;
}

function normalizeFrontierInterpretation(item) {
  if (item.interpretation && typeof item.interpretation === "object" && item.interpretation.businessProblem) {
    return item.interpretation;
  }
  const curated = curatedFrontierInterpretation(item);
  if (curated) return curated;
  const text = `${item.title || ""} ${item.summary || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
  const isAds = /\bads?\b|advertis|auction|bidding|\bctr\b|\bcvr\b|conversion|\bcpa\b|\bcpm\b|广告|竞价|出价|转化/.test(text);
  const isSearch = /search|retrieval|query|index|relevance|rag|搜索|检索|查询|索引/.test(text);
  const isRec = /recommend|recsys|ranking|personalization|feed|candidate|推荐|排序|召回|粗排|精排|重排|个性化|信息流/.test(text);
  const isExperiment = /experiment|a\/b|lifecycle graph|model lifecycle|实验平台|模型生命周期/.test(text);
  const isLabeling = /label|judge|dspy|human/.test(text);
  if (isAds) {
    return {
      businessProblem: "广告候选、排序和竞价需要同时控制转化价值、用户体验、延迟与算力成本，单点模型提升很难直接证明业务收益。",
      systemMechanism: "把用户行为序列、实时上下文、候选生成、轻量排序、精排/重排和预算约束拆成可观测阶段，并在高价值候选上投入更重模型。",
      metricsAndExperiment: "优先看 CTR、CVR、CPA/ROAS、广告质量、P95 延迟、推理成本和预算消耗；在线实验要同时观察广告主价值与用户负反馈。",
      borrowable: "可借鉴分阶段候选裁剪、实时特征注入、模型容量自适应和在线/离线差异诊断，把算力预算变成排序策略的一部分。",
      boundary: "流量小、转化回传慢、成本归因不清或缺少在线实验平台时，不适合直接复制大厂多阶段广告架构。",
    };
  }
  if (isRec) {
    return {
      businessProblem: "推荐系统需要在巨大候选池里兼顾兴趣匹配、新鲜度、多样性和商业目标，传统召回/排序割裂会造成离线提升难以上线转化。",
      systemMechanism: "把候选生成、向量/索引、用户序列、ranker 表征和反馈学习联合设计，让召回质量与后续排序目标保持一致。",
      metricsAndExperiment: "关注 recall@K、覆盖率、多样性、CTR/CVR、停留/满意度、延迟和索引刷新时延；实验要看离线召回是否转化为在线核心指标。",
      borrowable: "可借鉴模型化索引、可编辑生成式召回、多目标排序和实时行为特征，将推荐漏斗从组件拼接改为端到端协同。",
      boundary: "物料规模不大、业务目标单一或团队没有检索/排序联合 owner 时，复杂联合建模会增加维护成本。",
    };
  }
  if (isSearch || isLabeling) {
    return {
      businessProblem: "企业搜索和社区搜索的长尾查询、权限边界、语义漂移和标注稀缺会拉低相关性，人工标注又难以覆盖全部候选。",
      systemMechanism: "通过混合检索、模型化相关性评估、LLM 辅助标注或自动化 judge，把查询理解、召回、排序和质量评估串成闭环。",
      metricsAndExperiment: "重点看 NDCG/MRR、answer match、人工一致性、长尾覆盖、权限误召、P95 延迟和标注成本；线上需要观察搜索成功率与二次查询率。",
      borrowable: "适合迁移到企业知识库、RAG、客服搜索和社区内容搜索：先建立可靠评测集，再让 LLM 扩大标注覆盖。",
      boundary: "如果文档权限复杂但审计不足，或 LLM judge 没有金标校准，自动评估会把错误相关性放大到生产排序。",
    };
  }
  if (isExperiment) {
    return {
      businessProblem: "搜广推团队的模型、特征、训练、部署和实验资产关系复杂，单次实验成功后也容易在依赖、回滚和复用上失控。",
      systemMechanism: "用模型生命周期图或实验资产图谱记录数据、特征、模型、评测、服务和消费方关系，把影响面分析从人工经验转成系统能力。",
      metricsAndExperiment: "关注实验复用率、依赖定位时间、回滚时间、特征/模型血缘完整率、离线到线上指标一致性和事故恢复成本。",
      borrowable: "可借鉴到推荐/广告平台治理：先建轻量 lineage，再把实验报告、模型 registry、特征平台和线上指标串起来。",
      boundary: "团队规模小、模型数量少或没有统一平台 owner 时，完整生命周期图会变成维护负担。",
    };
  }
  return {
    businessProblem: "前沿论文或工程文章触及搜广推链路中的召回、排序、评测或系统效率问题，需要先判断它离真实业务目标有多近。",
    systemMechanism: "从任务定义、数据构造、模型结构、服务约束和评测协议五个层面拆解，避免只被单个 benchmark 指标吸引。",
    metricsAndExperiment: "优先补齐离线指标、线上代理指标、成本、延迟、稳定性和反例分析，再决定是否进入工程 spike。",
    borrowable: "适合沉淀为候选技术卡片：记录输入输出、依赖数据、可替换组件和最小验证路径。",
    boundary: "如果论文数据不可复现、业务指标不匹配或系统约束被简化，暂时只应观察，不应进入主链路。",
  };
}

function curatedFrontierInterpretation(item) {
  const title = normalizeTitle(item.title || "");
  const map = {
    [normalizeTitle("Exploring Hierarchical Interest Representation For Meta Ads Deep Funnel Optimization")]: {
      businessProblem: "深漏斗广告优化的核心矛盾是转化信号稀疏、长尾广告实体冷启动、用户兴趣层级复杂；只靠点击/互动模型会偏向短期可观测行为，难以把真实潜在购买意图与广告主供给匹配起来。",
      systemMechanism: "Meta 把用户、广告主、产品、服务和互动构成大规模关系图，引入 LLM 处理的多模态广告/商品语义，再用 transformer 图学习、偏置感知 attention、自监督跨视图蒸馏和多层级投影，产出可供召回、排序和监督复用的统一兴趣向量与 Bag-of-Meaning interest tokens。",
      metricsAndExperiment: "应关注 deep funnel conversion、稀疏/冷启动实体覆盖、retrieval recall、ranking AUC/校准、广告主 ROI、用户负反馈和模型 serving 成本；官方强调在真实 Meta ads 数据、十亿级互动规模上端到端训练，但线上指标和长期校准仍需持续跟踪。",
      borrowable: "可借鉴的是“上游统一表示层 + 多层级兴趣 token + 多下游复用”的平台思路：先把用户/物品/商家/内容关系图和多模态语义统一，再让召回、粗排、精排共享表示，减少每条链路重复造特征。",
      boundary: "没有足够实体图规模、跨域语义数据、负反馈治理和多目标实验体系的团队，不适合直接追求 universal ads embedding；中小广告系统应先补齐转化回传、特征新鲜度、召回覆盖和校准。",
    },
    [normalizeTitle("Thinking Fast & Slow for a Personalized Notification System")]: {
      businessProblem: "Netflix 个性化通知既要提高短期观看/互动，也要避免过度打扰造成疲劳和退订；如果用一个短期模型同时决定发送频次和消息内容，频控、排序和长期满意度会互相牵制。",
      systemMechanism: "用分层 slow-fast 架构解耦决策：慢策略按周生成用户级跨渠道 pacing plan，快策略在每日发送机会中读取计划特征，再做实时消息选择和相关性排序。",
      metricsAndExperiment: "实验要同时看即时互动、长期观看、opt-out/疲劳风险、频次分布、渠道组合、低活用户提升和策略稳定性；离线要校准消息成本，防止模型退化成“永远多发”。",
      borrowable: "适合推荐、营销触达和 feed push 团队借鉴：把频控/节奏从实时排序里拆出来，用 feature store 传递策略意图，让 pacing 和内容 ranker 独立迭代。",
      boundary: "如果触达量小、负反馈稀疏、缺少跨渠道用户状态或没有长期满意度指标，分层策略会增加复杂度，先做简单频控和反骚扰规则更稳。",
    },
    [normalizeTitle("Modernizing the Meta Ads Service With an Open-Source Kernel Scheduler")]: {
      businessProblem: "Meta 广告 retrieval 和 ranking 链路每天处理数千亿请求，P99 延迟的几毫秒波动会直接减少可检索/可排序广告数，影响用户相关性、广告主 ROI 和机房功耗。",
      systemMechanism: "Meta 在 Linux 6.9 上用 upstream sched_ext / BPF 写 workload-specific scheduler，把通用 CFS/EEVDF 换成理解广告服务线程形态、CPU 争用和 tail latency 的调度策略，并通过 launch-candidate review 与全局回放验证。",
      metricsAndExperiment: "核心指标不是平均延迟，而是 ads retrieval P99、weighted-ads-ranked、CPU 利用率、功耗、错误率、广告相关性和 holdout/backtest 口径；官方披露 P99 降 28%、节省 3.28MW、weighted-ads-ranked 提升 1.1%。",
      borrowable: "大规模广告/推荐 serving 团队可把 kernel scheduler、runtime、模型服务和业务指标放进同一实验面板，先在最大机型或高峰流量上做 shadow/backtest，再逐步扩大。",
      boundary: "没有足够请求规模、内核工程能力、回放体系和业务指标归因时，不应直接定制调度器；中小团队通常先优化特征服务、批处理、缓存、限流和模型路由更有效。",
    },
    [normalizeTitle("Achieving Near-Linear Training Scalability for Pinterest’s Foundation Models")]: {
      businessProblem: "Pinterest 的 Home feed 与 Related Pins ranking 依赖超大行为序列 foundation model；模型越大越能吃下两年用户活动数据，但多节点训练若扩展效率差，会直接把推荐效果提升变成不可承受的 GPU 成本。",
      systemMechanism: "Pinterest 从网络层、EFA、通信重叠、数据管线和训练瓶颈逐层排查，把 2 节点扩展从 1.13x 提到 2.0x、4 节点从 1.21x 提到 3.9x，并扩展到 8 节点 7.5x。",
      metricsAndExperiment: "核心指标不只是训练吞吐，还包括 scaling factor、GPU 利用率、通信等待、样本吞吐、训练成本、模型收敛、线上 engagement gain 和 Home/Related Pins 排名收益。",
      borrowable: "推荐团队做大模型前应先建立训练扩展基线：单机、2 节点、4 节点逐级 profile，只有在吞吐接近线性后再扩大模型和样本窗口。",
      boundary: "如果线上瓶颈仍在特征、样本质量或 serving 延迟，盲目扩大训练集群只会提高成本；基础设施团队和推荐建模团队必须共同 owner。",
    },
    [normalizeTitle("How we used DSPy to turn AI evaluations into better responses in Dash chat")]: {
      businessProblem: "Dropbox Dash 的企业搜索/Agent 体验不再是单条结果相关性，而是多轮意图理解、工具调用、上下文选择、证据使用和完整回答质量；人工调 prompt 难以稳定覆盖长尾失败。",
      systemMechanism: "先用人工标签校准 LLM-as-judge，再用 DSPy/GEPA/MIPROv2 在历史真实 trace 上回放候选 prompt，用生产对齐的 judge 反馈优化 chat agent。",
      metricsAndExperiment: "评估维度包括语义相关性、answer quality、证据使用、tool calling、context selection、完整性、token 成本和统计显著性；Dropbox 报告 incomplete answers 降 26%、missed key aspects 降 13%、token 用量降 5.4%。",
      borrowable: "企业 RAG/搜索可把 eval 先产品化：沉淀 trace、人工金标、failure code、回放系统和发布门禁，再让优化器生成候选改动。",
      boundary: "没有代表性回放集、人工标签和结构化 failure taxonomy 时，自动 prompt 优化会把 judge 偏差放大，甚至优化出更会取悦评测器但更差的 Agent。",
    },
    [normalizeTitle("GenPage: Towards End-to-End Generative Homepage Construction at Netflix")]: {
      businessProblem: "Netflix 首页不只是给一行内容排序，而是要在整个首屏/分页层面同时决定行类型、行内实体、观看意图、多样性和长期满意度；传统“逐行候选 + 局部排序”很难优化页面整体体验。",
      systemMechanism: "把用户历史、画像、请求上下文和结构化 homepage layout token 化为同一序列，由生成式 transformer 直接生成页面结构；再用强化学习后训练把离线行为目标和页面多样性校准到上线策略。",
      metricsAndExperiment: "离线看页面级 engagement 代理指标、行/实体多样性、序列有效性和 cold-start 表现；线上必须同时看播放转化、浏览深度、长期留存、重复曝光和 P95 生成延迟。",
      borrowable: "适合借鉴“页面即序列”的建模方式：先把推荐结果、广告位、运营位统一成可验证 layout token，再用小流量 shadow serving 对比传统漏斗。",
      boundary: "如果业务页面结构简单、样本量不足或运营规则强依赖人工编排，端到端生成会让解释、干预和回滚成本明显上升。",
    },
    [normalizeTitle("AI-Powered Personalization in Under 100ms: Optimizing Real-Time Decisioning at Scale")]: {
      businessProblem: "企业个性化必须在 web、mobile、email 和 Agent 交互里即时决定内容/商品/下一步动作；多服务依赖、实时行为变化、库存/偏好新鲜度和租户流量峰值会同时挤压相关性和延迟预算。",
      systemMechanism: "Salesforce DPRS 并行拉取用户画像、行为数据、ML 输出和推荐排序，配合 per-node cache、global distributed cache、stale-while-revalidate、fallback models、tenant-aware Kubernetes autoscaling 和 canary/staged rollout，把实时 decisioning 做成高可用管线。",
      metricsAndExperiment: "核心看 P95/P99 延迟、sub-100ms 达成率、推荐 engagement、模型计算效率、缓存命中/雪崩、依赖超时、租户隔离、离线评估准确性和 staged rollout 期间的错误/回退。",
      borrowable: "企业推荐、CRM 和客服 Agent 团队可借鉴“实时上下文 + 推荐服务 + 降级模型 + 分阶段发布”的组合；先把关键依赖并行化和缓存治理补齐，再谈更复杂的 contextual bandit 或 Agent decisioning。",
      boundary: "如果业务没有实时反馈闭环、租户隔离和性能门禁，sub-100ms 个性化会变成脆弱的多服务调用链；早期团队应优先做离线评估、低风险客户灰度和人工可解释回退。",
    },
    [normalizeTitle("In-House LLM Serving at Netflix")]: {
      businessProblem: "搜索、推荐、内容理解和客服 Agent 都在引入 LLM，但如果每条业务线各自接入不同 serving 方案，模型打包、限流、输出约束、成本和回滚会迅速碎片化。",
      systemMechanism: "Netflix 将 engine selection、模型包格式、API surface、部署策略、输出约束和运行观测统一到内部 LLM serving 平台，让业务模型能按统一接口接入生产链路。",
      metricsAndExperiment: "应看 TTFT、tokens/s、P95/P99、错误率、输出约束命中、GPU/CPU 利用率、单位请求成本、模型升级回滚时间和业务侧质量指标。",
      borrowable: "推荐/搜索团队可先把 LLM reranker、query understanding、内容摘要和 judge 服务纳入统一 serving 网关，建立限流、降级、缓存和模型版本血缘。",
      boundary: "如果调用规模小、模型类型少或没有平台 owner，自建 serving 可能比托管 API 更重；只有在成本、延迟、数据边界或输出约束成为硬需求时才值得投入。",
    },
    [normalizeTitle("SilverTorch: Index as Model — A New Retrieval Paradigm for Recommendation Systems")]: {
      businessProblem: "UGC 推荐的召回阶段要在毫秒级从海量内容缩到千级候选，传统微服务、ANN 索引和神经模型分散部署会造成准确率、吞吐和运维边界彼此牵制。",
      systemMechanism: "Meta 将检索索引本身模型化，把 candidate generation、embedding 表征、GPU serving 和 ranker 对齐放进统一架构，让检索结果直接服务后续排序目标。",
      metricsAndExperiment: "关注吞吐、单位请求计算成本、recall/precision、候选新鲜度、P95/P99 延迟、GPU 利用率和线上 CTR/停留转化；离线召回提升必须能解释到 ranker 输入质量。",
      borrowable: "中大型推荐团队可先做一条垂直召回路的 index-as-model 旁路，把原 ANN/规则召回与模型化召回做 interleaving 或 shadow 对比。",
      boundary: "内容规模小、GPU serving 能力不足、召回和排序 owner 分裂时，不宜直接复制整套架构；先解决特征/样本/评测对齐。",
    },
    [normalizeTitle("Unlocking dependable responses with Gemini Enterprise Agent Platform's Agentic RAG")]: {
      businessProblem: "企业 RAG 常见失败不是模型不会回答，而是权限文档、跨系统证据和长尾查询没有被充分检索，导致答案看似完整但依据不足。",
      systemMechanism: "Google 的 Agentic RAG 把检索拆成多步 agent 流程，由 sufficient-context 判断是否需要继续检索、改写查询或补充证据，再进入回答生成。",
      metricsAndExperiment: "应同时评估 answer groundedness、证据覆盖率、权限误召、二次检索次数、用户追问率、P95 延迟和每答案检索成本。",
      borrowable: "企业知识库可把“证据是否足够”做成独立 judge，在高风险答案前触发补检索和人工复核，而不是只调大 topK。",
      boundary: "权限模型不清、审计日志不完整或知识库质量差时，多 Agent 检索会放大错误证据和延迟。",
    },
    [normalizeTitle("Meta Adaptive Ranking Model: Bending the Inference Scaling Curve to Serve LLM-Scale Models for Ads")]: {
      businessProblem: "广告排序想引入更大模型理解用户意图和广告价值，但广告请求要求亚秒级返回，且算力成本必须被 ROAS 覆盖。",
      systemMechanism: "Meta 用 request-centric routing、硬件感知模型/系统协同和多卡 serving，让不同请求按价值、上下文和延迟预算选择合适模型复杂度。",
      metricsAndExperiment: "线上核心看 ad conversions、CTR、广告主价值、用户负反馈、P95/P99 延迟、MFU、单位转化推理成本和预算消耗稳定性。",
      borrowable: "广告团队可先把“请求价值分层 + 模型复杂度路由”用于高商业价值流量，低价值请求继续走轻模型，逐步验证边际 ROI。",
      boundary: "若转化回传慢、归因链路弱或缺少请求级成本核算，大模型排序的收益很容易被平均成本吞掉。",
    },
    [normalizeTitle("Reel Friends: Building Social Discovery that Scales to Billions")]: {
      businessProblem: "短视频发现不只靠兴趣相似，还要把好友关系、互动意图和内容消费场景纳入推荐，否则社交分发与纯兴趣分发会互相稀释。",
      systemMechanism: "将社交图谱、Reels 内容理解、互动候选生成和排序融合，在召回阶段引入关系强度与内容相关性，再由排序控制体验质量和规模化分发。",
      metricsAndExperiment: "重点观察好友互动率、分享/评论、观看完成率、重复曝光、冷启动覆盖、关系链噪声和长期社交活跃度。",
      borrowable: "社区/内容产品可把社交召回作为独立候选路，先通过多路召回配额和重排约束验证增量，而不是让社交信号直接替换兴趣模型。",
      boundary: "关系链稀疏、隐私边界严格或内容质量不可控时，社交发现会带来噪声、骚扰和同质化风险。",
    },
    [normalizeTitle("From Clicks to Conversions: Architecting Shopping Conversion Candidate Generation at Pinterest")]: {
      businessProblem: "购物推荐如果只优化点击，会把流量导向好奇心内容而非购买意图；候选生成阶段必须更早感知转化概率和商品可购性。",
      systemMechanism: "Pinterest 将 shopping conversion 目标前移到候选生成，用转化样本、商品上下文、用户购物行为和大规模 serving 约束共同训练候选路。",
      metricsAndExperiment: "除 CTR 外重点看 CVR、GMV/ROAS、add-to-cart、商品覆盖、新商家曝光、候选去重率和召回到精排的转化保真。",
      borrowable: "电商和内容电商可拆出“转化候选路”，与点击候选路并行进入精排，通过配额、校准和重排避免点击目标绑架购买目标。",
      boundary: "转化样本稀疏、商品库存/价格不稳定或归因窗口很长时，转化候选容易过拟合头部商家和短期促销。",
    },
    [normalizeTitle("Modernizing the Facebook Groups Search to Unlock the Power of Community Knowledge")]: {
      businessProblem: "群组搜索面对口语化查询、社区语境、权限可见性和新旧帖子混杂，单纯关键词匹配难以找到真正可用的社区知识。",
      systemMechanism: "把查询理解、语义召回、社区/帖子质量信号和排序重构到同一搜索链路，并在权限过滤后做相关性与新鲜度平衡。",
      metricsAndExperiment: "看搜索成功率、query reformulation、NDCG/MRR、点击后停留、权限误召、举报率和社区长尾覆盖。",
      borrowable: "企业论坛、客服社区和内部知识库可以先建立 query-intent 分层，再为高价值问答引入语义召回与质量重排。",
      boundary: "如果内容审核和权限模型不足，语义搜索会把低质、过期或不可见内容更高效地暴露出来。",
    },
    [normalizeTitle("Enhancing Ad Relevance: Integrating Real-Time Context into Sequential Recommender Models")]: {
      businessProblem: "广告序列模型常能学习长期偏好，但对刚发生的搜索、浏览、保存等实时意图响应慢，错过高转化窗口。",
      systemMechanism: "Pinterest 将实时上下文注入 sequential recommender，让用户近期行为、会话意图和广告候选在排序前被共同编码。",
      metricsAndExperiment: "重点看实时特征新鲜度、CVR/ROAS、CTR、负反馈、feature serving 延迟、特征缺失率和线上离线差异。",
      borrowable: "可先对高意图行为建立实时特征通道，用短 TTL、降级值和特征审计保护排序稳定性。",
      boundary: "实时特征噪声大、会话行为易被操纵或特征平台延迟不稳时，短期意图会伤害长期相关性和广告质量。",
    },
    [normalizeTitle("Building a Natural Language Interface to the Spotify Ads API with Claude Code Plugins")]: {
      businessProblem: "广告主和运营人员理解投放目标，但创建 campaign/ad set/ad 的 API 参数多、约束复杂，人工配置慢且容易出错。",
      systemMechanism: "Spotify 用 Claude Code plugins、OpenAPI schema、skills 和 hooks，把自然语言投放意图翻译成多步 API 调用，同时保留校验和人工确认。",
      metricsAndExperiment: "应看任务完成率、参数错误率、人工修改轮次、创建耗时、预算误配、审计日志完整性和回滚成功率。",
      borrowable: "适合把复杂广告后台先做成“草稿生成 + 参数校验 + 人工提交”的 Agent 工作流，降低操作门槛但不跳过审批。",
      boundary: "不适合让 Agent 直接改生产预算或投放状态；权限、预算上限、可解释 diff 和审批链必须先到位。",
    },
    [normalizeTitle("Our Multi-Agent Architecture for Smarter Advertising")]: {
      businessProblem: "广告平台通常同时服务直销、自助、程序化等渠道，业务规则不同但又共享受众、预算、库存和测量基础设施。",
      systemMechanism: "Spotify 用多 Agent 架构把渠道特定决策、共享后端能力和广告工作流编排分层，让各 Agent 处理目标拆解、查询、生成和校验。",
      metricsAndExperiment: "关注跨渠道任务完成率、人工接管率、预算/库存一致性、策略冲突、调用成本、延迟和错误恢复。",
      borrowable: "广告中台可用 domain agents 包装受众、预算、创意、报表等能力，由统一 orchestrator 做权限和审计。",
      boundary: "渠道规则尚未标准化、数据口径不一致或缺少统一权限模型时，多 Agent 会把组织复杂度转成系统复杂度。",
    },
    [normalizeTitle("Better Experiments with LLM Evals — A funnel, not a fork")]: {
      businessProblem: "推荐、搜索和广告团队越来越多用 LLM judge 评估 relevance、coherence 和生成质量，但如果把 eval 当成 A/B 替代品，会错过真实用户行为和长期业务指标。",
      systemMechanism: "Spotify 把 LLM eval 放在在线实验前：eval 先筛掉明显不符合质量标准的方案，A/B 再验证真实用户响应，并把线上学习反哺 eval 标准。",
      metricsAndExperiment: "核心看 eval/人工一致性、实验命中率、无效实验减少、线上 shipped positive ratio、valid learning ratio、用户行为指标和评估成本；Spotify 披露只有约 12% A/B 测试形成正向发布，64% 仍产生有效学习。",
      borrowable: "可借鉴为“离线 judge -> 小样本人工校准 -> 线上实验”的漏斗，把 LLM eval 用于提高实验质量，而不是绕过实验平台。",
      boundary: "如果没有金标校准、线上实验能力或 failure taxonomy，LLM eval 会强化主观偏好，不能证明真实推荐/搜索/广告收益。",
    },
    [normalizeTitle("Using LLMs to amplify human labeling and improve Dash search relevance")]: {
      businessProblem: "企业搜索 relevance 依赖高质量标注，但长尾查询、私有文档和权限上下文让纯人工标注覆盖慢且成本高。",
      systemMechanism: "Dropbox 用少量人工金标校准 LLM 辅助标注，再把扩展标签用于 Dash 搜索排序模型和 relevance 评测。",
      metricsAndExperiment: "必须看标注一致性、金标校准误差、NDCG/MRR、搜索成功率、权限误判、长尾 query 覆盖和标注单位成本。",
      borrowable: "企业 RAG/搜索团队可把 LLM 标注作为扩容器，不作为真值源；每轮训练都保留人工抽检和 disagreement review。",
      boundary: "如果查询意图高度专业、文档权限复杂或没有金标集，LLM 标注会把偏差系统性写进排序模型。",
    },
    [normalizeTitle("PAI-Rec 多路召回截断实践：用 PriorityAdjustCountFilter 和 SnakeFilter 控制精排入口数量")]: {
      businessProblem: "多路召回能提高覆盖，但进入精排的候选过多会拖垮延迟，过少又会牺牲新内容、运营配额和多样性。",
      systemMechanism: "PAI-Rec 用优先级截断和蛇形混排控制各召回路进入精排的数量，把业务配额、召回质量和精排成本变成可配置策略。",
      metricsAndExperiment: "看各召回路贡献、精排入口规模、P95 延迟、CTR/CVR、覆盖率、多样性、运营位达成率和新内容冷启动表现。",
      borrowable: "中小推荐团队可先把召回结果统一打标签，再用可解释的截断/混排策略替代隐式 if-else，便于实验和回滚。",
      boundary: "如果召回路质量没有可观测归因，截断策略会变成拍脑袋配额，长期压制探索和新路验证。",
    },
    [normalizeTitle("MTGR：美团外卖生成式推荐Scaling Law落地实践")]: {
      businessProblem: "外卖推荐既有高频短周期兴趣，又有商家、时段、配送、价格和转化目标约束；传统 DLRM 特征体系能稳定上线，但难以充分吸收长行为序列和跨场景上下文。",
      systemMechanism: "美团基于 HSTU 构建 MTGR，在保留工业 DLRM 特征体系的同时统一建模多条行为序列，并用生成式推荐的 scaling law 思路扩大序列窗口、模型容量和在线推理效率。",
      metricsAndExperiment: "官方披露离线 CTCVR GAUC +2.88pp、首页订单量 +1.22%、PV_CTR +1.31%、在线推理资源节省 12%；评估还应跟踪供给侧曝光、配送履约、长尾商家和时段异质性。",
      borrowable: "本地生活、电商和内容推荐团队可借鉴“保留成熟特征体系 + 引入生成式序列主干”的渐进路线，先在高频首页/推荐页做旁路对比。",
      boundary: "如果行为序列稀疏、供给约束强依赖规则或线上 serving 成本不可控，生成式推荐会增加调参和解释成本，不应直接替换精排主链路。",
    },
    [normalizeTitle("Academic Publications & Airbnb Tech: 2025 Year in Review")]: {
      businessProblem: "Airbnb 的搜索/推荐是双边 marketplace：客人要找到合适房源，房东要获得公平曝光，预订转化周期长，A/B 测试慢且受季节、地域和库存约束影响大。",
      systemMechanism: "Airbnb 将搜索排序、位置检索、反事实评估、interleaving 和两边市场优化作为一组研究资产沉淀，用学术会议论文反哺生产系统。",
      metricsAndExperiment: "除 CTR/CVR 外，要看预订率、host/guest 供需平衡、地域覆盖、interleaving 与反事实评估对正式 A/B 的预测能力，以及长期信任指标。",
      borrowable: "marketplace 团队可先引入快速 pre-A/B 评估和反事实回放，把慢转化实验的候选缩小后再进入正式线上实验。",
      boundary: "库存稀疏、地域差异极大或历史日志偏差未校正时，反事实评估会高估排序收益；仍需正式 A/B 和业务分层验收。",
    },
    [normalizeTitle("推荐系统为啥都长一个样？聊聊「离线训练 + 在线召回 + 排序」这套大数据架构")]: {
      businessProblem: "很多中小团队想上推荐系统时先追模型名字，却没有先处理海量候选、实时响应和复杂模型三者的基本矛盾。",
      systemMechanism: "文章用离线训练、在线召回、排序和反馈闭环解释经典推荐架构：离线负责全量特征和模型训练，在线召回快速缩小候选，排序/重排在延迟预算内优化业务目标。",
      metricsAndExperiment: "应先建立召回覆盖、排序 CTR/CVR、P95 延迟、特征新鲜度、实验分桶和反馈闭环，而不是只看离线 AUC。",
      borrowable: "适合作为团队共识材料：先把多路召回、粗排、精排、重排和实验平台的接口画清楚，再决定是否引入大模型或向量检索。",
      boundary: "文章是架构校准而非具体大厂落地方案；对成熟平台来说价值在于查漏补缺，不足以替代真实流量实验。",
    },
    [normalizeTitle("Design and evaluation of whole-page experience optimization for e-commerce search")]: {
      businessProblem: "电商搜索不能只排商品列表，还要决定整页模块、筛选、推荐小组件和广告/自然结果的整体组合；单模块最优可能伤害页面级购买体验。",
      systemMechanism: "Amazon Science 将整页体验作为优化对象，在搜索请求层面评估页面元素组合、用户行为和业务目标，让 ranking 从 item-level 扩展到 page-level decisioning。",
      metricsAndExperiment: "关注页面级转化、GMV、query reformulation、筛选使用率、模块交互、广告/自然结果平衡、长期满意度和实验异质性，而不是只看单商品 NDCG 或 CTR。",
      borrowable: "Marketplace 搜索团队可先把页面模块、候选来源和业务约束统一成实验单元，再用分层实验观察不同 query/user segment 的页面级收益。",
      boundary: "流量不足、页面模块强运营配置或缺少跨模块归因时，整页优化容易被单个模块 KPI 拉偏，实验解释成本很高。",
    },
  };
  return map[title] || null;
}

function buildFrontierDiagram(item, interpretation) {
  return {
    title: `${item.source || "Frontier"} 搜广推机制图`,
    caption: (item.tags || []).slice(0, 4).join(" / ") || item.sourceType || "frontier",
    nodes: [
      { label: "业务问题", detail: interpretation.businessProblem, type: "input" },
      { label: "系统机制", detail: interpretation.systemMechanism, type: "core" },
      { label: "指标实验", detail: interpretation.metricsAndExperiment, type: "measure" },
      { label: "采用边界", detail: interpretation.boundary, type: "risk" },
    ],
    links: ["定义目标", "拆解链路", "实验验收"],
  };
}

async function fetchArxivFrontierItems(maxItems) {
  try {
    const query = encodeURIComponent(
      'cat:cs.IR AND (all:"recommender systems" OR all:"learning to rank" OR all:"information retrieval" OR all:"search ranking" OR all:"recommendation" OR all:"retrieval augmented generation" OR all:"ads ranking")',
    );
    const url = `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${Math.max(maxItems * 4, 24)}&sortBy=submittedDate&sortOrder=descending`;
    const xml = await fetchText(url);
    return parseAtomEntries(xml, Math.max(maxItems * 4, 24))
      .map((item) => ({ ...item, frontierScore: scoreArxivFrontierItem(item) }))
      .filter((item) => item.frontierScore >= 8)
      .sort((a, b) => b.frontierScore - a.frontierScore || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, maxItems)
      .map((item, index) => ({
        rank: index + 1,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        source: "arXiv",
        sourceType: "paper",
        imageUrl: `https://dummyimage.com/960x540/eef2ff/1f2a44.png&text=${encodeURIComponent("Search Ads RecSys")}`,
        tags: inferFrontierTags(`${item.title} ${item.summary}`),
        summary: item.summary,
        interpretation: interpretFrontier(item),
      }));
  } catch (error) {
    throw error;
  }
}

function scoreArxivFrontierItem(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  const positive = [
    ["recommender", 10],
    ["recommendation", 10],
    ["learning to rank", 10],
    ["ranking", 6],
    ["information retrieval", 10],
    ["retrieval-augmented", 8],
    ["retrieval augmented", 8],
    ["search", 6],
    ["query", 5],
    ["index", 5],
    ["relevance", 7],
    ["advertising", 8],
    ["ads", 6],
    ["ctr", 6],
    ["cvr", 6],
    ["personalization", 7],
    ["embedding", 5],
  ];
  const negative = ["gravitational", "fishing", "seafood", "labor abuse", "wavepacket", "biology", "medical", "protein"];
  const positiveScore = positive.reduce((sum, [term, score]) => sum + (text.includes(term) ? score : 0), 0);
  const negativeScore = negative.reduce((sum, term) => sum + (text.includes(term) ? 8 : 0), 0);
  const age = item.publishedAt ? daysBetween(new Date(item.publishedAt), new Date()) : 999;
  const recency = age <= 14 ? 4 : age <= 45 ? 2 : 0;
  return positiveScore + recency - negativeScore;
}

async function fetchIndustryFrontierItems(maxItems) {
  const feeds = [
    { source: "Google Research", url: "https://research.google/blog/rss/", domain: "research.google", priority: 5 },
    { source: "Meta Engineering", url: "https://engineering.fb.com/feed/", domain: "engineering.fb.com", priority: 4 },
    { source: "Amazon Science", url: "https://www.amazon.science/index.rss", domain: "amazon.science", priority: 4 },
    { source: "Netflix TechBlog", url: "https://netflixtechblog.com/feed", domain: "netflixtechblog.com", priority: 3 },
    { source: "Pinterest Engineering", url: "https://medium.com/feed/pinterest-engineering", domain: "medium.com", priority: 4 },
    { source: "Airbnb Engineering", url: "https://medium.com/feed/airbnb-engineering", domain: "medium.com", priority: 3 },
    { source: "Spotify Engineering", url: "https://engineering.atspotify.com/feed/", domain: "engineering.atspotify.com", priority: 3 },
    { source: "Salesforce Engineering", url: "https://engineering.salesforce.com/feed/", domain: "engineering.salesforce.com", priority: 3 },
    { source: "Dropbox Tech", url: "https://dropbox.tech/feed", domain: "dropbox.tech", priority: 2 },
    { source: "Meituan Tech", url: "https://tech.meituan.com/feed/", domain: "tech.meituan.com", priority: 3 },
    { source: "Tencent Cloud Developer", url: "https://cloud.tencent.com/developer/rss", domain: "cloud.tencent.com", priority: 2 },
    { source: "Alibaba Cloud Developer", url: "https://developer.aliyun.com/rss", domain: "developer.aliyun.com", priority: 2 },
  ];

  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const xml = await fetchText(feed.url);
      return parseFeedItems(xml, feed)
        .slice(0, 12)
        .map((item) => ({ ...item, sourceType: "industry", frontierScore: scoreIndustryFrontierItem(item, feed) }))
        .filter((item) => item.frontierScore >= 7);
    }),
  );

  return [
    ...seedIndustryFrontierItems(),
    ...results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .map((item) => ({ ...item, sourceType: item.sourceType || "industry" })),
  ]
    .filter(dedupeByTitle)
    .sort((a, b) => b.frontierScore - a.frontierScore || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, maxItems)
    .map((item, index) => ({
      rank: index + 1,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      source: item.source,
      sourceType: item.sourceType,
      imageUrl: `https://www.google.com/s2/favicons?domain=${item.domain}&sz=128`,
      tags: inferFrontierTags(`${item.title} ${item.summary}`),
      summary: item.summary,
      interpretation: interpretFrontier(item),
    }));
}

function seedIndustryFrontierItems() {
  return [
    {
      title: "Exploring Hierarchical Interest Representation For Meta Ads Deep Funnel Optimization",
      url: "https://engineering.fb.com/2026/07/15/ai-research/exploring-hierarchical-interest-representation-for-meta-ads-deep-funnel-optimization/",
      publishedAt: "2026-07-15T16:00:00Z",
      source: "Meta Engineering",
      domain: "engineering.fb.com",
      sourceType: "industry",
      frontierScore: 59,
      summary: "Meta Ads 提出 Hierarchical Interest Representation：在用户、广告主、产品/服务等实体图上训练上游表示层，用 transformer graph learning、bias-aware attention 和 self-supervised cross-view distillation 生成 universal embeddings 与 Bag-of-Meaning interest tokens，服务 deep funnel ads 的 retrieval、supervision 和 specialized ranking。",
    },
    {
      title: "Modernizing the Meta Ads Service With an Open-Source Kernel Scheduler",
      url: "https://engineering.fb.com/2026/07/13/ml-applications/modernizing-the-meta-ads-service-with-an-open-source-kernel-scheduler/",
      publishedAt: "2026-07-13T16:00:00Z",
      source: "Meta Engineering",
      domain: "engineering.fb.com",
      sourceType: "industry",
      frontierScore: 56,
      summary: "Meta Ads 与 Linux Kernel 团队用 upstream sched_ext / BPF 为广告投放负载定制调度策略，全球回放后广告 retrieval 路径 P99 延迟降低 28%、节省 3.28MW、weighted-ads-ranked 提升 1.1%。",
    },
    {
      title: "Thinking Fast & Slow for a Personalized Notification System",
      url: "https://netflixtechblog.com/thinking-fast-slow-for-a-personalized-notification-system-4d89b26525cd",
      publishedAt: "2026-06-05T16:00:00Z",
      source: "Netflix TechBlog",
      domain: "netflixtechblog.com",
      sourceType: "industry",
      frontierScore: 52,
      summary: "Netflix 个性化通知系统把长期频次规划和实时消息选择拆成 slow/fast 两层，通过 feature store 传递 pacing plan，在短期互动、长期会员体验、疲劳风险和跨渠道节奏之间做可实验的系统解耦。",
    },
    {
      title: "Achieving Near-Linear Training Scalability for Pinterest’s Foundation Models",
      url: "https://medium.com/pinterest-engineering/achieving-near-linear-training-scalability-for-pinterests-foundation-models-14d4f59fe6f6",
      publishedAt: "2026-06-25T16:00:00Z",
      source: "Pinterest Engineering",
      domain: "medium.com",
      sourceType: "industry",
      frontierScore: 51,
      summary: "Pinterest foundation model 已部署到 Home feed 与 Related Pins ranking；文章拆解多节点训练从低扩展效率走向 4 节点 3.9x、8 节点 7.5x 的系统优化路径。",
    },
    {
      title: "How we used DSPy to turn AI evaluations into better responses in Dash chat",
      url: "https://dropbox.tech/machine-learning/how-we-turned-ai-evaluations-into-better-responses-in-dash-chat",
      publishedAt: "2026-06-25T17:00:00Z",
      source: "Dropbox Tech",
      domain: "dropbox.tech",
      sourceType: "industry",
      frontierScore: 50,
      summary: "Dropbox Dash 用人工标签校准 LLM judge，再通过 DSPy 优化企业搜索/Agent chat prompt；报告 incomplete answers 降 26%、missed key aspects 降 13%、token 用量降 5.4%。",
    },
    {
      title: "GenPage: Towards End-to-End Generative Homepage Construction at Netflix",
      url: "https://netflixtechblog.com/genpage-towards-end-to-end-generative-homepage-construction-at-netflix-77146fba8a08",
      publishedAt: "2026-07-19T16:00:00Z",
      source: "Netflix TechBlog",
      domain: "netflixtechblog.com",
      sourceType: "industry",
      frontierScore: 60,
      summary: "Netflix GenPage 把首页构建从多阶段候选、行级排序和业务规则编排推进到端到端生成式页面构建：模型以用户和请求上下文为 prompt，自回归生成多行结构化首页，并在工业部署中处理冷启动、模型新鲜度、业务规则和 serving 效率；官方披露 WBC 版本核心 engagement 指标 +0.24%、端到端 serving 延迟降低 20%。",
    },
    {
      title: "AI-Powered Personalization in Under 100ms: Optimizing Real-Time Decisioning at Scale",
      url: "https://engineering.salesforce.com/ai-powered-personalization-in-under-100ms-optimizing-real-time-decisioning-at-scale/",
      publishedAt: "2025-03-12T16:00:00Z",
      source: "Salesforce Engineering",
      domain: "engineering.salesforce.com",
      sourceType: "industry",
      frontierScore: 42,
      summary: "Salesforce DPRS 将用户画像、行为数据、item embeddings、推荐排序和多渠道 decisioning 放在低延迟管线里，强调 sub-100ms 响应、两层缓存、stale-while-revalidate、tenant-aware autoscaling、离线评估和 staged rollout，适合观察企业实时个性化与 Agentforce 场景的工程边界。",
    },
    {
      title: "In-House LLM Serving at Netflix",
      url: "https://netflixtechblog.com/in-house-llm-serving-at-netflix-a5a8e799ea2c",
      publishedAt: "2026-07-18T16:00:00Z",
      source: "Netflix TechBlog",
      domain: "netflixtechblog.com",
      sourceType: "industry",
      frontierScore: 47,
      summary: "Netflix 复盘自建 LLM serving：重点不是单一模型，而是 engine selection、模型打包、API surface、部署策略和输出约束在真实生产中的取舍。对搜索、推荐和内容理解团队的借鉴点在于把生成式模型纳入可观测、可限流、可回滚的统一 serving 平台。",
    },
    {
      title: "SilverTorch: Index as Model — A New Retrieval Paradigm for Recommendation Systems",
      url: "https://engineering.fb.com/2026/05/26/ml-applications/silvertorch-index-as-model-new-retrieval-paradigm-recommendation-systems/",
      publishedAt: "2026-05-26T16:00:00Z",
      source: "Meta Engineering",
      domain: "engineering.fb.com",
      sourceType: "industry",
      frontierScore: 48,
      summary: "Meta 将推荐检索组件统一到 index-as-model 架构，报告相比既有方案最高 23.7x 吞吐、20.9x 计算成本效率提升，并强调准确率、GPU serving 和 UGC 召回的一体化权衡。",
    },
    {
      title: "Unlocking dependable responses with Gemini Enterprise Agent Platform's Agentic RAG",
      url: "https://research.google/blog/unlocking-dependable-responses-with-gemini-enterprise-agent-platforms-agentic-rag/",
      publishedAt: "2026-06-05T16:00:00Z",
      source: "Google Research",
      domain: "research.google",
      sourceType: "industry",
      frontierScore: 47,
      summary: "Google Research 与 Google Cloud 将企业 RAG 改造成多 Agent 检索工作流，用 sufficient context agent 反复补齐证据后再回答，面向跨语料、多跳企业搜索。",
    },
    {
      title: "Meta Adaptive Ranking Model: Bending the Inference Scaling Curve to Serve LLM-Scale Models for Ads",
      url: "https://engineering.fb.com/2026/03/31/ml-applications/meta-adaptive-ranking-model-bending-the-inference-scaling-curve-to-serve-llm-scale-models-for-ads/",
      publishedAt: "2026-03-31T16:00:00Z",
      source: "Meta Engineering",
      domain: "engineering.fb.com",
      sourceType: "industry",
      frontierScore: 46,
      summary: "Meta 讨论在实时广告推荐中服务 LLM-scale 排序模型的复杂度/效率矛盾，核心是让模型容量、延迟预算和广告业务目标共同优化。",
    },
    {
      title: "Modernizing the Facebook Groups Search to Unlock the Power of Community Knowledge",
      url: "https://engineering.fb.com/2026/04/21/ml-applications/modernizing-the-facebook-groups-search-to-unlock-the-power-of-community-knowledge/",
      publishedAt: "2026-04-21T16:00:00Z",
      source: "Meta Engineering",
      domain: "engineering.fb.com",
      sourceType: "industry",
      frontierScore: 45,
      summary: "Meta 将 Facebook Groups 搜索现代化，重点是把社区知识、查询理解、召回和排序连接起来，适合作为社群内容搜索从关键词匹配走向语义相关性的工程样本。",
    },
    {
      title: "Reel Friends: Building Social Discovery that Scales to Billions",
      url: "https://engineering.fb.com/2026/05/13/ml-applications/reel-friends-building-social-discovery-that-scales-to-billions/",
      publishedAt: "2026-05-13T16:00:00Z",
      source: "Meta Engineering",
      domain: "engineering.fb.com",
      sourceType: "industry",
      frontierScore: 45,
      summary: "Meta 介绍 Reels 社交发现系统如何在十亿级规模下把好友关系、内容理解、召回和排序结合，说明推荐链路正在从纯兴趣匹配扩展到社交图谱驱动的发现机制。",
    },
    {
      title: "From Clicks to Conversions: Architecting Shopping Conversion Candidate Generation at Pinterest",
      url: "https://medium.com/pinterest-engineering/from-clicks-to-conversions-architecting-shopping-conversion-candidate-generation-at-pinterest-04cae5e1455b",
      publishedAt: "2026-04-27T16:01:05Z",
      source: "Pinterest Engineering",
      domain: "medium.com",
      sourceType: "industry",
      frontierScore: 45,
      summary: "Pinterest 介绍购物转化候选生成模型，从点击信号转向转化目标，并讨论大规模上线到 6 亿月活用户的系统设计。",
    },
    {
      title: "Enhancing Ad Relevance: Integrating Real-Time Context into Sequential Recommender Models",
      url: "https://medium.com/pinterest-engineering/enhancing-ad-relevance-integrating-real-time-context-into-sequential-recommender-models-bc3a2f9b682e",
      publishedAt: "2026-05-08T19:01:00Z",
      source: "Pinterest Engineering",
      domain: "medium.com",
      sourceType: "industry",
      frontierScore: 44,
      summary: "Pinterest 将实时上下文接入序列推荐模型，报告转化相关 ROAS 指标提升，适合观察广告实时特征和在线实验闭环。",
    },
    {
      title: "Building a Natural Language Interface to the Spotify Ads API with Claude Code Plugins",
      url: "https://engineering.atspotify.com/2026/5/spotify-ads-api-claude-plugins",
      publishedAt: "2026-05-01T16:00:00Z",
      source: "Spotify Engineering",
      domain: "engineering.atspotify.com",
      sourceType: "industry",
      frontierScore: 38,
      summary: "Spotify 用 Claude Code plugin、OpenAPI spec、技能/Agent/Hook 把自然语言广告意图转成 campaign、ad set、ad 的多步 API 调用，适合观察广告平台的人机协同操作层。",
    },
    {
      title: "Our Multi-Agent Architecture for Smarter Advertising",
      url: "https://engineering.atspotify.com/2026/2/our-multi-agent-architecture-for-smarter-advertising",
      publishedAt: "2026-02-19T16:00:00Z",
      source: "Spotify Engineering",
      domain: "engineering.atspotify.com",
      sourceType: "industry",
      frontierScore: 37,
      summary: "Spotify 把广告业务的 Direct、Self-Serve、Programmatic 多渠道工作流抽象为多 Agent 架构，核心问题是统一共享后端上的渠道差异化决策逻辑。",
    },
    {
      title: "Better Experiments with LLM Evals — A funnel, not a fork",
      url: "https://engineering.atspotify.com/2026/5/better-experiments-with-llm-evals-a-funnel-not-a-fork",
      publishedAt: "2026-05-18T16:00:00Z",
      source: "Spotify Engineering",
      domain: "engineering.atspotify.com",
      sourceType: "industry",
      frontierScore: 41,
      summary: "Spotify 讨论如何把 LLM eval 放在 A/B 实验前形成漏斗：自动 judge 先提高候选质量，线上实验再验证真实用户行为，并把实验学习反哺评测标准。",
    },
    {
      title: "Using LLMs to amplify human labeling and improve Dash search relevance",
      url: "https://dropbox.tech/machine-learning/llm-human-labeling-improving-search-relevance-dropbox-dash",
      publishedAt: "2026-02-26T17:00:00Z",
      source: "Dropbox Tech",
      domain: "dropbox.tech",
      sourceType: "industry",
      frontierScore: 36,
      summary: "Dropbox Dash 用少量人工标注和 LLM 辅助标注训练搜索排序模型，解决企业搜索相关性评测与长尾标注稀缺。",
    },
    {
      title: "How we optimized Dash's relevance judge with DSPy",
      url: "https://dropbox.tech/machine-learning/optimizing-dropbox-dash-relevance-judge-with-dspy",
      publishedAt: "2026-03-17T17:00:00Z",
      source: "Dropbox Tech",
      domain: "dropbox.tech",
      sourceType: "industry",
      frontierScore: 35,
      summary: "Dropbox 用 DSPy 将搜索相关性 judge 的提示词优化变成可测量、可迁移的自动化循环，降低 LLM judge 脆弱性。",
    },
    {
      title: "Towards Generalizable and Efficient Large-Scale Generative Recommenders",
      url: "https://netflixtechblog.com/towards-generalizable-and-efficient-large-scale-generative-recommenders-a7db648aa257",
      publishedAt: "2026-01-13T16:00:00Z",
      source: "Netflix TechBlog",
      domain: "netflixtechblog.com",
      sourceType: "industry",
      frontierScore: 34,
      summary: "Netflix 讨论大规模生成式推荐的泛化与效率，重点是如何让生成式模型服务个性化推荐而不牺牲工程成本。",
    },
    {
      title: "Improving Search Ranking for Maps",
      url: "https://medium.com/airbnb-engineering/improving-search-ranking-for-maps-13b03f2c2cca",
      publishedAt: "2024-12-01T16:00:00Z",
      source: "Airbnb Engineering",
      domain: "medium.com",
      sourceType: "industry",
      frontierScore: 24,
      summary: "Airbnb 讨论地图搜索排序如何在列表排序之外处理空间位置、预订概率、注意力分配和双边市场目标，适合作为 marketplace search ranking 的系统样本。",
    },
    {
      title: "Democratizing Machine Learning at Netflix: Building the Model Lifecycle Graph",
      url: "https://netflixtechblog.com/democratizing-machine-learning-at-netflix-building-the-model-lifecycle-graph-5cc6d5828bb1",
      publishedAt: "2026-05-12T16:00:00Z",
      source: "Netflix TechBlog",
      domain: "netflixtechblog.com",
      sourceType: "industry",
      frontierScore: 30,
      summary: "Netflix 将模型、特征、训练、部署和消费关系建成生命周期图，推荐和个性化团队可借此治理实验资产和依赖影响面。",
    },
    {
      title: "PAI-Rec推荐开发平台：企业级智能推荐解决方案，驱动业务全域增长",
      url: "https://developer.aliyun.com/article/1724027",
      publishedAt: "2026-04-04T00:00:00Z",
      source: "Alibaba Cloud Developer",
      domain: "developer.aliyun.com",
      sourceType: "industry",
      frontierScore: 34,
      summary: "阿里云 PAI-Rec 介绍企业级推荐平台，多路召回、多目标精排、GPU 推理和实验迭代面向电商、直播、音视频等场景。",
    },
    {
      title: "PAI-Rec 多路召回截断实践：用 PriorityAdjustCountFilter 和 SnakeFilter 控制精排入口数量",
      url: "https://developer.aliyun.com/article/1735119",
      publishedAt: "2026-05-18T00:00:00Z",
      source: "Alibaba Cloud Developer",
      domain: "developer.aliyun.com",
      sourceType: "industry",
      frontierScore: 35,
      summary: "阿里云 PAI-Rec 讨论多路召回后如何用优先级截断和蛇形混排控制进入精排的候选规模，核心是让召回覆盖、业务配额、精排成本和实时性在工程上可配置。",
    },
    {
      title: "MTGR：美团外卖生成式推荐Scaling Law落地实践",
      url: "https://tech.meituan.com/2025/05/19/Meituan-Generative-Recommendation.html",
      publishedAt: "2025-05-19T00:00:00Z",
      source: "Meituan Tech",
      domain: "tech.meituan.com",
      sourceType: "industry",
      frontierScore: 43,
      summary: "美团外卖推荐团队基于 HSTU 提出 MTGR，在保留 DLRM 特征体系的同时统一建模多条行为序列；官方披露离线 CTCVR GAUC +2.88pp、首页订单量 +1.22%、PV_CTR +1.31%、在线推理资源节省 12%。",
    },
    {
      title: "Query attribute recommendation at Amazon Search",
      url: "https://www.amazon.science/publications/query-attribute-recommendation-at-amazon-search",
      publishedAt: "2026-01-01T00:00:00Z",
      source: "Amazon Science",
      domain: "amazon.science",
      sourceType: "industry",
      frontierScore: 32,
      summary: "Amazon Search 关注短查询中的属性推荐，属性理解会同时影响排序、广告和推荐。",
    },
    {
      title: "Design and evaluation of whole-page experience optimization for e-commerce search",
      url: "https://www.amazon.science/publications/design-and-evaluation-of-whole-page-experience-optimization-for-e-commerce-search",
      publishedAt: "2026-01-01T00:00:00Z",
      source: "Amazon Science",
      domain: "amazon.science",
      sourceType: "industry",
      frontierScore: 39,
      summary: "Amazon Science WSDM 2026 论文把电商搜索从 item ranking 推到 whole-page experience optimization，关注商品、筛选、推荐模块和页面级业务目标的联合评估。",
    },
    {
      title: "Surface-Form Neural Sparse Retrieval: Robust Fuzzy Matching for Industrial Music Search",
      url: "https://www.amazon.science/publications/surface-form-neural-sparse-retrieval-robust-fuzzy-matching-for-industrial-music-search",
      publishedAt: "2026-06-01T00:00:00Z",
      source: "Amazon Science",
      domain: "amazon.science",
      sourceType: "industry",
      frontierScore: 34,
      summary: "Amazon Music 搜索论文关注拼写错误、音译、转置和语音相近查询，在毫秒级延迟约束下用 neural sparse retrieval 补强 High Confidence Index 的探索盲区。",
    },
    {
      title: "Agentforce: Scaling Agentic AI for Enterprise Automation",
      url: "https://engineering.salesforce.com/agentforce-scaling-agentic-ai-for-enterprise-automation-observability-powering-2-billion-predictions-monthly/",
      publishedAt: "2025-04-01T16:00:00Z",
      source: "Salesforce Engineering",
      domain: "engineering.salesforce.com",
      sourceType: "industry",
      frontierScore: 33,
      summary: "Salesforce 讨论 Agentforce 在 Data Cloud 规模下的 RAG、multi-source retrieval、query optimization、ranking intelligence、batching、embedding search 与缓存，适合企业搜索和客服 Agent 评测参考。",
    },
    {
      title: "Academic Publications & Airbnb Tech: 2025 Year in Review",
      url: "https://airbnb.tech/infrastructure/academic-publications-airbnb-tech-2025-year-in-review/",
      publishedAt: "2026-01-15T16:00:00Z",
      source: "Airbnb Engineering",
      domain: "airbnb.tech",
      sourceType: "industry",
      frontierScore: 42,
      summary: "Airbnb 回顾 Relevance and Personalization 团队在 CIKM 2025 的搜索与推荐论文，重点是双边 marketplace 中搜索排序、位置检索、反事实评估和长期预订意图建模。",
    },
    {
      title: "推荐系统为啥都长一个样？聊聊「离线训练 + 在线召回 + 排序」这套大数据架构",
      url: "https://cloud.tencent.com/developer/article/2625122",
      publishedAt: "2026-01-28T13:33:51Z",
      source: "Tencent Cloud Developer",
      domain: "cloud.tencent.com",
      sourceType: "industry",
      frontierScore: 40,
      summary: "腾讯云开发者社区文章从离线训练、在线召回、排序与反馈闭环解释推荐系统通用架构，适合用来校准中小团队搭建搜推链路时的数据、实时性和模型复杂度边界。",
    },
  ];
}

function scoreIndustryFrontierItem(item, feed) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const weightedSignals = [
    ["recommender", 8],
    ["recommendation", 8],
    ["personalization", 7],
    ["ranking", 8],
    ["learning to rank", 9],
    ["search ranking", 9],
    ["search", 5],
    ["retrieval", 7],
    ["information retrieval", 9],
    ["ads", 8],
    ["advertising", 8],
    ["auction", 7],
    ["bidding", 7],
    ["ctr", 7],
    ["conversion", 5],
    ["marketplace", 6],
    ["feed", 4],
    ["relevance", 7],
    ["candidate", 5],
    ["candidate generation", 8],
    ["embedding", 5],
    ["vector", 4],
    ["semantic", 4],
    ["query", 5],
    ["indexing", 5],
    ["feature store", 5],
    ["real-time ml", 6],
    ["experimentation", 4],
    ["a/b", 4],
    ["搜索", 8],
    ["推荐", 8],
    ["广告", 8],
    ["排序", 8],
    ["召回", 8],
    ["个性化", 7],
  ];
  const signalScore = weightedSignals.reduce((sum, [term, weight]) => sum + (frontierTermHit(text, term) ? weight : 0), 0);
  if (signalScore < 5) return 0;
  const age = item.publishedAt ? daysBetween(new Date(item.publishedAt), new Date()) : 999;
  const recency = age <= 14 ? 5 : age <= 45 ? 3 : age <= 120 ? 1 : 0;
  return signalScore + (feed.priority || 0) + recency;
}

function frontierTermHit(text, term) {
  if (/[\u4e00-\u9fff]/.test(term)) return text.includes(term);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}([^a-z0-9]|$)`, "i").test(text);
}

function pickUniqueItems(items, maxItems) {
  const seen = new Set();
  const selected = [];
  for (const item of items) {
    const key = normalizeTitle(item.title || item.url || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length >= maxItems) break;
  }
  return selected;
}

async function buildAiNewsSection(maxItems) {
  const feeds = [
    { source: "AIHOT 精选", url: "https://aihot.virxact.com/feed.xml", domain: "aihot.virxact.com", priority: 3 },
    { source: "OpenAI", url: "https://openai.com/news/rss.xml", domain: "openai.com" },
    { source: "Google AI", url: "https://blog.google/technology/ai/rss/", domain: "blog.google" },
    { source: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", domain: "huggingface.co" },
  ];

  const [feedResults, anthropicResult] = await Promise.all([
    Promise.allSettled(
    feeds.map(async (feed) => {
      const xml = await fetchText(feed.url);
      return parseFeedItems(xml, feed).slice(0, 4);
    }),
    ),
    fetchAnthropicNewsItems(Math.max(12, maxItems)).catch(() => []),
  ]);
  const aiHotDigest = await buildAiHotDigest();
  const aiHotItems = (aiHotDigest.selected || [])
    .slice(0, Math.min(8, maxItems))
    .map((item) => ({
      source: "AIHOT 精选",
      sourceDetail: item.source || "AIHOT 精选",
      domain: "aihot.virxact.com",
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      summary: item.summary || item.signal || "",
      imageUrl: "https://www.google.com/s2/favicons?domain=aihot.virxact.com&sz=128",
      priority: 3,
    }));

  const rawItems = feedResults
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .concat(seedOfficialAiNewsItems(), aiHotItems, anthropicResult)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .filter(dedupeByCanonicalItem)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const anthropicQuota = Math.min(18, Math.max(14, Math.ceil(maxItems * 0.9)));
  const anthropicItems = selectAnthropicCoverage(rawItems.filter(isAnthropicItem), anthropicQuota);
  const items = pickUniqueItems(
    [
      ...seedOfficialAiNewsItems(),
      ...rawItems.slice(0, Math.max(4, maxItems - anthropicItems.length)),
      ...anthropicItems,
      ...rawItems,
    ],
    maxItems,
  )
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      ...enrichAiNews(item),
    }));

  return {
    title: "AI 新闻",
    subtitle: "汇总 AIHOT 精选、官方博客、A 社 Anthropic 动态与技术社区更新，并提炼信号、影响和行动建议。",
    source: "AIHOT RSS + Official RSS feeds + A社 Anthropic",
    sourceBrief: buildAiHotSourceBrief(),
    aihot: aiHotDigest,
    anthropicCoverage: anthropicItems,
    items: items.length ? items : fallbackAiNewsItems(),
  };
}

function isAnthropicItem(item) {
  return isAnthropicOfficialItem(item);
}

function isAnthropicOfficialItem(item = {}) {
  const source = `${item.source || ""} ${item.sourceDetail || ""}`.toLowerCase();
  const url = `${item.domain || ""} ${item.url || ""}`.toLowerCase();
  return source.includes("anthropic") || source.includes("a社") || url.includes("anthropic.com") || url.includes("claude.com");
}

function buildAnthropicSection(aiNews = {}) {
  const items = (aiNews.anthropicCoverage || aiNews.items || [])
    .filter(isAnthropicItem)
    .sort((a, b) => {
      const bDate = Date.parse(b.publishedAt || "");
      const aDate = Date.parse(a.publishedAt || "");
      if (!Number.isNaN(bDate) || !Number.isNaN(aDate)) return (Number.isNaN(bDate) ? 0 : bDate) - (Number.isNaN(aDate) ? 0 : aDate);
      return (b.anthropicScore || 0) - (a.anthropicScore || 0);
    });
  const officialSections = uniqueList(
    items
      .map((item) => item.sourceDetail || item.source || "")
      .filter(Boolean)
      .map((source) => source.replace(/^Anthropic\s+/i, "Anthropic ")),
  );
  return {
    title: "A社 Anthropic 动态",
    subtitle: "覆盖 Anthropic 官方 News、Research、Engineering、Claude 模型、Claude Code/Agent、企业合作与安全研究。",
    source: officialSections.length ? officialSections.join(" + ") : "Anthropic official pages / trusted mirrors",
    items,
  };
}

function buildSearchAdsRecSection(frontier = {}) {
  const items = frontier.items || [];
  const sources = uniqueList(items.map((item) => item.source).filter(Boolean)).slice(0, 12);
  return {
    title: "搜广推工程前沿",
    subtitle: "聚焦 recommendation/recommender、ranking、retrieval、search、ads、auction、personalization、feed、embedding/vector、CTR/CVR 与实验平台。",
    source: sources.length ? sources.join(" + ") : frontier.source || "Big Tech Engineering/RSS + arXiv",
    items,
  };
}

function buildEditorialReview({ reportDate, frontier = {}, aiNews = {} }) {
  const frontierSources = uniqueList((frontier.items || []).map((item) => item.source).filter(Boolean)).slice(0, 12);
  const anthropicSources = uniqueList(((aiNews.anthropicCoverage || aiNews.items || []))
    .filter(isAnthropicItem)
    .map((item) => item.sourceDetail || item.source)
    .filter(Boolean));
  const verifiedLinks = [
    "https://github.com/trending?since=daily",
    "https://www.anthropic.com/news",
    "https://www.anthropic.com/research",
    "https://www.anthropic.com/engineering",
    "https://www.anthropic.com/news/position-open-weights-models",
    "https://www.anthropic.com/news/cognizant-anthropic",
    "https://www.anthropic.com/news/claude-opus-5",
    "https://www.anthropic.com/research/project-pilot",
    "https://claude.com/blog",
    "https://claude.com/blog/context-engineering-claude-5",
    "https://claude.com/blog/claude-models-explained",
    "https://www.anthropic.com/news/anthropic-economic-index-connector",
    "https://www.anthropic.com/news/economic-futures-research-fund-agenda",
    "https://claude.com/blog/building-verification-loops-in-claude-code-with-skills",
    "https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle",
    "https://claude.com/blog/how-datadog-built-a-universal-machine-tool-for-claude-code",
    "https://claude.com/blog/working-at-the-frontier-rakuten",
    "https://www.anthropic.com/features/making-of-claude-code",
    "https://www.anthropic.com/research/off-switch-dual-use",
    "https://www.anthropic.com/research/global-workspace",
    "https://www.anthropic.com/engineering/how-we-contain-claude",
    "https://www.anthropic.com/news/fable-safeguards-jailbreak-framework",
    "https://www.anthropic.com/news/claude-sonnet-5",
    "https://www.anthropic.com/news/claude-science-ai-workbench",
    "https://www.anthropic.com/news/introducing-claude-tag",
    "https://www.anthropic.com/news/ben-bernanke",
    "https://www.anthropic.com/news/reflect-with-claude",
    "https://www.anthropic.com/research/economic-index-june-2026-report",
    "https://www.anthropic.com/research/claude-code-expertise",
    "https://openai.com/index/gpt-5-6/",
    "https://openai.com/index/introducing-gpt-live/",
    "https://netflixtechblog.com/recommending-for-long-term-member-satisfaction-at-netflix-ac15cada49ef",
    "https://engineering.fb.com/2026/07/15/ai-research/exploring-hierarchical-interest-representation-for-meta-ads-deep-funnel-optimization/",
    "https://engineering.fb.com/2026/07/13/ml-applications/modernizing-the-meta-ads-service-with-an-open-source-kernel-scheduler/",
    "https://medium.com/pinterest-engineering/achieving-near-linear-training-scalability-for-pinterests-foundation-models-14d4f59fe6f6",
    "https://dropbox.tech/machine-learning/how-we-turned-ai-evaluations-into-better-responses-in-dash-chat",
    "https://engineering.fb.com/2026/05/26/ml-applications/silvertorch-index-as-model-new-retrieval-paradigm-recommendation-systems/",
    "https://medium.com/pinterest-engineering/enhancing-ad-relevance-integrating-real-time-context-into-sequential-recommender-models-bc3a2f9b682e",
    "https://engineering.atspotify.com/2026/5/better-experiments-with-llm-evals-a-funnel-not-a-fork",
    "https://engineering.atspotify.com/2026/1/why-we-use-separate-tech-stacks-for-personalization-and-experimentation",
    "https://dropbox.tech/machine-learning/optimizing-dropbox-dash-relevance-judge-with-dspy",
    "https://netflixtechblog.com/genpage-towards-end-to-end-generative-homepage-construction-at-netflix-77146fba8a08",
    "https://airbnb.tech/infrastructure/academic-publications-airbnb-tech-2025-year-in-review/",
    "https://tech.meituan.com/2025/05/19/Meituan-Generative-Recommendation.html",
    "https://cloud.tencent.com/developer/article/2625122",
    "https://engineering.salesforce.com/ai-powered-personalization-in-under-100ms-optimizing-real-time-decisioning-at-scale/",
    "https://www.amazon.science/publications/design-and-evaluation-of-whole-page-experience-optimization-for-e-commerce-search",
    "https://www.amazon.science/blog/from-structured-search-to-learning-to-rank-and-retrieve",
  ];
  return {
    method: "script refresh + Codex multi-source editorial review",
    reviewedAt: new Date().toISOString(),
    reportDate,
    focus: [
      "GitHub Trending daily metadata, repo README evidence and adoption risk review",
      "Anthropic official News/Research/Engineering pages; trusted mirrors only when official page discovery is incomplete",
      "Big-tech search/ads/recommendation engineering blogs plus arXiv IR/ranking signals",
      "AIHOT and official AI sources rewritten into signal-impact-action recommendations",
    ],
    sourceNotes: [
      `Anthropic official coverage includes ${anthropicSources.join("、") || "official News/Research/Engineering"} with Claude Tag, Economic Index, Claude Code practice, model updates, partnerships and safety research.`,
      "Anthropic official pages checked this run: Newsroom latest includes Jul 27 open-weights position and Cognizant partnership, Jul 24 Claude Opus 5; Research latest includes Jul 24 drone-control frontier-red-team work; Engineering highlights Claude containment and Claude Code safety posts.",
      "Claude Blog checked for Jul 24 Claude 5 context engineering/model guidance, Jul 22 verification loops with skills, Jul 21 Datadog Claude Code universal machine tool, and enterprise agent case studies.",
      `Search/ads/recommendation coverage includes ${frontierSources.join("、") || frontier.source || "Big Tech Engineering/RSS + arXiv"} and is interpreted through business problem, system mechanism, metrics/experiments, borrowable patterns and unsuitable boundaries.`,
      "Project reads distinguish architecture mechanism, team fit, landing path, production risk, decision question and watch signal; generic metadata summaries are treated as fallback only.",
    ],
    verifiedLinks,
  };
}

function selectAnthropicCoverage(items, maxItems) {
  const ranked = rankAnthropicItems(items);
  const buckets = [
    (item) => /global workspace|j-space|interpretability|internal thoughts|hidden intent/i.test(`${item.title} ${item.summary}`),
    (item) => /introducing claude opus|claude opus|claude sonnet|claude haiku/i.test(`${item.title} ${item.summary}`),
    (item) => /claude tag|@claude|claude code|agentic coding|computer use|dynamic workflows|managed agents|auto mode/i.test(`${item.source} ${item.title} ${item.summary}`),
    (item) => /partnership|alliance|regulated|compute|enterprise|tcs|dxc|spacex|seoul|corps/i.test(`${item.title} ${item.summary}`),
    (item) => /reflect|reflection|usage recap|monthly recap|memory|time and focus/i.test(`${item.title} ${item.summary}`),
    (item) => /ltbt|long-term benefit trust|bernanke|governance|benefit trust/i.test(`${item.title} ${item.summary}`),
    (item) => /hard questions|public questions|policy|accountability|publicly respond|公开回应|公共问责/i.test(`${item.title} ${item.summary}`),
    (item) => /cyber|safety|safeguards|jailbreak|alignment|misuse|autonomy|trustworthy|contain|teaching claude why|attack/i.test(`${item.source} ${item.title} ${item.summary}`),
    (item) => /values|language|languages|societal impacts|value axis|behavior profile|价值|语言|行为画像/i.test(`${item.sourceDetail || ""} ${item.title} ${item.summary}`),
    (item) => /engineering|managed agents|auto mode|sandbox|contain|harness|tool use|context engineering/i.test(`${item.source} ${item.title} ${item.summary}`),
    (item) => /economic index|cadences|survey|work|labor|automation/i.test(`${item.source} ${item.title} ${item.summary}`),
  ];
  const selected = ranked
    .slice()
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, Math.min(4, maxItems));
  for (const matches of buckets) {
    const item = ranked.find((candidate) => matches(candidate) && !selected.some((seen) => normalizeTitle(seen.title) === normalizeTitle(candidate.title)));
    if (item) selected.push(item);
  }
  for (const item of ranked) {
    if (selected.length >= maxItems) break;
    if (!selected.some((seen) => normalizeTitle(seen.title) === normalizeTitle(item.title))) selected.push(item);
  }
  return selected.slice(0, maxItems);
}

async function fetchAnthropicNewsItems(maxItems) {
  try {
    const sectionPages = [
      { section: "News", path: "/news" },
      { section: "Research", path: "/research" },
      { section: "Engineering", path: "/engineering" },
    ];
    const sectionResults = await Promise.allSettled(
      sectionPages.map(async (section) => {
        const html = await fetchText(`https://www.anthropic.com${section.path}`);
        const pattern = new RegExp(`href=["'](/(?:news|research|engineering)/[^"'?#]+)["']`, "g");
        return [...html.matchAll(pattern)].map((match) => ({
          pathname: match[1],
          section: section.section,
        }));
      }),
    );
    const paths = uniqueList(
      sectionResults
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .filter((item) => !item.pathname.includes("/team/"))
        .map((item) => `${item.section}|${item.pathname}`),
    )
      .map((value) => {
        const [section, pathname] = value.split("|");
        return { section, pathname };
      })
      .slice(0, Math.max(maxItems * 3, maxItems + 6));
    const results = await Promise.allSettled(
      paths.map(async ({ section, pathname }) => {
        const url = `https://www.anthropic.com${pathname}`;
        const page = await fetchText(url);
        const title = extractMeta(page, "og:title") || extractTitle(page) || pathname.split("/").pop();
        let summary = extractMeta(page, "og:description") || extractMeta(page, "description") || extractFirstParagraph(page);
        if (isGenericAnthropicSummary(summary)) summary = extractAnthropicLead(page, title);
        const imageUrl = extractMeta(page, "og:image") || "https://www.google.com/s2/favicons?domain=anthropic.com&sz=128";
        const publishedAt = parseAnthropicPublishedAt(page) || "";
        return {
          source: section === "News" ? "A社 Anthropic" : `A社 Anthropic ${section}`,
          sourceDetail: `Anthropic 官方 ${section}`,
          domain: "anthropic.com",
          title: cleanupXml(title).replace(/\s+\\ Anthropic$/, ""),
          url,
          publishedAt,
          summary: trimText(cleanupXml(summary), 300),
          imageUrl,
          priority: 4,
        };
      }),
    );
    const items = results
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .filter((item) => item.title && item.url);
    if (items.length) return rankAnthropicItems([...seedAnthropicOfficialItems(), ...items]).slice(0, Math.max(maxItems, 24));
  } catch {
    // Fall through to community-maintained feed mirrors when the official site blocks or changes markup.
  }

  const mirrorFeeds = [
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic News 镜像",
      url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml",
      domain: "anthropic.com",
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic Research 镜像",
      url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_research.xml",
      domain: "anthropic.com",
      priority: 4,
    },
    {
      source: "A社 Anthropic Engineering",
      sourceDetail: "Anthropic Engineering 镜像",
      url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml",
      domain: "anthropic.com",
      priority: 4,
    },
  ];
  const results = await Promise.allSettled(
    mirrorFeeds.map(async (feed) => {
      const xml = await fetchText(feed.url);
      return parseFeedItems(xml, feed).slice(0, 3);
    }),
  );
  return rankAnthropicItems([
    ...seedAnthropicOfficialItems(),
    ...results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  ]).slice(0, maxItems);
}

function seedAnthropicOfficialItems() {
  const favicon = "https://www.google.com/s2/favicons?domain=anthropic.com&sz=128";
  return [
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Policy",
      domain: "anthropic.com",
      title: "Our position on open-weights models",
      url: "https://www.anthropic.com/news/position-open-weights-models",
      publishedAt: "2026-07-27T16:00:00Z",
      summary: "Anthropic 澄清其 open-weights 立场：不主张全面禁止开源权重模型，支持不具危险能力的开放模型作为公共产品，同时主张芯片出口管制、打击工业级蒸馏和对足够强模型做强制安全测试。信号是 A 社把开放生态、国家安全和能力阈值拆开讨论；动作是企业选型时分别评估 license、能力风险、模型来源、蒸馏防护和安全测试证据。",
      imageUrl: favicon,
      priority: 14,
      signal: "开放权重治理信号：Anthropic 将开放模型价值与前沿能力安全阈值拆开，而不是简单支持或反对开源。",
      impact: "企业采用开源/开放权重模型时会被要求拿出更清晰的来源、能力、蒸馏和安全测试证据。",
      action: "把 open-weight 模型选型拆成模型能力边界、供应链来源、微调/蒸馏策略、红队结果和地区合规五张清单。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Enterprise",
      domain: "anthropic.com",
      title: "Cognizant and Anthropic expand their partnership to bring Claude to enterprise clients",
      url: "https://www.anthropic.com/news/cognizant-anthropic",
      publishedAt: "2026-07-27T16:00:00Z",
      summary: "Anthropic 与 Cognizant 扩大合作，Cognizant 成为 Claude Partner Network 的 Global Premier Partner，并把 Claude 嵌入 Flowsource 等企业平台。信号是 Claude 企业落地越来越依赖 SI/咨询伙伴把模型、行业流程、培训和治理打包；动作是采购时同时评估模型供应商与实施伙伴的权限、数据、变更和验收责任。",
      imageUrl: favicon,
      priority: 13,
      signal: "企业渠道信号：Claude 正通过全球 SI 伙伴进入行业流程，而不是只靠 API 或聊天产品自助扩散。",
      impact: "大型企业落地速度会提高，但责任边界会扩展到实施伙伴、流程改造、员工培训和数据治理。",
      action: "在 Claude 项目立项时把 Anthropic、SI 伙伴和内部 owner 的权限、交付物、审计日志和业务指标写进同一验收表。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Model",
      domain: "anthropic.com",
      title: "Introducing Claude Opus 5",
      url: "https://www.anthropic.com/news/claude-opus-5",
      publishedAt: "2026-07-24T16:00:00Z",
      summary: "Anthropic 发布 Claude Opus 5，定位为接近 Fable 5 frontier intelligence、但以约一半成本服务长周期 Agent、编码和专业知识工作的 Opus 档模型。信号是模型竞争继续转向任务级成本效率、验证能力和 Agent 稳定性；动作是用真实 coding、数据分析、法律/金融研究和多工具长任务回放评估，而不是只看单轮 benchmark。",
      imageUrl: favicon,
      priority: 13,
      signal: "Claude 模型更新信号：Opus 5 把高能力 Agent 工作从旗舰稀缺资源下沉到日常专业工作流。",
      impact: "企业会更倾向把困难 coding、分析和长任务交给 Opus 档，但仍要衡量成本、速度、上下文和工具权限。",
      action: "为 Opus 5 建立任务级评测矩阵：代码迁移、debug、表格分析、研究报告、工具调用和视觉 artifact 各自看准确率、轮次、耗时和人工修正。",
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research / Frontier Red Team",
      domain: "anthropic.com",
      title: "Project Pilot: Can AI control a drone?",
      url: "https://www.anthropic.com/research/project-pilot",
      publishedAt: "2026-07-24T16:00:00Z",
      summary: "Anthropic 与 Andon Labs 发布 Project Pilot，用 Drone-Bench 评估 AI 模型自主执行无人机 locate-and-follow 任务的能力。信号是 Frontier Red Team 正把 Claude/Agent 风险评测从软件、网页和机器人扩展到具备监视与物理后果的飞行平台；动作是所有 physical AI 试点先限定仿真、只读建议、动作白名单和人工接管。",
      imageUrl: favicon,
      priority: 12,
      signal: "物理 Agent 红队信号：A 社开始用无人机任务评估模型在现实世界控制链路中的能力和风险。",
      impact: "机器人、安防、巡检和工业团队会更快看到通用模型进入控制系统的压力，同时误动作成本明显上升。",
      action: "将 physical AI 评估拆成仿真、场地隔离、动作白名单、紧急停止、日志回放和责任边界，禁止直接接生产设备。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Economic Research",
      domain: "anthropic.com",
      title: "Ask Claude about the Anthropic Economic Index",
      url: "https://www.anthropic.com/news/anthropic-economic-index-connector",
      publishedAt: "2026-07-22T16:00:00Z",
      summary: "Anthropic 推出 Economic Index connector，让用户直接在 Claude 中查询 AI 使用与工作变化数据，并要求 Claude 展示底层数据和限制。信号是 A 社把经济影响研究从静态报告推进到可交互数据产品；影响是政策、HR 和业务团队能更快按行业、职业、地区追问 AI 采用证据；动作是把它用于假设生成和任务盘点，而不是把 Claude 使用样本当成完整劳动力市场事实。",
      imageUrl: favicon,
      priority: 12,
      signal: "经济数据产品化信号：Anthropic 把 Economic Index 接入 Claude connector，让研究数据进入普通用户问答流。",
      impact: "组织评估 AI 采用时会更容易按职业、地区和任务追问证据，但样本仍代表 Claude 使用而非全劳动力市场。",
      action: "用 connector 做内部 AI 采用假设生成，再回到本公司任务日志、岗位访谈和业务指标做二次验证。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Economic Research",
      domain: "anthropic.com",
      title: "A research agenda for the Economic Futures Research Fund",
      url: "https://www.anthropic.com/news/economic-futures-research-fund-agenda",
      publishedAt: "2026-07-22T16:00:00Z",
      summary: "Anthropic 公布 Economic Futures Research Fund 研究议程，承诺 2 亿美元支持外部研究，重点覆盖企业和工作场所影响、转型支持、收入保障、AI 增长中的劳动者权益和公共投资证据。信号是 A 社将 AI 经济冲击治理从观点声明推进到资金和实证研究；影响是企业 AI adoption 会被更多问及劳动替代、收益分配和再培训证据；动作是把岗位影响评估和再培训计划纳入 Agent 推广路线图。",
      imageUrl: favicon,
      priority: 11,
      signal: "经济治理信号：Anthropic 用大额研究基金押注 AI 工作冲击的实证干预。",
      impact: "企业内部 Agent 推广会面对更具体的岗位影响、再培训、收益分配和治理透明度问题。",
      action: "在推广 Claude/Agent 前建立任务级影响台账，明确哪些工作被增强、替代或需要再培训，而不是只报节省工时。",
    },
    {
      source: "A社 Claude",
      sourceDetail: "Claude 官方 Blog / Claude Code",
      domain: "claude.com",
      title: "Building verification loops in Claude Code with skills",
      url: "https://claude.com/blog/building-verification-loops-in-claude-code-with-skills",
      publishedAt: "2026-07-22T16:00:00Z",
      summary: "Claude 官方博客介绍如何把人工检查转成 skills，让 Claude Code 在 gather context -> take action -> verify work -> repeat 循环中主动执行验证。信号是 Claude Code 的竞争点继续从生成代码转向可复用验证闭环；影响是团队可以把测试、截图、lint、数据校验和发布前检查做成 Agent 可调用资产；动作是优先沉淀高频失败模式的 verification skill，并把通过率、误报和人工接管记录进 PR 门禁。",
      imageUrl: favicon,
      priority: 11,
      signal: "Claude Code 工程化信号：skills 正从提示模板升级为可复用验证环。",
      impact: "Agent 写代码的质量差异会更多取决于团队是否把测试、lint、截图和业务校验做成可执行反馈循环。",
      action: "先为一个高频 PR 类型编写 verification skill，要求 Claude Code 修改后自动运行并报告失败样本、成本和回滚建议。",
    },
    {
      source: "A社 Claude",
      sourceDetail: "Claude 官方 Blog / Claude Code",
      domain: "claude.com",
      title: "How Anthropic secures its AI-native software development lifecycle",
      url: "https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle",
      publishedAt: "2026-07-21T16:00:00Z",
      summary: "Claude 官方博客披露 Anthropic 如何治理 AI-native SDLC，强调权限、验证、审查和安全边界。信号是 Claude Code 企业化不只是提高开发速度，而是要求把 Agent 行为纳入软件生命周期安全控制；影响是研发效能、安全和平台团队必须共同定义工具白名单、审计日志、敏感操作确认和发布门禁；动作是把 AI 生成/修改路径纳入现有 secure SDLC，而不是另起一套例外流程。",
      imageUrl: favicon,
      priority: 10,
      signal: "AI-native SDLC 信号：Anthropic 将 Claude Code 使用方式与安全开发生命周期绑定。",
      impact: "企业采用 coding agent 会把风险从代码质量扩展到权限、供应链、审计和发布审批。",
      action: "把 Agent 变更纳入同一套 threat modeling、code review、CI、secrets scanning 和变更追溯，不允许绕过发布控制。",
    },
    {
      source: "A社 Claude",
      sourceDetail: "Claude 官方 Blog / Enterprise",
      domain: "claude.com",
      title: "How Datadog built a universal machine tool for Claude Code",
      url: "https://claude.com/blog/how-datadog-built-a-universal-machine-tool-for-claude-code",
      publishedAt: "2026-07-21T16:00:00Z",
      summary: "Claude 官方企业案例介绍 Datadog 的 Temper，把规格说明转成可验证、可进入生产的软件系统。信号是成熟工程团队开始把重点放在 Agent 工作环境、上下文、验证和安全，而不是让模型自由写代码；影响是企业 coding agent 平台会围绕任务规格、验证器和生产约束重构；动作是优先设计 Agent 的 machine tool 和验证协议，再扩大自动改代码权限。",
      imageUrl: favicon,
      priority: 10,
      signal: "企业 Agent 平台信号：Datadog 关注的是为 Claude Code 设计机器环境和验证协议。",
      impact: "大团队采用 Claude Code 的关键资产会是规格、上下文封装、验证器和安全边界，而不是单次 prompt。",
      action: "把高价值工程任务改造成“规格 -> 生成 -> 自动验证 -> 人工审查”的固定管线，再衡量交付周期和缺陷率。",
    },
    {
      source: "A社 Claude",
      sourceDetail: "Claude 官方 Blog / Enterprise AI",
      domain: "claude.com",
      title: "Working at the frontier: How Rakuten builds agents overnight with Claude Fable 5",
      url: "https://claude.com/blog/working-at-the-frontier-rakuten",
      publishedAt: "2026-07-20T16:00:00Z",
      summary: "Claude 官方企业案例介绍 Rakuten 使用 Claude Fable 5 构建可长时间运行的 enterprise agents。信号是 Claude 模型更新正在推动工作单元从短对话转向跨夜自主执行；影响是组织会更关注长任务恢复、自我验证、taste alignment、预算上限和人工接管；动作是在企业试点中先选可回放、低风险、结果可验收的 overnight agent 任务，不要直接接入不可逆生产操作。",
      imageUrl: favicon,
      priority: 9,
      signal: "长周期 Agent 信号：Fable 5 被包装为能支撑跨夜企业 Agent 的 frontier 模型。",
      impact: "企业委托粒度会从单步问答扩大到多小时任务，但失败恢复、权限和成本风险同步放大。",
      action: "为长任务 Agent 设置预算、检查点、可中断恢复、验证器和人工审批，再比较跨夜执行与人工批处理的真实收益。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Research Partnerships",
      domain: "anthropic.com",
      title: "Anthropic commits $10 million to Canadian AI research",
      url: "https://www.anthropic.com/news/canadian-ai-research",
      publishedAt: "2026-07-14T16:00:00Z",
      summary: "Anthropic 承诺向加拿大研究机构投入 1000 万加元，并同时发布加拿大 Claude 使用画像。信号是 A 社把模型供给、学术生态、AI safety、医疗/心理健康、低资源语言和区域创业生态放到同一套国家级合作叙事里；企业评估时应关注这些研究合作如何沉淀为安全评测、行业工作台和本地合规能力。",
      imageUrl: favicon,
      priority: 9,
      signal: "生态投资信号：Claude 的竞争不只在模型能力，也在研究机构、行业试点和区域合规网络。",
      impact: "对加拿大 AI 安全、健康、教育和多语言研究有直接资源注入；对企业客户则提示 Claude 生态会更偏向可审计、高价值专业工作流。",
      action: "把供应商评估从模型 benchmark 扩展到区域数据治理、研究合作、行业证据和本地支持能力，尤其关注医疗、政府和教育场景。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Education",
      domain: "anthropic.com",
      title: "Introducing Claude for Teachers",
      url: "https://www.anthropic.com/news/claude-for-teachers",
      publishedAt: "2026-07-14T16:00:00Z",
      summary: "Anthropic 推出 Claude for Teachers，面向教师工作流提供免费访问和教育场景支持。信号是 Claude 正从企业知识工作扩展到公共教育采用；学校和教育产品评估时要同时看内容质量、学生数据边界、教师审核和地区合规。",
      imageUrl: favicon,
      priority: 10,
      signal: "教育采用信号：A 社把 Claude 包装成教师工作流入口，而不只是通用聊天助手。",
      impact: "教育场景会带来更大规模的低门槛采用，但也会放大内容准确性、隐私、未成年人保护和教师责任边界问题。",
      action: "教育团队应先限定教师备课、反馈草稿和资料整理，不让模型直接评分或替代教师判断，并建立数据留存与人工复核规则。",
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research / Economic Research",
      domain: "anthropic.com",
      title: "How Canada uses Claude: Findings from the Anthropic Economic Index",
      url: "https://www.anthropic.com/research/how-canada-uses-claude",
      publishedAt: "2026-07-14T16:00:00Z",
      summary: "Anthropic Economic Index 加拿大简报显示，加拿大占 Claude.ai 全球流量 2.6%，总量排名第八，人均采用率超过人口预测的四倍；省级采用更受专业、科学和技术服务业占比影响，而不是单纯收入水平。信号是 AI 采用评估正在从宏观热度转向真实工作结构和地域产业结构。",
      imageUrl: favicon,
      priority: 8,
      signal: "经济采用信号：Claude 使用强度与工作结构匹配度相关，区域产业结构会影响 Agent 落地速度。",
      impact: "组织推广 AI 时不能只看员工数量或预算，应优先识别专业服务、科研、翻译、代码和早期职业任务密集的团队。",
      action: "在内部推广 Claude/Agent 前先做任务结构盘点：按岗位、语言、数据敏感度和可复盘指标分层，而不是全员平均铺开。",
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research / Societal Impacts",
      domain: "anthropic.com",
      title: "Claude’s values across models and languages",
      url: "https://www.anthropic.com/research/claude-values-models-languages",
      publishedAt: "2026-07-13T16:00:00Z",
      summary: "Anthropic 用价值轴压缩方法分析 Claude 在不同模型和语言中的表达差异，观察到 Deference/Caution、Warmth/Rigor、Depth/Brevity、Candor/Execution 等维度会随模型和语言变化。信号是模型评测正在从正确率、安全拒答扩展到跨语言、跨文化的行为画像和上线监控。",
      imageUrl: favicon,
      priority: 8,
      signal: "行为评测信号：同一模型在不同语言和版本中的价值表达并不完全一致，需要被测量和治理。",
      impact: "多语言产品、教育、客服和企业知识助手会遇到风格、谨慎度、深度和直接性差异，影响用户信任和决策质量。",
      action: "多语言 Agent 上线前建立语言分层评测集，单独看拒答、事实严谨、建议强度、语气和用户结果，而不是只复用英文测试。",
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research / Frontier Red Team",
      domain: "anthropic.com",
      title: "Claude plays robotics",
      url: "https://www.anthropic.com/research/claude-plays-robotics",
      publishedAt: "2026-07-09T16:00:00Z",
      summary: "Anthropic Frontier Red Team 将 Claude 放进机器人仿真任务，观察模型在现实世界控制、工具调用和自主决策边界上的表现。信号是 A 社安全研究正从文本/代码扩展到具备物理后果的 Agent 场景；评估重点必须包括仿真、约束执行、人工接管和失败回放。",
      imageUrl: favicon,
      priority: 8,
      signal: "机器人安全信号：Claude/Agent 能力评测正在覆盖 physical AI，不再局限于浏览器、终端和代码。",
      impact: "机器人、制造、仓储和现场服务团队会更快看到通用 Agent 进入控制链路的压力，但错误成本也显著提高。",
      action: "任何 physical AI 试点都应先限定为仿真或只读建议，建立动作白名单、紧急停止、日志回放和责任边界后再扩大。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Enterprise",
      domain: "anthropic.com",
      title: "UST is bringing Claude to physical AI",
      url: "https://www.anthropic.com/news/ust-claude",
      publishedAt: "2026-07-09T16:00:00Z",
      summary: "Anthropic 报道 UST 正把 Claude 用到 physical AI 场景。信号是 Claude 的企业合作不再只围绕知识工作和代码，而是向机器人、工业流程和现实世界系统理解延伸；落地时要把仿真验证、现场安全、数据权限、工具调用边界和人工接管作为第一层架构，而不是把通用 Agent 直接接到物理执行链路。",
      imageUrl: favicon,
      priority: 8,
      signal: "企业合作信号：Claude 正从办公/代码 Agent 扩展到 physical AI 和现实世界工作流。",
      impact: "对机器人、制造、物流和现场服务团队有方向意义，但风险从输出错误升级为物理动作、设备安全和责任归属。",
      action: "评估 physical AI Agent 时先建仿真、只读观测、人工审批和事故回放链路，再考虑让 Claude 触发任何执行动作。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Policy",
      domain: "anthropic.com",
      title: "Inviting hard questions",
      url: "https://www.anthropic.com/news/hard-questions",
      publishedAt: "2026-07-09T16:00:00Z",
      summary: "Anthropic 邀请公众提出关于 AI 的 hard questions，并承诺公开回应。信号是 A 社把安全、社会影响和政策沟通继续前置到公司叙事；企业用户应把供应商问责问题写进评估清单，包括模型边界、滥用事件响应、数据处理、成本透明度、监管冲突和产品撤回机制。",
      imageUrl: favicon,
      priority: 8,
      signal: "公共问责信号：Anthropic 主动把外部质询纳入安全与政策沟通节奏。",
      impact: "短期不改变模型能力，但会影响企业采购、政府合作和高风险行业对 Claude 的信任评估。",
      action: "采购/治理团队可把这类公开问答转成供应商尽调模板，持续追踪承诺是否落到产品、文档和事件响应里。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Governance",
      domain: "anthropic.com",
      title: "Ben Bernanke appointed to Anthropic's Long-Term Benefit Trust",
      url: "https://www.anthropic.com/news/ben-bernanke",
      publishedAt: "2026-07-09T16:00:00Z",
      summary: "Anthropic 宣布前美联储主席 Ben Bernanke 加入 Long-Term Benefit Trust。信号不是模型能力更新，而是 A 社继续把独立治理、长期公共利益和商业化扩张绑定；企业评估 Claude 供应商时，应把董事会/信托治理、模型安全阈值、政策争议响应和长期供给稳定性纳入供应商风险清单。",
      imageUrl: favicon,
      priority: 7,
      signal: "治理信号：Anthropic 把 LTBT 作为长期使命约束的独立机制继续强化，并引入宏观政策与金融监管经验。",
      impact: "对企业客户的直接产品影响有限，但会影响 Anthropic 在安全边界、政府关系、资本市场和高监管行业中的可信度叙事。",
      action: "采购和平台团队应把模型供应商尽调扩展到治理结构、事件响应、政策冲突和服务连续性，而不是只看 benchmark 与价格。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Claude Apps",
      domain: "anthropic.com",
      title: "A new way to reflect on how you use Claude",
      url: "https://www.anthropic.com/news/reflect-with-claude",
      publishedAt: "2026-07-09T16:00:00Z",
      summary: "Anthropic 推出 Claude Reflect，让开启 memory 的 Free/Pro/Max 用户在 web 和桌面端查看月度使用回顾、主题、活跃时间、工作方式观察，并配套 quiet hours / break reminders。信号是 Claude 从生产力工具向“自我使用治理”扩展；企业团队应借鉴 usage recap 设计，把 Agent 使用、成本、时间段、任务类型和人工保留边界做成团队级仪表盘。",
      imageUrl: favicon,
      priority: 7,
      signal: "产品治理信号：Claude 开始帮助用户审视是否过度委托、是否符合原始目标，而不是单纯增加使用时长。",
      impact: "对个人用户是使用透明度，对企业是未来 Agent adoption analytics 的样板；但 memory 与敏感主题摘要会带来隐私、解释和数据保留问题。",
      action: "上线内部 Agent 前同步设计 usage review：按任务类型、成本、失败率、人工接管、敏感数据和 quiet-hours 策略记录，而不是事后靠账单追责。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Claude Code",
      domain: "anthropic.com",
      title: "The Making of Claude Code",
      url: "https://www.anthropic.com/features/making-of-claude-code",
      publishedAt: "2026-07-06T16:00:00Z",
      summary: "Anthropic 新闻页把 Claude Code 从内部 CLI 演进为 coding agent 的故事放在 7 月 6 日头条；信号不是单个功能发布，而是 Claude Code 已经成为可产品化、可企业化、可被早期用户反复使用的 Agent 工程范式。评估动作应聚焦任务边界、工具权限、上下文恢复、审计日志和团队采用模式。",
      imageUrl: favicon,
      priority: 9,
      signal: "Claude Code 产品化信号：A 社把内部 CLI 的演进路径公开成 coding agent 工程故事，说明采用重点已从模型能力转向真实团队工作流。",
      impact: "企业评估 Claude Code 时会更关注工具权限、任务边界、上下文恢复、审计日志和团队协作模式，而不是只看单次代码生成成绩。",
      action: "把 Claude Code 试点拆成 issue/PR 级任务、长任务迁移、代码审查和文档维护四类回放，逐项记录权限、失败接管、成本和 review 缺陷。",
    },
    {
      source: "A社 Anthropic Engineering",
      sourceDetail: "Anthropic 官方 Engineering / Agent Containment",
      domain: "anthropic.com",
      title: "How we contain Claude across products",
      url: "https://www.anthropic.com/engineering/how-we-contain-claude",
      publishedAt: "2026-06-18T16:00:00Z",
      summary: "Anthropic Engineering 将 claude.ai、Claude Code 与 Claude Cowork 放在同一套 containment 叙事下，强调 agent 能力越强，工程重点越要从权限弹窗转向 blast radius、工具隔离、动作审计、回滚和产品级安全边界。",
      imageUrl: favicon,
      priority: 8,
      signal: "Agent 安全工程信号：Claude Code/Agent 的关键竞争力正在从“能完成任务”扩展到“出错时影响范围可控”。",
      impact: "企业采用 Claude Code、Cowork 或内部 Agent 平台时，最先暴露的不是模型分数，而是文件、终端、浏览器、连接器和团队数据的越权半径。",
      action: "把 containment 做成试点准入项：工具白名单、敏感动作确认、最小权限、日志审计、回滚剧本和人工接管必须早于大规模推广。",
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research / Interpretability",
      domain: "anthropic.com",
      title: "A global workspace in language models",
      url: "https://www.anthropic.com/research/global-workspace",
      publishedAt: "2026-07-06T16:00:00Z",
      summary: "Anthropic 发布 Claude J-space / global workspace 研究，显示模型内部存在可被读取、干预并参与多步推理的“静默工作区”；这把 Claude 安全监控从输出审查推进到内部表征、隐式意图和评测感知的可观测治理。",
      imageUrl: favicon,
      priority: 5,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research / Alignment",
      domain: "anthropic.com",
      title: "An off switch for dual use knowledge in AI models",
      url: "https://www.anthropic.com/research/off-switch-dual-use",
      publishedAt: "2026-07-08T16:00:00Z",
      summary: "Anthropic 与 AE Studio 提出 GRAM，把病毒学、网络安全、核物理等双重用途知识路由到可移除模块；同一次训练可按部署场景打开或删除能力模块，但官方明确这仍是早期研究，尚未用于 Claude 生产模型。",
      imageUrl: favicon,
      priority: 6,
      signal: "安全架构信号：模型治理开始从“输出拒答/分类器”前移到训练时的能力分区和部署时的模块化访问控制。",
      impact: "如果后续能扩展到 frontier-scale，企业模型供应会出现“同基座、不同能力开关”的合规形态；短期仍只能作为研发方向，不能替代现有红队、拒答和审计。",
      action: "安全/平台团队应把它纳入模型供应商尽调问题：双重用途能力如何隔离、如何验证删除效果、如何防止小样本微调恢复、以及生产模型是否真的使用该机制。",
      interpretation: {
        signal: "安全架构信号：GRAM 把双重用途知识放进可移除模块，而不是只依赖输出层拒答。",
        impact: "长期可能改变企业对同一模型在可信/非可信部署中的能力分级方式；当前限制是未在 Claude 生产训练线验证。",
        action: "只作为安全路线观察项，评审时重点追问 frontier-scale、下游任务评测、模块恢复攻击和审计证据。",
      },
      diagram: {
        title: "GRAM 双重用途能力开关图解",
        caption: "Anthropic Research · Alignment · Jul 8 2026",
        nodes: [
          { label: "双重用途数据", detail: "网络安全、病毒学、核物理等高风险知识源", type: "input" },
          { label: "梯度路由模块", detail: "冻结通用权重，把类别知识写入对应辅助模块", type: "core" },
          { label: "部署配置", detail: "可信场景保留模块，非可信场景删除模块", type: "integration" },
          { label: "验证边界", detail: "未上生产；需验证下游任务、恢复攻击和规模化成本", type: "risk" },
        ],
        links: ["能力分区", "模块开关", "安全评估"],
      },
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Safeguards",
      domain: "anthropic.com",
      title: "More details on Fable 5’s cyber safeguards and our jailbreak framework",
      url: "https://www.anthropic.com/news/fable-safeguards-jailbreak-framework",
      publishedAt: "2026-07-02T16:00:00Z",
      summary: "Anthropic 补充 Fable 5 网络安全防护和 jailbreak 严重度框架，说明前沿 Claude 模型发布正在同时绑定能力开放、滥用分级、跨厂商协作、地区可用性和上线治理。",
      imageUrl: favicon,
      priority: 5,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Introducing Claude Sonnet 5",
      url: "https://www.anthropic.com/news/claude-sonnet-5",
      publishedAt: "2026-06-30T16:00:00Z",
      summary: "Anthropic 发布 Claude Sonnet 5，定位为最 agentic 的 Sonnet 模型；官方强调它可规划、调用浏览器和终端工具，并在 Claude Code、Claude Platform 和各套餐中可用。企业评估应把成本曲线、BrowseComp/OSWorld-Verified 表现、长任务权限和审计边界放在同一张表里。",
      imageUrl: favicon,
      priority: 5,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Claude Science, an AI workbench for scientists, is now available",
      url: "https://www.anthropic.com/news/claude-science-ai-workbench",
      publishedAt: "2026-06-30T16:00:00Z",
      summary: "Anthropic 推出 Claude Science，把文献分析、多步骤研究、常用科研工具、计算资源和可审计 artifact 放进统一工作台；这说明 Claude 产品线正在从通用助手扩展到高价值专业工作流，采用时要优先验证数据权限、可复现记录、专家复核和远程算力边界。",
      imageUrl: favicon,
      priority: 5,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Introducing Claude Corps",
      url: "https://www.anthropic.com/news/claude-corps",
      publishedAt: "2026-06-11T16:00:00Z",
      summary: "Anthropic 发布 Claude Corps fellowship，面向早期职业人群招募并训练 Claude 原生工作方式；这不是模型能力更新，而是把 Claude Code、Claude Cowork 和 Agent 工作流扩展到人才培养与组织采用路径的生态信号。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research",
      domain: "anthropic.com",
      title: "Anthropic Economic Index report: Cadences",
      url: "https://www.anthropic.com/research/economic-index-june-2026-report",
      publishedAt: "2026-06-26T16:00:00Z",
      summary: "Anthropic Economic Index 6 月报告从小时级 Claude 使用节奏、产出类型和问卷感知三条线观察 AI 如何进入工作；它把 Claude/Agent 采用问题从单次能力评测推进到任务节奏、自动化意愿和组织影响评估。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Introducing Claude Tag",
      url: "https://www.anthropic.com/news/introducing-claude-tag",
      publishedAt: "2026-06-23T16:00:00Z",
      summary: "Anthropic 发布 Claude Tag，把 Claude 作为 Slack 团队成员接入频道、工具、数据和代码库；它支持频道级记忆、异步任务、主动跟进、预算上限和审计日志，是 Claude Code/Cowork 从个人 Agent 走向团队协作 Agent 的重要信号。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research",
      domain: "anthropic.com",
      title: "Project Fetch: Phase two",
      url: "https://www.anthropic.com/research/project-fetch-phase-two",
      publishedAt: "2026-06-18T16:00:00Z",
      summary: "Anthropic 的 Project Fetch 二阶段继续用红队任务衡量模型在自主网络行动、漏洞利用和防御边界上的能力，说明安全评测正在从静态问答走向任务链路观测。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research",
      domain: "anthropic.com",
      title: "Agentic coding and persistent returns to expertise",
      url: "https://www.anthropic.com/research/claude-code-expertise",
      publishedAt: "2026-06-16T16:00:00Z",
      summary: "Anthropic 研究 Claude Code 实际使用中专家经验的持续回报，提示企业评估 coding agent 时要看人机协作结构，而不是只看自动完成率。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research",
      domain: "anthropic.com",
      title: "Measuring LLMs' impact on N-day exploits",
      url: "https://www.anthropic.com/research/llms-n-day-exploits",
      publishedAt: "2026-06-08T16:00:00Z",
      summary: "Anthropic 将模型能力放到 N-day 漏洞利用场景里评估，安全团队需要把模型使用、漏洞情报、补丁窗口和授权测试流程一起治理。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research",
      domain: "anthropic.com",
      title: "Making Claude a chemist",
      url: "https://www.anthropic.com/research/making-claude-a-chemist",
      publishedAt: "2026-06-05T16:00:00Z",
      summary: "Anthropic 展示 Claude 在化学工作流中的推理和工具使用潜力，落地重点应放在实验约束、专家复核、实验室安全和可追溯记录。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Introducing Claude Opus 4.8",
      url: "https://www.anthropic.com/news/claude-opus-4-8",
      publishedAt: "2026-05-28T16:00:00Z",
      summary: "Anthropic 发布 Claude Opus 4.8，官方重点放在 coding、agentic tasks、computer use、长会话协作、诚实性和企业工作流可靠性。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Claude Fable 5 and Claude Mythos 5 access unavailable",
      url: "https://www.anthropic.com/news/claude-fable-5-mythos-5",
      publishedAt: "2026-06-12T16:00:00Z",
      summary: "Anthropic 说明 Claude Fable 5 / Mythos 5 访问不可用，并将部分请求回退到 Claude Opus 4.8，体现高能力模型上线后的供应、安全和合规约束。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News / Model Availability",
      domain: "anthropic.com",
      title: "Redeploying Claude Fable 5",
      url: "https://www.anthropic.com/news/redeploying-fable-5",
      publishedAt: "2026-06-29T16:00:00Z",
      summary: "Anthropic 在出口管制解除后从 7 月 1 日起重新开放 Claude Fable 5，并同步更新网络安全防护和行业 jailbreak 分级框架；这说明 frontier 模型上线需要同时管理监管、地区可用性、身份验证和安全阈值。",
      imageUrl: favicon,
      priority: 6,
      signal: "模型供应治理信号：Fable 5 重新开放不是单纯恢复访问，而是把出口管制、模型可用性、网络安全防护和 jailbreak 分级框架绑定到同一次发布节奏。",
      impact: "高能力模型的可用性会受监管、地区、身份验证和安全评估影响；企业不能把 frontier 模型当成稳定无条件资源。",
      action: "把模型供应连续性写入架构：保留 fallback 模型、地区/身份限制预案、能力降级策略和安全事件沟通窗口。",
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Higher usage limits for Claude and a compute deal with SpaceX",
      url: "https://www.anthropic.com/news/higher-limits-spacex",
      publishedAt: "2026-05-20T16:00:00Z",
      summary: "Anthropic 提高 Claude Code 与 Opus API 使用限制，并披露与 SpaceX 的算力合作，说明 Claude 企业和 Agent 用量正在受供给能力约束。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Anthropic opens Seoul office and announces new partnerships across the Korean AI ecosystem",
      url: "https://www.anthropic.com/news/seoul-office-partnerships-korean-ai-ecosystem",
      publishedAt: "2026-06-17T16:00:00Z",
      summary: "Anthropic 宣布首尔办公室和韩国生态合作，强调 startup teams、Claude Code、企业客户和本地伙伴网络，说明 Claude 正从模型 API 扩展到区域产业落地。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "TCS and Anthropic partner to bring Claude to regulated industries",
      url: "https://www.anthropic.com/news/tcs-anthropic-partnership",
      publishedAt: "2026-06-12T16:00:00Z",
      summary: "Anthropic 与 TCS 合作，将 Claude 提供给 TCS 56 个国家的 50,000 名员工，并面向金融、医疗、公共部门等强监管行业构建可审计的 Claude 产品。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "Expanding Project Glasswing",
      url: "https://www.anthropic.com/news/expanding-project-glasswing",
      publishedAt: "2026-06-06T16:00:00Z",
      summary: "Anthropic 扩展 Project Glasswing，并提到 Claude Security 使用 Opus 4.8 扫描代码和建议补丁，安全研究正在产品化到企业防御流程。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic",
      sourceDetail: "Anthropic 官方 News",
      domain: "anthropic.com",
      title: "What we learned mapping a year's worth of AI-enabled cyber threats",
      url: "https://www.anthropic.com/news/AI-enabled-cyber-threats-mitre-attack",
      publishedAt: "2026-06-09T16:00:00Z",
      summary: "Anthropic 将一年 AI-enabled cyber threats 映射到 MITRE ATT&CK，并将 Project Glasswing、数据集和防御协作作为安全研究产品化路径。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Engineering",
      sourceDetail: "Anthropic 官方 Engineering",
      domain: "anthropic.com",
      title: "Quantifying infrastructure noise in agentic coding evals",
      url: "https://www.anthropic.com/engineering/infrastructure-noise",
      publishedAt: "2026-02-05T16:00:00Z",
      summary: "Anthropic 讨论 agentic coding evals 中运行环境、资源预算和约束执行方式带来的基础设施噪声，提醒比较 Claude Code/Agent 能力时必须控制测试环境。",
      imageUrl: favicon,
      priority: 4,
    },
    {
      source: "A社 Anthropic Research",
      sourceDetail: "Anthropic 官方 Research",
      domain: "anthropic.com",
      title: "Building Effective AI Agents",
      url: "https://www.anthropic.com/research/building-effective-agents",
      publishedAt: "2024-12-19T16:00:00Z",
      summary: "Anthropic 总结 agent workflows 与 agents 的差异，并把 coding agent、tool use 和 computer use reference implementation 作为可复用模式。",
      imageUrl: favicon,
      priority: 4,
    },
  ];
}

function seedOfficialAiNewsItems() {
  return [
    {
      source: "OpenAI 官方",
      sourceDetail: "OpenAI Safety / Robustness",
      domain: "openai.com",
      title: "GPT-Red: Unlocking Self-Improvement for Robustness",
      url: "https://openai.com/index/unlocking-self-improvement-gpt-red/",
      publishedAt: "2026-07-15T16:00:00Z",
      summary:
        "OpenAI 发布 GPT-Red，用自动化红队和自我改进框架持续发现 prompt injection、浏览器/开发者工具攻击和鲁棒性缺陷。信号是模型安全竞争从一次性红队报告走向可持续攻防流水线；动作是把内部 Agent 评测也改成持续攻击回放、修复验证和版本间回归。",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
      priority: 8,
    },
    {
      source: "Hugging Face 官方",
      sourceDetail: "Hugging Face Blog / Voice Evaluation",
      domain: "huggingface.co",
      title: "Introducing Real World VoiceEQ: Measuring the human quality of voice AI",
      url: "https://huggingface.co/blog",
      publishedAt: "2026-07-15T16:00:00Z",
      summary:
        "Hugging Face 7 月 15 日博客流新增 Real World VoiceEQ，强调用更贴近真实听感的方式评估语音 AI。信号是语音模型竞争正在从 demo 音色转向人类感知质量、场景鲁棒性和可比较评测；动作是把客服、陪伴、会议和无障碍输入分场景建立主观/客观混合评测。",
      imageUrl: "https://www.google.com/s2/favicons?domain=huggingface.co&sz=128",
      priority: 6,
    },
    {
      source: "Hugging Face 官方",
      sourceDetail: "Hugging Face Blog / Open Models",
      domain: "huggingface.co",
      title: "Welcome Inkling by Thinking Machines",
      url: "https://huggingface.co/blog",
      publishedAt: "2026-07-15T16:00:00Z",
      summary:
        "Hugging Face 7 月 15 日博客流收录 Thinking Machines 的 Inkling。信号是开源/开放模型生态继续吸引新一代实验室通过模型卡、权重分发和社区评测快速建立开发者入口；动作是跟踪 license、模型能力、复现实验和托管成本，而不是只看发布声量。",
      imageUrl: "https://www.google.com/s2/favicons?domain=huggingface.co&sz=128",
      priority: 5,
    },
    {
      source: "OpenAI 官方",
      sourceDetail: "OpenAI Product / Models",
      domain: "openai.com",
      title: "GPT-5.6: Frontier intelligence that scales with your ambition",
      url: "https://openai.com/index/gpt-5-6/",
      publishedAt: "2026-07-09T00:00:00Z",
      summary:
        "OpenAI 发布 GPT-5.6 Sol/Terra/Luna，强调更强的知识工作、浏览、computer use、artifact 生成、Programmatic Tool Calling、多 Agent beta、显式缓存断点和更可预测的价格/缓存策略。信号是前沿模型竞争正在从单次推理分数转向长任务代理、可编辑交付物、工具编排和成本可控性；动作是用真实报告、表格、代码修复、浏览任务和 ZDR/缓存约束做回放评测。",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
      priority: 7,
    },
    {
      source: "OpenAI 官方",
      sourceDetail: "OpenAI Product / Voice Agents",
      domain: "openai.com",
      title: "Introducing GPT-Live",
      url: "https://openai.com/index/introducing-gpt-live/",
      publishedAt: "2026-07-09T00:00:00Z",
      summary:
        "OpenAI 推出 GPT-Live，把连续语音交互与后台深度工作解耦：前台保持自然对话，复杂任务可委托给更强模型做搜索、推理和 Agent 操作。信号是语音助手架构从单模型实时应答走向“实时层 + 后台任务层”；动作是验证中断处理、委托可见性、长任务恢复、隐私提示和客服场景的人工接管。",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
      priority: 6,
    },
    {
      source: "Hugging Face 官方",
      sourceDetail: "Hugging Face Blog",
      domain: "huggingface.co",
      title: "Hugging Face Models on Foundry Managed Compute",
      url: "https://huggingface.co/blog",
      publishedAt: "2026-07-07T16:00:00Z",
      summary:
        "Hugging Face 博客最新流把模型托管到 Foundry managed compute 放在 7 月 7 日首位；信号是开源模型分发正在从下载权重扩展到托管算力、企业部署和运行时成本治理。动作是把模型卡、运行环境、权限和成本回放放到同一张选型表里。",
      imageUrl: "https://www.google.com/s2/favicons?domain=huggingface.co&sz=128",
      priority: 5,
    },
    {
      source: "Hugging Face 官方",
      sourceDetail: "Hugging Face Blog / Robotics",
      domain: "huggingface.co",
      title: "LeRobot v0.6.0: Imagine, Evaluate, Improve",
      url: "https://huggingface.co/blog",
      publishedAt: "2026-07-07T16:00:00Z",
      summary:
        "Hugging Face LeRobot v0.6.0 把机器人工作流组织成想象、评估、改进的闭环；信号是具身智能开始强调可复现实验、数据采集和评测流程，而不是单次演示。动作是优先复现离线 benchmark、仿真到真机差距和失败样本记录。",
      imageUrl: "https://www.google.com/s2/favicons?domain=huggingface.co&sz=128",
      priority: 4,
    },
    {
      source: "Google Cloud 官方",
      sourceDetail: "Google Cloud AI",
      domain: "cloud.google.com",
      title: "What Google Cloud announced in AI this month",
      url: "https://cloud.google.com/blog/products/ai-machine-learning/what-google-cloud-announced-in-ai-this-month",
      publishedAt: "2026-07-01T16:00:00Z",
      summary:
        "Google Cloud 月度 AI 汇总把 Gemini 3.5、Gemini Omni、Antigravity、Gemini Spark、Managed Agents API 和 CodeMender 放在同一组企业 Agent 更新里；信号是模型、托管 Agent、安全修复和 Workspace 自动化正在合并成平台能力。动作是按托管沙箱、权限、审计、成本和人工接管拆分验证。",
      imageUrl: "https://www.google.com/s2/favicons?domain=cloud.google.com&sz=128",
      priority: 4,
    },
    {
      source: "OpenAI 官方",
      sourceDetail: "OpenAI Research",
      domain: "openai.com",
      title: "Introducing GeneBench-Pro",
      url: "https://openai.com/news/research/",
      publishedAt: "2026-06-30T16:00:00Z",
      summary:
        "OpenAI Research 最新研究页把 GeneBench-Pro 放在 6 月 30 日首位；信号不是单点 benchmark，而是生命科学评测从问答走向专业任务集。动作上应先看任务定义、数据泄露防护、专家评分和实验复现，而不是直接把模型结论接入研发决策。",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
      priority: 5,
    },
    {
      source: "Hugging Face 官方",
      sourceDetail: "Hugging Face Blog",
      domain: "huggingface.co",
      title: "Every Eval Ever Results on Hugging Face Model Pages",
      url: "https://huggingface.co/blog",
      publishedAt: "2026-06-30T16:00:00Z",
      summary:
        "Hugging Face 最新博客流把模型页评测结果、企业 Java 迁移 Agent benchmark 和开源工具链更新放在一起；信号是开源生态正在把 eval 元数据前置到模型选择入口。动作是把模型卡、任务评测和本地回放纳入选型流程，避免只按排行榜或单篇 release 决策。",
      imageUrl: "https://www.google.com/s2/favicons?domain=huggingface.co&sz=128",
      priority: 4,
    },
    {
      source: "Google AI 官方",
      sourceDetail: "Google Developers Blog",
      domain: "developers.googleblog.com",
      title: "Build reliable multi-agent applications with ADK Go 2.0",
      url: "https://developers.googleblog.com/",
      publishedAt: "2026-06-30T16:00:00Z",
      summary:
        "Google Developers 最新流强调 ADK Go 2.0 的图式 workflow、人类介入和动态编排；这把 Gemini/Agent 平台竞争从模型能力推进到可治理 orchestration。动作是评估状态机、人工审批、失败恢复和跨语言 SDK，而不是只比较单次代码生成能力。",
      imageUrl: "https://www.google.com/s2/favicons?domain=developers.googleblog.com&sz=128",
      priority: 4,
    },
    {
      source: "OpenAI 官方",
      sourceDetail: "OpenAI Economic Research",
      domain: "openai.com",
      title: "How agents are transforming work",
      url: "https://openai.com/index/how-agents-are-transforming-work/",
      publishedAt: "2026-06-25T16:00:00Z",
      summary:
        "OpenAI 发布 Codex 经济研究：Agentic AI 把知识工作单位从短聊天变成长任务委托；到 2026 年 5 月，80.6% 抽样个人用户至少提交过一次估计超过 30 分钟人类工作量的 Codex 请求，OpenAI 内部 Codex 已成为跨部门主要 AI 工具。",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
      priority: 4,
    },
    {
      source: "Google AI 官方",
      sourceDetail: "Gemini API Release Notes",
      domain: "ai.google.dev",
      title: "Gemini API Computer Use tool public preview for Gemini 3.5 Flash",
      url: "https://ai.google.dev/gemini-api/docs/changelog",
      publishedAt: "2026-06-24T16:00:00Z",
      summary:
        "Google Gemini API 更新：Gemini 3.5 Flash 的 Computer Use 工具进入 public preview，包含 intent 化动作、浏览器/移动/桌面环境支持、可配置安全策略和 prompt injection 检测。",
      imageUrl: "https://www.google.com/s2/favicons?domain=ai.google.dev&sz=128",
      priority: 4,
    },
    {
      source: "Microsoft 官方",
      sourceDetail: "Microsoft AI / Copilot",
      domain: "blogs.microsoft.com",
      title: "Achieving success with AI",
      url: "https://blogs.microsoft.com/blog/2026/06/16/achieving-success-with-ai/",
      publishedAt: "2026-06-16T16:00:00Z",
      summary:
        "Microsoft 将 Copilot Cowork、Microsoft 365 Copilot 和 GitHub Copilot 放进统一商业化叙事，强调企业 Agent 采用正在从许可证转向可计量使用、组织数据上下文和工作流改造。",
      imageUrl: "https://www.google.com/s2/favicons?domain=blogs.microsoft.com&sz=128",
      priority: 3,
    },
  ];
}

function isGenericAnthropicSummary(summary = "") {
  const text = summary.toLowerCase();
  return !summary || text.includes("anthropic is an ai safety and research company") || text.length < 48;
}

function extractAnthropicLead(html, title = "") {
  const text = cleanupXml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
  const titleIndex = title ? text.toLowerCase().indexOf(cleanupXml(title).toLowerCase().slice(0, 80)) : -1;
  const scoped = titleIndex >= 0 ? text.slice(titleIndex, titleIndex + 5000) : text.slice(0, 5000);
  const candidates = scoped
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 80 && item.length <= 520)
    .filter((item) => !/^(research|policy|commitments|learn|news|try claude)$/i.test(item))
    .filter((item) => !item.toLowerCase().includes("skip to main content"))
    .filter((item) => !item.toLowerCase().includes("anthropic is an ai safety and research company"));
  return trimText(candidates[0] || extractFirstParagraph(html) || title, 300);
}

function rankAnthropicItems(items) {
  const priorityTerms = [
    ["opus", 9],
    ["sonnet", 8],
    ["fable", 8],
    ["mythos", 8],
    ["global workspace", 12],
    ["off switch", 12],
    ["dual use", 10],
    ["dual-use", 10],
    ["gram", 10],
    ["j-space", 12],
    ["interpretability", 8],
    ["jailbreak", 8],
    ["safeguards", 8],
    ["claude tag", 10],
    ["@claude", 10],
    ["claude code", 9],
    ["agentic coding", 9],
    ["dynamic workflows", 8],
    ["agent", 8],
    ["computer use", 8],
    ["managed agents", 8],
    ["sandbox", 7],
    ["contain", 7],
    ["reflect", 10],
    ["reflection", 10],
    ["usage recap", 9],
    ["monthly recap", 9],
    ["memory", 5],
    ["long-term benefit trust", 9],
    ["benefit trust", 8],
    ["ltbt", 8],
    ["bernanke", 8],
    ["governance", 6],
    ["cyber", 7],
    ["safety", 7],
    ["alignment", 7],
    ["misuse", 7],
    ["partnership", 6],
    ["alliance", 6],
    ["compute", 6],
    ["enterprise", 5],
    ["economic index", 7],
    ["cadences", 6],
    ["claude science", 9],
    ["science", 5],
    ["workbench", 5],
    ["teachers", 8],
    ["education", 6],
    ["educators", 6],
    ["physical ai", 8],
    ["ust", 5],
    ["hard questions", 8],
    ["public questions", 5],
    ["values", 9],
    ["language", 6],
    ["languages", 6],
    ["societal impacts", 8],
    ["value axis", 8],
    ["behavior profile", 7],
    ["survey", 4],
    ["automation", 4],
  ];
  return items
    .map((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      const sectionBoost = item.source?.includes("Research") || item.source?.includes("Engineering") ? 5 : 0;
      const signalBoost = priorityTerms.reduce((sum, [term, score]) => sum + (text.includes(term) ? score : 0), 0);
      const age = item.publishedAt ? daysBetween(new Date(item.publishedAt), new Date()) : 999;
      const recencyBoost = age <= 7 ? 8 : age <= 30 ? 5 : age <= 90 ? 2 : 0;
      const explicitPriorityBoost = Number(item.priority || 0) * 3;
      return { ...item, anthropicScore: sectionBoost + signalBoost + recencyBoost + explicitPriorityBoost };
    })
    .sort((a, b) => b.anthropicScore - a.anthropicScore || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .filter(dedupeByTitle);
}

async function buildAiHotDigest() {
  const [selectedResult, dailyResult, dailiesResult] = await Promise.allSettled([
    fetchJson("https://aihot.virxact.com/api/public/items?mode=selected&take=12"),
    fetchJson("https://aihot.virxact.com/api/public/daily"),
    fetchJson("https://aihot.virxact.com/api/public/dailies?take=5"),
  ]);

  const selectedPayload = selectedResult.status === "fulfilled" ? selectedResult.value : null;
  const dailyPayload = dailyResult.status === "fulfilled" ? dailyResult.value : null;
  const dailiesPayload = dailiesResult.status === "fulfilled" ? dailiesResult.value : null;

  if (!selectedPayload?.items?.length && !dailyPayload?.sections?.length) {
    try {
      const xml = await fetchText("https://aihot.virxact.com/feed.xml");
      const selected = parseFeedItems(xml, {
        source: "AIHOT 精选",
        domain: "aihot.virxact.com",
        priority: 3,
      })
        .slice(0, 8)
        .map(normalizeAiHotFeedItem);
      return {
        title: "AIHOT 内容抓取",
        source: "AIHOT RSS fallback",
        date: localDate(reportTimezone),
        generatedAt: new Date().toISOString(),
        summary: `AIHOT API 暂时不可用，本次使用精选 RSS 抓取 ${selected.length} 条高价值动态。`,
        stats: [
          { label: "精选条目", value: selected.length },
          { label: "接入方式", value: 3 },
          { label: "刷新频率", value: "每日" },
        ],
        sections: [],
        selected,
        recentDailies: [],
        entrypoints: buildAiHotEntrypoints(),
      };
    } catch (error) {
      return {
        title: "AIHOT 内容抓取",
        source: `fallback failed: ${String(error.message || error).slice(0, 120)}`,
        date: localDate(reportTimezone),
        generatedAt: new Date().toISOString(),
        summary: "AIHOT 内容暂时不可抓取，保留入口和接入说明，等待下次日报任务重试。",
        stats: [],
        sections: [],
        selected: [],
        recentDailies: [],
        entrypoints: buildAiHotEntrypoints(),
      };
    }
  }

  const selected = (selectedPayload?.items || []).slice(0, 10).map(normalizeAiHotApiItem);
  const sections = (dailyPayload?.sections || []).map(normalizeAiHotDailySection);
  const storyCount = sections.reduce((sum, section) => sum + section.count, 0);
  const topSections = sections
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((section) => `${section.label} ${section.count} 条`);

  return {
    title: "AIHOT 内容抓取",
    source: "AIHOT Public API",
    date: dailyPayload?.date || localDate(reportTimezone),
    generatedAt: dailyPayload?.generatedAt || new Date().toISOString(),
    summary: buildAiHotDigestSummary({ selected, sections, storyCount, topSections }),
    stats: [
      { label: "精选条目", value: selectedPayload?.count || selected.length },
      { label: "日报条目", value: storyCount || "-" },
      { label: "日报分区", value: sections.length || "-" },
      { label: "近期日报", value: dailiesPayload?.count || dailiesPayload?.items?.length || "-" },
    ],
    sections,
    selected: selected.slice(0, 8),
    recentDailies: (dailiesPayload?.items || []).slice(0, 5).map((item) => ({
      date: item.date,
      title: item.leadTitle || "AIHOT 日报",
      url: `https://aihot.virxact.com/daily/${item.date}`,
    })),
    entrypoints: buildAiHotEntrypoints(),
  };
}

function normalizeAiHotApiItem(item) {
  const base = {
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    summary: trimText(item.summary || "", 210),
    category: labelAiHotCategory(item.category),
  };
  return {
    ...base,
    signal: interpretAiNews(base),
    tags: inferAiNewsTags(base),
  };
}

function normalizeAiHotFeedItem(item) {
  return {
    title: item.title,
    url: item.url,
    source: item.sourceDetail || item.source,
    publishedAt: item.publishedAt,
    summary: trimText(item.summary || "", 210),
    category: "精选",
    signal: interpretAiNews(item),
    tags: inferAiNewsTags(item),
  };
}

function normalizeAiHotDailySection(section) {
  const items = (section.items || []).slice(0, 3).map((item) => {
    const base = {
      title: item.title,
      url: item.sourceUrl,
      source: item.sourceName,
      summary: trimText(item.summary || "", 180),
    };
    return {
      ...base,
      signal: interpretAiNews(base),
    };
  });
  return {
    label: section.label,
    count: section.items?.length || 0,
    items,
  };
}

function buildAiHotDigestSummary({ selected, sections, storyCount, topSections }) {
  const lead = selected[0]?.title || sections[0]?.items?.[0]?.title || "AIHOT 今日精选";
  const sectionText = topSections.length ? `，重点分布在 ${topSections.join("、")}` : "";
  const countText = storyCount ? `日报收录 ${storyCount} 条结构化内容${sectionText}` : `精选流抓取 ${selected.length} 条内容`;
  return `${countText}。今日优先关注「${lead}」，它会进入下方 AI 新闻流做进一步信号、影响和动作拆解。`;
}

function buildAiHotEntrypoints() {
  return [
    {
      label: "精选",
      detail: "高价值时间流",
      url: "https://aihot.virxact.com/",
    },
    {
      label: "AI 日报",
      detail: "按五类整理",
      url: "https://aihot.virxact.com/daily",
    },
    {
      label: "Agent 接入",
      detail: "Skill / RSS / API",
      url: "https://aihot.virxact.com/agent",
    },
  ];
}

function labelAiHotCategory(category = "") {
  const labels = {
    "ai-models": "模型发布",
    "ai-products": "产品更新",
    industry: "行业动态",
    research: "论文研究",
    tip: "技巧观点",
  };
  return labels[category] || "AI 动态";
}

function dedupeByTitle(item, index, items) {
  const key = normalizeTitle(item.title);
  return items.findIndex((candidate) => normalizeTitle(candidate.title) === key) === index;
}

function dedupeByCanonicalItem(item, index, items) {
  const key = canonicalItemKey(item);
  return items.findIndex((candidate) => canonicalItemKey(candidate) === key) === index;
}

function canonicalItemKey(item = {}) {
  const url = canonicalUrl(item.url || "");
  if (url) return `url:${url}`;
  return `title:${normalizeTitle(item.title)}`;
}

function canonicalUrl(value = "") {
  try {
    const url = new URL(cleanupXml(value));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|source$|ref$|rss$)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch {
    return "";
  }
}

function normalizeTitle(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 42);
}

function parseAtomEntries(xml, limit) {
  return matchBlocks(xml, "entry")
    .slice(0, limit)
    .map((entry) => ({
      title: cleanupXml(extractTag(entry, "title")),
      summary: cleanupXml(extractTag(entry, "summary")),
      publishedAt: cleanupXml(extractTag(entry, "published")),
      url: cleanupXml(extractTag(entry, "id")),
    }))
    .filter((item) => item.title && item.url);
}

function parseFeedItems(xml, feed) {
  const blocks = matchBlocks(xml, "item").length ? matchBlocks(xml, "item") : matchBlocks(xml, "entry");
  return blocks
    .map((block) => {
      const link = extractTag(block, "link") || extractAttr(block, "link", "href");
      const title = cleanupXml(extractTag(block, "title"));
      const summary = trimText(cleanupXml(extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content")), 300);
      const author = cleanupXml(extractTag(block, "author"));
      return {
        source: feed.source,
        sourceDetail: extractSourceDetail(author) || feed.source,
        domain: feed.domain,
        title,
        url: cleanupXml(link),
        publishedAt: cleanupXml(extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated")),
        summary: summary || `${feed.source} 发布新动态：${title}`,
        imageUrl: `https://www.google.com/s2/favicons?domain=${feed.domain}&sz=128`,
        priority: feed.priority || 0,
      };
    })
    .filter((item) => item.title && item.url);
}

function extractSourceDetail(author = "") {
  const match = author.match(/\(([^)]+)\)/);
  return match?.[1] || "";
}

function interpretFrontier(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (item.sourceType === "industry") {
    if (frontierTermHit(text, "ads") || frontierTermHit(text, "advertising") || frontierTermHit(text, "auction") || frontierTermHit(text, "bidding")) {
      return "大厂广告工程信号：重点看它如何把预估、竞价、预算和平台收益拆成可观测模块，可借鉴到广告排序和商业化实验设计。";
    }
    if (frontierTermHit(text, "recommend") || frontierTermHit(text, "recommendation") || frontierTermHit(text, "personalization") || frontierTermHit(text, "feed")) {
      return "大厂推荐工程信号：优先拆用户兴趣建模、候选生成、排序目标和在线反馈闭环，比单看模型结构更有迁移价值。";
    }
    if (frontierTermHit(text, "search") || frontierTermHit(text, "retrieval") || frontierTermHit(text, "query") || frontierTermHit(text, "index")) {
      return "大厂搜索工程信号：关注查询理解、召回索引、相关性排序和延迟预算之间的工程权衡，适合进入搜索/RAG 共同评估池。";
    }
    if (frontierTermHit(text, "embedding") || frontierTermHit(text, "vector") || frontierTermHit(text, "semantic")) {
      return "向量检索工程信号：重点验证向量质量、索引刷新、召回延迟和线上评测闭环，避免只把它当模型特征。";
    }
    if (frontierTermHit(text, "experiment") || frontierTermHit(text, "a/b")) {
      return "实验平台信号：搜广推迭代最终靠在线实验收敛，值得观察指标归因、流量切分和长期效应监控。";
    }
    return "大厂工程实践信号：先抽取它的系统边界、指标口径和上线约束，再判断是否能迁移到自家搜广推链路。";
  }
  if (text.includes("negative sampling")) {
    return "推荐训练信号：负采样策略会直接影响长尾泛化和在线探索，适合看它是否能缓解热门物品过拟合。";
  }
  if (text.includes("privacy") || text.includes("collusion")) {
    return "RAG/检索安全信号：多租户检索的隐私边界正在变成工程问题，适合补进权限隔离和审计清单。";
  }
  if (text.includes("chunk")) {
    return "检索工程信号：切分策略会影响召回粒度、上下文成本和答案可解释性，适合做离线 A/B 评测。";
  }
  if (text.includes("fraud")) {
    return "风控排序信号：这类方法的价值在于从“像作弊的正常行为”里挖可靠负样本，适合广告反作弊和异常检测借鉴。";
  }
  if (text.includes("ranking defense") || text.includes("poison")) {
    return "排序鲁棒性信号：检索排序一旦被投毒会影响后续生成结果，适合进入 RAG 安全和召回质量监控。";
  }
  if (text.includes("rank") || text.includes("retrieval")) {
    return "排序/召回链路信号：重点看它改的是候选集、排序结构还是评测协议，避免只被指标提升吸引。";
  }
  if (text.includes("recommend")) {
    return "推荐系统信号：优先看用户兴趣建模和在线反馈闭环，判断是否能迁移到多目标推荐场景。";
  }
  if (text.includes("advertis") || text.includes("ads")) {
    return "广告系统信号：重点看点击/转化预估、竞价机制、预算分配与平台收益之间的权衡。";
  }
  return "前沿候选：先读任务定义和实验设置，再判断它离线上排序、召回或内容理解链路有多近。";
}

function interpretAiNews(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (text.includes("gpt-5.6")) return "模型产品化信号：GPT-5.6 把前沿推理、浏览/computer use、artifact 生成、缓存断点和多 Agent 能力打包成面向知识工作的生产套件，竞争焦点从单次 benchmark 转到可交付任务。";
  if (text.includes("gpt-live")) return "实时语音 Agent 信号：OpenAI 把低延迟对话层与后台深度任务层拆开，语音入口不再只是聊天，而是可委托搜索、推理和操作的前台控制面。";
  if (text.includes("foundry managed compute")) return "开源模型企业部署信号：Hugging Face 模型进入 Foundry managed compute，说明开源权重分发正在和云端合规运行时、预置镜像、账单与观测能力绑定。";
  if (text.includes("genebench-pro")) return "专业评测信号：生命科学模型评测正在从通用问答推进到专家任务集，模型是否可用于研发决策取决于任务定义、泄露防护、专家评分和复现实验。";
  if (text.includes("google cloud announced in ai this month")) return "平台整合信号：Google Cloud 把 Gemini、Agent API、代码/安全自动化和 Workspace 能力放进同一企业 AI 更新面，客户评估会从单模型能力转向托管平台边界。";
  if (text.includes("how agents are transforming work") || text.includes("codex 已占") || text.includes("99.8%") || (text.includes("codex") && (text.includes("economic research") || text.includes("output tokens")))) return "官方 Agent 采用信号：Codex 正从工程师工具扩展到跨部门长任务委托，重点看任务时长、并行 Agent、非技术岗位采用和组织级治理。";
  if (text.includes("computer use") && text.includes("gemini")) return "官方 Computer Use 信号：浏览器、移动和桌面操作正在被纳入模型原生工具链，关键看动作空间、安全策略和 prompt injection 防护。";
  if (text.includes("daybreak") || text.includes("codex security") || text.includes("gpt-5.5-cyber") || text.includes("ai cyber threats") || text.includes("网络威胁")) return "AI 安全工程信号：安全 Agent 和攻击 Agent 同时进入实战窗口，关键看漏洞验证、权限隔离、自动补丁和人工审查闭环。";
  if (isAnthropicOfficialItem(item) || text.includes("anthropic")) {
    if (text.includes("claude code") && (text.includes("sandbox") || text.includes("filesystem") || text.includes("network isolation"))) return "A 社 Claude Code 基建信号：sandboxing 把文件系统、网络和权限提示变成 Agent 自主性的前置条件，适合直接转成企业编码 Agent 安全基线。";
    if (text.includes("agent") || text.includes("computer") || text.includes("tool")) return "A 社 Agent 信号：Claude 正在把工具使用、电脑操作和企业流程连接起来，重点看权限、审计和失败接管。";
    if (text.includes("partnership") || text.includes("office") || text.includes("ecosystem") || text.includes("enterprise") || text.includes("compute")) return "A 社企业生态信号：合作、算力和区域办公室会影响 Claude 的可用额度、企业采购路径和本地生态扩散。";
    if (text.includes("research") || text.includes("alignment") || text.includes("safety") || text.includes("contain")) return "A 社安全研究信号：值得跟进其评测、可解释性和对齐方法是否能转化为内部模型治理清单。";
    if (text.includes("opus") || text.includes("sonnet") || text.includes("fable") || text.includes("mythos") || text.includes("model")) return "A 社模型信号：Claude 系列更新需要重点拆编码能力、长任务稳定性、上下文管理和企业成本边界。";
    return "A 社生态信号：Anthropic 的产品、研究和企业合作会影响 Claude 生态、模型选型和 Agent 工作流落地节奏。";
  }
  if (text.includes("openclaw") || text.includes("grok")) return "开源 Agent 生态信号：模型厂商正在把能力接入本地优先的个人助理和多端通讯入口。";
  if (text.includes("ai results") || text.includes("操纵")) return "AI 搜索安全信号：生成式搜索开始面对 SEO 式操纵，可信排序和反作弊会成为基础能力。";
  if (text.includes("搜索框") || text.includes("ai overviews") || /\bai mode\b/i.test(text)) return "搜索产品信号：AI 搜索正在把多模态输入、对话式查询和答案生成合并成新的入口形态。";
  if (text.includes("forge") || text.includes("retry") || text.includes("工具调用") || (text.includes("reliability") && text.includes("agent")) || (text.includes("可靠性") && text.includes("agent"))) return "Agent 可靠性信号：小模型能否稳定完成复杂任务，越来越依赖重试、防护、上下文管理和步骤约束。";
  if (text.includes("4-bit") || text.includes("quant") || text.includes("量化") || text.includes("kv cache") || text.includes("推理")) return "推理基础设施信号：量化、缓存和并行化继续把长上下文、多模态和视频生成推向可部署。";
  if (text.includes("context") || text.includes("上下文") || text.includes("压缩")) return "上下文工程信号：更少 token、更准上下文正在成为搜索和 Agent 体验的核心优化点。";
  if (text.includes("codex")) return "移动编码信号：Coding Agent 正从桌面 IDE 扩展到手机端连续会话，远程协作和碎片时间处理会变重要。";
  if (text.includes("claude cowork") || text.includes("account")) return "企业 Agent 落地信号：销售、账户管理等高频流程开始被 Agent 仪表板化。";
  if (text.includes("openrouter") || text.includes("routing")) return "模型路由工程信号：缓存命中、会话粘滞和供应商切换正在变成多模型基础设施关键点。";
  if (text.includes("speech") || text.includes("voice") || text.includes("语音") || text.includes("声音") || text.includes("stability audio") || text.includes("audio")) return "音频生成信号：声音库、长音频和端侧模型并行推进，内容生产工具会继续向专业工作流靠近。";
  if (text.includes("omni") || text.includes("多模态") || text.includes("world model") || text.includes("世界模型") || text.includes("图像") || text.includes("视频")) return "多模态产品信号：模型正在从单一生成走向图文视频一体化和可编辑工作流，重点看一致性、成本和版权边界。";
  if (text.includes("sandbox") || text.includes("mcp") || text.includes("managed agents") || text.includes("cloudflare")) return "企业 Agent 基建信号：托管沙箱、私网连接和权限隔离正在成为 Agent 进入生产环境的关键门槛。";
  if (text.includes("membrane") || text.includes("万种api") || text.includes("100,000") || text.includes("api")) return "Agent 集成信号：外部 API 连接正在从逐个适配走向通用技能层，集成成本会决定 Agent 的业务覆盖面。";
  if (text.includes("karpathy") || text.includes("卡帕西") || text.includes("人才")) return "人才流动信号：顶尖研究人员去向会改变机构声量、研究议程和开发者生态预期。";
  if (text.includes("persuasion") || text.includes("说服") || text.includes("不当请求") || text.includes("ai law") || text.includes("高风险")) return "AI 安全与合规信号：模型行为、监管分类和滥用边界正在进入可测试、可审计、可追责阶段。";
  if (text.includes("hackathon") || text.includes("xprize")) return "开发者生态信号：大厂正在用黑客松把 Agent 工具推向现实问题验证。";
  if (text.includes("education") || text.includes("school") || text.includes("teacher")) return "AI 教育落地信号：重点看它如何把模型能力变成课程、教师工作流和国家级采用框架。";
  if (text.includes("singapore") || text.includes("country") || text.includes("partnership")) return "国家/产业合作信号：这类新闻更关乎本地生态、人才培养和企业采用通道。";
  if (text.includes("provenance") || text.includes("credential") || text.includes("synthid")) return "内容可信信号：AI 生成内容的来源证明正在成为平台治理和合规基础设施。";
  if (text.includes("conjecture") || text.includes("geometry") || text.includes("mathematics")) return "科学发现信号：模型开始进入可验证的数学与科研推理任务，重点看证明链路、可复现性和人机协作方式。";
  if (hasSearchSignal(text)) return "搜索体验信号：用户从关键词转向自然语言查询，会影响搜索广告、内容召回和答案呈现方式。";
  if (text.includes("i/o") || text.includes("developer")) return "平台发布信号：开发者大会类更新适合拆成模型、工具、分发渠道三条线跟进。";
  if (text.includes("workspace") || text.includes("gmail") || text.includes("docs")) return "办公产品化信号：AI 正从聊天入口渗透到具体文档、邮件和协作场景。";
  if (text.includes("meeting") || text.includes("beam")) return "协作界面信号：多模态会议体验会改变远程协作的数据采集、摘要和实时辅助空间。";
  if (text.includes("earth observation")) return "垂直模型信号：地理/遥感模型更新说明基础模型正在向行业数据模态扩散。";
  if (text.includes("model") || text.includes("benchmark")) return "模型能力或评测更新，建议关注是否改变内部模型选型和评估基线。";
  if (text.includes("agent") || text.includes("tool")) return "Agent/工具调用方向，适合评估能否进入研发工作流或数据分析流程。";
  if (text.includes("open source") || text.includes("release")) return "生态发布信号，建议关注 license、可部署性和社区迁移成本。";
  return "行业动态信号，适合纳入周度技术雷达观察。";
}

function enrichAiNews(item) {
  const tags = inferAiNewsTags(item);
  const signal = interpretAiNews(item);
  const impact = buildAiNewsImpact(item, tags);
  const action = buildAiNewsAction(item, tags);
  return {
    signal,
    interpretation: {
      signal,
      impact,
      action,
    },
    impact,
    action,
    tags,
  };
}

function inferAiNewsTags(item) {
  const text = `${item.title} ${item.summary} ${item.sourceDetail || ""}`.toLowerCase();
  const tags = [];
  if (isAnthropicOfficialItem(item) || text.includes("anthropic") || text.includes("claude")) tags.push("A社/Claude");
  if (text.includes("agent") || text.includes("智能体") || text.includes("openclaw") || text.includes("codex")) tags.push("Agent");
  if (text.includes("model") || text.includes("模型") || text.includes("grok") || text.includes("gemini") || text.includes("claude")) tags.push("模型");
  if (hasSearchSignal(text)) tags.push("搜索");
  if (text.includes("audio") || text.includes("voice") || text.includes("speech") || text.includes("声音") || text.includes("语音") || text.includes("视频") || text.includes("image") || text.includes("图像") || text.includes("多模态") || text.includes("omni")) tags.push("多模态");
  if (text.includes("security") || text.includes("安全") || text.includes("操纵") || text.includes("provenance") || text.includes("高风险") || text.includes("说服")) tags.push("安全/可信");
  if (text.includes("api") || text.includes("routing") || text.includes("缓存") || text.includes("capacity") || text.includes("sandbox") || text.includes("mcp") || text.includes("量化") || text.includes("推理")) tags.push("工程/基础设施");
  if (text.includes("education") || text.includes("school")) tags.push("教育");
  return tags.length ? tags.slice(0, 4) : ["AI"];
}

function hasSearchSignal(text) {
  return /\bsearch\b/i.test(text) || /\bai mode\b/i.test(text) || text.includes("搜索") || text.includes("perplexity");
}

function buildAiNewsImpact(item, tags) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (text.includes("gpt-5.6")) return "对企业团队的直接影响是评测口径要变：不能只看推理分数，要把浏览、文件修改、代码修复、长任务恢复、缓存成本、ZDR/合规限制和人工接管放进同一回放集。";
  if (text.includes("gpt-live")) return "实时语音会把 Agent 带进客服、销售、运营和个人助理场景，但也会放大误听、越权委托、隐私提示不足和后台任务不可见的问题。";
  if (text.includes("foundry managed compute")) return "开源模型采用门槛会从“能否下载和跑起来”转为“是否有受管运行时、供应链扫描、权限治理、成本观测和企业支持”，平台锁定与开放生态会同时增强。";
  if (text.includes("genebench-pro")) return "生命科学场景会更快把模型引入候选假设、文献分析和实验设计，但错误结论的代价高，必须把专家复核和实验复现作为默认流程。";
  if (text.includes("google cloud announced in ai this month")) return "云厂商正在把 Agent、代码、安全、搜索和办公入口合并售卖；平台团队需要比较的是权限模型、沙箱、审计、数据驻留和成本，而不是单个 demo。";
  if (text.includes("every eval ever")) return "模型选择入口正在从单一排行榜转向模型页内的多任务评测矩阵；这会降低初筛成本，但也会让团队更容易忽略本地任务和数据分布差异。";
  if (text.includes("adk go 2.0")) return "多 Agent 框架开始把 workflow、人类介入和动态编排作为基础能力，企业自建 Agent 应从 prompt demo 转向可观测状态机。";
  if (text.includes("how agents are transforming work") || text.includes("codex 已占") || text.includes("99.8%") || (text.includes("codex") && (text.includes("economic research") || text.includes("output tokens")))) return "Agent 采用的核心指标正在从“回答质量”转向“可委托工时、跨岗位渗透、并行任务量和组织流程重构”，研发效能、法务、招聘、财务等团队都需要重新定义可交付任务边界。";
  if (text.includes("computer use") && text.includes("gemini")) return "Computer Use 进入主流 API 预览后，GUI 自动化会从单厂商能力变成多模型竞争点；企业评估要同时比较动作准确率、注入防护、权限隔离和失败接管。";
  if (text.includes("achieving success with ai") || text.includes("copilot cowork")) return "微软把 Copilot 从席位销售推向 Cowork、M365 和 GitHub 的组合工作流，企业采购会更关注组织数据权限、可计量使用和流程改造收益。";
  if (text.includes("lerobot v0.6.0")) return "开源机器人栈正在把仿真、评估和改进循环产品化，具身智能团队会更依赖可复现实验而不是单次演示视频。";
  if (text.includes("prx part 4")) return "Hugging Face 持续公开数据策略，说明开源模型竞争正在回到数据构造、过滤、评测和可追溯治理。";
  if (text.includes("sglang") && (text.includes("dspark") || text.includes("speculative"))) return "推测解码从固定 draft 长度走向按请求置信度自适应，推理平台的竞争点会变成吞吐、尾延迟和无效验证成本的联合优化。";
  if (text.includes("daybreak") || text.includes("codex security") || text.includes("gpt-5.5-cyber")) return "安全 Agent 正从“辅助写脚本”进入漏洞发现、验证和修复建议链路，企业需要把它纳入 DevSecOps、审计和变更管理，而不是当成普通聊天能力。";
  if (text.includes("a2ui") || text.includes("mcp apps")) return "Google 把 A2UI 与 MCP Apps 放在同一组集成架构里，信号是 AI 应用入口正在从单点插件走向标准化应用协议。";
  if (text.includes("workload identity federation")) return "Claude Platform 接入开始强调无长期密钥的身份联合，影响企业把 Claude 接入云上工作负载和 CI/CD 的安全基线。";
  if (text.includes("claude design")) return "Claude Design 与 Claude Code 协同意味着品牌资产、设计规范和代码生成会更紧密，设计系统会成为 Agent 工作流输入。";
  if (tags.includes("A社/Claude")) return "Claude 生态的变化会直接影响 Agent 选型、企业采购、权限治理和安全评测，不能只按模型跑分决策。";
  if (tags.includes("Agent")) return "Agent 正从单点工具走向跨设备、跨应用、跨通讯入口，产品设计要考虑权限、记忆和接管机制。";
  if (tags.includes("搜索")) return "搜索正在从“更多上下文”转向“更会压缩和排序上下文”，会影响 RAG、推荐和信息流产品。";
  if (tags.includes("安全/可信")) return "AI 生成内容和搜索结果会被系统性攻击，后续要把来源证明、反作弊和审计纳入基础架构。";
  if (tags.includes("多模态")) return "多模态生成开始从玩具效果进入专业工作流，关键评估点会变成一致性、时长、成本和可编辑性。";
  if (tags.includes("工程/基础设施")) return "模型供应链会更像云资源管理：容量、缓存、路由和成本控制会成为应用护城河。";
  if (text.includes("education")) return "教育和国家级合作会扩大 AI 普及面，也会带来合规、内容质量和教师工作流重塑问题。";
  return "这条动态适合放进周度观察池，重点看它是否会改变模型选型、产品入口或工程成本结构。";
}

function buildAiNewsAction(item, tags) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (text.includes("gpt-5.6")) return "建议建立 10-20 个真实知识工作回放任务：报告、表格、代码修复、网页调查和跨工具执行分别记录完成率、人工修改、成本、延迟、权限触发和失败样本。";
  if (text.includes("gpt-live")) return "建议先做低风险语音 Agent 试点，强制展示后台任务状态、可撤销操作、敏感信息提示、人工接管按钮和完整 transcript 审计。";
  if (text.includes("foundry managed compute")) return "建议把 Hugging Face 候选模型按“模型卡 -> 托管运行时 -> 合规扫描 -> 成本/延迟 -> 回滚路径”做选型表，不要只比较开源许可证。";
  if (text.includes("genebench-pro")) return "建议生命科学/医疗研发团队只把它作为评测参考，先抽查数据集、任务定义、专家评分协议和泄露控制，再决定是否进入内部 benchmark。";
  if (text.includes("google cloud announced in ai this month")) return "建议用一个内部 Agent 流程做云平台横评：同一任务分别验证 Google、OpenAI、Anthropic 和自建方案的权限、审计、成本、失败恢复和数据边界。";
  if (text.includes("every eval ever")) return "建议把 Hugging Face 模型页评测作为候选筛选入口，但最终仍用内部任务集、成本、延迟和失败样本做回放验收。";
  if (text.includes("adk go 2.0")) return "建议用一个低风险多 Agent 流程验证 ADK：状态持久化、人类审批、失败恢复、工具权限和 trace 可读性必须一起测。";
  if (text.includes("how agents are transforming work") || text.includes("codex 已占") || text.includes("99.8%") || (text.includes("codex") && (text.includes("economic research") || text.includes("output tokens")))) return "建议把内部 Agent 试点指标改成任务级：人类等效工时、完成率、返工率、并行任务上限、敏感数据访问和跨部门 owner，而不是只统计使用人数。";
  if (text.includes("computer use") && text.includes("gemini")) return "建议建立跨模型 GUI Agent 评测集：同一批网页/桌面任务分别跑 Claude、Gemini 和现有 RPA，记录误点击、注入命中、人工接管和审计日志完整性。";
  if (text.includes("achieving success with ai") || text.includes("copilot cowork")) return "建议把 Copilot 采购评估拆成三张表：数据访问边界、真实工作流节省、审计/留痕能力，避免只按许可证折扣决策。";
  if (text.includes("lerobot v0.6.0")) return "建议机器人/自动化团队下载复现实验，记录数据采集、仿真到真机差距、评测指标和硬件失败样本。";
  if (text.includes("prx part 4")) return "建议跟踪其数据配方和过滤策略，把可追溯数据治理纳入开源模型采用清单。";
  if (text.includes("sglang") && (text.includes("dspark") || text.includes("speculative"))) return "建议在现有推理网关用离线流量回放测试 DSpark 类策略，比较吞吐、P99、显存、接受率和输出一致性。";
  if (text.includes("daybreak") || text.includes("codex security") || text.includes("gpt-5.5-cyber")) return "建议建立安全 Agent 试点清单：只读扫描、人工确认补丁、沙箱执行、审计日志和误报/漏报复盘必须同时验证。";
  if (text.includes("a2ui") || text.includes("mcp apps")) return "建议把 A2UI/MCP Apps 放入 Agent 集成雷达，比较权限模型、上下文传递、应用发现和前端承载边界。";
  if (text.includes("workload identity federation")) return "建议更新 Claude Platform 接入规范，优先验证短期凭据、最小权限、审计日志和密钥轮换流程。";
  if (text.includes("claude design")) return "建议让设计系统 owner 试跑一次品牌一致性流程，检查 token、组件、文案和 Claude Code 交付物是否可追踪。";
  if (tags.includes("A社/Claude")) return "建议更新 Claude 评测清单：模型能力、Claude Code/Agent 工作流、权限隔离、审计日志和供应连续性分开验证。";
  if (tags.includes("Agent")) return "建议记录可试用入口、权限模型和是否支持长会话，适合做 30 分钟产品体验验证。";
  if (tags.includes("搜索")) return "建议加入搜广推/RAG 观察清单，重点看压缩率、召回质量、延迟和答案质量是否同时改善。";
  if (tags.includes("安全/可信")) return "建议沉淀到 AI 安全清单，跟踪攻击方式、检测指标和平台级防御策略。";
  if (tags.includes("多模态")) return "建议收集样例和失败案例，比较一致性、可控性、生成时长和商业版权风险。";
  if (tags.includes("工程/基础设施")) return "建议纳入成本与架构评估，关注 API 价格、路由策略、缓存命中和供应商锁定。";
  return "建议保留原文链接，等后续出现产品实测、开发者反馈或生态跟进时再升级权重。";
}

function buildAiHotSourceBrief() {
  return {
    kicker: "AIHOT Source",
    title: "AIHOT 可作为 AI 资讯上游：日报、精选、分类、RSS/API/Skill",
    url: "https://mp.weixin.qq.com/s/L3OIqqrZkxDxqLA4RZB14Q",
    summary:
      "这篇文章介绍的 AIHOT 不是单条新闻，而是一套 AI 信息源：从多信源抓取、筛选、去重、打分、分类，再通过日报、精选 Feed、RSS/API/Skill 输出。",
    takeaways: [
      "日报按模型发布/更新、产品发布/更新、行业动态、论文研究、技巧与观点五类组织，适合做早间简报。",
      "精选模式像高质量时间流，适合捕捉不一定进日报、但值得跟进的产品和工程信号。",
      "支持时间窗口、分类和关键词查询，最长窗口 7 天，适合周报、专题调研和补课。",
      "RSS/API/Skill 三种接入方式说明它可以直接进入 Agent 工作流，而不是只靠人工刷网页。",
    ],
  };
}

function buildExecutiveSummary(items, frontier, aiNews) {
  const languages = items.map((item) => item.repo.language).filter(Boolean);
  const categories = items.map((item) => item.analysis.category).filter(Boolean);
  const topRepos = items.slice(0, 3).map((item) => item.repo.fullName);
  const topCategory = mostCommon(categories) || "开源工程";
  const repoSignals = items
    .slice(0, 4)
    .map((item) => item.analysis?.category)
    .filter(Boolean);
  const repoSignalText = uniqueList(repoSignals).join("、") || "当前项目的架构机制、落地路径和生产风险";
  const frontierItems = frontier.items || [];
  const frontierSources = uniqueList(frontierItems.map((item) => item.source).filter(Boolean)).slice(0, 12);
  const frontierTags = uniqueList(frontierItems.flatMap((item) => item.tags || [])).slice(0, 5);
  const anthropicItems = (aiNews.anthropicCoverage || aiNews.items || []).filter((item) => isAnthropicItem(item));
  const aiHotCount = (aiNews.items || []).filter((item) => item.source?.includes("AIHOT")).length;
  const firstRepoAction = items[0]?.analysis?.deepDive?.recommendedAction || items[0]?.analysis?.watchSignals?.[0] || "";
  const firstFrontier = frontierItems[0];
  const primaryAnthropic =
    anthropicItems.find((item) => /off switch|dual[- ]use|gram/i.test(`${item.title} ${item.summary}`)) ||
    anthropicItems.find((item) => /global workspace/i.test(item.title)) ||
    anthropicItems.find((item) => /fable.*safeguards|jailbreak framework/i.test(item.title)) ||
    anthropicItems.find((item) => /sonnet 5/i.test(item.title)) ||
    anthropicItems.find((item) => /claude science/i.test(item.title));
  const claudeTag = anthropicItems.find((item) => /claude tag/i.test(item.title));
  const claudeCodeSignals = anthropicItems
    .filter((item) => /claude code|agentic coding|sandbox|managed agents|auto mode|contain/i.test(`${item.title} ${item.summary}`))
    .sort((a, b) => (Number(/making of claude code/i.test(b.title)) - Number(/making of claude code/i.test(a.title))) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .map((item) => item.title)
    .slice(0, 3);
  const latestAnthropic = anthropicItems
    .slice()
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))[0];
  const firstAnthropic = latestAnthropic || primaryAnthropic || claudeTag || anthropicItems[0];
  const aiHotLead = (aiNews.items || []).find((item) => item.source?.includes("AIHOT"));
  return {
    headline: `今日雷达主线：GitHub 热门继续围绕 Agent 工作流、个人云和文档/设计上下文扩散；搜广推从单模型优化转向召回、排序、serving 成本和实验血缘协同；A 社把安全治理推进到可移除知识模块。`,
    bullets: [
      topRepos.length ? `GitHub 本轮由 ${topRepos.join("、")} 领跑；解读重点落在 ${repoSignalText}，采用判断不按 star 排序，而按架构机制、适用团队、落地路径、生产风险、决策问题和观察信号拆解。` : "今日暂无 GitHub 项目数据。",
      firstRepoAction ? `开源项目解读已按“架构机制 -> 适用团队 -> 落地路径 -> 生产风险 -> 决策问题 -> 观察信号”展开；本轮更适合旁路 spike 的入口是：${trimText(firstRepoAction, 120)}` : "开源项目先按架构机制、适用团队、落地路径和生产风险做小样本验证。",
      firstFrontier ? `搜广推收录 ${frontierItems.length} 条工程/研究信号，覆盖 ${frontierSources.join("、") || frontier.source}；重点从「${firstFrontier.title}」延伸到广告排序、实时上下文、企业搜索 relevance judge、模型生命周期图和工业搜索属性推荐。` : `搜广推板块收录 ${frontierItems.length} 条前沿论文/研究信号。`,
      firstAnthropic ? `A 社覆盖 ${anthropicItems.length} 条官方 News/Research/Engineering 动态，最新重点是「${firstAnthropic.title}」；安全研究主线继续观察「${primaryAnthropic?.title || "off switch / global workspace / safeguards"}」，Claude Code 相关信号包括 ${claudeCodeSignals.join("、") || "sandboxing、managed agents、auto mode"}，评估动作应拆成模型能力、权限隔离、长任务恢复、团队协作记忆、预算上限和审计边界。` : "A 社动态本次未抓到足够官方条目，下次优先重试 Anthropic News/Research/Engineering 页面。",
      `AIHOT/官方 AI 新闻共 ${aiNews.items?.length || 0} 条，其中 AIHOT ${aiHotCount} 条；今日先看「${aiHotLead?.title || "AIHOT 精选"}」，所有新闻统一写成“信号 -> 影响 -> 动作”，动作聚焦评测回放、预算治理、工具白名单、权限审计和真实工作流验证。`,
    ],
  };
}

function normalizeRepo(repo, languages, reportDate) {
  return {
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login,
    avatarUrl: repo.owner?.avatar_url,
    visualUrl: `https://opengraph.githubassets.com/${reportDate.replaceAll("-", "")}/${repo.full_name}`,
    url: repo.html_url,
    description: repo.description || "",
    stars: repo.stargazers_count,
    starsToday: repo.trending?.starsToday || 0,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    language: repo.language || Object.keys(languages)[0] || "",
    topics: repo.topics || [],
    license: repo.license?.spdx_id || "",
    pushedAt: repo.pushed_at,
    createdAt: repo.created_at,
    languages,
  };
}

function mergeRepoWithPrevious(repo, previousRepo = {}) {
  if (!previousRepo?.fullName) return repo;
  const isFallbackRepo = !repo.created_at || !repo.license || !(repo.topics || []).length;
  if (!isFallbackRepo) return repo;

  return {
    ...repo,
    owner: {
      ...(repo.owner || {}),
      login: repo.owner?.login || previousRepo.owner,
      avatar_url: previousRepo.avatarUrl || repo.owner?.avatar_url,
    },
    description: cleanupXml(repo.description || "") || previousRepo.description || "",
    forks_count: repo.forks_count || previousRepo.forks || 0,
    open_issues_count: previousRepo.openIssues ?? repo.open_issues_count ?? 0,
    topics: (repo.topics || []).length ? repo.topics : previousRepo.topics || [],
    license: repo.license || (previousRepo.license ? { spdx_id: previousRepo.license } : null),
    pushed_at: repo.created_at ? repo.pushed_at : previousRepo.pushedAt || repo.pushed_at,
    created_at: repo.created_at || previousRepo.createdAt || "",
    default_branch: repo.default_branch || "main",
  };
}

function scoreRepo(repo) {
  const stars = Math.min(45, Math.log10(Math.max(repo.stargazers_count, 1)) * 12);
  const forks = Math.min(20, Math.log10(Math.max(repo.forks_count, 1)) * 8);
  const recency = Math.max(0, 20 - daysBetween(new Date(repo.pushed_at), new Date()));
  const issuePenalty = repo.open_issues_count > 500 ? 8 : repo.open_issues_count > 100 ? 4 : 0;
  return Math.max(0, Math.min(100, Math.round(stars + forks + recency + 15 - issuePenalty)));
}

async function writeReport(report) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(path.join(dataReportsDir, `${report.date}.json`), json);
  await fs.writeFile(path.join(publicReportsDir, `${report.date}.json`), json);
  await writeReportPayload(report.date, json);
}

async function updateIndex() {
  const files = await fs.readdir(publicReportsDir).catch(() => []);
  const reports = files
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .sort()
    .reverse()
    .map((file) => ({
      date: file.replace(".json", ""),
      path: `reports/${file}`,
    }));
  await fs.writeFile(
    path.join(publicReportsDir, "index.json"),
    `${JSON.stringify({ latest: reports[0] || null, reports }, null, 2)}\n`,
  );
  await updateReportPayloadManifest(reports);
}

async function pruneOldReports(currentDate) {
  if (!Number.isFinite(reportRetentionDays) || reportRetentionDays <= 0) return;
  const cutoff = offsetDate(currentDate, -(Math.floor(reportRetentionDays) - 1));
  await Promise.all([pruneReportsInDir(publicReportsDir, cutoff), pruneReportsInDir(dataReportsDir, cutoff), prunePayloads(cutoff)]);
}

async function pruneReportsInDir(dir, cutoff) {
  const files = await fs.readdir(dir).catch(() => []);
  await Promise.all(
    files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .filter((file) => file.replace(".json", "") < cutoff)
      .map((file) => fs.unlink(path.join(dir, file)).catch(() => {})),
  );
}

async function writeReportPayload(date, json) {
  await fs.mkdir(publicPayloadsDir, { recursive: true });
  await removePayloadParts(date);
  const encoded = (await gzipAsync(Buffer.from(json, "utf8"))).toString("base64");
  const chunkSize = 900000;
  const partCount = Math.max(1, Math.ceil(encoded.length / chunkSize));
  await Promise.all(
    Array.from({ length: partCount }, (_, index) => {
      const part = encoded.slice(index * chunkSize, (index + 1) * chunkSize);
      return fs.writeFile(payloadPartPath(date, index), `${part}\n`);
    }),
  );
}

async function removePayloadParts(date) {
  const files = await fs.readdir(publicPayloadsDir).catch(() => []);
  await Promise.all(
    files
      .filter((file) => file.startsWith(`${date}.json.gz.b64.part`))
      .map((file) => fs.unlink(path.join(publicPayloadsDir, file)).catch(() => {})),
  );
}

function payloadPartPath(date, index) {
  return path.join(publicPayloadsDir, `${date}.json.gz.b64.part${String(index).padStart(2, "0")}`);
}

async function prunePayloads(cutoff) {
  const files = await fs.readdir(publicPayloadsDir).catch(() => []);
  await Promise.all(
    files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json\.gz\.b64\.part\d{2}$/.test(file))
      .filter((file) => file.slice(0, 10) < cutoff)
      .map((file) => fs.unlink(path.join(publicPayloadsDir, file)).catch(() => {})),
  );
}

async function updateReportPayloadManifest(reports) {
  const html = await fs.readFile(publicIndexHtmlPath, "utf8").catch(() => "");
  if (!html) return;
  const manifest = [
    "        const reportPayloads = {",
    ...reports.map((report) => `          "${report.path}": "reports/payloads/${report.date}.json.gz.b64.part",`),
    "        };",
  ].join("\n");
  const nextHtml = html.replace(/        const reportPayloads = \{[\s\S]*?        \};/, manifest);
  if (nextHtml !== html) await fs.writeFile(publicIndexHtmlPath, nextHtml);
}

function makeSampleReport(date) {
  const frontier = {
    title: "搜广推技术前沿",
    subtitle: "跟踪搜索、广告、推荐、排序、召回相关的新论文和工程趋势。",
    source: "sample",
    items: fallbackFrontierItems(),
  };
  const aiNews = {
    title: "AI 新闻",
    subtitle: "汇总模型、产品、开源生态与基础设施方向的近期动态。",
    source: "sample",
    items: fallbackAiNewsItems(),
  };
  const items = [
    sampleItem(1, {
      fullName: "modelcontextprotocol/servers",
      name: "servers",
      owner: "modelcontextprotocol",
      language: "TypeScript",
      stars: 128000,
      forks: 9200,
      topics: ["mcp", "agents", "tools"],
      oneLiner: "MCP 官方服务器集合，适合作为 Agent 工具接入的参考实现。",
      whyItMatters: "它把文件系统、数据库、浏览器等能力抽象为统一协议，是 Agent 工程化的关键基础设施。",
    }),
    sampleItem(2, {
      fullName: "astral-sh/uv",
      name: "uv",
      owner: "astral-sh",
      language: "Rust",
      stars: 68000,
      forks: 1900,
      topics: ["python", "package-manager", "rust"],
      oneLiner: "一个极快的 Python 包和项目管理工具。",
      whyItMatters: "它正在改变 Python 工程的依赖安装、锁文件和多环境管理方式，适合替换慢速 pip 工作流。",
    }),
    sampleItem(3, {
      fullName: "vercel/ai",
      name: "ai",
      owner: "vercel",
      language: "TypeScript",
      stars: 42000,
      forks: 5600,
      topics: ["ai", "sdk", "react"],
      oneLiner: "面向前端和全栈应用的 AI SDK。",
      whyItMatters: "它降低了流式生成、多模型接入和聊天 UI 的集成成本，适合快速搭建 AI 产品原型。",
    }),
  ];
  return {
    date,
    generatedAt: new Date().toISOString(),
    source: {
      provider: "sample",
      query: "demo data",
      since: offsetDate(date, -7),
      limit: 3,
      language: "all",
    },
    summary: buildExecutiveSummary(items, frontier, aiNews),
    items,
    frontier,
    aiNews,
  };
}

function sampleItem(rank, input) {
  const repo = {
    full_name: input.fullName,
    name: input.name,
    owner: { login: input.owner, avatar_url: `https://github.com/${input.owner}.png` },
    html_url: `https://github.com/${input.fullName}`,
    description: input.oneLiner,
    stargazers_count: input.stars,
    forks_count: input.forks,
    open_issues_count: Math.round(input.forks / 20),
    language: input.language,
    topics: input.topics,
    license: { spdx_id: "MIT" },
    pushed_at: new Date().toISOString(),
    created_at: "2024-01-01T00:00:00Z",
  };
  const languages = { [input.language]: 100000 };
  const baseAnalysis = fallbackAnalysis({ repo, readme: input.oneLiner, languages });
  return {
    rank,
    repo: normalizeRepo(repo, languages, "sample"),
    analysis: {
      ...baseAnalysis,
      oneLiner: input.oneLiner,
      whyItMatters: input.whyItMatters,
      engineeringRead: `这是一个 ${input.language} 生态项目，适合从工程集成成本、维护活跃度和与现有栈的耦合度评估。`,
      architectureSignals: [
        `主语言为 ${input.language}，工程可读性较强。`,
        `围绕 ${input.topics.join(", ")} 形成明确生态定位。`,
      ],
      valueHypothesis: ["如果当前团队已有相似痛点，可先用小场景验证。", "优先验证 API 稳定性和部署复杂度。"],
      technicalTakeaways: ["建议阅读 examples、issues 和 release notes 判断生产成熟度。"],
      adoptionRisks: ["需要确认 license、维护节奏和 breaking changes。", "热门项目不等于适配当前业务，需要小样本验证。"],
      suggestedUseCases: ["进入技术雷达观察列表。", "挑一个业务场景做 1 小时 spike。"],
      watchSignals: ["观察 issue close 速度。", "观察未来两周 release 和 stars 增速。"],
      method: "sample",
      score: Math.min(98, 70 + rank * 3),
    },
    evidence: {
      readmeExcerpt: input.oneLiner,
      githubUrl: `https://github.com/${input.fullName}`,
    },
  };
}

function fallbackFrontierItems() {
  return [
    {
      rank: 1,
      title: "多阶段召回与排序的一体化建模",
      url: "https://arxiv.org",
      source: "sample",
      publishedAt: new Date().toISOString(),
      imageUrl: "https://dummyimage.com/960x540/eef2ff/1f2a44.png&text=RecSys+Ranking",
      tags: ["ranking", "retrieval", "multi-stage"],
      summary: "从召回、粗排、精排到重排的目标一致性仍是搜广推系统的关键问题。",
      interpretation: "适合关注多目标训练、蒸馏、特征复用和线上延迟约束之间的平衡。",
    },
    {
      rank: 2,
      title: "生成式推荐与传统推荐链路的融合",
      url: "https://arxiv.org",
      source: "sample",
      publishedAt: new Date().toISOString(),
      imageUrl: "https://dummyimage.com/960x540/e8f7f1/123c33.png&text=Generative+RecSys",
      tags: ["generative", "recsys", "llm"],
      summary: "LLM/生成式模型正在进入召回、解释、用户理解和内容理解链路。",
      interpretation: "短期更适合做旁路增强和特征生成，主排序链路仍需谨慎评估成本和稳定性。",
    },
  ];
}

function fallbackAiNewsItems() {
  return [
    {
      rank: 1,
      source: "AI Radar",
      domain: "openai.com",
      title: "模型能力、Agent 工作流和开源生态仍是近期 AI 主线",
      url: "https://openai.com/news/",
      publishedAt: new Date().toISOString(),
      summary: "建议持续跟踪模型能力边界、工具调用、评测基线和企业落地安全策略。",
      imageUrl: "https://www.google.com/s2/favicons?domain=openai.com&sz=128",
      interpretation: "行业动态信号，适合纳入周度技术雷达观察。",
    },
  ];
}

function inferFrontierTags(text) {
  const lower = text.toLowerCase();
  const tags = [];
  if (frontierTermHit(lower, "recommend") || frontierTermHit(lower, "recommending") || frontierTermHit(lower, "recommendation") || frontierTermHit(lower, "recommender") || frontierTermHit(lower, "personalization") || frontierTermHit(lower, "feed") || frontierTermHit(lower, "candidate generation")) tags.push("recsys");
  if (frontierTermHit(lower, "rank") || frontierTermHit(lower, "ranking")) tags.push("ranking");
  if (frontierTermHit(lower, "retrieval") || frontierTermHit(lower, "search") || frontierTermHit(lower, "query") || frontierTermHit(lower, "index")) tags.push("retrieval");
  if (frontierTermHit(lower, "advertising") || frontierTermHit(lower, "ads") || frontierTermHit(lower, "auction") || frontierTermHit(lower, "bidding") || frontierTermHit(lower, "conversion")) tags.push("ads");
  if (frontierTermHit(lower, "embedding") || frontierTermHit(lower, "vector") || frontierTermHit(lower, "semantic")) tags.push("vector");
  if (frontierTermHit(lower, "experiment") || frontierTermHit(lower, "a/b")) tags.push("experiment");
  if (frontierTermHit(lower, "llm") || frontierTermHit(lower, "language model")) tags.push("llm");
  return tags.length ? tags.slice(0, 4) : ["frontier"];
}

function matchBlocks(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...xml.matchAll(regex)].map((match) => match[1]);
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] || "";
}

function extractAttr(block, tag, attr) {
  const match = block.match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return match?.[1] || "";
}

function extractMeta(html, name) {
  const escaped = escapeRegExp(name);
  const propertyMatch = html.match(new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"));
  if (propertyMatch) return decodeEntities(propertyMatch[1]);
  const nameMatch = html.match(new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"));
  if (nameMatch) return decodeEntities(nameMatch[1]);
  const reversedPropertyMatch = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"));
  if (reversedPropertyMatch) return decodeEntities(reversedPropertyMatch[1]);
  const reversedNameMatch = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"));
  return reversedNameMatch ? decodeEntities(reversedNameMatch[1]) : "";
}

function extractTitle(html) {
  return cleanupXml(extractTag(html, "title"));
}

function extractFirstParagraph(html) {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return cleanupXml(match?.[1] || "");
}

function parseAnthropicPublishedAt(html) {
  const dateText = cleanupXml(html.match(/<div[^>]*agate[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
  const parsed = dateText ? new Date(dateText) : null;
  if (parsed && Number.isFinite(parsed.getTime())) return parsed.toISOString();
  const published = html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] || html.match(/publishedAt["']?\s*:\s*["']([^"']+)/i)?.[1];
  const fallback = published ? new Date(published) : null;
  if (fallback && Number.isFinite(fallback.getTime())) return fallback.toISOString();
  const visibleDate = cleanupXml(html.slice(0, 7000)).match(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+20\d{2}\b/i,
  )?.[0];
  const visibleParsed = visibleDate ? new Date(visibleDate) : null;
  return visibleParsed && Number.isFinite(visibleParsed.getTime()) ? visibleParsed.toISOString() : "";
}

function cleanupXml(value) {
  return stripTags(decodeEntities(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, key) => entities[key] || `&${key};`);
}

function cleanMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+]\([^)]*\)/g, (match) => match.replace(/^\[|\]\([^)]*\)$/g, ""))
    .replace(/[#>*_`|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(text, maxLength) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function offsetDate(dateString, offsetDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function localDate(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
