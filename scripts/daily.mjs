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
    const previousLanguages = previousReport?.items?.find((item) => item.repo?.fullName === fullName)?.repo?.languages || {};
    const [readme, languages] = await Promise.all([
      fetchReadme(fullName, repo.default_branch),
      fetchLanguages(fullName),
    ]);
    const stableLanguages = Object.keys(languages || {}).length ? languages : previousLanguages;
    const analysis = await analyzeRepo({ repo, readme, languages: stableLanguages });
    items.push({
      rank: index + 1,
      repo: normalizeRepo(repo, stableLanguages, reportDate),
      analysis,
      evidence: {
        readmeExcerpt: trimText(cleanMarkdown(readme || repo.description || ""), 900),
        githubUrl: repo.html_url,
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
      provider: `${repoSource.provider} + arXiv + RSS + Codex curated official/source review`,
      query,
      since,
      limit,
      language: language || "all",
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
    method: "codex-research-refresh",
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
  const selected = pickUniqueItems(
    [
      ...industryItems.slice(0, industryTarget),
      ...arxivItems.slice(0, Math.max(0, maxItems - industryTarget)),
      ...industryItems,
      ...arxivItems,
    ],
    maxItems,
  ).map((item, index) => {
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

function normalizeFrontierInterpretation(item) {
  if (item.interpretation && typeof item.interpretation === "object" && item.interpretation.businessProblem) {
    return item.interpretation;
  }
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
      frontierScore: 33,
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
      frontierScore: 33,
      summary: "Airbnb 回顾 Relevance and Personalization 团队在 CIKM 2025 的搜索与推荐论文，重点是双边 marketplace 中搜索排序、位置检索、反事实评估和长期预订意图建模。",
    },
    {
      title: "推荐系统为啥都长一个样？聊聊「离线训练 + 在线召回 + 排序」这套大数据架构",
      url: "https://cloud.tencent.com/developer/article/2625122",
      publishedAt: "2026-01-28T13:33:51Z",
      source: "Tencent Cloud Developer",
      domain: "cloud.tencent.com",
      sourceType: "industry",
      frontierScore: 32,
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
  const anthropicQuota = Math.min(18, Math.max(12, Math.ceil(maxItems * 0.8)));
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
    items: items.length ? items : fallbackAiNewsItems(),
  };
}

function isAnthropicItem(item) {
  return isAnthropicOfficialItem(item);
}

function isAnthropicOfficialItem(item = {}) {
  const source = `${item.source || ""} ${item.sourceDetail || ""}`.toLowerCase();
  const url = `${item.domain || ""} ${item.url || ""}`.toLowerCase();
  return source.includes("anthropic") || source.includes("a社") || url.includes("anthropic.com");
}

function buildAnthropicSection(aiNews = {}) {
  const items = (aiNews.items || [])
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

function selectAnthropicCoverage(items, maxItems) {
  const ranked = rankAnthropicItems(items);
  const buckets = [
    (item) => /introducing claude opus|claude opus|claude sonnet|claude haiku/i.test(`${item.title} ${item.summary}`),
    (item) => /claude tag|@claude|claude code|agentic coding|computer use|dynamic workflows|managed agents|auto mode/i.test(`${item.source} ${item.title} ${item.summary}`),
    (item) => /partnership|alliance|regulated|compute|enterprise|tcs|dxc|spacex|seoul|corps/i.test(`${item.title} ${item.summary}`),
    (item) => /cyber|safety|alignment|misuse|autonomy|trustworthy|contain|teaching claude why|attack/i.test(`${item.source} ${item.title} ${item.summary}`),
    (item) => /engineering|managed agents|auto mode|sandbox|contain|harness|tool use|context engineering/i.test(`${item.source} ${item.title} ${item.summary}`),
  ];
  const selected = [];
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
    ["cyber", 7],
    ["safety", 7],
    ["alignment", 7],
    ["misuse", 7],
    ["partnership", 6],
    ["alliance", 6],
    ["compute", 6],
    ["enterprise", 5],
  ];
  return items
    .map((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      const sectionBoost = item.source?.includes("Research") || item.source?.includes("Engineering") ? 5 : 0;
      const signalBoost = priorityTerms.reduce((sum, [term, score]) => sum + (text.includes(term) ? score : 0), 0);
      const age = item.publishedAt ? daysBetween(new Date(item.publishedAt), new Date()) : 999;
      const recencyBoost = age <= 7 ? 8 : age <= 30 ? 5 : age <= 90 ? 2 : 0;
      return { ...item, anthropicScore: sectionBoost + signalBoost + recencyBoost };
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
  if (text.includes("how agents are transforming work") || text.includes("codex 已占") || text.includes("99.8%") || (text.includes("codex") && (text.includes("economic research") || text.includes("output tokens")))) return "Agent 采用的核心指标正在从“回答质量”转向“可委托工时、跨岗位渗透、并行任务量和组织流程重构”，研发效能、法务、招聘、财务等团队都需要重新定义可交付任务边界。";
  if (text.includes("computer use") && text.includes("gemini")) return "Computer Use 进入主流 API 预览后，GUI 自动化会从单厂商能力变成多模型竞争点；企业评估要同时比较动作准确率、注入防护、权限隔离和失败接管。";
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
  if (text.includes("how agents are transforming work") || text.includes("codex 已占") || text.includes("99.8%") || (text.includes("codex") && (text.includes("economic research") || text.includes("output tokens")))) return "建议把内部 Agent 试点指标改成任务级：人类等效工时、完成率、返工率、并行任务上限、敏感数据访问和跨部门 owner，而不是只统计使用人数。";
  if (text.includes("computer use") && text.includes("gemini")) return "建议建立跨模型 GUI Agent 评测集：同一批网页/桌面任务分别跑 Claude、Gemini 和现有 RPA，记录误点击、注入命中、人工接管和审计日志完整性。";
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
  const anthropicItems = (aiNews.items || []).filter((item) => isAnthropicItem(item));
  const aiHotCount = (aiNews.items || []).filter((item) => item.source?.includes("AIHOT")).length;
  const firstRepoAction = items[0]?.analysis?.deepDive?.recommendedAction || items[0]?.analysis?.watchSignals?.[0] || "";
  const firstFrontier = frontierItems[0];
  const claudeTag = anthropicItems.find((item) => /claude tag/i.test(item.title));
  const claudeCodeSignals = anthropicItems
    .filter((item) => /claude code|agentic coding|sandbox|managed agents|auto mode|contain/i.test(`${item.title} ${item.summary}`))
    .map((item) => item.title)
    .slice(0, 3);
  const firstAnthropic = claudeTag || anthropicItems[0];
  const aiHotLead = (aiNews.items || []).find((item) => item.source?.includes("AIHOT"));
  return {
    headline: `今日雷达主线：GitHub 热门继续围绕 Agent 工作流、个人云和文档/设计上下文扩散；搜广推从单模型优化转向召回、排序、serving 成本和实验血缘协同；A 社把 Claude 推向团队频道、长任务执行和安全治理。`,
    bullets: [
      topRepos.length ? `GitHub 本轮由 ${topRepos.join("、")} 领跑；解读重点落在 ${repoSignalText}，采用判断不按 star 排序，而按架构机制、适用团队、落地路径、生产风险、决策问题和观察信号拆解。` : "今日暂无 GitHub 项目数据。",
      firstRepoAction ? `开源项目解读已按“架构机制 -> 适用团队 -> 落地路径 -> 生产风险 -> 决策问题 -> 观察信号”展开；本轮更适合旁路 spike 的入口是：${trimText(firstRepoAction, 120)}` : "开源项目先按架构机制、适用团队、落地路径和生产风险做小样本验证。",
      firstFrontier ? `搜广推收录 ${frontierItems.length} 条工程/研究信号，覆盖 ${frontierSources.join("、") || frontier.source}；重点从「${firstFrontier.title}」延伸到广告排序、实时上下文、企业搜索 relevance judge、模型生命周期图和工业搜索属性推荐。` : `搜广推板块收录 ${frontierItems.length} 条前沿论文/研究信号。`,
      firstAnthropic ? `A 社覆盖 ${anthropicItems.length} 条官方 News/Research/Engineering 动态，新增重点是「${firstAnthropic.title}」；Claude Code 相关信号包括 ${claudeCodeSignals.join("、") || "sandboxing、managed agents、auto mode"}，评估动作应拆成模型能力、权限隔离、长任务恢复、团队协作记忆、预算上限和审计边界。` : "A 社动态本次未抓到足够官方条目，下次优先重试 Anthropic News/Research/Engineering 页面。",
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
  if (frontierTermHit(lower, "recommend") || frontierTermHit(lower, "recommendation") || frontierTermHit(lower, "recommender") || frontierTermHit(lower, "personalization") || frontierTermHit(lower, "feed") || frontierTermHit(lower, "candidate generation")) tags.push("recsys");
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
