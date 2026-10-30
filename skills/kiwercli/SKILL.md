---
name: kiwercli
description: Fill a REWE basket (Lieferservice or Abholservice) from the terminal with the kiwercli CLI - search products, add them to the basket, look at timeslots and past orders. Use when the user wants groceries from REWE put into their basket. Never places an order.
---

# kiwercli — REWE basket CLI

**Never order. Only fill the basket.** No kiwercli command submits an order, and you must not
complete checkout any other way (browser, API call, script). When the basket is ready, tell the
user to review and order on rewe.de themselves.

All output is JSON; add `-p` to pretty-print. Prices are in **cents**.

## Setup (once, done by the user)

```bash
kiwercli store set-delivery <zip>        # Lieferservice: resolves the delivery market for the ZIP
kiwercli store set <wwIdent> <zip>       # Abholservice: pickup market
kiwercli store show                      # wwIdent, zipCode, serviceType
kiwercli import-cookies <file>           # Netscape cookies.txt or JSON (CDP getAllCookies / Playwright)
```

If a command returns `Auth error 401/403`, the session expired: ask the user for a fresh cookie
export. Never ask for passwords or TOTP secrets.

With `KIWERCLI_TRANSPORT=browser`, requests run in the user's own logged-in Chromium
(`KIWERCLI_CDP_URL`, default `http://127.0.0.1:9223`). On 401/403 ask the user to log in to
rewe.de in that browser.

## Commands

```bash
kiwercli search <query> [--category <slug>] [--sort PRICE_ASC] [--offers] [--organic] [--per-page N]
kiwercli basket show
kiwercli basket add <listingId> [--qty N]
kiwercli basket bulk-add '[{"listingId":"...","qty":2}]'
kiwercli basket update <listingId> <qty>
kiwercli basket remove <listingId>
kiwercli timeslots                       # pickup or delivery slots, depending on store setup
kiwercli orders show
kiwercli orders items <orderId>          # [{name, productId, quantity, price}] — reorder past items
kiwercli favorites
```

Use the `listingId` from `search` (`_embedded.articles[0]._embedded.listing.id`) for basket
commands. Listing IDs are market-specific: search again after switching store or service.

## Category slugs

Pass `--category` so "Milch" does not return shower gel.

| Category | Slug |
|---|---|
| Milk | `milch` |
| Eggs | `eier-ei-ersatz` |
| Hard cheese | `hartkaese` |
| Fresh cheese | `frischkaese` |
| Poultry | `gefluegelfleisch` |
| Pork | `schweinefleisch` |
| Beef | `rindfleisch` |
| Bacon/ham | `roher-schinken-speck` |
| Pasta | `nudeln` |
| Rice | `reis` |
| Fresh fruit | `frisches-obst` |
| Fresh vegetables | `frisches-gemuese` |
| Spices | `gewuerze` |
| Butter | `butter` |
| Bread | `brot` |

Slugs are kebab-case German names (ä→ae, ö→oe, ü→ue). If one returns nothing, read
`categoryPath` from a search result to find the right slug.

## Workflow

1. `kiwercli store show`: confirm service type and market.
2. For each item: `kiwercli search` with a category, pick by name/price, `basket add`.
3. `kiwercli basket show`: report items and total to the user.
4. Stop. **Do not order.** The user checks out on rewe.de.
