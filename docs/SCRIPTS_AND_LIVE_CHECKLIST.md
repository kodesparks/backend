# Scripts & Live Deployment Checklist

**Last verified:** Scripts tested and working. Safe to push to live and brief frontend.

---

## ✅ Test result (verified)

The full Zoho flow script was run and **passed**:

| Step | What happened | Status |
|------|----------------|--------|
| Order | New test order created (e.g. CT-007) when none provided | ✅ |
| **1. Quote** | Created in Zoho Books, ID saved on order, email sent (Zoho or our SMTP fallback) | ✅ |
| **2. Sales Order** | Created in Zoho Books, ID saved on order, email attempted | ✅ |
| **3. Invoice** | Created in Zoho Books, marked as paid, ID saved on order | ✅ |

**Conclusion:** Quote → Sales Order → Invoice flow is working. You can push to live and tell frontend the backend flow is confirmed.

---

## All scripts (what they do & how to run)

### 1. `scripts/test-zoho-flow.js` — **Full flow test (use this to confirm)**

**What it does:**
- Connects to DB (uses `MONGO_URI` from `.env`).
- If you **don’t pass a leadId**: creates a **new test order** (uses first customer + first inventory item in DB), then runs the flow.
- If you **pass a leadId** (e.g. `CT-125`): uses that order (or creates one if not found).
- Runs in order:
  1. **Quote** — create in Zoho (if missing), email, save `zohoQuoteId`.
  2. **Sales Order** — create in Zoho (if missing), email, save `zohoSalesOrderId`.
  3. **Invoice** — create payment if needed, create in Zoho (if missing), mark paid, save `zohoInvoiceId`.
- Prints a clear **RESULT** block with Order, Quote ID, Sales Order ID, Invoice ID.

**When to use:** To confirm the full flow works before/after deploy. Run once to verify; safe to run on live DB (it only creates/updates one order and Zoho docs).

**How to run:**
```bash
npm run test:zoho-flow              # Create new test order and run full flow
npm run test:zoho-flow -- CT-125   # Use order CT-125 (or create if not found)
node scripts/test-zoho-flow.js
node scripts/test-zoho-flow.js CT-125
```

**Requires:** `.env` with `MONGO_URI`, Zoho Books vars, SMTP (for fallback quote email). At least one customer and one inventory item in DB when creating a new order.

---

### 2. `scripts/test-quote-for-order.js` — Quote-only test

**What it does:**
- Finds order by `leadId` (default `CT-120`).
- If order has no `zohoQuoteId`: creates Quote in Zoho, saves ID, emails quote (Zoho or SMTP fallback).
- If order already has `zohoQuoteId`: does nothing, just prints info.

**When to use:** When you only want to test or re-trigger **quote** for one order.

**How to run:**
```bash
npm run test:quote              # Uses default leadId CT-120
npm run test:quote -- CT-125    # Quote for order CT-125
node scripts/test-quote-for-order.js CT-125
```

**Requires:** Order must exist (script does **not** create an order). `.env` with `MONGO_URI`, Zoho, SMTP.

---

### 3. `test-zoho-integration-flow.js` (project root)

**What it does:** Older full integration test (Zoho connection, customer, inventory, order, quote, SO, invoice, E-Way). More verbose, uses existing or creates one test order.

**When to use:** Deeper integration check; optional. For “is the flow working?” use `scripts/test-zoho-flow.js` instead.

**How to run:**
```bash
node test-zoho-integration-flow.js
```

---

## npm scripts (package.json)

| Command | Script | Purpose |
|---------|--------|--------|
| `npm run test:zoho-flow` | `scripts/test-zoho-flow.js` | **Full flow test** — Quote → Sales Order → Invoice (creates order if needed). |
| `npm run test:quote` | `scripts/test-quote-for-order.js` | **Quote only** for a given order (order must exist). |
| `npm run dev` | `nodemon server.js` | Start backend in dev. |

---

## For frontend team (short brief)

You can send something like this:

- **Order flow (Zoho documents):**
  - **Place order** → Backend sends “order placed” email only (no Zoho doc).
  - **Vendor accepts** → Backend sends “order accepted” email only (no Quote/SO).
  - **Order confirmed** → Backend creates **Zoho Quote** and emails it (Zoho or our SMTP).
  - **Payment done** → Backend creates **Zoho Sales Order** and emails it.
  - **Later (e.g. out for delivery)** → Backend creates **Zoho Invoice** (and E-Way when applicable).

- **APIs:** Existing order/tracking/PDF endpoints unchanged. Order response includes `zohoQuoteId`, `zohoSalesOrderId`, `zohoInvoiceId` when set.

- **Backend check:** We run `npm run test:zoho-flow` to confirm Quote → Sales Order → Invoice generation; it’s passing. Safe to push to live.

---

## Quick “is it working?” check

On server (or locally with live `.env`):

```bash
npm run test:zoho-flow
```

- If you see **RESULT** with Order, Quote ID, Sales Order, Invoice → **flow is working.**
- If you see an error → check `.env` (MONGO_URI, Zoho, SMTP) and DB (at least one customer, one inventory item for new order creation).
