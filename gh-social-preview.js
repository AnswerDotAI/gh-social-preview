#!/usr/bin/env node
/**
 * gh-social-preview.js
 *
 * Automates:
 *   - screenshot of a repo README (1280x640 viewport)
 *   - upload as the repo's Social preview image (Open Graph image) in Settings
 *
 * Why UI automation?
 * GitHub documents the feature in the web UI and its constraints (PNG/JPG/GIF under 1MB,
 * recommend 1280x640). There isn't a stable public API for this, so browser automation is
 * usually the most robust approach.
 *
 * Commands:
 *   1) Init auth (interactive login, saves cookies/session):
 *        node gh-social-preview.js init-auth
 *
 *   2) Update social preview from README screenshot:
 *        node gh-social-preview.js update --repo owner/repo
 *
 * Options (both commands):
 *   --base-url https://github.com        (or your GHE base url)
 *   --storage-state .auth/<host>.json    (default: .auth/github.json for github.com)
 *   --headless true|false               (default: true for update, false for init-auth)
 *
 * Options (update):
 *   --width 1280
 *   --height 640
 *   --format png|jpeg                   (default: jpeg)
 *   --quality 80                        (jpeg only; default: 80)
 *   --out ./social-preview.jpg          (default: ./.social-preview/<owner>__<repo>.<ext>)
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function parseArgs(argv) {
  // Minimal flag parser: --key value, or --flag (boolean true)
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function toBool(v, defVal) {
  if (v === undefined) return defVal;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}

function toInt(v, defVal) {
  if (v === undefined) return defVal;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : defVal;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function bytes(n) {
  // pretty
  const units = ["B", "KB", "MB", "GB"];
  let x = n;
  let u = 0;
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024;
    u++;
  }
  return `${x.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

function normalizeBaseUrl(baseUrl) {
  const u = baseUrl ? String(baseUrl).trim() : "https://github.com";
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function normalizeRepo(repoOrUrl) {
  const s = String(repoOrUrl || "").trim();
  if (!s) throw new Error("Missing --repo (expected owner/repo or a GitHub repo URL).");

  if (s.includes("://")) {
    const u = new URL(s);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid repo URL: ${s}`);
    return `${parts[0]}/${parts[1]}`;
  }

  // allow owner/repo, with common characters
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s;

  // allow passing just "owner/repo#something" etc
  const hashSplit = s.split("#")[0];
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(hashSplit)) return hashSplit;

  throw new Error(`Invalid --repo "${s}". Expected "owner/repo" or a GitHub repo URL.`);
}

function defaultOutPath(repo, format) {
  const [owner, name] = repo.split("/");
  const dir = path.join(process.cwd(), ".social-preview");
  ensureDir(dir);
  const ext = format === "png" ? "png" : "jpg";
  return path.join(dir, `${owner}__${name}.${ext}`);
}

function defaultStorageStatePath(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const stem = host === "github.com" ? "github" : host.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(process.cwd(), ".auth", `${stem}.json`);
}

const readmeSelector = "article.markdown-body";

async function hideBlobChrome(page) {
  await page.evaluate(() => {
    // Remove GitHub's sticky blob header (Preview/Code/Blame + file controls) from captures.
    for (const sel of ["#repos-sticky-header", ".react-blob-header"]) {
      for (const el of document.querySelectorAll(sel)) el.style.display = "none";
    }
  });
}

async function openAndPositionReadme(page, repoUrl, timeoutMs = 20_000) {
  const url = `${repoUrl}/blob/main/README.md`;
  console.log(`Opening README: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const readme = page.locator(readmeSelector).first();
  await readme.waitFor({ state: "visible", timeout: timeoutMs });
  await readme.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await hideBlobChrome(page);
  await page.waitForTimeout(150);
  return url;
}

async function launchContext({ storageStatePath, headless, width, height }) {
  const browser = await chromium.launch({ headless });
  const contextOptions = {
    viewport: width && height ? { width, height } : undefined,
  };

  if (storageStatePath) {
    if (!fs.existsSync(storageStatePath)) {
      throw new Error(
        `Storage state not found at "${storageStatePath}". Run:\n` +
          `  node gh-social-preview.js init-auth --storage-state ${storageStatePath}`
      );
    }
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // A small robustness tweak: sometimes GitHub pages use lazy loading.
  page.setDefaultTimeout(30_000);

  return { browser, context, page };
}

async function initAuth({ baseUrl, storageStatePath }) {
  if (!storageStatePath) {
    throw new Error("init-auth requires --storage-state <path>");
  }
  ensureDir(path.dirname(storageStatePath));

  const { browser, context, page } = await launchContext({
    storageStatePath: null,
    headless: false,
    width: 1280,
    height: 720,
  });

  console.log(`Opening ${baseUrl}/login ...`);
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });

  console.log(
    "\nLog into GitHub in the opened browser (including 2FA if enabled).\n" +
      "This script will automatically detect that you're logged in and then save your session.\n"
  );

  // GitHub pages include <meta name="user-login" content="..."> when logged in.
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);

  await page.waitForFunction(() => {
    const loginMeta = document.querySelector('meta[name="user-login"]')?.content?.trim();
    if (loginMeta) return true;

    // user menu appears when logged in
    const userMenu =
      document.querySelector('summary[aria-label="View profile and more"]') ||
      document.querySelector('summary[aria-label="Open user account menu"]') ||
      document.querySelector('button[data-login]'); // fallback-ish
    return !!userMenu;
  }, null, { timeout: 0, polling: 500 });

  const username = await page.evaluate(() => {
    return document.querySelector('meta[name="user-login"]')?.content?.trim() || "";
  });

  await context.storageState({ path: storageStatePath });
  await browser.close();

  console.log(`✅ Saved storage state for @${username} to: ${storageStatePath}`);
}

async function captureReadmeScreenshot({
  baseUrl,
  repo,
  storageStatePath,
  outPath,
  width,
  height,
  format,
  quality,
  headless,
}) {
  const repoUrl = `${baseUrl}/${repo}`;

  const { browser, page } = await launchContext({
    storageStatePath: storageStatePath || null,
    headless,
    width,
    height,
  });

  const usedReadmeUrl = await openAndPositionReadme(page, repoUrl, 20_000);

  // Take viewport screenshot at exactly width x height.
  ensureDir(path.dirname(outPath));

  const shotOpts = {
    path: outPath,
    fullPage: false,
  };

  if (format === "png") {
    shotOpts.type = "png";
  } else {
    shotOpts.type = "jpeg";
    shotOpts.quality = quality; // 0-100
  }

  await page.screenshot(shotOpts);
  await browser.close();

  const size = fs.statSync(outPath).size;
  console.log(`✅ Screenshot saved: ${outPath} (${bytes(size)}) from ${usedReadmeUrl}`);

  // GitHub wants < 1 MB for social preview images (per docs).
  // If we exceed, re-encode by re-taking a JPEG at lower quality (no extra deps).
  if (size > 1_000_000) {
    if (format === "jpeg") {
      console.warn(
        `⚠️ Screenshot is > 1MB (${bytes(size)}). Retrying with lower JPEG quality...`
      );
      // Try a few qualities.
      const qualities = [70, 60, 50, 40, 30];
      for (const q of qualities) {
        const tmpPath = outPath; // overwrite
        await (async () => {
          const { browser: b2, page: p2 } = await launchContext({
            storageStatePath: storageStatePath || null,
            headless,
            width,
            height,
          });
          await openAndPositionReadme(p2, repoUrl, 20_000);
          await p2.screenshot({ path: tmpPath, type: "jpeg", quality: q, fullPage: false });
          await b2.close();
        })();
        const newSize = fs.statSync(outPath).size;
        console.log(`   -> JPEG quality ${q}: ${bytes(newSize)}`);
        if (newSize <= 1_000_000) break;
      }
    } else {
      console.warn(
        `⚠️ PNG screenshot is > 1MB (${bytes(size)}). Consider using --format jpeg --quality 80`
      );
    }
  }

  return outPath;
}

async function uploadSocialPreview({
  baseUrl,
  repo,
  storageStatePath,
  imagePath,
  headless,
}) {
  if (!storageStatePath) {
    throw new Error("upload requires --storage-state <path> (you must be logged in).");
  }
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const repoUrl = `${baseUrl}/${repo}`;
  const settingsUrl = `${repoUrl}/settings`;

  const { browser, page } = await launchContext({
    storageStatePath,
    headless,
    width: 1280,
    height: 720,
  });

  console.log(`Opening Settings: ${settingsUrl}`);
  await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });

  // If we got bounced to login, stop.
  if (page.url().includes("/login")) {
    await browser.close();
    throw new Error(
      "Not logged in (redirected to /login). Re-run init-auth and try again."
    );
  }

  // We use .js-repository-image-id to confirm upload completion.
  const socialHeading = page.locator("xpath=//h2[normalize-space()='Social preview']").first();
  const editButton = page.locator("#edit-social-preview-button");
  const socialEditButton = page.locator(
    "xpath=(//h2[normalize-space()='Social preview']/following::*[(self::button or self::summary) and normalize-space(.)='Edit'][1])"
  );
  const fileInput = page.locator("input#repo-image-file-input");
  const uploadMenuItem = page.getByText(/upload an image/i).first();
  const imageIdInput = page.locator("input.js-repository-image-id");
  const imageContainer = page.locator(".js-repository-image-container");

  // First, wait for the section itself. Optional controls can vary by current state (add vs replace).
  console.log("Waiting for Social preview section...");
  await socialHeading.waitFor({ state: "attached", timeout: 60_000 });
  console.log("Social preview section found.");
  await socialHeading.scrollIntoViewIfNeeded().catch(() => {});

  // Capture previous image id (blank if none).
  let prevId = "";
  if (await imageIdInput.count()) prevId = (await imageIdInput.first().inputValue().catch(() => "")).trim();
  const mode = prevId ? "replace" : "add";
  console.log(`Social preview mode: ${mode}`);

  // Existing cards often require opening an Edit menu before upload controls become active.
  if (await editButton.count()) {
    console.log("Opening Social preview edit menu via #edit-social-preview-button...");
    await editButton.first().click({ force: true }).catch(() => {});
  } else if (await socialEditButton.count()) {
    console.log("Opening Social preview edit menu via nearby Edit control...");
    await socialEditButton.first().click({ force: true }).catch(() => {});
  }

  // After section (and optional edit-menu) is ready, wait for upload affordances.
  console.log("Waiting for upload controls...");
  await Promise.any([
    fileInput.first().waitFor({ state: "attached", timeout: 30_000 }),
    uploadMenuItem.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  console.log("Upload controls found.");

  console.log(`Uploading: ${imagePath}`);

  const uploadResponsePromise = page.waitForResponse((resp) => {
    const u = resp.url();
    const ok = resp.status() >= 200 && resp.status() < 300;
    if (!ok) return false;
    // GitHub upload flow can report success on either policy creation or image attach endpoints.
    return u.includes("/upload/repository-images/") || u.includes("/upload/policies/repository-images");
  }, { timeout: 20_000 }).then((resp) => `${resp.status()} ${resp.url()}`).catch(() => "");

  // Upload, using either direct setInputFiles (best) or filechooser fallback.
  if (await fileInput.count()) {
    await fileInput.first().setInputFiles(imagePath);
  } else {
    // Fallback: click Upload an image to trigger the native file chooser.
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      uploadMenuItem.click({ force: true }),
    ]);
    await chooser.setFiles(imagePath);
  }

  const uploadResponseUrl = await uploadResponsePromise;
  const sawUploadResponse = !!uploadResponseUrl;
  if (sawUploadResponse) console.log(`Upload request completed: ${uploadResponseUrl}`);
  else console.warn("⚠️ Upload request response not observed; using DOM fallback checks.");

  // When network signal is missing, fall back to id-change logic.
  let idChanged = false;
  if (!sawUploadResponse) {
    try {
      await page.waitForFunction(
        ({ prevId }) => {
          const input = document.querySelector("input.js-repository-image-id");
          if (!input) return false;
          const v = (input.value || "").trim();
          if (!v) return false;
          if (!prevId) return true;
          return v !== prevId;
        },
        { prevId },
        { timeout: 20_000 }
      );
      idChanged = true;
    } catch {}
  }

  // Ensure we have a non-empty id populated after upload.
  await page.waitForFunction(() => {
    const input = document.querySelector("input.js-repository-image-id");
    return !!((input?.value || "").trim());
  }, { timeout: 20_000 }).catch(() => {});

  // Also wait for the image container to be visible (not hidden), if present.
  if (await imageContainer.count()) {
    await page.waitForFunction(() => {
      const el = document.querySelector(".js-repository-image-container");
      return el && el.hidden === false;
    }, { timeout: 30_000 }).catch(() => {});
  }

  const newId = await imageIdInput.first().inputValue().catch(() => "");
  if (!String(newId).trim()) {
    await browser.close();
    throw new Error("Upload did not produce a social preview image id.");
  }

  if (!idChanged && prevId && String(newId).trim() === prevId) {
    console.warn("⚠️ Upload finished but image id is unchanged (likely same image content).");
  }

  console.log(`✅ Upload complete. New image id: ${String(newId).trim()}`);

  await browser.close();
}

async function updateFlow(opts) {
  const {
    baseUrl,
    repo,
    storageStatePath,
    width,
    height,
    format,
    quality,
    outPath,
    headless,
  } = opts;

  const finalOut = outPath || defaultOutPath(repo, format);

  const screenshotPath = await captureReadmeScreenshot({
    baseUrl,
    repo,
    storageStatePath,
    outPath: finalOut,
    width,
    height,
    format,
    quality,
    headless,
  });

  await uploadSocialPreview({
    baseUrl,
    repo,
    storageStatePath,
    imagePath: screenshotPath,
    headless,
  });
}

function printHelp() {
  console.log(`
Usage:
  node gh-social-preview.js init-auth [--storage-state .auth/github.json] [--base-url https://github.com]
  node gh-social-preview.js update --repo owner/repo [--storage-state .auth/github.json] [options]

Options:
  --base-url   Base GitHub URL (default: https://github.com)
  --storage-state  Path to Playwright storageState JSON (default: ./.auth/<host>.json)
  --headless   true|false (default: init-auth=false, update=true)

Update options:
  --width      Viewport width (default: 1280)
  --height     Viewport height (default: 640)
  --format     png|jpeg (default: jpeg)
  --quality    JPEG quality 1-100 (default: 80; only for jpeg)
  --out        Output screenshot path (default: ./.social-preview/<owner>__<repo>.<ext>)

Examples:
  node gh-social-preview.js init-auth
  node gh-social-preview.js update --repo AnswerDotAI/exhash --headless false
`.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || ["-h", "--help", "help"].includes(cmd)) {
    printHelp();
    return;
  }

  const baseUrl = normalizeBaseUrl(args["base-url"] || "https://github.com");
  const defaultStorageState = defaultStorageStatePath(baseUrl);

  if (cmd === "init-auth") {
    const storageStatePath = args["storage-state"] ? path.resolve(String(args["storage-state"])) : defaultStorageState;
    await initAuth({ baseUrl, storageStatePath });
    return;
  }

  if (cmd === "update") {
    const repo = normalizeRepo(args.repo);
    const storageStatePath = args["storage-state"] ? path.resolve(String(args["storage-state"])) : defaultStorageState;
    const width = toInt(args.width, 1280);
    const height = toInt(args.height, 640);
    const format = String(args.format || "jpeg").toLowerCase() === "png" ? "png" : "jpeg";
    const quality = Math.max(1, Math.min(100, toInt(args.quality, 80)));
    const outPath = args.out ? path.resolve(String(args.out)) : null;
    const headless = toBool(args.headless, true);

    await updateFlow({
      baseUrl,
      repo,
      storageStatePath,
      width,
      height,
      format,
      quality,
      outPath,
      headless,
    });
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(`\n❌ ${err?.stack || err}\n`);
  process.exitCode = 1;
});
