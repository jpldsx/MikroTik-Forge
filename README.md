# MikroTik Forge

RouterOS **v6 and v7** configuration generator. Static site + API on **Cloudflare Pages / Workers**, tested and deployed from **GitHub Actions**.

**Generates:** multi-WAN (failover · ECMP · weighted PCC) with DHCP / static / PPPoE / ISP-VLAN uplinks · bridge VLAN filtering with isolation, management VLAN, per-VLAN caps · DHCP, static leases, DNS · firewall, NAT, port forwards, hairpin NAT · bandwidth management (HTB priority tree, CAKE, FQ-CoDel) with **gaming priority** · WireGuard (v7) · service hardening.

## How it works

```
public/                 static site (no build step)
  js/generator.js       pure ES module: config JSON -> .rsc   (browser, Worker and tests share it)
  js/net.js             IPv4 maths, RouterOS quoting (newline/quote injection safe)
  js/presets.js         defaults + game port presets (each tagged official / community)
  js/examples.js        16 example configs (UI menu, tests, snapshots)
functions/api/          Pages Functions (= Workers): /api/generate, /api/share (optional KV)
tests/                  node:test suite + structural RouterOS linter (tests/lint.js)
configs/                golden .rsc snapshots of every example x v6/v7 (CI fails if stale)
```

The generated script targets an **empty configuration**: apply with
`/system reset-configuration no-defaults=yes skip-backup=yes run-after-reset=forge.rsc`.

### v6 vs v7 differences handled
| | v6 | v7 |
|---|---|---|
| Routing tables | `routing-mark=` on routes | `/routing table add name=X fib` + `routing-table=` |
| Mangle | `new-routing-mark` | `new-routing-mark` (same) |
| NTP | `primary-ntp` / `secondary-ntp` (IPs) | `servers=a,b` |
| Queues | HTB + SFQ/PCQ | + `fq-codel`, `cake` (7.1+); v6 requests fall back to HTB with a warning |
| WireGuard | not available (skipped with warning) | native |

## Develop

```bash
npm test               # 64 tests: generator, v6/v7 rules, linter on all examples, Worker functions
npm run examples       # regenerate configs/*.rsc snapshots (commit the diff)
npm install && npm run dev   # wrangler pages dev -> http://localhost:8788
```

## Deploy (GitHub -> Cloudflare)

1. Create the repo and push:
   ```bash
   git add -A && git commit -m "MikroTik Forge" && git branch -M main
   git remote add origin git@github.com:<you>/mikrotik-forge.git && git push -u origin main
   ```
2. Cloudflare dashboard -> **Workers & Pages -> Create -> Pages -> Direct Upload**, name it `mikrotik-forge` (or set the repo *variable* `CLOUDFLARE_PAGES_PROJECT`).
3. Create an **API token** with *Account -> Cloudflare Pages -> Edit*. In GitHub: **Settings -> Secrets and variables -> Actions**, add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Every push to `main` runs the tests, checks the snapshots and runs `wrangler pages deploy public` (which bundles `functions/`). Other branches/PRs run CI only.
5. *(Optional)* short share links: `npx wrangler kv namespace create SHARES`, paste the id into the commented block in `wrangler.toml` (or bind `SHARES` in the Pages project settings). Without it the Share button produces self-contained `#c=` links.

Consider a Cloudflare **rate-limiting rule** on `/api/*` if you expose it publicly.

## API

```bash
curl -s -X POST https://<your-site>/api/generate?format=rsc \
  -H 'content-type: application/json' --data @forge-config.json > router.rsc
```
Without `?format=rsc` you get JSON: `{ ok, script, warnings, errors[], summary }`. Invalid configs return `400` with field-level errors. Get a config file from the UI's **Export JSON**.

## What has and has not been verified

- Syntax was checked against MikroTik's documentation (routing tables/policy routing, queue types incl. all `cake-*`/`pcq-*`/`sfq-*` properties, NTP). Game ports marked **official** were read from Riot and Activision support pages; **community** ports (LoL, Steam, Fortnite) could not be confirmed against the publisher during development - verify before relying on them.
- The linter checks structure and cross-references (dangling queues/marks/lists/tables, v6-vs-v7 syntax, PCC remainders, queue limit sums, VLAN entries, ordering). **No script has been imported on a physical RouterOS device** - test in a lab or Safe Mode first.
- Known limits: no Wi-Fi configuration (wireless/wifi/wifiwave2 differ too much between models); download shaping in VLAN mode attaches to the bridge - confirm counters with `/queue tree print stats` and switch the parent to `global` if they stay at zero; failover over DHCP-only WANs can't detect a dead ISP behind a live link (use static gateways or PCC, which ping).
