# Architecture

Echo Trending is a static reporting pipeline.

```text
scripts/daily.mjs
  |
  |-- GitHub repository discovery
  |-- source collection for AI and search/ads/recommendation signals
  |-- structured analysis
  |-- report retention
  |
  v
data/reports/YYYY-MM-DD.json
public/reports/YYYY-MM-DD.json
public/reports/index.json
  |
  v
public/index.html + public/app.js + public/styles.css
  |
  v
GitHub Pages
```

## Key Directories

- `scripts/`: report generation logic
- `data/reports/`: archived reports
- `public/`: static site and published report JSON
- `.github/workflows/`: GitHub Pages publishing workflow

## Design Principles

- Static first: no database or server required.
- Source attribution: every signal should remain linkable.
- Scan first, expand for depth: the default page should be readable in minutes.
- Retention-limited: avoid unbounded report growth in the repository.
