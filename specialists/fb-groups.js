#!/usr/bin/env node
//
// fb-groups.js. Read-only Playwright wrapper for the Facebook
// Dodge Viper parts scraper. NO write verbs by design.
//
// Two subcommands, each prints JSON to stdout and exits:
//   auth-check                              verify cookies still log in
//   read-group --url <url> --count N        scroll a group, extract posts
//
// Cookies loaded from /secrets/facebook.cookies.json (read-only
// mount). Expected format: top-level array in Playwright's
// addCookies() shape. Same normalization as the engager wrappers
// (sameSite mapping across exporter formats).
//
// Stealth + headed under Xvfb. The Comet UI has aggressive class-
// name hashing, so SELECTORS leans on aria-label, role, and href
// patterns. Selectors WILL break; centralized for one-line fixes.

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');

const COOKIES_PATH = process.env.FB_COOKIES_PATH
  || '/secrets/facebook.cookies.json';

const BASE = 'https://www.facebook.com';

const SCREENSHOTS_DIR = '/workspace/repo/data/screenshots';

const SELECTORS = {
  // Logged-in indicator. Facebook's global nav has a profile
  // button; pre-login the same area has "Sign Up" / "Log In".
  loggedInAccountButton: '[aria-label*="Your profile" i], [aria-label="Account"]',

  // Post containers in a group feed. Comet UI wraps each post
  // in a div with role="article". This is the most stable
  // signal.
  postArticle:           'div[role="article"]',

  // Inside a post:
  postAuthorLink:        'h3 a[role="link"], h2 a[role="link"]',
  // Post body text is in nested spans without stable classes.
  // The post text usually lives inside [data-ad-comet-preview]
  // or the first long-text container.
  postBodyContainer:     '[data-ad-comet-preview], [data-ad-preview]',
  // Permalink is anchored to the post's timestamp.
  postTimestampLink:     'a[role="link"][href*="/posts/"], a[role="link"][href*="/permalink/"], a[href*="?multi_permalinks"]',
  // Photo thumbnails inside the post.
  postPhoto:             'img[src*="scontent"]',

  // Login redirect / challenge signals (similar to LinkedIn but
  // with FB-specific labels).
  loginForm:             'form[id="login_form"], input[name="email"][type="text"], a[href*="/login"]',
  checkpointPage:        ':text("We don\'t recognize"), :text("verify your identity")',
  rateLimitNotice:       ':text("you\'re going too fast"), :text("temporarily blocked")',
};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function die(error, details) {
  emit({ ok: false, error, ...(details ? { details } : {}) });
  process.exit(1);
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    die('cookies missing', `expected file at ${COOKIES_PATH}`);
  }
  const raw = fs.readFileSync(COOKIES_PATH, 'utf-8');
  let cookies;
  try { cookies = JSON.parse(raw); }
  catch (e) { die('cookies malformed', `not valid JSON: ${e.message}`); }
  if (!Array.isArray(cookies)) die('cookies malformed', 'top level must be an array');

  return cookies.map((c) => {
    const out = { ...c };
    if (typeof out.expires === 'string') out.expires = Number(out.expires);
    if (out.expirationDate && !out.expires) out.expires = Math.floor(out.expirationDate);
    if (out.session === true) delete out.expires;
    if (!out.domain) out.domain = '.facebook.com';
    if (!out.path) out.path = '/';
    const ss = (() => {
      if (out.sameSite == null) return null;
      const v = String(out.sameSite).toLowerCase();
      switch (v) {
        case 'strict':         return 'Strict';
        case 'lax':            return 'Lax';
        case 'none':           return 'None';
        case 'no_restriction': return 'None';
        default:               return null;
      }
    })();
    if (ss) out.sameSite = ss;
    else delete out.sameSite;
    delete out.hostOnly;
    delete out.storeId;
    delete out.id;
    delete out.expirationDate;
    return out;
  });
}

async function newContext() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    viewport:   { width: 1366, height: 900 },
    userAgent:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/New_York',
  });
  await ctx.addCookies(loadCookies());
  return { browser, ctx };
}

let navSeq = 0;
async function snapshotNav(page, contextTag, navLabel) {
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } catch {}
  navSeq++;
  const filename = `nav-${contextTag}-${String(navSeq).padStart(2, '0')}-${navLabel}-${Date.now()}.png`;
  const absolutePath = `${SCREENSHOTS_DIR}/${filename}`;
  const repoRelativePath = `data/screenshots/${filename}`;
  try {
    await page.screenshot({ path: absolutePath, fullPage: true });
    return repoRelativePath;
  } catch {
    return null;
  }
}

async function gotoWithRetry(page, url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      lastErr = e;
      const isTimeout = e?.name === 'TimeoutError' || /Timeout/i.test(e?.message ?? '');
      if (!isTimeout || attempt === 1) throw e;
      await page.waitForTimeout(3_000);
    }
  }
  throw lastErr;
}

async function assertNotChallenged(page) {
  if (await page.locator(SELECTORS.loginForm).count() > 0) {
    die('auth_lost_mid_cycle', 'redirected to login form');
  }
  if (await page.locator(SELECTORS.checkpointPage).count() > 0) {
    die('auth_lost_mid_cycle', 'Facebook served an identity verification page');
  }
  if (await page.locator(SELECTORS.rateLimitNotice).count() > 0) {
    die('rate_limited');
  }
}

function urlLooksLikeAuthFail(url) {
  return /\/login|\/checkpoint|\/r\/sign/i.test(url);
}

// Best-effort permalink extraction from a post's timestamp link.
// Returns the canonical /groups/<id>/posts/<id>/ URL when possible.
function normalizePostUrl(href) {
  if (!href) return null;
  // Strip query string + fragment.
  const stripped = href.split('?')[0].split('#')[0];
  if (stripped.startsWith('http')) return stripped;
  return BASE + stripped;
}

function extractPostId(url) {
  if (!url) return null;
  const m = url.match(/\/posts\/(\d+)|\/permalink\/(\d+)|multi_permalinks=(\d+)/);
  return (m && (m[1] || m[2] || m[3])) || null;
}

// ─── Subcommand: auth-check ───────────────────────────────────

async function cmdAuthCheck() {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, BASE + '/');
    // Facebook's React shell hydrates after domcontentloaded;
    // wait for nav region or short timeout.
    await page.waitForSelector('div[role="banner"], nav, [aria-label="Facebook"]', { timeout: 10_000, state: 'attached' }).catch(() => {});
    await page.waitForTimeout(2_500);
    screenshots.push(await snapshotNav(page, 'auth-check', 'post-goto'));

    const finalUrl = page.url();
    if (urlLooksLikeAuthFail(finalUrl)) {
      emit({
        ok: false,
        error: 'not logged in',
        final_url: finalUrl,
        hint: 'Facebook redirected to login or checkpoint. Cookies are expired, partial, or exported from a different account. Re-export from a logged-in browser session on facebook.com.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }

    await assertNotChallenged(page);

    const profileBtn = page.locator(SELECTORS.loggedInAccountButton).first();
    if (await profileBtn.count() === 0) {
      // Tertiary fallback: presence of any reasonable nav.
      const navPresent = await page.locator('div[role="banner"], [aria-label="Facebook"], div[role="main"]').count() > 0;
      if (navPresent) {
        emit({
          ok: true,
          logged_in_as: '(no display name extracted; nav present)',
          final_url: finalUrl,
          warning: 'profile-button selectors stale; update SELECTORS.loggedInAccountButton in fb-groups.js when convenient',
          screenshots: screenshots.filter(Boolean),
        });
        return;
      }
      emit({
        ok: false,
        error: 'not logged in',
        final_url: finalUrl,
        hint: 'URL did not redirect to login but no nav or profile button found. Inspect the screenshot to see what FB actually rendered.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }

    // Display name. FB makes this annoying to extract reliably;
    // try the profile button's aria-label.
    const aria = await profileBtn.getAttribute('aria-label').catch(() => null);
    const displayName = aria ? aria.replace(/^Your profile,?\s*/i, '').trim() : '(name not extracted)';

    emit({ ok: true, logged_in_as: displayName, final_url: finalUrl, screenshots: screenshots.filter(Boolean) });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    const snap = await snapshotNav(page, 'auth-check', 'uncaught').catch(() => null);
    emit({ ok: false, error: 'auth_check_failed', details: e.message, screenshots: [...screenshots, snap].filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: read-group ───────────────────────────────────

async function cmdReadGroup(args) {
  const groupUrl = args.url;
  const count = parseInt(args.count || '50', 10);
  if (!groupUrl) die('missing_arg', 'read-group requires --url <group-url>');

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, groupUrl);
    await page.waitForSelector('div[role="banner"], nav', { timeout: 10_000, state: 'attached' }).catch(() => {});
    await page.waitForTimeout(2_500);
    screenshots.push(await snapshotNav(page, 'read-group', 'post-goto'));

    const finalUrl = page.url();
    if (urlLooksLikeAuthFail(finalUrl)) {
      emit({
        ok: false,
        error: 'auth_lost_mid_cycle',
        final_url: finalUrl,
        hint: 'Facebook redirected to login when loading this group. Cookies likely partially valid; refresh + restart.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }
    await assertNotChallenged(page);

    // Scroll to load posts. Facebook lazy-renders; need multiple
    // passes with hydration time between each.
    let articles = [];
    for (let pass = 0; pass < 8; pass++) {
      articles = await page.locator(SELECTORS.postArticle).all();
      if (articles.length >= count) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1_500);
      screenshots.push(await snapshotNav(page, 'read-group', `after-scroll-${pass + 1}`));
    }

    const posts = [];
    for (const article of articles.slice(0, count)) {
      try {
        const author = (await article.locator(SELECTORS.postAuthorLink).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');
        // Post text. Multiple candidate containers; try in order.
        let text = (await article.locator(SELECTORS.postBodyContainer).first().textContent().catch(() => ''))?.trim();
        if (!text) {
          // Fallback: grab the whole article text and trim the author header.
          text = (await article.textContent().catch(() => ''))?.trim();
          if (author && text) text = text.replace(author, '').trim();
        }
        text = (text || '').replace(/\s+/g, ' ').slice(0, 2000);

        // Permalink + timestamp. Look for href patterns inside the article.
        const timestampLinks = await article.locator(SELECTORS.postTimestampLink).all();
        let permalinkHref = null;
        for (const tl of timestampLinks.slice(0, 5)) {
          const href = await tl.getAttribute('href').catch(() => null);
          if (href && (/\/posts\//.test(href) || /\/permalink\//.test(href) || /multi_permalinks=/.test(href))) {
            permalinkHref = href;
            break;
          }
        }
        const postUrl = normalizePostUrl(permalinkHref);
        const postId = extractPostId(postUrl);

        // Photos: collect scontent image URLs.
        const photoLocators = await article.locator(SELECTORS.postPhoto).all();
        const photos = [];
        for (const p of photoLocators.slice(0, 6)) {
          const src = await p.getAttribute('src').catch(() => null);
          if (src) photos.push(src);
        }

        // Age. FB shows "3h", "2d", "Yesterday at 3:14 PM", etc.
        // We pull whatever text the timestamp link shows; the
        // agent's judgment side parses it.
        const ageText = (await article.locator('a[role="link"][aria-label*="hour" i], a[role="link"][aria-label*="day" i], a[role="link"][aria-label*="minute" i]').first().textContent().catch(() => null))?.trim();

        if (!postUrl && !text) continue;
        posts.push({
          post_id: postId,
          post_url: postUrl,
          author: author || null,
          text,
          age_text: ageText || null,
          age_hours: null,
          photos,
        });
      } catch (e) {
        continue;
      }
    }

    emit({
      ok: true,
      group_url: groupUrl,
      posts,
      screenshots: screenshots.filter(Boolean),
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    const snap = await snapshotNav(page, 'read-group', 'uncaught').catch(() => null);
    emit({ ok: false, error: 'read_group_failed', details: e.message, screenshots: [...screenshots, snap].filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── CLI dispatch ─────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); }
      else { out[a.slice(2)] = argv[i + 1]; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'auth-check': await cmdAuthCheck(); break;
    case 'read-group': await cmdReadGroup(args); break;
    default:
      emit({
        ok: false,
        error: 'unknown_command',
        usage: [
          'fb-groups.js auth-check',
          'fb-groups.js read-group --url <group-url> --count <N>',
        ],
      });
      process.exit(1);
  }
}

main().catch((e) => die('uncaught', e.stack || e.message || String(e)));
