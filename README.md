# worker_v1-example-viper-parts-scraper-repo

Playbook and Playwright wrapper for the Facebook Dodge Viper
parts scraper. Read-only.

Cloned by the sibling deployment repo
([worker_v1-example-viper-parts-scraper-worker](https://github.com/clawborrator/worker_v1-example-viper-parts-scraper-worker))
on container boot. You do not run anything here directly. This
repo IS the agent's instructions, tools, and config.

## What's here

```
CLAUDE.md                       cron-driven (6h), one cycle per turn
                                read-only scrape: auth, scrape each
                                group, filter+classify+dedup, commit
                                listings JSON, notify operator
specialists/fb-groups.js        Playwright wrapper: auth-check +
                                read-group commands. NO write verbs.
config/groups.json              which groups to scrape (operator-edited)
config/keywords.json            buy/sell pattern matches (operator-edited)
data/listings/<ts>.json         structured output + audit, one per cycle
data/screenshots/               per-navigation PNGs (visible on GitHub)
package.json                    declares stealth deps
```

## What the agent does each cycle

Every 6 hours, the scraper:

1. Verifies its Facebook cookies still log it in
2. Reads `config/groups.json` and `config/keywords.json`
3. Builds a seen-URL set by scanning every prior
   `data/listings/*.json`
4. For each active group: scrolls the feed, extracts the first
   ~50 posts, sleeps 30-60s before the next group
5. Filters posts by keyword patterns and classifies each as
   sell / buy / ambiguous
6. Drops any post whose URL is in the seen set
7. Commits a structured listings JSON to
   `data/listings/<timestamp>.json` plus the per-navigation
   PNG trail
8. Notifies `@clauderemote` with a one-paragraph digest of
   the new matches (or "no new matches this round" if none)
9. Returns. Cron fires the next cycle in 6 hours.

## Configuring groups + keywords

Edit `config/groups.json` to add/remove groups. Each entry:

```json
{ "name": "Dodge Viper Nation", "url": "https://www.facebook.com/groups/<id>/", "active": true }
```

Set `active: false` to temporarily disable a group without
deleting its entry. Push your edit; the next cron fire reads
the file fresh.

Edit `config/keywords.json` similarly. The defaults cover the
common buy/sell shorthand (wts, wtb, fs, iso, "for sale",
"looking for", etc.). Tune to taste.

## How dedup works

The agent treats every prior `data/listings/*.json` as
authoritative for "have we already reported this post". The
match is by `post_url`. A post that appears in two cycles only
shows up in the first cycle's listings; subsequent cycles drop
it before the operator sees it.

This means if you ever want to "reset" the seen set (e.g. to
re-surface a post you missed), you can delete the relevant
listings file and push.

## Listings JSON shape

```json
{
  "ts": "2026-05-16T18:00:00Z",
  "groups_scraped": [
    { "url": "...", "name": "Dodge Viper Nation", "posts_extracted": 47, "candidates_kept": 3 }
  ],
  "new_matches": [
    {
      "post_url": "https://www.facebook.com/groups/.../posts/12345/",
      "post_id": "12345",
      "group_url": "...",
      "author": "Some Person",
      "classification": "sell",
      "text_summary": "1996 GTS hardtop, $4500, Phoenix AZ",
      "item": "1996 GTS hardtop",
      "price": "$4500",
      "location": "Phoenix AZ",
      "photos": ["https://scontent..."],
      "age_hours": 3
    }
  ],
  "skip_reason": null
}
```

Skipped cycles record `{ts, skip_reason}` only.

## Selectors

Facebook's "Comet" UI hashes class names per build. The wrapper
leans on `aria-label`, `role`, and `href` patterns where
possible. When selectors break, the agent's failure path
notifies `@clauderemote` and the operator updates
`SELECTORS` in `specialists/fb-groups.js`.

## Risk envelope

Read-only. No posting, commenting, reactions, DMs, or
connection requests. The wrapper has no write verbs.

Cookies expire faster on FB than on Reddit (days to weeks vs
weeks to months) but the account itself is in low risk: Meta
mostly throttles read sessions rather than banning them.

## See also

- `../worker_v1-example-viper-parts-scraper-worker/` for the
  docker-compose deployment and setup README
- `../worker_v1-example-reddit-engager-repo/` is the sibling
  pattern for a read-and-write engagement engager
- `../worker_v1-playwright/` for the image
