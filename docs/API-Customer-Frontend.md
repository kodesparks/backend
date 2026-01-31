# Customer Frontend – API Documentation

This document is for the **Customer Frontend** team. It describes the **entire order and Zoho flow** for context, then lists only the **API endpoints and payloads relevant to the Customer role**. Customers do not integrate or call external platforms (e.g. Zoho Books); those integrations run only on the backend.

---

## 1. Entire flow (how it works)

High-level flow so the Customer UI can show the right screens and call the right APIs:

1. **Customer** adds items to cart (creates order with status `pending`), then **places order** → status becomes `order_placed`.
   - **Backend** creates a **Quote (Estimate)** in Zoho Books for this order. Customer can **download Quote PDF** via `GET .../pdf/quote` (see [PDF downloads](#24-pdf-downloads-customer) below).
2. **Admin or Vendor** accepts the order → status becomes `vendor_accepted`.
   - **Backend** may send the quote email via Zoho (see [Email service](#4-email-service-behaviour) below).
3. **Customer** completes **payment** (your app’s payment flow). When payment is successful, status can move to `payment_done` / `order_confirmed`.
4. **Admin or Vendor** confirms and generates Sales Order in Zoho → **Backend** creates Sales Order in Zoho and **Zoho sends the sales order email** to the customer.
5. **Vendor** ships and sets delivery to `in_transit` or `out_for_delivery`:
   - **Backend** creates an **Invoice** in Zoho and **Zoho sends the invoice email** to the customer.
   - If payment was already successful, the backend marks the invoice as paid in Zoho.
6. Customer can **track delivery** and **download Quote, Sales Order, Purchase Order (if applicable), and Invoice PDFs** via the APIs below. PDFs are served by our backend (backend fetches from Zoho when needed).

**Data links:** Our order is identified by `leadId`; the backend keeps this in sync with Zoho’s `reference_number` for Quote, Sales Order, and Invoice. **Customer does not call Zoho**; all Zoho integration is server-side.

---

## 2. Customer-only APIs (what Customer frontend can use)

**Base path for order APIs:** **`/api/order`** (singular). All customer order endpoints require **authentication** (logged-in customer).

### 2.1 Cart and orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/order/cart/add` | Add item to cart (creates a new order). Body: `itemCode` (MongoId), `qty`, optional `deliveryAddress`, `deliveryPincode`, `deliveryExpectedDate`, `custPhoneNum`, `receiverMobileNum`. |
| GET | `/api/order/customer/orders` | List current user’s orders/cart. Query: optional `status`, `page`, `limit`. |
| GET | `/api/order/customer/orders/:leadId` | Get single order details for the current customer. |
| PUT | `/api/order/customer/orders/:leadId` | Update order (e.g. delivery info before place). Body: optional `deliveryAddress`, `deliveryPincode`, `deliveryExpectedDate`, `receiverMobileNum`. |
| POST | `/api/order/customer/orders/:leadId/place` | Place order (move from cart to placed). Body: `deliveryAddress`, `deliveryPincode`, `deliveryExpectedDate`, `receiverMobileNum`. |
| DELETE | `/api/order/customer/orders/:leadId/items` | Remove item from cart. Body: `itemCode`. |
| DELETE | `/api/order/customer/orders/:leadId` | Remove entire order from cart. |
| DELETE | `/api/order/customer/orders/clear` | Clear entire cart (all pending orders). |

### 2.2 Payment (Customer)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/order/customer/orders/:leadId/payment` | Process payment. Body: `paymentType`, `paymentMode`. |
| GET | `/api/order/customer/orders/:leadId/payment` | Get payment status for the order. |

### 2.3 Delivery and tracking (Customer)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/order/customer/orders/:leadId/tracking` | Get order tracking info (delivery status, tracking number, etc.). |
| PUT | `/api/order/customer/orders/:leadId/address` | Change delivery address (within same pincode, within 48 hours). Body: `newAddress`, optional `reason`. |
| PUT | `/api/order/customer/orders/:leadId/delivery-date` | Change delivery date (within 48 hours). Body: `newDeliveryDate`, optional `reason`. |
| GET | `/api/order/customer/orders/:leadId/change-history` | Get order change history (e.g. address/date changes). |

### 2.4 PDF downloads (Customer)

The backend returns the PDF file (it may fetch from Zoho Books using stored Zoho IDs). Customer never calls Zoho directly.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/order/customer/orders/:leadId/pdf/quote` | Quote (Estimate) PDF (from Zoho; available after order is placed). |
| GET | `/api/order/customer/orders/:leadId/pdf/sales-order` | Sales Order PDF (from Zoho; available after admin/vendor generates the Sales Order). |
| GET | `/api/order/customer/orders/:leadId/pdf/po` | Purchase Order PDF (if applicable). |
| GET | `/api/order/customer/orders/:leadId/pdf/invoice` | Invoice PDF (from Zoho; available after invoice is created by backend when vendor sets delivery to in_transit/out_for_delivery). |

---

## 3. Other platforms (Zoho, etc.) – knowing purpose only

- **Zoho Books** is used by the backend for: creating Quote, Sales Order, and Invoice, and for **sending emails** (quote, sales order, invoice) to the customer. The customer may receive these emails from Zoho (e.g. “noreply@zoho.in” or your configured sender).
- **Customer cannot integrate** external platform APIs (e.g. Zoho Books) into this backend or from the Customer frontend. No Zoho API keys or credentials are exposed to the Customer UI. All Zoho integration is server-side.
- The Customer frontend only calls **our backend APIs** listed above. The backend handles Zoho and keeps documents in sync (e.g. `zohoQuoteId`, `zohoInvoiceId` on the order).

---

## 4. Email service behaviour

- **Who sends the emails:** **Zoho Books** sends the emails. Our backend calls Zoho’s “send” APIs; Zoho then sends the email to the customer’s contact (e.g. email on the Zoho customer/contact).
- **When the customer receives emails:**
  1. **Quote (Estimate):** The backend creates a Zoho Quote when the customer places the order. The quote email may be sent when Admin or Vendor accepts the order (`vendor_accepted`). The customer receives the **quote email** from Zoho.
  2. **Sales Order:** After the backend creates a Zoho Sales Order (when order is confirmed), it asks Zoho to email it. The customer receives the **sales order email** from Zoho.
  3. **Invoice:** When the Vendor sets delivery to `in_transit` or `out_for_delivery`, the backend creates a Zoho Invoice and asks Zoho to email it. The customer receives the **invoice email** from Zoho.
- **SMS:** Zoho Books does not provide a public API for SMS for estimates/sales orders/invoices. Any SMS (e.g. payment link, order updates) would be from another service, not from this Zoho integration.
- **Failures:** If Zoho’s email send fails, the backend still saves the order and Zoho document IDs. The customer can still use “Get order details” and “Download Invoice PDF” to view or download the invoice once it exists.

---

## 5. Response and errors

- Success: typically `200` with JSON (e.g. `message`, `order`, `payment`).
- Validation errors: `400` with error details.
- Not found: `404` (e.g. order not found or not owned by the customer).
- Unauthorized: `401` when the user is not logged in or token is invalid.

Use the existing backend auth (e.g. JWT) for all customer endpoints; the backend ensures customers only access their own orders.
