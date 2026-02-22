# gh-social-preview

Automate GitHub social preview image updates from your repository README.

This utility does two things:

1. Captures a screenshot of `https://github.com/<owner>/<repo>/blob/<default-branch>/README.md`.
2. Uploads that image to the repo's **Settings -> Social preview**.

It uses Playwright UI automation because this setting is managed in GitHub's web UI.

## Requirements

- Node.js 18+
- A GitHub account that can edit the target repo settings (typically admin access)
- Chromium installed for Playwright

## Install

From npm (recommended):

```bash
npm i -g gh-social-preview
npx playwright install chromium
```

Or without global install:

```bash
npx gh-social-preview init-auth
npx gh-social-preview --repo owner/repo
```

From source:

```bash
npm install
npx playwright install chromium
```

## Quick Start

1. Authenticate once and save browser session state:

```bash
node gh-social-preview.js init-auth
```

2. Update social preview from README screenshot:

```bash
node gh-social-preview.js --repo owner/repo
```

## Usage

```bash
node gh-social-preview.js help
```

### `init-auth`

```bash
node gh-social-preview.js init-auth [--storage-state /path/to/state.json] [--base-url https://github.com]
```

Options:

- `--storage-state` (optional): Path where Playwright session JSON is saved.
  - Default: `$XDG_STATE_HOME/gh-social-preview/auth/<host>.json`
  - Fallback when `XDG_STATE_HOME` is unset: `~/.local/state/gh-social-preview/auth/<host>.json`
- `--base-url` (optional): GitHub base URL (for GitHub Enterprise, for example).

Notes:

- Opens a visible browser window.
- Waits until login is detected, then writes storage state.

### Main command

```bash
node gh-social-preview.js --repo owner/repo [--storage-state /path/to/state.json] [options]
```

Required:

- `--repo`: `owner/repo` or full repo URL.

Optional:

- `--base-url`: Default `https://github.com`
- `--storage-state`: Default `$XDG_STATE_HOME/gh-social-preview/auth/<host>.json` (fallback: `~/.local/state/gh-social-preview/auth/<host>.json`; uses `<host>=github` for GitHub.com)
- `--width`: Default `960`
- `--height`: Default `480`
- `--format`: `png` or `jpeg` (default `jpeg`)
- `--quality`: JPEG quality `1-100` (default `80`)
- `--out`: Output path for screenshot (default `./.social-preview/<owner>__<repo>.<ext>`)
- `--headless`: `true|false` (default `true`)

## Examples

Update with visible browser and custom output:

```bash
node gh-social-preview.js \
  --repo AnswerDotAI/exhash \
  --headless false \
  --out .social-preview/exhash.jpg
```

Use against GitHub Enterprise:

```bash
node gh-social-preview.js init-auth \
  --base-url https://github.mycompany.com

node gh-social-preview.js \
  --base-url https://github.mycompany.com \
  --repo team/repo \
  --headless false
```

## Behavior Notes

- The screenshot is a viewport capture (not full page).
- README capture resolves the repo default branch via the GitHub REST API (`/repos/<owner>/<repo>`), then targets `blob/<default-branch>/README.md`, waits for `article.markdown-body`, and hides GitHub's sticky blob header (`Preview | Code | Blame`) before taking the screenshot.
- Upload supports both states:
  - no existing social card: adds a new one
  - existing social card: replaces it
- If a JPEG output is over 1MB, the script retries with lower JPEG quality.
- If PNG output is over 1MB, the script warns but does not auto-convert.
- Upload completion primarily uses GitHub's upload response (`/upload/repository-images/...`) plus non-empty social-image id; unchanged id is accepted for identical-image replacements.

## Troubleshooting

- Redirected to `/login` during run:
  - Re-run `init-auth` and use the same base URL + storage-state path (or default host path).
- Previously used `./.auth/<host>.json` defaults:
  - Move that file to the XDG default path above (or pass `--storage-state` explicitly).
- README container not found:
  - Repo likely does not have a root `README.md` on its default branch, or GitHub markup/layout changed.
- Failed to query repo metadata from GitHub API:
  - Ensure the repository exists and is publicly accessible.
- Upload controls not found:
  - GitHub UI may have changed; selectors in `gh-social-preview.js` may need updating.
- Permission errors in settings:
  - Ensure your account has admin-level access for that repository.

## Security

`--storage-state` contains authenticated browser session data. Treat it like a credential.

Recommended `.gitignore` entries:

```gitignore
.auth/
.social-preview/
```

## License

ISC
