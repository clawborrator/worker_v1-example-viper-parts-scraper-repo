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

  // Post containers in a group feed. Comet UI wraps both posts
  // AND comments in role="article", so a bare role-article match
  // picks up comments-as-posts. We grab all role-article elements
  // first then JS-filter to TOP-LEVEL ones (no ancestor role-
  // article) inside the extraction loop. aria-posinset would be
  // a cleaner discriminator but Comet doesn't always emit it on
  // group feeds.
  postArticle:           'div[role="article"]',

  // Inside a post header. Author live links are anchors to
  // /user/<id>/ within the group, or to /<vanity>/ at the root.
  // Multiple fallbacks because Comet hashes class names.
  postAuthorLink:        'a[role="link"][href*="/user/"], a[role="link"][href*="/profile.php"], a[role="link"][aria-label*="profile" i], h3 strong a, h2 strong a, h3 a[role="link"]',
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
    // Viewport-only (not fullPage). Facebook's Comet UI pads pages
    // with massive empty regions when rendered headed, so fullPage
    // PNGs are mostly whitespace and run 2-10MB. Viewport-only is
    // ~200-500KB and shows what the user would actually see.
    await page.screenshot({ path: absolutePath, fullPage: false });
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

// Comet renders a post as concatenated text with no clean
// semantic separator: AuthorName, optional ContributorBadge,
// optional "· Follow", BodyText, AgeText, "LikeReplyShare",
// optional ReactionCount. innerText preserves block boundaries
// as newlines, which lets us split + filter UI noise to isolate
// the actual author + body.
function cleanFacebookPostText(raw) {
  if (!raw) return { author: null, body: '' };
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  const isNoise = (line) =>
    /^(Like|Reply|Share|Follow|Comment|See more|See translation|Sponsored|Edited)$/i.test(line) ||
    /^· Follow$/i.test(line) ||
    /^All-star contributor$/i.test(line) ||
    /^Rising contributor$/i.test(line) ||
    /^Top contributor$/i.test(line) ||
    /^Group expert$/i.test(line) ||
    /^Author$/i.test(line) ||
    /^Anonymous member$/i.test(line) ||
    /^Admin$/i.test(line) ||
    /^Moderator$/i.test(line) ||
    /^\d+\s*(s|m|h|d|w|y|mo)$/i.test(line) ||      // age "43w", "23h", "5m"
    /^(Yesterday|Today)\s+at\s+/i.test(line) ||
    /^\d+(\.\d+)?[KMB]?$/i.test(line) ||           // reaction counts "131", "1.2K"
    /^All comments$/i.test(line) ||
    /^Most relevant$/i.test(line) ||
    /^View\s+\d+/i.test(line) ||
    /^Hide\s+\d+/i.test(line);

  const meaningful = lines.filter((l) => !isNoise(l));
  const author = meaningful[0] || null;
  // Strip leading author from body lines just in case it bled
  // into the next line, then join.
  const bodyLines = meaningful.slice(1);
  const body = bodyLines.join(' ').replace(/\s+/g, ' ').trim();

  return { author, body };
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

    // Scroll + accumulate. Facebook uses virtual scrolling: it
    // unmounts posts that have scrolled out of view to save
    // memory. A final-state-only extraction sees only the
    // currently-visible 2-4 posts after extensive scrolling,
    // even though we passed THROUGH 20+ posts on the way down.
    // Fix: extract from whatever is currently rendered after
    // EACH scroll pass, accumulate into a Map keyed by post_id,
    // dedup as we go. Break when we have `count` distinct posts
    // OR we run out of scroll passes.
    const accumulator = new Map();   // post_id -> post-record
    const unknownIdAccumulator = [];  // posts with no extractable post_id (rare, fallback)

    for (let pass = 0; pass <= 8; pass++) {
      const articles = await page.locator(SELECTORS.postArticle).all();
      for (const article of articles) {
        try {
          // Skip nested articles (comments).
          const isNested = await article.evaluate((el) => {
            let p = el.parentElement;
            while (p) {
              if (p.matches && p.matches('div[role="article"]')) return true;
              p = p.parentElement;
            }
            return false;
          }).catch(() => false);
          if (isNested) continue;

          // Permalink + post_id are the dedup key.
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

          if (postId && accumulator.has(postId)) continue;

          // Extract the rest.
          const linkAuthor = (await article.locator(SELECTORS.postAuthorLink).first().textContent({ timeout: 1_500 }).catch(() => null))?.trim()?.replace(/\s+/g, ' ');
          const rawInnerText = (await article.innerText().catch(() => ''));
          const { author: cleanedAuthor, body: cleanedBody } = cleanFacebookPostText(rawInnerText);

          const author = linkAuthor || cleanedAuthor || null;
          let text = cleanedBody;
          if (author && text.startsWith(author)) text = text.slice(author.length).trim();
          text = text.slice(0, 2000);

          const photoLocators = await article.locator(SELECTORS.postPhoto).all();
          const photos = [];
          for (const p of photoLocators.slice(0, 6)) {
            const src = await p.getAttribute('src').catch(() => null);
            if (src) photos.push(src);
          }

          const ageText = (await article.locator('a[role="link"][aria-label*="hour" i], a[role="link"][aria-label*="day" i], a[role="link"][aria-label*="minute" i]').first().textContent().catch(() => null))?.trim();

          if (!postUrl && !text) continue;

          const record = {
            post_id: postId,
            post_url: postUrl,
            author: author || null,
            text,
            age_text: ageText || null,
            age_hours: null,
            photos,
          };

          if (postId) {
            accumulator.set(postId, record);
          } else {
            // Fallback: stash by text-prefix to dedup the
            // not-uncommon case where a post has no extractable
            // post_id (e.g. timestamp link not yet rendered).
            const key = (text || '').slice(0, 120);
            if (key && !unknownIdAccumulator.some((r) => (r.text || '').slice(0, 120) === key)) {
              unknownIdAccumulator.push(record);
            }
          }
        } catch (e) {
          continue;
        }
      }

      if (accumulator.size + unknownIdAccumulator.length >= count) break;
      if (pass === 8) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1_500);
      screenshots.push(await snapshotNav(page, 'read-group', `after-scroll-${pass + 1}`));
    }

    const posts = [...accumulator.values(), ...unknownIdAccumulator].slice(0, count);

    emit({
      ok: true,
      group_url: groupUrl,
      posts,
      posts_count: posts.length,
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
