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

const args = parseArgs(process.argv.slice(2));
const reportTimezone = process.env.REPORT_TIMEZONE || "Asia/Shanghai";
const today = localDate(reportTimezone);
const reportDate = args.date || today;
const limit = Number(args.limit || process.env.TRENDING_LIMIT || 12);
const days = Number(args.days || process.env.TRENDING_DAYS || 7);
const language = args.language || process.env.TRENDING_LANGUAGE || "";
const frontierLimit = Number(process.env.FRONTIER_LIMIT || 10);
const newsLimit = Number(process.env.AI_NEWS_LIMIT || 12);
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
    const [readme, languages] = await Promise.all([
      fetchReadme(fullName, repo.default_branch),
      fetchLanguages(fullName),
    ]);
    const analysis = await analyzeRepo({ repo, readme, languages });
    items.push({
      rank: index + 1,
      repo: normalizeRepo(repo, languages, reportDate),
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

  return {
    date: reportDate,
    generatedAt: new Date().toISOString(),
    source: {
      provider: `${repoSource.provider} + arXiv + RSS`,
      query,
      since,
      limit,
      language: language || "all",
    },
    summary: buildExecutiveSummary(items, frontier, aiNews),
    items,
    frontier,
    aiNews,
  };
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
      "User-Agent": "echo-trending",
      Accept: "application/rss+xml, application/atom+xml, text/xml, text/plain, */*",
    },
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36",
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
  const teamFit = describeTeamFit(lens, repo);
  const landingPath = describeLandingPath(lens, repo, profile);
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
  const industryTarget = Math.min(maxItems, Math.max(4, Math.ceil(maxItems * 0.6)));
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
  const isAds = /\bads?\b|advertis|auction|bidding|\bctr\b|\bcvr\b|conversion|\bcpa\b|\bcpm\b/.test(text);
  const isSearch = /search|retrieval|query|index|relevance|rag/.test(text);
  const isRec = /recommend|recsys|ranking|personalization|feed|candidate/.test(text);
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
  if (isSearch || isLabeling) {
    return {
      businessProblem: "企业搜索和社区搜索的长尾查询、权限边界、语义漂移和标注稀缺会拉低相关性，人工标注又难以覆盖全部候选。",
      systemMechanism: "通过混合检索、模型化相关性评估、LLM 辅助标注或自动化 judge，把查询理解、召回、排序和质量评估串成闭环。",
      metricsAndExperiment: "重点看 NDCG/MRR、answer match、人工一致性、长尾覆盖、权限误召、P95 延迟和标注成本；线上需要观察搜索成功率与二次查询率。",
      borrowable: "适合迁移到企业知识库、RAG、客服搜索和社区内容搜索：先建立可靠评测集，再让 LLM 扩大标注覆盖。",
      boundary: "如果文档权限复杂但审计不足，或 LLM judge 没有金标校准，自动评估会把错误相关性放大到生产排序。",
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

  return results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
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

  const rawItems = feedResults
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .concat(anthropicResult)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .filter(dedupeByCanonicalItem)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const anthropicQuota = Math.min(6, Math.max(5, Math.floor(maxItems * 0.45)));
  const anthropicItems = selectAnthropicCoverage(rawItems.filter(isAnthropicItem), anthropicQuota);
  const items = pickUniqueItems(
    [
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

function selectAnthropicCoverage(items, maxItems) {
  const ranked = rankAnthropicItems(items);
  const buckets = [
    (item) => /introducing claude opus|claude opus|claude sonnet|claude haiku/i.test(`${item.title} ${item.summary}`),
    (item) => /claude code|agentic coding|computer use|dynamic workflows|managed agents|auto mode/i.test(`${item.source} ${item.title} ${item.summary}`),
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
    if (items.length) return rankAnthropicItems(items).slice(0, Math.max(maxItems, 24));
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
  return results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter(dedupeByTitle)
    .slice(0, maxItems);
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
  if (isAnthropicOfficialItem(item) || text.includes("anthropic")) {
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
  return {
    interpretation: interpretAiNews(item),
    impact: buildAiNewsImpact(item, tags),
    action: buildAiNewsAction(item, tags),
    tags,
  };
}

function inferAiNewsTags(item) {
  const text = `${item.title} ${item.summary} ${item.sourceDetail || ""}`.toLowerCase();
  const tags = [];
  if (isAnthropicOfficialItem(item) || text.includes("anthropic")) tags.push("A社/Claude");
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
  const frontierItems = frontier.items || [];
  const frontierSources = uniqueList(frontierItems.map((item) => item.source).filter(Boolean)).slice(0, 4);
  const frontierTags = uniqueList(frontierItems.flatMap((item) => item.tags || [])).slice(0, 5);
  const anthropicItems = (aiNews.items || []).filter((item) => isAnthropicItem(item));
  const aiHotCount = (aiNews.items || []).filter((item) => item.source?.includes("AIHOT")).length;
  const firstRepoAction = items[0]?.analysis?.deepDive?.recommendedAction || items[0]?.analysis?.watchSignals?.[0] || "";
  const firstFrontier = frontierItems[0];
  const firstAnthropic = anthropicItems[0];
  return {
    headline: `今日雷达主线：${topCategory} 继续升温，搜广推关注 ${frontierTags.join(" / ") || "召回排序"}，A 社动态聚焦 Claude 生态治理。`,
    bullets: [
      topRepos.length ? `GitHub 热门前三为 ${topRepos.join("、")}；主要语言是 ${mostCommon(languages) || "多语言生态"}，主题集中在 ${uniqueList(repoSignals).slice(0, 3).join("、") || "工程效率和 AI 基建"}。` : "今日暂无 GitHub 项目数据。",
      firstRepoAction ? `开源项目的采用动作：${trimText(firstRepoAction, 150)}` : "开源项目先按架构机制、适用团队、落地路径和生产风险做小样本验证。",
      firstFrontier ? `搜广推收录 ${frontierItems.length} 条，来源覆盖 ${frontierSources.join("、") || frontier.source}；首要信号是「${firstFrontier.title}」，适合按业务问题、系统机制、指标实验和采用边界拆解。` : `搜广推板块收录 ${frontierItems.length} 条前沿论文/研究信号。`,
      firstAnthropic ? `A 社覆盖 ${anthropicItems.length} 条官方 News/Research/Engineering 动态，重点包括「${firstAnthropic.title}」；动作是把模型更新、Claude Code/Agent、企业合作和安全治理分开评估。` : "A 社动态本次未抓到足够官方条目，下次优先重试 Anthropic News/Research/Engineering 页面。",
      `AIHOT/官方 AI 新闻共 ${aiNews.items?.length || 0} 条，其中 AIHOT ${aiHotCount} 条；阅读口径统一为“信号 -> 影响 -> 动作”，避免只收藏新闻标题。`,
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
    `${JSON.stringify({ reports }, null, 2)}\n`,
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
