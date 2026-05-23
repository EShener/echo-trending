# Contributing

Echo Trending is useful when its sources are reliable and its interpretation is practical. Contributions should improve signal quality, analysis depth, or the reading experience.

## Good First Contributions

- Add a credible engineering blog, research feed, or official AI source.
- Improve a scoring rule in `scripts/daily.mjs`.
- Fix layout issues in `public/styles.css`.
- Improve accessibility or mobile readability.
- Add a regression check for report JSON shape.

## Local Setup

```bash
npm run sample
npm run serve
```

Open `http://127.0.0.1:8787`.

## Report Generation

```bash
GITHUB_TOKEN=xxx npm run daily
```

Optional:

```bash
OPENAI_API_KEY=xxx OPENAI_MODEL=your-model npm run daily
```

## Pull Request Rules

- Keep changes scoped.
- Do not commit secrets or private source material.
- Prefer official sources, primary engineering blogs, or stable RSS feeds.
- For UI changes, test at desktop and mobile widths.
- For data logic changes, include the source category and expected report impact in the PR description.

## Source Quality Bar

A good source should be:

- public and linkable
- stable enough to be fetched repeatedly
- attributable to a company, research group, maintainer, or author
- relevant to GitHub projects, AI engineering, or search/ads/recommendation systems

Avoid sources that are only repost aggregators, paywalled snippets, or unverified social posts.
