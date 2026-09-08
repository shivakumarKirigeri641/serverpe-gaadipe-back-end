# serverpe-gaadipe-back-end

Vehicle gateway for GaadiPe — RC, e-Challan and FASTag from ULIP, behind one API key.

**Why this service exists:** ULIP authorises by **source IP**, so only this deployed,
whitelisted server can call VAHAN / ECHALLAN / FASTAG. Every other ServerPe app —
including a local development machine — calls this instead, with an API key, from anywhere.

---

## Endpoints

    GET /api/v1/vehicle/:regNo             everything (cache-first)
    GET /api/v1/vehicle/:regNo?refresh=1   force a fresh ULIP fetch
    GET /api/v1/vehicle/:regNo/rc          RC only
    GET /api/v1/vehicle/:regNo/challans    challans only
    GET /api/v1/vehicle/:regNo/fastag      FASTag only
    GET /api/v1/health                     liveness (also key-protected)

**Auth:** `x-api-key: <VEHICLE_LOOKUP_KEY>` — or `Authorization: Bearer <key>`.
Every route under `/api/v1` requires it; there is no unauthenticated surface.

Registration numbers are normalised before use, so `KA-31 n 8147`, `ka31n8147` and
`KA31N8147` are the same vehicle. Anything failing ULIP's `^[A-Z0-9]{5,11}$` is
rejected with a 400 **before** a call is spent.

---

## Deploying

```bash
git clone <repo> && cd serverpe-gaadipe-back-end
npm install
cp .env.example .env      # then fill in the three required values
npm start                 # or: pm2 start src/app.js --name gaadipe-gateway
```

No database, no build step, no migrations. Two dependencies.

### `.env` — only three values are required

```
ULIP_USERNAME=          # gateway logs in automatically and caches the token
ULIP_PASSWORD=
VEHICLE_LOOKUP_KEY=     # what callers send as x-api-key
```

Everything else has a working default in `src/config.js`. Override only if needed:

| Variable | Default | When to change it |
|---|---|---|
| `PORT` | `5007` | port clash |
| `ULIP_BASE_URL` | production ULIP | pointing at staging |
| `ULIP_VAHAN_PRIMARY` | `04` | set `01` when ULIP's JSON feed is broken for every vehicle |
| `ULIP_TIMEOUT_MS` | `30000` | |
| `ULIP_TOKEN_TTL_MS` | `1500000` (25 min) | ULIP idles tokens out at ~30 min |
| `CACHE_ENABLED` | `true` | |
| `CACHE_MINUTES_RC` | `10080` (7 days) | RC barely changes |
| `CACHE_MINUTES_CHALLAN` | `720` (12 h) | the volatile one |
| `CACHE_MINUTES_FASTAG` | `10080` (7 days) | |
| `CACHE_MINUTES_NOT_FOUND` | `1440` (24 h) | so a mistyped plate costs one call, not one per attempt |
| `LOG_ULIP_CALLS` | `true` | |

---

## How ULIP failures are read

ULIP reports a **missing vehicle as a complete success** at every outer level:

```json
{ "response": [ { "response": null,
                  "responseStatus": "ERROR",
                  "message": { "code": "231", "text": "Vehicle Details not Found" } } ],
  "error": "false", "code": "200", "message": "Success" }
```

HTTP 200 · `error:"false"` · `code:"200"` · `message:"Success"` — and the vehicle
does not exist. So every response is classified into one of four outcomes:

| Outcome | Trigger | What happens |
|---|---|---|
| `FOUND` | usable payload | cached and returned |
| `NOT_FOUND` | VAHAN **231**, e-Challan **305**, FASTag **740** | **stop** — no fallback, no retry. Cached briefly. |
| `RETRY` | 500, 502, timeout, mapping error | fall back / try again later |
| `REJECTED` | 400 | bad input; never retried |

### The VAHAN fallback

    VAHAN/04 (JSON) returns data      -> done
    VAHAN/04 says 231 (not found)     -> STOP. VAHAN/01 will not find it either.
    VAHAN/04 fails any other way      -> VAHAN/01 (XML)
    ULIP login fails                  -> STOP. Both datasets share one token.

The earlier implementation could not tell "mapping error" from "no such vehicle" —
it collapsed both into `null` and always fell back — so **every mistyped plate cost
two API calls instead of one.** Free while ULIP is free; a permanent tax on the
free-check funnel once it is not.

### Other traps handled

* `error` is the **string** `"false"` on success, so `if (body.error)` is true for
  every good response.
* `ECHALLAN/01` takes **`vehicleNumber`**; VAHAN and FASTAG take **`vehiclenumber`**.
* A vehicle can hold **several FASTags** — the live test vehicle returned three, two
  inactive. The active one is whichever has `TAGSTATUS = "A"`, not the first.
* VAHAN mixes date formats within one vehicle (`13-Sep-2021` and `12-09-2036`).
* PII is **masked by ULIP at source** — owner name, chassis and engine arrive partly
  starred, address is district + pincode, mobile is null.

---

## Cost

Every response carries `calls` — the ULIP requests that lookup actually spent — and
`ulip_calls_made`. ULIP is free today and will not always be; when that changes,
cost per customer is already measurable rather than a guess.

A cached lookup spends nothing. A vehicle that does not exist spends **one** call,
not two.
