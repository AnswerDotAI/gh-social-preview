# DEV Notes

## Scope

This repo is a Playwright-based CLI that:

1. captures a README screenshot from `blob/main/README.md`
2. uploads it as GitHub Social preview

Use this file for release steps and manual validation workflow.

## Process-First Debugging (CLI Before JS)

When fixing automation behavior, validate the exact browser interaction with `playwright-cli` first, then port the working sequence into `gh-social-preview.js`.

Recommended loop:

1. Open browser/session:
```bash
playwright-cli open
playwright-cli state-load .auth/github.json
```
2. Navigate and inspect:
```bash
playwright-cli goto https://github.com/<owner>/<repo>/blob/main/README.md
playwright-cli resize 1280 640
playwright-cli snapshot
```
3. Test selectors/actions directly:
```bash
playwright-cli eval "() => document.querySelector('article.markdown-body') !== null"
playwright-cli screenshot --filename /tmp/readme-test.jpg
```
4. Validate upload path manually:
```bash
playwright-cli goto https://github.com/<owner>/<repo>/settings
playwright-cli snapshot
```
5. Confirm a stable sequence before coding:
   - element exists
   - click target is deterministic
   - upload control appears in both add/replace states
   - completion signal is unambiguous

Only after this works manually should selectors/timing logic be implemented in JS.

## Release Process (npm + GitHub Actions)

This repo publishes from GitHub Actions on tag push (`v*`) via Trusted Publishing.

Minimal release flow:

```bash
npm version patch   # or: npm version minor / npm version major / npm version 0.0.X
git push --follow-tags
v=$(node -p "require('./package.json').version")
gh release create "v${v}" --title "v${v}" --generate-notes
```
