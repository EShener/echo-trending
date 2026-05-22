const reportSelect = document.querySelector("#reportSelect");
const searchInput = document.querySelector("#searchInput");
const repoGrid = document.querySelector("#repoGrid");
const frontierGrid = document.querySelector("#frontierGrid");
const newsGrid = document.querySelector("#newsGrid");
const emptyState = document.querySelector("#emptyState");
const reportTitle = document.querySelector("#reportTitle");
const repoCount = document.querySelector("#repoCount");
const sourceInfo = document.querySelector("#sourceInfo");
const avgScore = document.querySelector("#avgScore");
const maxStars = document.querySelector("#maxStars");
const topLanguage = document.querySelector("#topLanguage");
const intelSources = document.querySelector("#intelSources");
const briefHeadline = document.querySelector("#briefHeadline");
const briefBullets = document.querySelector("#briefBullets");
const heroVisual = document.querySelector("#heroVisual");
const repoSectionMeta = document.querySelector("#repoSectionMeta");
const frontierMeta = document.querySelector("#frontierMeta");
const newsMeta = document.querySelector("#newsMeta");
const newsBrief = document.querySelector("#newsBrief");
const aiHotDigest = document.querySelector("#aiHotDigest");
const pageProgress = document.querySelector("#pageProgress");
const tocLinks = [...document.querySelectorAll("[data-toc-link]")];
const scrollPrevBtn = document.querySelector("#scrollPrevBtn");
const scrollNextBtn = document.querySelector("#scrollNextBtn");
const scrollTopBtn = document.querySelector("#scrollTopBtn");
const scrollBottomBtn = document.querySelector("#scrollBottomBtn");

let currentReport = null;
let revealObserver = null;
let scrollFrame = 0;

init();

async function init() {
  try {
    const index = await fetchJson("reports/index.json");
    if (!index.reports?.length) {
      renderEmpty();
      return;
    }

    reportSelect.innerHTML = index.reports
      .map((report) => `<option value="${escapeHtml(report.path)}">${escapeHtml(report.date)}</option>`)
      .join("");

    reportSelect.addEventListener("change", () => {
      searchInput.value = "";
      loadReport(reportSelect.value);
    });
    searchInput.addEventListener("input", () => renderReport(currentReport));
    setupFloatingToc();
    await loadReport(index.reports[0].path);
  } catch (error) {
    console.error(error);
    renderEmpty();
  }
}

async function loadReport(path) {
  currentReport = await fetchJson(path);
  renderReport(currentReport);
}

function renderReport(report) {
  if (!report?.items?.length) {
    renderEmpty();
    return;
  }

  emptyState.hidden = true;
  repoGrid.hidden = false;

  const keyword = searchInput.value.trim().toLowerCase();
  const allItems = report.items || [];
  const items = allItems.filter((item) => matchesKeyword(item, keyword));
  const metricItems = items.length ? items : allItems;
  const frontierItems = report.frontier?.items || [];
  const newsItems = report.aiNews?.items || [];

  reportTitle.textContent = `${report.date} 技术雷达日报`;
  repoCount.textContent = String(items.length);
  sourceInfo.textContent = `${report.source?.language || "all"} · ${formatDateTime(report.generatedAt)}`;
  avgScore.textContent = metricItems.length ? String(Math.round(avg(metricItems.map((item) => item.analysis.score || 0)))) : "-";
  maxStars.textContent = metricItems.length ? compactNumber(Math.max(...metricItems.map((item) => item.repo.stars || 0))) : "-";
  topLanguage.textContent = mostCommon(metricItems.map((item) => item.repo.language).filter(Boolean)) || "-";
  intelSources.textContent = `${frontierItems.length + newsItems.length} 条`;
  briefHeadline.innerHTML = renderBriefHeadline(report.summary?.headline || "今日暂无摘要");
  briefBullets.innerHTML = (report.summary?.bullets || []).map(renderBriefItem).join("");
  repoSectionMeta.textContent = keyword ? `${items.length}/${allItems.length} repos` : `${allItems.length} repos`;
  frontierMeta.textContent = `${frontierItems.length} signals · ${report.frontier?.source || "-"}`;
  newsMeta.textContent = `${newsItems.length} updates · ${report.aiNews?.source || "-"}`;
  renderHeroVisual(report, items.length ? items : allItems, frontierItems, newsItems);

  repoGrid.innerHTML = items.length ? items.map(safeRenderRepoCard).join("") : renderRepoEmptyState(keyword, allItems.length);
  frontierGrid.innerHTML = frontierItems.map(renderFrontierCard).join("");
  renderSourceBrief(report.aiNews?.sourceBrief);
  renderAiHotDigest(report.aiNews?.aihot);
  newsGrid.innerHTML = newsItems.map(renderNewsCard).join("");
  observeMotion();
}

function renderRepoEmptyState(keyword, totalCount) {
  return `
    <article class="repo-empty-state reveal">
      <span>Open Source Radar</span>
      <strong>${keyword ? "当前关键词没有匹配到项目" : "当前日报暂无项目"}</strong>
      <p>${keyword ? `这份日报共有 ${totalCount} 个 GitHub 项目，但没有项目匹配「${escapeHtml(keyword)}」。切换日期时已自动清空过滤；也可以手动删除关键词重新查看。` : "数据文件已加载，但项目列表为空。请等待下一次自动更新。"}</p>
    </article>
  `;
}

function safeRenderRepoCard(item, index = 0) {
  try {
    return renderRepoCard(item, index);
  } catch (error) {
    console.error("Failed to render repo card", item?.repo?.fullName || item?.repo?.name || item?.rank, error);
    return renderRepoFallbackCard(item, index);
  }
}

function renderRepoFallbackCard(item = {}, index = 0) {
  const repo = item.repo || {};
  const analysis = item.analysis || {};
  const title = repo.fullName || repo.name || `Rank #${item.rank || index + 1}`;
  return `
    <article class="repo-card repo-card-error">
      <div class="repo-card-top">
        <a class="repo-visual-link" href="${escapeAttr(repo.url || "#")}" target="_blank" rel="noreferrer">
          <img class="repo-visual repo-visual-fallback" src="${escapeAttr(repo.avatarUrl || "")}" alt="${escapeAttr(title)} preview" loading="lazy" />
        </a>
        <div class="repo-summary-panel">
          <div class="repo-head">
            <div class="repo-title">
              <a href="${escapeAttr(repo.url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
              <div class="repo-meta">#${item.rank || index + 1} · ${escapeHtml(repo.language || "Unknown")}</div>
            </div>
            <div class="score">${Number(analysis.score || 0) || "-"}</div>
          </div>
          <p class="repo-desc strong">${escapeHtml(analysis.oneLiner || repo.description || "这条项目数据已加载，但部分字段需要下次更新补齐。")}</p>
          <p class="repo-desc">已降级展示基础信息，避免单条异常影响整块项目解读。</p>
        </div>
      </div>
    </article>
  `;
}

function renderRepoCard(item, index = 0) {
  const repo = item.repo;
  const analysis = completeAnalysis(item.analysis, repo);
  const topics = repo.topics?.slice(0, 5) || [];

  return `
    <article class="repo-card" style="--delay: ${Math.min(index * 45, 360)}ms">
      <div class="repo-card-top">
        <a class="repo-visual-link" href="${escapeAttr(repo.url)}" target="_blank" rel="noreferrer">
          <img class="repo-visual" src="${escapeAttr(repo.visualUrl || repo.avatarUrl || "")}" alt="${escapeAttr(repo.fullName)} social preview" loading="lazy" onerror="this.onerror=null;this.src='${escapeAttr(repo.avatarUrl || "")}';this.classList.add('repo-visual-fallback');" />
        </a>

        <div class="repo-summary-panel">
          <div class="repo-head">
            <img class="avatar" src="${escapeAttr(repo.avatarUrl || "")}" alt="${escapeAttr(repo.owner || repo.name)}" />
            <div class="repo-title">
              <a href="${escapeAttr(repo.url)}" target="_blank" rel="noreferrer">${escapeHtml(repo.fullName)}</a>
              <div class="repo-meta">#${item.rank} · ${escapeHtml(repo.language || "Unknown")} · ${escapeHtml(repo.license || "No license")} · pushed ${formatDate(repo.pushedAt)}</div>
            </div>
            <div class="score">${Number(analysis.score || 0)}</div>
          </div>

          <p class="repo-desc strong">${escapeHtml(compactCopy(analysis.oneLiner || repo.description || "", 92))}</p>
          ${renderMicroDetail("为什么值得看", analysis.whyItMatters || "")}

          <div class="topic-row">
            ${topics.map((topic) => `<span class="topic">${escapeHtml(topic)}</span>`).join("")}
          </div>
        </div>
      </div>

      ${renderSignalBoard(analysis, repo)}

      <div class="repo-decision-row">
        ${renderMaturity(analysis.maturity)}
        <div class="decision-strip">
          <span>推荐动作</span>
          <strong>${escapeHtml(analysis.deepDive.recommendedAction || "进入技术雷达观察池，先做小范围验证。")}</strong>
        </div>
      </div>

      <details class="repo-details">
        <summary>
          <span>展开项目图解与深度解读</span>
          <strong>工业图解 / 架构信号 / 落地路径 / 风险判断</strong>
        </summary>

        ${renderProjectDiagram(analysis.diagram, repo, analysis)}

        <div class="repo-read-stack">
          <p class="engineering-read">${escapeHtml(analysis.engineeringRead || "")}</p>
          <p class="strategy-read">${escapeHtml(analysis.deepDive.strategicValue || "")}</p>
        </div>

        <div class="stat-row">
          <span class="stat">Stars ${compactNumber(repo.stars)}</span>
          <span class="stat">Forks ${compactNumber(repo.forks)}</span>
          <span class="stat">Issues ${compactNumber(repo.openIssues)}</span>
        </div>

        <div class="deep-grid">
          ${renderList("架构信号", analysis.architectureSignals)}
          ${renderList("价值假设", analysis.valueHypothesis)}
          ${renderList("技术抓手", analysis.technicalTakeaways)}
          ${renderList("落地路径", analysis.deepDive.implementationPath)}
          ${renderList("生产风险", analysis.deepDive.productionConcerns || analysis.adoptionRisks)}
          ${renderList("决策问题", analysis.deepDive.decisionQuestions)}
          ${renderList("观察指标", analysis.watchSignals)}
        </div>
      </details>
    </article>
  `;
}

function renderHeroVisual(report, items, frontierItems, newsItems) {
  if (!heroVisual) return;
  const leaders = items.slice(0, 3);
  const pins = items.slice(0, 6);
  const generatedAt = formatDateTime(report.generatedAt);

  heroVisual.innerHTML = `
    <div class="hero-mosaic">
      ${leaders.map(renderHeroTile).join("")}
    </div>
    <div class="hero-radar-card">
      <div class="radar-canvas" aria-hidden="true">
        <span class="radar-ring radar-ring-1"></span>
        <span class="radar-ring radar-ring-2"></span>
        <span class="radar-ring radar-ring-3"></span>
        <span class="radar-sweep"></span>
        ${pins
          .map((item, index) => {
            const score = clampScore(item.analysis?.score || 60);
            const x = 16 + ((score + index * 19) % 68);
            const y = 18 + ((item.repo.stars / 997 + index * 23) % 62);
            return `<span class="radar-pin radar-pin-${index % 4}" style="--x: ${x}%; --y: ${y}%"></span>`;
          })
          .join("")}
      </div>
      <div class="hero-radar-copy">
        <span>Radar Snapshot</span>
        <strong>${escapeHtml(items.length)} 个项目 · ${escapeHtml(String(frontierItems.length))} 条搜广推 · ${escapeHtml(String(newsItems.length))} 条 AI</strong>
        <small>${escapeHtml(generatedAt)}</small>
      </div>
    </div>
  `;
}

function renderHeroTile(item, index) {
  const repo = item.repo;
  return `
    <a class="hero-tile hero-tile-${index + 1}" href="${escapeAttr(repo.url)}" target="_blank" rel="noreferrer">
      <img src="${escapeAttr(repo.visualUrl || repo.avatarUrl || "")}" alt="${escapeAttr(repo.fullName)} preview" loading="lazy" onerror="this.onerror=null;this.src='${escapeAttr(repo.avatarUrl || "")}';" />
      <span>#${item.rank}</span>
      <strong>${escapeHtml(repo.fullName)}</strong>
      <em>${compactNumber(repo.stars)} stars</em>
    </a>
  `;
}

function renderBriefHeadline(value = "") {
  const compact = compactCopy(value, 58);
  return `
    <strong>${escapeHtml(compact)}</strong>
    ${renderMicroDetail("完整判断", value, compact)}
  `;
}

function renderBriefItem(item = "", index = 0) {
  const labels = ["开源", "A 社", "AIHOT", "搜广推"];
  const compact = compactCopy(item, 68);
  return `
    <li>
      <span>${escapeHtml(labels[index] || `要点 ${index + 1}`)}</span>
      <p>${escapeHtml(compact)}</p>
      ${renderMicroDetail("阅读全文", item, compact)}
    </li>
  `;
}

function renderSignalBoard(analysis, repo) {
  const diagram = analysis.diagram || {};
  const nodes = diagram.nodes || [];
  const lenses = [
    { label: "场景", value: nodes[0]?.detail || analysis.deepDive.decisionQuestions?.[0] || repo.description },
    { label: "机制", value: nodes[1]?.detail || analysis.architectureSignals?.[0] },
    { label: "接入", value: nodes[2]?.detail || analysis.deepDive.implementationPath?.[0] },
    { label: "产出", value: nodes[3]?.detail || analysis.valueHypothesis?.[0] },
  ].filter((item) => item.value);

  return `
    <section class="repo-signal-board" aria-label="项目视觉信号">
      <div class="signal-orbit" style="--score: ${clampScore(analysis.score || 0)}%">
        <span class="orbit-ring orbit-ring-a"></span>
        <span class="orbit-ring orbit-ring-b"></span>
        <span class="orbit-dot orbit-dot-a"></span>
        <span class="orbit-dot orbit-dot-b"></span>
        <span class="orbit-dot orbit-dot-c"></span>
        <div class="orbit-core">
          <span>Radar Score</span>
          <strong>${Number(analysis.score || 0)}</strong>
          <em>${escapeHtml(repo.language || "Open Source")}</em>
        </div>
      </div>
      <div class="signal-lenses">
        ${lenses
          .map(
            (lens, index) => `
              <article class="signal-lens signal-lens-${index + 1}">
                <span>${escapeHtml(lens.label)}</span>
                <strong title="${escapeAttr(lens.value)}">${escapeHtml(compactCopy(lens.value, 58))}</strong>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderProjectDiagram(diagram, repo = {}, analysis = {}) {
  const poster = completeProjectPoster(diagram, repo, analysis);
  return `
    <section class="project-diagram project-poster" aria-label="${escapeAttr(diagram.title)}">
      <div class="poster-grid-bg" aria-hidden="true"></div>
      <div class="poster-header">
        <div>
          <span class="poster-eyebrow">${escapeHtml(poster.eyebrow)}</span>
          <h4>${escapeHtml(poster.headline)}</h4>
          <p>${escapeHtml(poster.thesis)}</p>
        </div>
        <div class="poster-badge">
          <span>${escapeHtml(repo.fullName || poster.subhead)}</span>
          <strong>${escapeHtml(poster.subhead)}</strong>
        </div>
      </div>

      <div class="poster-metrics">
        ${poster.metrics.map(renderPosterMetric).join("")}
      </div>

      <div class="poster-flow">
        ${poster.lanes.map((lane, index) => renderPosterLane(lane, index, poster.lanes.length)).join("")}
      </div>

      <div class="poster-adoption">
        ${poster.adoption.map(renderPosterNote).join("")}
      </div>

      <div class="poster-warning">
        <span>采用边界</span>
        <strong>${escapeHtml(poster.warning)}</strong>
      </div>
    </section>
  `;
}

function completeProjectPoster(diagram = {}, repo = {}, analysis = {}) {
  const poster = diagram.poster || {};
  const nodes = diagram.nodes || [];
  const lanes = poster.lanes?.length
    ? poster.lanes
    : nodes.map((node, index) => ({
        ...node,
        step: `0${index + 1}`,
        signal:
          index === 0
            ? analysis.deepDive?.decisionQuestions?.[0] || "确认真实痛点"
            : index === 1
              ? analysis.architectureSignals?.[0] || "识别核心机制"
              : index === 2
                ? analysis.deepDive?.implementationPath?.[1] || "小范围接入"
                : analysis.valueHypothesis?.[0] || "验证产出价值",
      }));

  return {
    eyebrow: poster.eyebrow || "Project Blueprint",
    headline: poster.headline || analysis.category || diagram.caption || "项目蓝图",
    subhead: poster.subhead || `${repo.fullName || ""} · ${repo.language || "Open Source"}`,
    thesis:
      poster.thesis ||
      diagram.summary ||
      analysis.deepDive?.strategicValue ||
      analysis.whyItMatters ||
      "从问题、机制、接入和产出四个层面理解这个项目。",
    metrics: poster.metrics?.length
      ? poster.metrics
      : [
          { label: "Stars", value: compactNumber(repo.stars), note: "社区关注" },
          { label: "Forks", value: compactNumber(repo.forks), note: "二次采用" },
          { label: "Issues", value: compactNumber(repo.openIssues), note: "维护压力" },
          { label: "Score", value: analysis.score || "-", note: "综合评分" },
        ],
    lanes: lanes.slice(0, 4),
    adoption: poster.adoption?.length
      ? poster.adoption
      : [
          { label: "试点入口", detail: analysis.deepDive?.implementationPath?.[1] || analysis.suggestedUseCases?.[0] || "非核心路径验证" },
          { label: "验收指标", detail: analysis.valueHypothesis?.[2] || "接入成本、稳定性、维护成本" },
          { label: "阅读顺序", detail: analysis.technicalTakeaways?.[2] || "先看 examples、issues 和 release notes" },
          { label: "主要风险", detail: analysis.adoptionRisks?.[0] || "维护强度和适配成本要先验证" },
        ],
    warning: poster.warning || analysis.deepDive?.decisionQuestions?.[2] || "热门项目不等于适配当前业务，需要小样本验证。",
  };
}

function renderPosterMetric(metric) {
  return `
    <div class="poster-metric">
      <span>${escapeHtml(metric.label)}</span>
      <strong>${escapeHtml(metric.value)}</strong>
      <small>${escapeHtml(metric.note || "")}</small>
    </div>
  `;
}

function renderPosterLane(lane, index, total) {
  const isLast = index === total - 1;
  return `
    <article class="poster-lane poster-lane-${safeClass(lane.type || "node")}">
      <div class="poster-step">${escapeHtml(lane.step || `0${index + 1}`)}</div>
      <div>
        <span>${escapeHtml(lane.label)}</span>
        <strong>${escapeHtml(lane.detail)}</strong>
        <p>${escapeHtml(lane.signal || "")}</p>
      </div>
      ${isLast ? "" : `<div class="poster-arrow" aria-hidden="true"></div>`}
    </article>
  `;
}

function renderPosterNote(note) {
  return `
    <div class="poster-note">
      <span>${escapeHtml(note.label)}</span>
      <strong>${escapeHtml(note.detail)}</strong>
    </div>
  `;
}

function renderMaturity(maturity) {
  const rows = [
    ["community", "社区势能"],
    ["maintenance", "维护活跃"],
    ["production", "生产成熟"],
    ["complexity", "落地复杂"],
  ];
  return `
    <section class="maturity-panel" aria-label="成熟度雷达">
      ${rows
        .map(([key, label]) => {
          const value = clampScore(maturity[key]);
          return `
            <div class="maturity-row">
              <div class="maturity-label"><span>${label}</span><strong>${value}</strong></div>
              <div class="maturity-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-label="${label}">
                <span style="--value: ${value}%"></span>
              </div>
            </div>
          `;
        })
        .join("")}
    </section>
  `;
}

function renderFrontierCard(item, index = 0) {
  const tags = item.tags || [];
  const summary = item.summary || "";
  const interpretation = item.interpretation || "";
  const detailCopy = [summary, interpretation].filter(Boolean).join("\n\n");
  return `
    <article class="insight-card reveal" style="--delay: ${Math.min(index * 70, 350)}ms">
      <a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">
        <img class="insight-image" src="${escapeAttr(item.imageUrl || "")}" alt="${escapeAttr(item.title)}" loading="lazy" onerror="this.onerror=null;this.src='https://dummyimage.com/960x540/eef2ff/1f2a44.png&text=Research';" />
      </a>
      <div class="card-body">
        <div class="card-kicker">${escapeHtml(item.source || "source")} · ${formatDate(item.publishedAt)}</div>
        <h4><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h4>
        <p class="card-summary">${escapeHtml(compactCopy(summary || interpretation, 88))}</p>
        ${renderMicroDetail("展开解读", detailCopy, compactCopy(summary || interpretation, 88))}
        <div class="topic-row">
          ${tags.map((tag) => `<span class="topic">${escapeHtml(tag)}</span>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function renderNewsCard(item, index = 0) {
  const tags = item.tags || [];
  const newsDetail = [item.interpretation, item.impact, item.action].filter(Boolean).join("\n\n");
  return `
    <article class="news-card reveal" style="--delay: ${Math.min(index * 55, 330)}ms">
      <img class="source-logo" src="${escapeAttr(item.imageUrl || "")}" alt="${escapeAttr(item.source || "source")}" loading="lazy" onerror="this.onerror=null;this.src='https://dummyimage.com/96x96/eef2ff/1f2a44.png&text=AI';" />
      <div>
        <div class="card-kicker">${escapeHtml(item.sourceDetail || item.source || "AI News")} · ${formatDate(item.publishedAt)}</div>
        <h4><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h4>
        <p class="card-summary">${escapeHtml(compactCopy(item.summary || item.interpretation || "", 84))}</p>
        ${renderMicroDetail("信号 / 影响 / 动作", newsDetail, compactCopy(item.summary || item.interpretation || "", 84))}
        <div class="topic-row">
          ${tags.map((tag) => `<span class="topic">${escapeHtml(tag)}</span>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function renderSourceBrief(brief) {
  if (!newsBrief) return;
  if (!brief) {
    newsBrief.hidden = true;
    newsBrief.innerHTML = "";
    return;
  }
  newsBrief.hidden = false;
  newsBrief.innerHTML = `
    <div>
      <span>${escapeHtml(brief.kicker || "Source Playbook")}</span>
      <h4><a href="${escapeAttr(brief.url)}" target="_blank" rel="noreferrer">${escapeHtml(brief.title)}</a></h4>
      <p>${escapeHtml(brief.summary)}</p>
    </div>
    <ul>
      ${(brief.takeaways || []).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

function renderAiHotDigest(digest) {
  if (!aiHotDigest) return;
  if (!digest) {
    aiHotDigest.hidden = true;
    aiHotDigest.innerHTML = "";
    return;
  }

  const stats = digest.stats || [];
  const sections = digest.sections || [];
  const selected = digest.selected || [];
  const entrypoints = digest.entrypoints || [];
  const recentDailies = digest.recentDailies || [];

  aiHotDigest.hidden = false;
  aiHotDigest.innerHTML = `
    <div class="aihot-hero reveal">
      <div>
        <span class="aihot-kicker">${escapeHtml(digest.source || "AIHOT")}</span>
        <h4>${escapeHtml(digest.title || "AIHOT 内容抓取")} · ${escapeHtml(digest.date || "")}</h4>
        <p>${escapeHtml(digest.summary || "")}</p>
      </div>
      <div class="aihot-stats">
        ${stats.map((stat) => `<span><strong>${escapeHtml(stat.value)}</strong>${escapeHtml(stat.label)}</span>`).join("")}
      </div>
    </div>

    <div class="aihot-links">
      ${entrypoints.map((link) => `<a href="${escapeAttr(link.url)}" target="_blank" rel="noreferrer"><span>${escapeHtml(link.label)}</span><strong>${escapeHtml(link.detail)}</strong></a>`).join("")}
    </div>

    ${
      sections.length
        ? `<div class="aihot-section-grid">
            ${sections
              .map(
                (section) => `
                  <article class="aihot-section-card reveal">
                    <div class="aihot-section-head">
                      <span>${escapeHtml(section.label)}</span>
                      <strong>${escapeHtml(section.count)} 条</strong>
                    </div>
                    <ul>
                      ${(section.items || [])
                        .map(
                          (item) => `
                            <li>
                              <a href="${escapeAttr(item.url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
                              <p>${escapeHtml(item.signal || item.summary || "")}</p>
                              <small>${escapeHtml(item.source || "")}</small>
                            </li>
                          `,
                        )
                        .join("")}
                    </ul>
                  </article>
                `,
              )
              .join("")}
          </div>`
        : ""
    }

    ${
      selected.length
        ? `<div class="aihot-selected">
            <div class="aihot-subhead">
              <span>精选流</span>
              <strong>${escapeHtml(selected.length)} 条进入今日观察池</strong>
            </div>
            <div class="aihot-selected-grid">
              ${selected
                .map(
                  (item) => `
                    <article class="aihot-selected-card reveal">
                      <div>
                        <span>${escapeHtml(item.category || "AI 动态")} · ${formatDate(item.publishedAt)}</span>
                        <a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
                      </div>
                      <p>${escapeHtml(item.signal || item.summary || "")}</p>
                      <small>${escapeHtml(item.source || "")}</small>
                    </article>
                  `,
                )
                .join("")}
            </div>
          </div>`
        : ""
    }

    ${
      recentDailies.length
        ? `<div class="aihot-dailies">
            <span>近期日报</span>
            ${recentDailies.map((item) => `<a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.date)} · ${escapeHtml(item.title)}</a>`).join("")}
          </div>`
        : ""
    }
  `;
}

function renderList(title, items = []) {
  const visible = (items || []).filter(Boolean).slice(0, 3);
  if (!visible.length) return "";
  return `
    <div class="analysis-block">
      <h4>${escapeHtml(title)}</h4>
      <ul>${visible.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  `;
}

function completeAnalysis(analysis = {}, repo = {}) {
  const fallbackDiagram = {
    title: "项目机制图",
    caption: `${repo.language || "Open Source"} · ${repo.topics?.[0] || "radar"}`,
    nodes: [
      { label: "场景痛点", detail: repo.description || "识别团队已有痛点", type: "input" },
      { label: "核心机制", detail: analysis.architectureSignals?.[0] || "封装关键能力", type: "core" },
      { label: "接入方式", detail: analysis.suggestedUseCases?.[0] || "小范围 spike 验证", type: "integration" },
      { label: "产出价值", detail: analysis.valueHypothesis?.[0] || "沉淀可复用工程能力", type: "output" },
    ],
    links: ["需求", "能力", "落地"],
  };
  return {
    ...analysis,
    deepDive: {
      strategicValue: analysis.whyItMatters || "",
      implementationPath: analysis.suggestedUseCases || [],
      productionConcerns: analysis.adoptionRisks || [],
      decisionQuestions: ["是否能小范围验证？", "是否有清晰回滚路径？", "是否值得进入主链路？"],
      recommendedAction: "进入技术雷达观察池，先做小范围验证。",
      ...(analysis.deepDive || {}),
    },
    diagram: normalizeDiagram(analysis.diagram, fallbackDiagram),
    maturity: {
      community: clampScore(analysis.score || 60),
      maintenance: 70,
      production: 58,
      complexity: 55,
      ...(analysis.maturity || {}),
    },
  };
}

function normalizeDiagram(input, fallback) {
  const source = input && typeof input === "object" ? input : fallback;
  const nodes = Array.isArray(source.nodes) && source.nodes.length >= 4 ? source.nodes.slice(0, 4) : fallback.nodes;
  const links = Array.isArray(source.links) && source.links.length >= 3 ? source.links.slice(0, 3) : fallback.links;
  return {
    title: source.title || fallback.title,
    caption: source.caption || fallback.caption,
    summary: source.summary || fallback.summary || "",
    nodes: nodes.map((node) => ({
      label: node.label || "节点",
      detail: node.detail || "待补充",
      type: node.type || "node",
    })),
    links,
    poster: normalizePoster(source.poster, fallback.poster),
  };
}

function normalizePoster(input, fallback = {}) {
  const source = input && typeof input === "object" ? input : fallback;
  return {
    eyebrow: source.eyebrow || fallback.eyebrow || "Project Blueprint",
    headline: source.headline || fallback.headline || "",
    subhead: source.subhead || fallback.subhead || "",
    thesis: source.thesis || fallback.thesis || "",
    metrics: Array.isArray(source.metrics) ? source.metrics.slice(0, 4) : fallback.metrics || [],
    lanes: Array.isArray(source.lanes) ? source.lanes.slice(0, 4) : fallback.lanes || [],
    adoption: Array.isArray(source.adoption) ? source.adoption.slice(0, 4) : fallback.adoption || [],
    warning: source.warning || fallback.warning || "",
  };
}

function observeMotion() {
  const targets = document.querySelectorAll(".reveal");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    targets.forEach((target) => target.classList.add("is-visible"));
    return;
  }
  if (revealObserver) revealObserver.disconnect();
  const reveal = (target) => target.classList.add("is-visible");
  const revealIfNearViewport = (target) => {
    const rect = target.getBoundingClientRect();
    if (rect.top <= window.innerHeight + 180 && rect.bottom >= -180) reveal(target);
  };
  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal(entry.target);
        revealObserver.unobserve(entry.target);
      }
    },
    { rootMargin: "180px 0px", threshold: 0.01 },
  );
  targets.forEach((target) => {
    revealIfNearViewport(target);
    if (!target.classList.contains("is-visible")) revealObserver.observe(target);
  });
  window.setTimeout(() => targets.forEach(reveal), 900);
}

function setupFloatingToc() {
  if (!tocLinks.length) return;

  for (const link of tocLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.querySelector(link.getAttribute("href"));
      if (target) scrollToElement(target);
    });
  }

  scrollPrevBtn?.addEventListener("click", () => scrollToRelativeSection(-1));
  scrollNextBtn?.addEventListener("click", () => scrollToRelativeSection(1));
  scrollTopBtn?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  scrollBottomBtn?.addEventListener("click", () =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }),
  );

  window.addEventListener("scroll", scheduleFloatingTocUpdate, { passive: true });
  window.addEventListener("resize", scheduleFloatingTocUpdate);
  updateFloatingToc();
}

function scheduleFloatingTocUpdate() {
  if (scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    updateFloatingToc();
  });
}

function updateFloatingToc() {
  const targets = getTocTargets();
  const activeIndex = getCurrentTocIndex(targets);
  const activeId = targets[activeIndex]?.id || "";

  for (const link of tocLinks) {
    const isActive = link.dataset.tocLink === activeId;
    link.classList.toggle("is-active", isActive);
    if (isActive) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }

  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const progress = Math.min(100, Math.max(0, (window.scrollY / maxScroll) * 100));
  if (pageProgress) pageProgress.style.setProperty("--progress", `${progress}%`);

  setControlState(scrollPrevBtn, activeIndex <= 0 && window.scrollY < 24);
  setControlState(scrollNextBtn, activeIndex >= targets.length - 1 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 24);
}

function scrollToRelativeSection(direction) {
  const targets = getTocTargets();
  if (!targets.length) return;
  const currentIndex = getCurrentTocIndex(targets);
  const nextIndex = Math.min(targets.length - 1, Math.max(0, currentIndex + direction));
  if (nextIndex === currentIndex && direction > 0) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    return;
  }
  if (nextIndex === currentIndex && direction < 0) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  scrollToElement(targets[nextIndex]);
}

function getTocTargets() {
  return [...document.querySelectorAll("[data-toc-target]")].filter((target) => target.offsetParent !== null);
}

function getCurrentTocIndex(targets) {
  const anchor = Math.min(window.innerHeight * 0.38, 280);
  let currentIndex = 0;
  targets.forEach((target, index) => {
    if (target.getBoundingClientRect().top <= anchor) currentIndex = index;
  });
  return currentIndex;
}

function scrollToElement(target) {
  const offset = window.innerWidth <= 1180 ? 96 : 22;
  const top = target.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function setControlState(button, disabled) {
  if (!button) return;
  button.classList.toggle("is-disabled", disabled);
  button.setAttribute("aria-disabled", disabled ? "true" : "false");
}

function renderEmpty() {
  reportTitle.textContent = "暂无日报";
  repoCount.textContent = "0";
  sourceInfo.textContent = "未生成数据";
  avgScore.textContent = "-";
  maxStars.textContent = "-";
  topLanguage.textContent = "-";
  intelSources.textContent = "-";
  briefHeadline.textContent = "暂无摘要";
  briefBullets.innerHTML = "";
  if (heroVisual) heroVisual.innerHTML = "";
  repoGrid.hidden = true;
  renderSourceBrief(null);
  renderAiHotDigest(null);
  emptyState.hidden = false;
}

function compactCopy(value = "", maxLength = 80) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const sentence = text.split(/(?<=[。！？；;.!?])\s*/)[0] || "";
  if (sentence.length >= 18 && sentence.length <= maxLength + 12) return sentence;
  const boundary = text.lastIndexOf("，", maxLength);
  const cutAt = boundary > maxLength * 0.55 ? boundary : maxLength;
  return `${text.slice(0, cutAt).trim()}...`;
}

function renderMicroDetail(label, fullValue = "", compactValue = "") {
  const full = String(fullValue || "").trim();
  if (!full || full === compactValue) return "";
  return `
    <details class="micro-detail">
      <summary>${escapeHtml(label)}</summary>
      ${full
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((part) => `<p>${escapeHtml(part)}</p>`)
        .join("")}
    </details>
  `;
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch ${path}`);
  return response.json();
}

function matchesKeyword(item, keyword) {
  if (!keyword) return true;
  const haystack = [
    item.repo.fullName,
    item.repo.description,
    item.repo.language,
    ...(item.repo.topics || []),
    item.analysis.oneLiner,
    item.analysis.whyItMatters,
    item.analysis.engineeringRead,
    item.analysis.deepDive?.strategicValue,
    item.analysis.deepDive?.recommendedAction,
    ...(item.analysis.architectureSignals || []),
    ...(item.analysis.valueHypothesis || []),
    ...(item.analysis.technicalTakeaways || []),
    ...(item.analysis.deepDive?.implementationPath || []),
    ...(item.analysis.deepDive?.productionConcerns || []),
    ...(item.analysis.deepDive?.decisionQuestions || []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(keyword);
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function compactNumber(value = 0) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function safeClass(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "node";
}
