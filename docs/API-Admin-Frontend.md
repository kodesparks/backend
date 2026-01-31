# Admin Frontend – API Documentation

This document is for the **Admin Frontend** team. It lists **every backend API relevant to the Admin role**: orders, payments, deliveries, inventory (including Zoho mapping), admin dashboard/user management, and warehouse. Admin cannot call Zoho or other external APIs directly; all Zoho integration runs on the backend.

**Base paths (backend):**
- Orders: **`/api/order`** (singular)
- Inventory: **`/api/inventory`**
- Admin (dashboard, users, stats): **`/api/admin`**
- Warehouse: **`/api/warehouse`**
- Delivery (calculate, estimate): **`/api/delivery`**

All endpoints below require **authentication**. Order/admin/warehouse endpoints also require the appropriate **role** (admin, manager, etc.) as noted.

---

## 1. Entire flow (how it works)

1. **Customer** adds items to cart and places order (status: `order_placed`).
2. **Admin or Vendor** accepts → status `vendor_accepted`. Backend creates **Zoho Quote** and **Zoho sends quote email** to customer.
3. **Customer** pays; status moves to `payment_done` / `order_confirmed`.
4. **Admin or Vendor** confirms → Backend creates **Zoho Sales Order** and **Zoho sends sales order email**.
5. **Vendor** sets delivery to `in_transit` or `out_for_delivery` → Backend creates **Zoho Invoice** and **Zoho sends invoice email**; payment can be marked in Zoho.
6. **E-Way Bill** in Zoho when applicable (backend or manual in Zoho).

**Data links:** `leadId` ↔ Zoho `reference_number`; we store `zohoCustomerId`, `zohoItemId`, `zohoQuoteId`, `zohoSalesOrderId`, `zohoInvoiceId`. Admin does not call Zoho APIs.

---

## 2. Orders (Admin)

Base: **`/api/order`**. Role: **admin**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/order/admin/orders` | List all orders. Query: `status`, `vendorId`, `customerId`, `page`, `limit`. |
| GET | `/api/order/admin/orders/:leadId` | Single order (order, statusHistory, deliveryInfo, paymentInfo). |
| GET | `/api/order/admin/orders/stats` | Order statistics. |
| GET | `/api/order/admin/orders/date-range` | Orders in date range. Query: **`startDate`**, **`endDate`** (ISO), `page`, `limit`. |
| PUT | `/api/order/admin/orders/:leadId/status` | Update order status. Body: `orderStatus`, optional `remarks`. Triggers Zoho Quote (on `vendor_accepted`) and Zoho Sales Order + emails. |
| PUT | `/api/order/admin/orders/:leadId/delivery` | Update delivery. Body: optional `deliveryStatus`, `trackingNumber`, `courierService`, `expectedDeliveryDate`, `remarks`, `driverName`, `driverPhone`, `driverLicenseNo`, `truckNumber`, `vehicleType`, `capacityTons`, `startTime`, `estimatedArrival`, `lastLocation`, `deliveryNotes`. |
| POST | `/api/order/admin/orders/:leadId/delivered` | Mark as delivered. Body: optional `deliveredDate`, `receivedBy`, `remarks`. |
| POST | `/api/order/admin/orders/:leadId/cancel` | Cancel order. Body: optional `reason`. |
| POST | `/api/order/admin/orders/:leadId/confirm` | Confirm order. Body: optional `remarks`. |
| GET | `/api/order/admin/orders/:leadId/status-history` | Order status history. |

---

## 3. Payments (Admin)

Base: **`/api/order`**. Role: **admin**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/order/admin/payments/stats` | Payment statistics. |
| GET | `/api/order/admin/payments` | List all payments. Query: **`paymentStatus`**, **`paymentMethod`**, `page`, `limit`. |
| GET | `/api/order/admin/payments/:leadId` | Payment details for order (by leadId). |
| POST | `/api/order/admin/orders/:leadId/payment` | Mark payment done. Body: `paidAmount`, optional `paymentMethod`, `transactionId`, `paymentDate`, `remarks`. |

---

## 4. Deliveries (Admin)

Base: **`/api/order`**. Role: **admin**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/order/admin/deliveries/stats` | Delivery statistics. |
| GET | `/api/order/admin/deliveries/:leadId` | Delivery details for order. |

---

## 5. PDF downloads (Admin)

Base: **`/api/order`**. Backend fetches from Zoho and returns file. Role: **admin**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/order/admin/orders/:leadId/pdf/po` | Purchase Order PDF. |
| GET | `/api/order/admin/orders/:leadId/pdf/quote` | Quote (Estimate) PDF from Zoho. |
| GET | `/api/order/admin/orders/:leadId/pdf/so` | Sales Order PDF from Zoho. |
| GET | `/api/order/admin/orders/:leadId/pdf/invoice` | Invoice PDF from Zoho. |

---

## 6. Inventory (Admin / Manager / Vendor)

Base: **`/api/inventory`**. Most write operations require **admin**, **manager**, or **vendor** (vendor for own items). Zoho mapping and vendors list: **admin or manager**.

### 6.1 CRUD and list

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory` | List all inventory. Query: `page`, `limit`. Auth required. |
| GET | `/api/inventory/:id` | Get inventory item by ID. Auth required. |
| POST | `/api/inventory` | Create inventory. Body: `itemDescription`, `category` (Cement, Iron, or Concrete Mixer), `subCategory`, `units`, optional `vendorId` (Phase 1: no vendor portal). Auth: Admin/Manager/Vendor. |
| PUT | `/api/inventory/:id` | Update inventory. Body: optional `itemDescription`, `category`, `subCategory`, `units`. Auth: Admin/Manager/Vendor (own). |
| DELETE | `/api/inventory/:id` | Delete/deactivate inventory. Auth: Admin/Manager/Vendor (own). |

### 6.2 Pricing (public) and pricing update

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory/pricing` | Get items with calculated pricing. Query: optional `pincode`, `page`, `limit`, `category`, `subCategory`, `search`. **Public** (no auth). |
| GET | `/api/inventory/pricing/:itemId` | Single item with pricing. Query: optional `pincode`. **Public**. |
| PUT | `/api/inventory/:itemId/pricing` | Update inventory pricing. Body: optional `basePrice`, `unitPrice`, `baseCharge`, `perKmCharge`, `warehouseLatitude`, `warehouseLongitude`. Auth: Admin/Manager/Vendor (own). |

### 6.3 Zoho Books mapping (Admin/Manager only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory/zoho/unmapped` | Get inventory items not yet mapped to Zoho. Auth: Admin/Manager. |
| PUT | `/api/inventory/:id/zoho/map` | Map Zoho item to inventory. Body: `zohoItemId`. Auth: Admin/Manager. |

When inventory is created/updated, backend can auto-create item in Zoho and set `zohoItemId`; these endpoints are for manual mapping or fixing unmapped items.

### 6.4 Categories and vendors

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory/categories` | All categories and subcategories. Auth required. |
| GET | `/api/inventory/categories/:category/subcategories` | Subcategories for a category. `category`: Cement | Iron | Concrete Mixer. Auth required. |
| GET | `/api/inventory/vendors` | All vendors (Admin/Manager). Query: `page`, `limit`. |

### 6.5 Promo

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/inventory/promo` | Create promo. Body: `itemCode`, `promoName`, `discountType` (percentage | fixed), `startDate`, `endDate` (ISO), optional `minOrderValue`, `maxDiscountAmount`, `usageLimit`. Auth: Admin/Manager/Vendor (own). |
| GET | `/api/inventory/promo/active` | Active promos. Query: `page`, `limit`, optional `itemCode`. Auth required. |
| POST | `/api/inventory/promo/calculate` | Calculate promo discount. Body: `promoId`, `orderValue`. Auth required. |
| GET | `/api/inventory/:id/promo` | Promo data for one item. Query: optional `active`. Auth required. |

### 6.6 Images

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/inventory/:id/images` | Add images (multipart). Auth: Admin/Manager/Vendor (own). |
| GET | `/api/inventory/:id/images` | Get images for item. Auth required. |
| DELETE | `/api/inventory/:id/images/:imageKey` | Remove image. Auth: Admin/Manager/Vendor (own). |
| PUT | `/api/inventory/:id/images/:imageKey/primary` | Set primary image. Auth: Admin/Manager/Vendor (own). |

### 6.7 Inventory stats

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory/stats/overview` | Inventory statistics. Auth: requires inventory page permission. |

---

## 7. Admin dashboard and user management

Base: **`/api/admin`**. Role/permission as noted.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/dashboard` | Dashboard access. Auth: admin page. |
| GET | `/api/admin/inventory` | Inventory page access. Auth: inventory page. |
| GET | `/api/admin/bank-payments` | Bank payments page. Auth: bank payments. |
| GET | `/api/admin/vendor-details` | Vendor details page. Auth: vendor details. |
| GET | `/api/admin/user-management` | User management page. Auth: role/user creation. |
| GET | `/api/admin/stats` | System stats (users by role, active, verified). Auth: admin only. |
| PUT | `/api/admin/users/:userId/role` | Update user role. Body: `role` (admin | manager | employee | vendor | customer). Auth: admin only. |
| PUT | `/api/admin/users/:userId/status` | Activate/deactivate user. Body: `isActive` (boolean). Auth: admin only. |

---

## 8. Warehouse (Admin/Manager)

Base: **`/api/warehouse`**. Role: **admin** or **manager**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/warehouse/available` | Available warehouses. **Public**. |
| GET | `/api/warehouse/search` | Search warehouses. **Public**. |
| GET | `/api/warehouse/list` | List warehouses. **Public**. |
| POST | `/api/warehouse/create` | Create warehouse. Body: `warehouseName`, `location` (address, city, state, pincode, coordinates.latitude, coordinates.longitude), `categories` (array), `deliveryConfig` (baseDeliveryCharge, perKmCharge, minimumOrder). Auth: Admin/Manager. |
| GET | `/api/warehouse/vendor/:vendorId` | Warehouses by vendor. Auth: Admin/Manager. |
| PUT | `/api/warehouse/vendor/:vendorId` | Update vendor warehouses. Body: same as create (all optional). Auth: Admin/Manager. |
| DELETE | `/api/warehouse/:vendorId` | Delete warehouse (by vendorId). Auth: Admin/Manager. |
| POST | `/api/warehouse/sync-inventory` | Sync inventory warehouse data. Auth: Admin/Manager. |
| POST | `/api/warehouse/cleanup-orphaned` | Cleanup orphaned warehouse references. Auth: Admin/Manager. |

---

## 9. Delivery (calculate / estimate)

Base: **`/api/delivery`**. Can be used by admin for pricing/tools. **Public** (no auth).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/delivery/calculate` | Calculate delivery charges. Body: `pincode`, `items` (e.g. `[{ itemId, quantity }]`). |
| GET | `/api/delivery/estimate-time/:pincode` | Delivery time estimate for pincode. |

---

## 10. Other platforms (Zoho) – knowing purpose only

- **Zoho Books** is used by the backend for: Quotes, Sales Orders, Invoices, E-Way Bill, and **sending emails** (quote, sales order, invoice) to the customer. Inventory items are synced to Zoho (`zohoItemId`). Admin **cannot** call Zoho APIs from the frontend; all integration is server-side.
- **Inventory Zoho mapping:** Admin/Manager can use **GET /api/inventory/zoho/unmapped** and **PUT /api/inventory/:id/zoho/map** to link our inventory to Zoho items. Creating/updating inventory may auto-create the item in Zoho and set `zohoItemId`.

---

## 11. Email service behaviour

- **Who sends:** **Zoho Books** sends the emails. Backend only calls Zoho “send” APIs.
- **When:** (1) **Quote** – after backend creates Zoho Quote (e.g. order → `vendor_accepted`). (2) **Sales Order** – after backend creates Zoho SO (e.g. `vendor_accepted` / `order_confirmed`). (3) **Invoice** – when Vendor sets delivery to `in_transit` or `out_for_delivery`.
- **SMS:** Not sent via Zoho Books (no public SMS API for these documents).
- **Failures:** Backend logs and continues; order/document is still saved. Use PDF download endpoints to re-share.

---

## 12. Response and errors

- Success: typically `200` with JSON (`message`, data, `pagination` where applicable).
- Validation: `400` with error details.
- Not found: `404`.
- Unauthorized/Forbidden: `401` / `403`.

Use JWT and role/permission checks for all admin and inventory write/read endpoints as indicated above.
