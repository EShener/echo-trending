# Security Policy

## Supported Version

The `main` branch is the supported version.

## Reporting A Vulnerability

Please open a GitHub issue if the report does not expose sensitive data.

For sensitive issues, contact the repository owner privately before posting details publicly.

## Secrets

Never commit:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- private feed credentials
- unpublished source dumps

Use local environment variables or GitHub Actions secrets.
