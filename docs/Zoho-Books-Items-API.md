# Zoho Books: Items API vs UI

This doc clarifies **which API to use** for creating items in Zoho Books (India) and how it relates to the Zoho Books UI.

## Official public API (what we use)

- **Endpoint:** `POST /items`  
  Full URL (India): `https://www.zohoapis.in/books/v3/items`
- **Documentation:** [Zoho Books API v3 – Items – Create an Item](https://www.zoho.com/books/api/v3/items/#create-an-item)

**Required:**
- Query: `organization_id` (required)
- Body: `name` (string, max 100), `rate` (number)

**Optional (we use where needed):**
- `description`, `sku`, `product_type` (`goods` / `service` / `digital_service`), `unit`, `account_id`, `purchase_rate`, `custom_fields`, etc.

**Custom fields (per API):**
- `custom_fields`: array of `{ "customfield_id": "<id>", "value": "<value>" }`
- If your Zoho Books India has **Item Name** as a custom field (Settings → Customization → Items), send that value here using the field’s `customfield_id` (e.g. via `ZOHO_ITEM_NAME_CUSTOM_FIELD_ID` in `.env`).

---

## Zoho Books UI (internal, do not use for backend)

- The **web UI** may call an internal endpoint such as `POST /api/v3/product` with a different payload (e.g. `variants`, internal `custom_fields` structure).
- That endpoint is **not** part of the public API docs and is for the Zoho Books app only.
- For server-side integration we **must** use the **public API**: `POST /items` as above.

---

## Summary

| Use case              | Endpoint        | Notes                                      |
|-----------------------|-----------------|--------------------------------------------|
| Backend create item   | `POST /items`   | Public API; use this.                      |
| Zoho Books web UI     | e.g. `/product` | Internal; do not rely on it for our app.   |

Our implementation in `utils/zohoBooks.js` uses `POST /items` with `organization_id`, required `name` and `rate`, and optional `custom_fields` (including Item Name custom field when `ZOHO_ITEM_NAME_CUSTOM_FIELD_ID` is set). Item names are sanitized to alphanumeric and spaces to satisfy Zoho’s “Item Name” custom field rule when that field is used.
