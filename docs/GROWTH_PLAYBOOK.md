# Growth Playbook

This file tracks how to operate Echo Trending as a visible open-source project.

## Positioning

Echo Trending is not another GitHub trending clone. The hook is:

> "GitHub Trending, but interpreted as engineering signals in Chinese, with AI and search/ads/recommendation context."

## Audience

- AI engineers tracking coding-agent infrastructure
- backend and platform engineers looking for reusable tools
- search/ads/recommendation engineers tracking industry movement
- technical leads who need a quick daily radar
- Chinese-speaking engineers who want curated interpretation, not raw links

## Repository Setup Checklist

- Description: `Hourly Chinese technology radar for GitHub Trending, AI news, and search/ads/recommendation engineering.`
- Website: `https://eshener.github.io/echo-trending/`
- Topics:
  - `github-trending`
  - `ai-news`
  - `technology-radar`
  - `developer-tools`
  - `search-recommendation`
  - `static-site`
  - `chinese`
  - `agents`

## Weekly Operating Cadence

- Monday: inspect failed report generations and source freshness.
- Wednesday: add or remove sources based on quality.
- Friday: publish a short changelog issue with notable signals.
- Weekend: review open issues and mark good first issues.

## Launch Copy

Short:

```text
I built Echo Trending: an hourly Chinese technology radar for GitHub Trending, AI news, and search/ads/recommendation engineering.

It does not just list repos. It explains why a project matters, where it may fit, and what risks to watch.

Demo: https://eshener.github.io/echo-trending/
Repo: https://github.com/EShener/echo-trending
```

Long:

```text
GitHub Trending is useful, but raw lists are hard to turn into engineering decisions.

Echo Trending reads trending repositories, official AI updates, AIHOT signals, and search/ads/recommendation engineering sources, then turns them into a Chinese daily radar: project value, architecture signals, landing paths, production risks, and recommended actions.

It is static, open-source, and published through GitHub Pages.
```

## Star Growth Tactics

- Pin the live demo and repo link in personal profiles.
- Post weekly screenshots of the radar, not only text links.
- Open issues for source requests so users can participate without code.
- Keep the README focused on the value proposition and live demo.
- Add small, concrete `good first issue` tasks.
- Avoid over-automation that makes reports look generic.

## Metrics To Watch

- Stars per week
- Visitors to GitHub Pages
- Issues opened for source suggestions
- Repeat sources that frequently generate high-signal reports
- Failed report generation rate
