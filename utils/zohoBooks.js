import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Zoho Books API Service
 * Handles all Zoho Books API integrations.
 *
 * FLOW:
 * 1. Customer places order → Our SMTP sends order-placed email only (no Zoho quote yet).
 * 2. Order accepted (vendor_accepted) → Our SMTP sends order-accepted email only (no quote, no SO).
 * 3. Order confirmed (order_confirmed) → Create Quote in Zoho → Email quote to customer (Zoho Books API or our SMTP fallback).
 * 4. Payment done (payment_done) → Create Sales Order in Zoho → Email SO to customer (Zoho Books API).
 * 5. Vendor sets delivery to in_transit or out_for_delivery → Create Invoice in Zoho, then E-Way Bill (if applicable).
 * 6. Payment receipt in Zoho: markInvoiceAsPaid when payment is already successful (e.g. after step 5).
 *
 * Email: Quote and SO are emailed via Zoho Books API (or our SMTP fallback for quote). SMS is not integrated.
 * Note: Purchase Orders are created manually in Zoho dashboard.
 */

class ZohoBooksService {
  constructor() {
    // Use zohoapis.in domain for API requests (not books.zoho.in)
    // For India region, use www.zohoapis.in
    this.baseURL = process.env.ZOHO_BOOKS_BASE_URL || 'https://www.zohoapis.in/books/v3';
    this.organizationId = process.env.ZOHO_ORGANIZATION_ID || '60064355762';
    this.clientId = process.env.ZOHO_CLIENT_ID;
    this.clientSecret = process.env.ZOHO_CLIENT_SECRET;
    this.refreshToken = process.env.ZOHO_REFRESH_TOKEN;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Get or refresh access token
   */
  async getAccessToken() {
    // If we have a valid token, return it
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    // Refresh the token
    if (!this.refreshToken) {
      console.error('❌ Zoho refresh token is missing');
      console.error('   ZOHO_REFRESH_TOKEN from env:', process.env.ZOHO_REFRESH_TOKEN ? 'SET' : 'NOT SET');
      throw new Error('Zoho refresh token not configured. Please set ZOHO_REFRESH_TOKEN in .env');
    }

    try {
      const response = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
        params: {
          refresh_token: this.refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token'
        }
      });

      this.accessToken = response.data.access_token;
      // Set expiry to 55 minutes (tokens last 1 hour)
      this.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000);

      // Update base URL based on API domain from token response
      if (response.data.api_domain) {
        const apiDomain = response.data.api_domain.replace(/\/$/, ''); // Remove trailing slash
        this.baseURL = `${apiDomain}/books/v3`;
        console.log(`✅ Zoho Books access token refreshed, using API domain: ${this.baseURL}`);
      } else {
        console.log('✅ Zoho Books access token refreshed');
      }
      return this.accessToken;
    } catch (error) {
      const errorData = error.response?.data;
      if (errorData?.error_description?.includes('too many requests')) {
        console.error('⏳ Rate limit hit. Please wait 1-2 minutes before trying again.');
        throw new Error('Rate limit exceeded. Please wait before retrying.');
      }
      console.error('❌ Zoho Books token refresh error:', errorData || error.message);
      throw new Error(`Failed to refresh Zoho Books token: ${error.message}`);
    }
  }

  /**
   * Make authenticated API request to Zoho Books
   * Updated to match working Postman example: uses header instead of query param
   */
  async makeRequest(method, endpoint, data = null) {
    try {
      const token = await this.getAccessToken();
      const url = `${this.baseURL}/${endpoint}`;

      const config = {
        method,
        url,
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'X-com-zoho-books-organizationid': this.organizationId, // Use header (as per working Postman example)
          'Content-Type': 'application/json'
        }
      };

      // Create an Item, Product, Contacts, Contact Persons: doc requires organization_id as query param
      if (method === 'GET' || method === 'DELETE' || (method === 'POST' && (endpoint === 'items' || endpoint === 'product' || endpoint === 'contacts' || endpoint === 'contacts/contactpersons' || endpoint.startsWith('contacts/contactpersons/') && endpoint.endsWith('/primary')))) {
        config.params = {
          organization_id: this.organizationId
        };
      }

      if (data) config.data = data;

      const response = await axios(config);
      return response.data;
    } catch (error) {
      const errorData = error.response?.data;
      console.error(`❌ Zoho Books API error (${method} ${endpoint}):`, errorData?.message || errorData || error.message);
      if (errorData?.code && method === 'POST' && data && (endpoint === 'items' || endpoint === 'invoices' || endpoint === 'salesorder')) {
        console.error('📋 Request payload:', JSON.stringify(data).slice(0, 500) + (JSON.stringify(data).length > 500 ? '...' : ''));
      }
      throw error;
    }
  }

  /**
   * Create Purchase Order in Zoho Books
   * Called when: Order is placed (order_placed status)
   */
  async createPurchaseOrder(order, vendor, customer) {
    try {
      // When Inventory is NOT enabled, line items need account_id for expense tracking
      // Get purchase/expense account for line items
      let purchaseAccountId = null;
      try {
        const accounts = await this.getAccounts();
        const purchaseAccount = accounts.find(acc => 
          acc.account_type === 'cost_of_goods_sold' || 
          acc.account_type === 'expense' ||
          acc.account_name?.toLowerCase().includes('purchase') ||
          acc.account_name?.toLowerCase().includes('expense')
        );
        if (purchaseAccount?.account_id) {
          purchaseAccountId = purchaseAccount.account_id;
          console.log(`✅ Using purchase account: ${purchaseAccount.account_name} (${purchaseAccountId})`);
        }
      } catch (accountError) {
        console.warn(`⚠️  Could not fetch accounts: ${accountError.message}`);
      }

      // Build line items - when Inventory is disabled, account_id is REQUIRED
      // Also need a valid item name (not just 'I')
      const lineItems = order.items.map((item, index) => {
        // Get item name from populated order or use a descriptive name
        const itemName = item.itemCode?.itemDescription || 
                        item.itemCode?.name || 
                        `Item ${index + 1}`;
        
        // Limit name to 100 chars (Zoho limit)
        const shortName = itemName.substring(0, 100);
        
        const lineItem = {
          name: shortName, // Valid item name/description (required)
          rate: item.unitPrice,
          quantity: item.qty
        };
        
        // account_id is REQUIRED when Inventory is not enabled
        if (!purchaseAccountId) {
          throw new Error('Purchase account_id is required for Purchase Order line items when Inventory is not enabled. Please configure accounts in Zoho Books.');
        }
        lineItem.account_id = purchaseAccountId;
        
        return lineItem;
      });

      // Get or create vendor in Zoho Books - REQUIRED for Purchase Orders
      // According to Zoho API docs: vendor_id is REQUIRED
      let zohoVendorId = vendor?.zohoVendorId;
      if (!zohoVendorId && vendor) {
        try {
          zohoVendorId = await this.createOrGetVendor(vendor);
          if (zohoVendorId && !vendor.zohoVendorId) {
            vendor.zohoVendorId = zohoVendorId;
            await vendor.save();
          }
        } catch (error) {
          console.error(`❌ Vendor creation failed:`, error.message);
          throw new Error(`Cannot create Purchase Order: Vendor must be created in Zoho first. Error: ${error.message}`);
        }
      }
      
      if (!zohoVendorId) {
        throw new Error('Vendor ID is required for Purchase Order creation. Please create vendor in Zoho first.');
      }

      // Build Purchase Order payload
      // According to Zoho API: vendor_id (required) + date + line_items (required)
      // Don't set purchaseorder_number - let Zoho auto-generate
      // Custom fields are added via update after creation
      // When Inventory is disabled, ensure all required fields are present
      const purchaseOrderData = {
        vendor_id: zohoVendorId,
        date: new Date().toISOString().split('T')[0],
        line_items: lineItems
      };
      
      // Try adding vendor_name as well (some Zoho configurations might need both)
      try {
        const vendorInfo = await this.makeRequest('GET', `contacts/${zohoVendorId}`, null);
        if (vendorInfo.contact?.contact_name) {
          purchaseOrderData.vendor_name = vendorInfo.contact.contact_name;
        }
      } catch (vendorError) {
        console.warn(`⚠️  Could not fetch vendor name: ${vendorError.message}`);
      }

      console.log('📤 Creating Purchase Order:', JSON.stringify({ purchaseorder: purchaseOrderData }, null, 2));
      console.log(`📋 Vendor ID being used: ${zohoVendorId}`);
      
      // Verify vendor exists and is active before creating PO
      try {
        const vendorCheck = await this.makeRequest('GET', `contacts/${zohoVendorId}`, null);
        if (vendorCheck.contact) {
          console.log(`✅ Vendor verified: ${vendorCheck.contact.contact_name} (Status: ${vendorCheck.contact.status || 'N/A'})`);
          if (vendorCheck.contact.status !== 'active') {
            console.warn(`⚠️  Vendor status is not 'active': ${vendorCheck.contact.status}`);
          }
        }
      } catch (checkError) {
        console.warn(`⚠️  Could not verify vendor before PO creation:`, checkError.message);
      }
      
      const response = await this.makeRequest('POST', 'purchaseorders', { purchaseorder: purchaseOrderData });
      
      // Update with custom fields after creation
      if (response.purchaseorder?.purchaseorder_id) {
        try {
          const updateData = {};
          if (order.leadId) updateData.cf_lead_id = order.leadId;
          if (order.deliveryAddress) updateData.cf_delivery_address = order.deliveryAddress;
          if (order.deliveryPincode) updateData.cf_delivery_pincode = order.deliveryPincode;
          if (order.deliveryExpectedDate) updateData.cf_delivery_expected_date = new Date(order.deliveryExpectedDate).toISOString().split('T')[0];
          if (order.totalQty) updateData.cf_total_quantity = order.totalQty;
          if (order.deliveryCharges) updateData.cf_delivery_charges = order.deliveryCharges;
          
          if (Object.keys(updateData).length > 0) {
            await this.makeRequest('PUT', `purchaseorders/${response.purchaseorder.purchaseorder_id}`, { purchaseorder: updateData });
            console.log(`✅ Purchase Order updated with custom fields`);
          }
        } catch (updateError) {
          console.error(`⚠️  Failed to update Purchase Order with custom fields:`, updateError.message);
          // Don't fail - document was created successfully
        }
      }
      
      console.log(`✅ Purchase Order created in Zoho Books: ${response.purchaseorder?.purchaseorder_id}`);
      return response.purchaseorder;
    } catch (error) {
      console.error('❌ Failed to create Purchase Order in Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  /** Zoho Books Sales Order API: billing_address "address" field must be under 100 characters. */
  static get ZOHO_ADDRESS_MAX_LEN() { return 99; }

  /**
   * Enforce Zoho's 100-char limit (Sales Order API rejects "billing_address has less than 100 characters").
   * Zoho may count the main "address" field only: we cap it at 99. Also cap city/state/zip.
   */
  _truncateAddressForZoho(addr) {
    if (!addr || typeof addr !== 'object') return addr;
    const addrMax = 99;
    const out = { ...addr, country: addr.country || 'India' };
    if (out.address && out.address.length > addrMax) out.address = out.address.substring(0, addrMax);
    if (out.city && out.city.length > addrMax) out.city = out.city.substring(0, addrMax);
    if (out.state && out.state.length > addrMax) out.state = out.state.substring(0, addrMax);
    if (out.zip && out.zip.length > 20) out.zip = out.zip.substring(0, 20);
    return out;
  }

  /**
   * Stricter truncation for Sales Order create – Zoho returns "billing_address has less than 100 characters".
   * Docs imply the whole billing_address block is validated; enforce combined address+city+state <= 99 chars.
   */
  _truncateAddressForSalesOrderCreate(addr) {
    if (!addr || typeof addr !== 'object') return addr;
    const TOTAL_MAX = 99;
    const out = {
      address: (addr.address || '').trim(),
      city: (addr.city || '').trim(),
      state: (addr.state || '').trim(),
      zip: (addr.zip || '').trim() || undefined,
      country: addr.country || 'India'
    };
    if (out.zip && out.zip.length > 20) out.zip = out.zip.substring(0, 20);
    let total = (out.address.length || 0) + (out.city.length || 0) + (out.state.length || 0);
    if (total <= TOTAL_MAX) return out;
    // Trim from address first, then city, then state until total <= 99
    const maxAddr = Math.min(out.address.length, Math.max(0, TOTAL_MAX - out.city.length - out.state.length));
    out.address = out.address.substring(0, maxAddr);
    total = out.address.length + out.city.length + out.state.length;
    if (total > TOTAL_MAX) {
      const maxCity = Math.min(out.city.length, Math.max(0, TOTAL_MAX - out.address.length - out.state.length));
      out.city = out.city.substring(0, maxCity);
      total = out.address.length + out.city.length + out.state.length;
    }
    if (total > TOTAL_MAX) {
      const maxState = Math.min(out.state.length, Math.max(0, TOTAL_MAX - out.address.length - out.city.length));
      out.state = out.state.substring(0, maxState);
    }
    return out;
  }

  /**
   * Parse delivery address into structured address object for Zoho (billing/shipping).
   * Truncates to 99 chars for Zoho Sales Order API compatibility.
   * @param {Object} order - Order with deliveryAddress, deliveryPincode, deliveryCity?, deliveryState?
   */
  _parseDeliveryAddress(order) {
    const deliveryAddress = order.deliveryAddress;
    const deliveryPincode = order.deliveryPincode;
    const deliveryCity = order.deliveryCity && String(order.deliveryCity).trim();
    const deliveryState = order.deliveryState && String(order.deliveryState).trim();

    if (!deliveryAddress || deliveryAddress === 'Address to be updated') {
      return null;
    }

    const maxLen = 99;
    const address = deliveryAddress.trim().substring(0, maxLen);
    const pincode = deliveryPincode && deliveryPincode !== '000000' ? deliveryPincode : '';

    return {
      address: address || undefined,
      city: deliveryCity ? deliveryCity.substring(0, maxLen) : undefined,
      state: deliveryState ? deliveryState.substring(0, maxLen) : undefined,
      zip: pincode || undefined,
      country: 'India'
    };
  }

  /**
   * Get billing/shipping address for Zoho from order only (no customer fallback).
   * Per Zoho Books API: billing_address is object { address, street2?, city?, state?, zip?, country?, fax?, attention? }.
   * We do NOT fall back to customer profile address, to avoid showing placeholder/garbage (e.g. "asdf something") on the PDF.
   * @param {Object} order - Order with deliveryAddress, deliveryPincode, deliveryCity?, deliveryState?
   * @returns {Object|null} Zoho-style address { address, city?, state?, zip, country } or null
   */
  _getBillingAddressForZoho(order) {
    const fromOrder = this._parseDeliveryAddress(order);
    if (!fromOrder || !fromOrder.address) return null;
    return this._truncateAddressForZoho(fromOrder);
  }

  /**
   * Sanitize name for Zoho: alphanumeric and spaces only, max length.
   */
  _sanitizeItemName(raw, maxLen = 100) {
    const s = String(raw || 'Item').trim().replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    return (s || 'Item').substring(0, maxLen);
  }

  /**
   * Create item via Zoho Books Product API (POST /product with one variant).
   * Returns variant_id which is used as item_id elsewhere. Uses zohoapis domain (same as other API calls).
   */
  async createItemViaProduct(inventoryItem) {
    try {
      const accounts = await this.getAccounts();
      const salesAccount = (accounts || []).find(acc =>
        acc.account_name === 'Sales' || acc.account_type === 'income' || acc.account_type === 'other_income'
      );
      const purchaseAccount = (accounts || []).find(acc =>
        (acc.account_name && (acc.account_name.includes('Cost of Goods Sold') || acc.account_name.includes('COGS'))) ||
        acc.account_type === 'cost_of_goods_sold'
      );
      if (!salesAccount?.account_id) return null;
      const purchaseAccountId = purchaseAccount?.account_id ? String(purchaseAccount.account_id) : String(salesAccount.account_id);

      const displayName = this._sanitizeItemName(inventoryItem.itemDescription || inventoryItem.name || 'Item', 100);
      const rate = Math.max(0, Number(inventoryItem.pricing?.unitPrice) || 0);
      const purchaseRate = Math.max(0, Number(inventoryItem.pricing?.basePrice) || 0);
      const sku = inventoryItem.itemCode || inventoryItem.sku;
      const skuStr = (sku && String(sku).length <= 100) ? String(sku) : `item-${Date.now()}`;
      const uniqueSuffix = skuStr.length >= 8 ? skuStr.slice(-8) : skuStr;
      const itemName = `${displayName} ${uniqueSuffix}`.trim().substring(0, 100);

      const descRaw = [inventoryItem.details, inventoryItem.specification].filter(Boolean).join(' ').trim();
      const description = this._sanitizeItemName(descRaw, 2000) || '';
      const purchaseDescription = description;

      const unit = (inventoryItem.units || 'Nos').toString().toUpperCase().replace(/_/g, ' ').trim().substring(0, 50) || 'Nos';
      const hsnOrSac = String(inventoryItem.hscCode || inventoryItem.hsnCode || '').trim().substring(0, 50) || '';

      const warehouses = inventoryItem.warehouses || [];
      const initialStock = warehouses.reduce((sum, w) => sum + (Number(w.stock?.available) || 0), 0);
      const initialStockRate = purchaseRate > 0 ? String(purchaseRate) : '';

      const cfItemName = process.env.ZOHO_ITEM_NAME_CUSTOM_FIELD_ID || '3422894000000033136';
      const cfItemCd = process.env.ZOHO_ITEM_CD_CUSTOM_FIELD_ID || '3422894000000033130';

      const variant = {
        name: itemName,
        rate: String(rate),
        account_id: String(salesAccount.account_id),
        tax_id: '',
        tags: [],
        sku: skuStr,
        upc: '', ean: '', part_number: '', isbn: '',
        custom_fields: [
          { value: '', customfield_id: cfItemCd },
          { value: '', customfield_id: cfItemName }
        ],
        purchase_rate: String(purchaseRate),
        purchase_account_id: purchaseAccountId,
        purchase_description: purchaseDescription,
        description,
        unit,
        hsn_or_sac: hsnOrSac,
        is_taxable: true,
        product_type: 'goods',
        item_tax_preferences: [],
        taxability_type: 'none',
        can_be_sold: true,
        can_be_purchased: true
      };
      if (initialStock > 0 && initialStockRate) {
        variant.initial_stock = String(initialStock);
        variant.initial_stock_rate = initialStockRate;
      }

      const productPayload = {
        product_type: 'goods',
        name: itemName,
        description: description || undefined,
        is_taxable: true,
        account_id: String(salesAccount.account_id),
        purchase_account_id: purchaseAccountId,
        variants: [variant]
      };

      const productUrl = `${this.baseURL.replace(/\/$/, '')}/product`;
      const token = await this.getAccessToken();
      const response = await axios({
        method: 'POST',
        url: productUrl,
        params: { organization_id: this.organizationId },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'X-com-zoho-books-organizationid': this.organizationId,
          'Content-Type': 'application/json'
        },
        data: productPayload
      });

      const variantId = response.data?.product?.variants?.[0]?.variant_id;
      if (variantId) {
        console.log(`✅ Zoho item created: ${displayName} (${skuStr}) → ${variantId}`);
        return String(variantId);
      }
      return null;
    } catch (error) {
      if (error.response?.data?.message) {
        console.warn('⚠️  Zoho Product API:', error.response.data.message);
      }
      return null;
    }
  }

  /**
   * Create item in Zoho Books. Uses Product API first (POST /product); falls back to POST /items if needed.
   * @returns {Promise<string|null>} Zoho item_id (or variant_id from product) or null
   */
  async createItemInZoho(inventoryItem) {
    const itemId = await this.createItemViaProduct(inventoryItem);
    if (itemId) return itemId;

    try {
      const accounts = await this.getAccounts();
      const salesAccount = (accounts || []).find(acc =>
        acc.account_name === 'Sales' || acc.account_type === 'income' || acc.account_type === 'other_income'
      );
      if (!salesAccount?.account_id) return null;

      const name = this._sanitizeItemName(inventoryItem.itemDescription || inventoryItem.name || 'Item', 100);
      const sku = inventoryItem.itemCode || inventoryItem.sku;
      const skuStr = (sku && String(sku).length <= 100) ? String(sku) : `item-${Date.now()}`;
      const rate = Math.max(0, Number(inventoryItem.pricing?.unitPrice) || 0);
      const descRaw = [inventoryItem.details, inventoryItem.specification].filter(Boolean).join(' ').trim();
      const description = this._sanitizeItemName(descRaw, 2000) || '';
      const unit = (inventoryItem.units || 'Nos').toString().toUpperCase().replace(/_/g, ' ').trim().substring(0, 50) || 'Nos';
      const hsnOrSac = String(inventoryItem.hscCode || inventoryItem.hsnCode || '').trim().substring(0, 50) || '';

      const zohoItemData = {
        name,
        rate,
        product_type: 'goods',
        unit,
        account_id: String(salesAccount.account_id),
        sku: skuStr
      };
      if (inventoryItem.pricing?.basePrice != null) {
        zohoItemData.purchase_rate = String(Math.max(0, Number(inventoryItem.pricing.basePrice)));
      }
      if (description) {
        zohoItemData.description = description;
        zohoItemData.purchase_description = description;
      }
      if (hsnOrSac) zohoItemData.hsn_or_sac = hsnOrSac;

      const response = await this.makeRequest('POST', 'items', { item: zohoItemData });
      if (response.item?.item_id) {
        console.log(`✅ Zoho item created (items API): ${name} → ${response.item.item_id}`);
        return response.item.item_id;
      }
      return null;
    } catch (error) {
      console.warn('⚠️  createItemInZoho failed:', error.response?.data?.message || error.message);
      return null;
    }
  }

  /**
   * Create or get item in Zoho Books (helper function)
   * Tries: existing zohoItemId → find by SKU → create in Zoho (real name, SKU, rate). Maintains link.
   */
  async createOrGetItem(inventoryItem) {
    try {
      if (!inventoryItem) return null;
      if (inventoryItem.zohoItemId) {
        return inventoryItem.zohoItemId;
      }

      const sku = inventoryItem.itemCode || inventoryItem.sku;
      if (sku) {
        try {
          const existingItems = await this.makeRequest('GET', 'items', null);
          if (existingItems.items && Array.isArray(existingItems.items)) {
            const existing = existingItems.items.find(item => item.sku === String(sku));
            if (existing?.item_id) {
              console.log(`✅ Found existing item in Zoho by SKU: ${existing.item_id}`);
              inventoryItem.zohoItemId = existing.item_id;
              if (typeof inventoryItem.save === 'function') {
                await inventoryItem.save();
              }
              return existing.item_id;
            }
          }
        } catch (error) {
          console.warn('⚠️  Error checking existing items:', error.message);
        }
      }

      const newItemId = await this.createItemInZoho(inventoryItem);
      if (newItemId) {
        inventoryItem.zohoItemId = newItemId;
        if (typeof inventoryItem.save === 'function') {
          await inventoryItem.save();
        }
        return newItemId;
      }

      return null;
    } catch (error) {
      console.warn('⚠️  Error in createOrGetItem:', error.message);
      return null;
    }
  }

  /**
   * Create Sales Order in Zoho Books
   * Called when: Admin generates SO (Step 4 in flow)
   * Flow: Customer places order → Admin creates Quote → Admin generates SO → Dispatch → Invoice
   */
  async createSalesOrder(order, vendor, customer) {
    try {
      // Get or create customer in Zoho; always call so email/phone from our User model are synced (for SO email)
      let zohoCustomerId = null;
      if (customer) {
        try {
          zohoCustomerId = await this.createOrGetCustomer(customer);
          if (zohoCustomerId && !customer.zohoCustomerId) {
            customer.zohoCustomerId = zohoCustomerId;
            await customer.save();
          }
        } catch (error) {
          console.error(`⚠️  Customer creation failed:`, error.message);
          throw new Error(`Cannot create Sales Order: Customer must be created in Zoho first. Error: ${error.message}`);
        }
      }
      if (!zohoCustomerId) {
        throw new Error('Customer ID is required for Sales Order creation. Please create customer in Zoho first.');
      }

      // Try to use item_id if items exist in Zoho, otherwise use name
      const lineItems = [];
      for (const orderItem of order.items) {
        const inventoryItem = orderItem.itemCode;
        
        // Try to get item_id if available
        let itemId = null;
        if (inventoryItem?.zohoItemId) {
          itemId = inventoryItem.zohoItemId;
        } else if (inventoryItem) {
          itemId = await this.createOrGetItem(inventoryItem);
        }

        if (itemId) {
          lineItems.push({
            item_id: itemId,
            rate: orderItem.unitPrice,
            quantity: orderItem.qty
          });
        } else {
          const itemName = inventoryItem?.itemDescription || 
                          inventoryItem?.name || 
                          'Item';
          lineItems.push({
            name: itemName.substring(0, 100),
            rate: orderItem.unitPrice,
            quantity: orderItem.qty
          });
        }
      }

      // Billing/shipping: prefer order delivery address, fallback to customer profile
      // Billing/shipping: ONLY from order (place order API). Never use Zoho contact/signup address.
      const deliveryAddr = this._getBillingAddressForZoho(order);
      if (!deliveryAddr) {
        console.warn(`⚠️  Sales Order will use Zoho contact address: order has no valid delivery address. Ensure place order API was called with deliveryAddress.`);
      }

      // Build Sales Order payload
      // DO NOT send salesorder_number - let Zoho auto-generate it
      // Build Sales Order payload (Zoho Sales Order API)
      // reference_number = our order ID (leadId) for sync between our system and Zoho
      // DO NOT send salesorder_number - let Zoho auto-generate it
      const salesOrderData = {
        customer_id: zohoCustomerId,
        date: new Date().toISOString().split('T')[0],
        reference_number: order.leadId || '',
        line_items: lineItems,
        is_inclusive_tax: true
      };
      
      // Add shipping charge if present
      if (order.deliveryCharges && order.deliveryCharges > 0) {
        salesOrderData.shipping_charge = String(order.deliveryCharges.toFixed(2));
      }
      
      // Do NOT send billing_address/shipping_address on create – Zoho rejects with
      // "billing_address has less than 100 characters" (they validate the whole block).
      // We create the SO first, then set addresses via PUT so create never fails.
      
      console.log('📤 Creating Sales Order in Zoho:', JSON.stringify(salesOrderData, null, 2));
      const response = await this.makeRequest('POST', 'salesorders', salesOrderData);
      
      // Update with custom fields and proper item names after creation
      if (response.salesorder?.salesorder_id) {
        try {
          const updateData = {};
          
          // Update line items with proper names
          const updatedLineItems = order.items.map((item, index) => {
            const itemName = item.itemCode?.itemDescription || 
                            item.itemCode?.name || 
                            `Item ${index + 1}`;
            const cleanName = itemName.trim().substring(0, 100);
            const finalName = cleanName.length >= 2 ? cleanName : `Item ${index + 1}`;
            
            return {
              line_item_id: response.salesorder.line_items?.[index]?.line_item_id,
              name: finalName.substring(0, 100),
              rate: item.unitPrice,
              quantity: item.qty
            };
          });
          
          if (updatedLineItems.length > 0) {
            updateData.line_items = updatedLineItems;
          }
          
          // Add custom fields
          if (order.leadId) updateData.cf_lead_id = order.leadId;
          if (order.deliveryAddress) updateData.cf_delivery_address = order.deliveryAddress;
          if (order.deliveryPincode) updateData.cf_delivery_pincode = order.deliveryPincode;
          if (order.deliveryExpectedDate) updateData.cf_delivery_expected_date = new Date(order.deliveryExpectedDate).toISOString().split('T')[0];
          if (order.totalQty) updateData.cf_total_quantity = order.totalQty;
          if (order.deliveryCharges) updateData.cf_delivery_charges = order.deliveryCharges;
          
          if (Object.keys(updateData).length > 0) {
            // Sales Orders API expects data WITHOUT { salesorder: {...} } wrapper
            await this.makeRequest('PUT', `salesorders/${response.salesorder.salesorder_id}`, updateData);
            console.log(`✅ Sales Order updated with custom fields and proper item names`);
          }
        } catch (updateError) {
          console.warn(`⚠️  Failed to update Sales Order with custom fields:`, updateError.message);
          // Don't fail - SO was created successfully
        }

        // Set document-level billing/shipping (use same strict truncation as create)
        if (deliveryAddr) {
          const safeAddr = this._truncateAddressForSalesOrderCreate(deliveryAddr);
          try {
            await this.makeRequest('PUT', `salesorders/${response.salesorder.salesorder_id}/address/billing`, safeAddr);
            await this.makeRequest('PUT', `salesorders/${response.salesorder.salesorder_id}/address/shipping`, safeAddr);
            console.log(`✅ Sales Order billing/shipping address set on document`);
          } catch (addrError) {
            console.warn(`⚠️  Failed to set Sales Order billing/shipping address:`, addrError.message);
          }
        }
      }
      
      console.log(`✅ Sales Order created in Zoho Books: ${response.salesorder?.salesorder_id}`);
      return response.salesorder;
    } catch (error) {
      console.error('❌ Failed to create Sales Order in Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Email an estimate (quote) to the customer via Zoho Books.
   * POST /estimates/{estimate_id}/email
   * Sends to contact persons associated with the estimate. When to_mail_ids is not provided, send empty body
   * so Zoho uses default contact persons (avoids "Invalid value passed for to_mail_ids").
   * Our SMTP already sends quote-ready email with PDF URL.
   */
  async emailEstimate(estimateId, options = {}) {
    if (!estimateId) return null;
    try {
      const pdfUrl = await this.getQuotePDFUrl(estimateId);
      const body = {};
      if (options.to_mail_ids != null && options.to_mail_ids !== '') {
        body.to_mail_ids = options.to_mail_ids;
      }
      if (Object.keys(body).length === 0) {
        // No custom recipients: send empty body so Zoho emails to contact persons (avoids to_mail_ids error)
        const response = await this.makeRequest('POST', `estimates/${estimateId}/email`, {});
        if (response?.code === 0) {
          console.log(`✅ Zoho Books: Estimate ${estimateId} emailed successfully`);
          return { ...response, pdfUrl };
        }
        return { ...response, pdfUrl };
      }
      if (options.subject) body.subject = options.subject;
      let emailBody = options.body || '';
      if (pdfUrl) emailBody += (emailBody ? '\n\n' : '') + `View Quote PDF: ${pdfUrl}`;
      if (emailBody) body.body = emailBody;
      const response = await this.makeRequest('POST', `estimates/${estimateId}/email`, body);
      if (response?.code === 0) {
        console.log(`✅ Zoho Books: Estimate ${estimateId} emailed successfully`);
        return { ...response, pdfUrl };
      }
      return { ...response, pdfUrl };
    } catch (error) {
      console.warn(`⚠️  Zoho Books email estimate failed:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Email a sales order via Zoho Books. When to_mail_ids not provided, send empty body to avoid to_mail_ids error.
   */
  async emailSalesOrder(salesOrderId, options = {}) {
    if (!salesOrderId) return null;
    try {
      const pdfUrl = await this.getSalesOrderPDFUrl(salesOrderId);
      const body = {};
      if (options.to_mail_ids != null && options.to_mail_ids !== '') body.to_mail_ids = options.to_mail_ids;
      if (Object.keys(body).length === 0) {
        const response = await this.makeRequest('POST', `salesorders/${salesOrderId}/email`, {});
        if (response?.code === 0) console.log(`✅ Zoho Books: Sales Order ${salesOrderId} emailed successfully`);
        return response ? { ...response, pdfUrl } : { pdfUrl };
      }
      if (options.subject) body.subject = options.subject;
      let emailBody = options.body || '';
      if (pdfUrl) emailBody += (emailBody ? '\n\n' : '') + `View Sales Order PDF: ${pdfUrl}`;
      if (emailBody) body.body = emailBody;
      const response = await this.makeRequest('POST', `salesorders/${salesOrderId}/email`, body);
      if (response?.code === 0) console.log(`✅ Zoho Books: Sales Order ${salesOrderId} emailed successfully`);
      return response ? { ...response, pdfUrl } : { pdfUrl };
    } catch (error) {
      console.warn(`⚠️  Zoho Books email sales order failed:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Email an invoice via Zoho Books. When to_mail_ids not provided, send empty body to avoid to_mail_ids error.
   */
  async emailInvoice(invoiceId, options = {}) {
    if (!invoiceId) return null;
    try {
      const pdfUrl = await this.getInvoicePDFUrl(invoiceId);
      const body = {};
      if (options.to_mail_ids != null && options.to_mail_ids !== '') body.to_mail_ids = options.to_mail_ids;
      if (Object.keys(body).length === 0) {
        const response = await this.makeRequest('POST', `invoices/${invoiceId}/email`, {});
        if (response?.code === 0) console.log(`✅ Zoho Books: Invoice ${invoiceId} emailed successfully`);
        return response ? { ...response, pdfUrl } : { pdfUrl };
      }
      if (options.subject) body.subject = options.subject;
      let emailBody = options.body || '';
      if (pdfUrl) emailBody += (emailBody ? '\n\n' : '') + `View Invoice PDF: ${pdfUrl}`;
      if (emailBody) body.body = emailBody;
      const response = await this.makeRequest('POST', `invoices/${invoiceId}/email`, body);
      if (response?.code === 0) {
        console.log(`✅ Zoho Books: Invoice ${invoiceId} emailed successfully`);
        return { ...response, pdfUrl };
      }
      return { ...response, pdfUrl };
    } catch (error) {
      console.warn(`⚠️  Zoho Books email invoice failed:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Create Invoice in Zoho Books
   * Called when: Delivery status is in_transit or out_for_delivery (NOT at payment_done).
   * Payment receipt / mark-as-paid is still applied when payment is already successful.
   */
  async createInvoice(order, payment, vendor, customer) {
    try {
      // Build line items with real names and Zoho item_id when available (maintain inventory link)
      const lineItems = [];
      for (const orderItem of order.items) {
        const inventoryItem = orderItem.itemCode;
        let itemId = inventoryItem?.zohoItemId || null;
        if (!itemId && inventoryItem) {
          itemId = await this.createOrGetItem(inventoryItem);
        }
        const realName = (inventoryItem?.itemDescription || inventoryItem?.name || 'Item').trim();
        const nameForZoho = realName.length ? realName.substring(0, 255) : 'Item';
        if (itemId) {
          lineItems.push({ item_id: itemId, rate: orderItem.unitPrice, quantity: orderItem.qty });
        } else {
          lineItems.push({ name: nameForZoho, rate: orderItem.unitPrice, quantity: orderItem.qty });
        }
      }

      // Get or create customer in Zoho; always call createOrGetCustomer when we have customer so email/phone are synced (for invoice email)
      let zohoCustomerId = null;
      if (customer) {
        try {
          zohoCustomerId = await this.createOrGetCustomer(customer);
          if (zohoCustomerId && !customer.zohoCustomerId) {
            customer.zohoCustomerId = zohoCustomerId;
            await customer.save();
          }
        } catch (error) {
          console.error(`⚠️  Customer creation failed, continuing without customer_id:`, error.message);
        }
      }

      // Billing/shipping: prefer order delivery address, fallback to customer profile
      // Billing/shipping: ONLY from order (place order API). Never use Zoho contact/signup address.
      const deliveryAddr = this._getBillingAddressForZoho(order);
      if (!deliveryAddr) {
        console.warn(`⚠️  Invoice will use Zoho contact address: order has no valid delivery address. Ensure place order API was called with deliveryAddress.`);
      }

      // Don't provide invoice_number - let Zoho auto-generate it
      // is_inclusive_tax: true so total matches our order total (no extra GST added)
      let invoiceData = {
        date: new Date().toISOString().split('T')[0],
        reference_number: order.leadId || '',
        line_items: lineItems,
        is_inclusive_tax: true
      };
      if (zohoCustomerId) {
        invoiceData.customer_id = zohoCustomerId;
      }
      
      // Add shipping charge if present
      if (order.deliveryCharges && order.deliveryCharges > 0) {
        invoiceData.shipping_charge = String(order.deliveryCharges.toFixed(2));
      }
      
      // Do NOT send billing_address/shipping_address on create – Zoho returns same error as Sales Order:
      // "billing_address has less than 100 characters". Create first, then set addresses via PUT.

      // Custom fields are added via update after creation
      // IMPORTANT: Invoices API expects data WITHOUT { invoice: {...} } wrapper (like Estimates and Sales Orders)
      console.log('📤 Creating Invoice in Zoho:', JSON.stringify(invoiceData, null, 2));
      const response = await this.makeRequest('POST', 'invoices', invoiceData);
      
      // Update with custom fields after creation
      if (response.invoice?.invoice_id) {
        try {
          const updateData = {};
          if (order.leadId) updateData.cf_lead_id = order.leadId;
          if (order.invcNum) updateData.cf_invoice_number = order.invcNum;
          if (order.deliveryAddress) updateData.cf_delivery_address = order.deliveryAddress;
          if (order.deliveryPincode) updateData.cf_delivery_pincode = order.deliveryPincode;
          if (order.deliveryExpectedDate) updateData.cf_delivery_expected_date = new Date(order.deliveryExpectedDate).toISOString().split('T')[0];
          if (order.totalQty) updateData.cf_total_quantity = order.totalQty;
          if (order.deliveryCharges) updateData.cf_delivery_charges = order.deliveryCharges;
          
          if (Object.keys(updateData).length > 0) {
            // Invoices API expects data WITHOUT { invoice: {...} } wrapper
            await this.makeRequest('PUT', `invoices/${response.invoice.invoice_id}`, updateData);
            console.log(`✅ Invoice updated with custom fields`);
          }
        } catch (updateError) {
          console.warn(`⚠️  Failed to update Invoice with custom fields:`, updateError.message);
          // Don't fail - invoice was created successfully
        }

        // Set document-level billing/shipping so PDF shows order delivery address (strict truncation for Zoho 100-char limit)
        if (deliveryAddr) {
          const safeAddr = this._truncateAddressForSalesOrderCreate(deliveryAddr);
          try {
            await this.makeRequest('PUT', `invoices/${response.invoice.invoice_id}/address/billing`, safeAddr);
            await this.makeRequest('PUT', `invoices/${response.invoice.invoice_id}/address/shipping`, safeAddr);
            console.log(`✅ Invoice billing/shipping address set on document`);
          } catch (addrError) {
            console.warn(`⚠️  Failed to set Invoice billing/shipping address:`, addrError.message);
          }
        }
      }
      
      // Mark invoice as paid if payment is successful (non-blocking)
      if (payment && payment.paymentStatus === 'successful' && response.invoice?.invoice_id) {
        (async () => {
          try {
            await this.markInvoiceAsPaid(response.invoice.invoice_id, payment);
          } catch (error) {
            console.warn('⚠️  Payment marking failed, but invoice was created successfully');
          }
        })();
      }
      
      console.log(`✅ Invoice created in Zoho Books: ${response.invoice?.invoice_id}`);
      return response.invoice;
    } catch (error) {
      console.error('❌ Failed to create Invoice in Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Mark invoice as paid in Zoho Books
   */
  async markInvoiceAsPaid(invoiceId, payment) {
    try {
      // Get invoice details first to get the total amount
      const invoiceDetails = await this.makeRequest('GET', `invoices/${invoiceId}`);
      const invoiceTotal = invoiceDetails.invoice?.total || payment.paidAmount || payment.orderAmount;
      
      const paymentData = {
        customer_id: invoiceDetails.invoice?.customer_id,
        invoices: [
          {
            invoice_id: invoiceId,
            amount: invoiceTotal // Use invoice total, not payment amount
          }
        ],
        payment_mode: this.mapPaymentMode(payment.paymentType),
        amount: invoiceTotal, // Total payment amount should match invoice total
        date: payment.paymentDate ? new Date(payment.paymentDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        reference_number: payment.transactionId || payment.utrNum || '',
        notes: `Payment received via ${payment.paymentType || 'N/A'}`
      };

      // Customer payments API expects data WITHOUT wrapper (like other endpoints)
      const response = await this.makeRequest('POST', 'customerpayments', paymentData);
      console.log(`✅ Invoice marked as paid in Zoho Books: ${invoiceId}`);
      return response.payment || response.customerpayment;
    } catch (error) {
      console.error('❌ Failed to mark invoice as paid in Zoho Books:', error.response?.data || error.message);
      // Don't throw - invoice was created successfully, payment marking is optional
      console.warn('⚠️  Invoice created but payment marking failed. You can mark it as paid manually in Zoho.');
      return null;
    }
  }


  /**
   * Map payment type to Zoho payment mode
   */
  mapPaymentMode(paymentType) {
    const mapping = {
      'credit_card': 'Credit Card',
      'debit_card': 'Debit Card',
      'upi': 'UPI',
      'net_banking': 'Net Banking',
      'wallet': 'Wallet',
      'cash_on_delivery': 'Cash',
      'bank_transfer': 'Bank Transfer'
    };
    return mapping[paymentType] || 'Other';
  }

  /**
   * Test connection to Zoho Books
   */
  async testConnection() {
    try {
      const response = await this.makeRequest('GET', 'organizations');
      console.log('✅ Zoho Books connection successful');
      return { success: true, organization: response.organizations?.[0] };
    } catch (error) {
      console.error('❌ Zoho Books connection failed:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get accounts list (needed for item creation)
   */
  async getAccounts() {
    try {
      const response = await this.makeRequest('GET', 'chartofaccounts');
      return response.chartofaccounts || [];
    } catch (error) {
      // Try alternative endpoint
      try {
        const response2 = await this.makeRequest('GET', 'accounts');
        return response2.accounts || [];
      } catch (error2) {
        console.error('❌ Failed to get accounts:', error.response?.data || error2.response?.data || error.message);
        return [];
      }
    }
  }

  /**
   * Create or get Vendor in Zoho Books
   * @param {Object} vendor - User object with vendor role
   * @returns {Promise<string>} Zoho Vendor ID
   */
  async createOrGetVendor(vendor) {
    try {
      // If vendor already has Zoho ID, return it
      if (vendor.zohoVendorId) {
        return vendor.zohoVendorId;
      }

      // Check if vendor exists by email (use contacts endpoint - works even if Inventory is disabled)
      try {
        const existingContacts = await this.makeRequest('GET', 'contacts', null);
        if (existingContacts.contacts && Array.isArray(existingContacts.contacts)) {
          const existing = existingContacts.contacts.find(c => 
            c.email && vendor.email && c.email.toLowerCase() === vendor.email.toLowerCase() &&
            (c.customer_type === 'vendor' || c.contact_type === 'vendor' || c.is_vendor === true)
          );
          if (existing && existing.contact_id) {
            console.log(`✅ Found existing vendor in Zoho: ${existing.contact_id}`);
            // Update vendor with Zoho ID
            if (!vendor.zohoVendorId) {
              vendor.zohoVendorId = existing.contact_id;
              await vendor.save();
            }
            return existing.contact_id;
          }
        }
      } catch (error) {
        console.error('⚠️  Error checking existing vendors:', error.message);
        // Continue to create new vendor
      }

      // Create new vendor
      let vendorName = (vendor.name || vendor.companyName || 'Vendor').trim();
      if (!vendorName || vendorName.length < 2) {
        throw new Error('Vendor name is required and must be at least 2 characters');
      }

      // Format vendor name - use company name if available, otherwise use name
      // According to Zoho: contact_name is the Display Name (shown in UI)
      // For India GST accounts, prefer company name format
      let cleanVendorName = '';
      
      if (vendor.companyName && vendor.companyName.trim()) {
        // Use company name as primary (Display Name in UI)
        cleanVendorName = vendor.companyName.trim();
      } else {
        // Use name and format as company if needed
        cleanVendorName = vendorName.trim();
        
        // If name doesn't look like a company, add company suffix for India GST
        const companySuffixes = ['Pvt Ltd', 'Ltd', 'Inc', 'LLC', 'Corp', 'Enterprises', 'Traders'];
        const hasCompanySuffix = companySuffixes.some(suffix => 
          cleanVendorName.toLowerCase().includes(suffix.toLowerCase())
        );
        
        if (!hasCompanySuffix) {
          // Extract first part of name (before any existing suffix)
          const nameParts = cleanVendorName.split(' ');
          const baseName = nameParts[0] || 'Vendor';
          cleanVendorName = `${baseName} Enterprises Pvt Ltd`;
        }
      }
      
      // Limit to 100 characters (Zoho's limit for contact_name/display_name)
      cleanVendorName = cleanVendorName.substring(0, 100).trim();
      
      if (!cleanVendorName || cleanVendorName.length < 2) {
        throw new Error('Vendor name/company name is required and must be at least 2 characters');
      }

      // Use /contacts endpoint with contact_type: "vendor" (as per working Postman example)
      // According to Zoho: Both Customer and Vendors are created as "Contacts"
      // Use contact_type (as per working example: contact_type: "customer" works)
      // Start with ABSOLUTE MINIMUM to avoid validation errors
      // Then update with additional fields after creation
      const contactData = {
        contact_name: cleanVendorName,
        contact_type: 'vendor'  // Use contact_type (matches working customer example)
      };

      console.log('📤 Creating vendor:', JSON.stringify(contactData, null, 2));
      // /contacts endpoint accepts data directly (not wrapped in { contact: ... })
      const response = await this.makeRequest('POST', 'contacts', contactData);
      
      // If creation successful, update with additional fields
      if (response.contact?.contact_id) {
        const vendorId = response.contact.contact_id;
        console.log(`✅ Vendor created in Zoho: ${vendorId}`);
        
        // Update vendor with additional fields (non-blocking)
        (async () => {
          try {
            const updateData = {};
            
            // Add company name if different from contact_name
            if (vendor.companyName && vendor.companyName.trim() !== cleanVendorName) {
              updateData.company_name = vendor.companyName.substring(0, 100);
            }
            
            // Add email
            if (vendor.email) {
              updateData.email = vendor.email;
            }
            
            // Add phone
            if (vendor.phone) {
              updateData.phone = vendor.phone;
            }
            
            // Add PAN
            if (vendor.panCard) {
              updateData.pan_no = vendor.panCard.substring(0, 10);
            }
            
            // Add billing address
            if (vendor.address) {
              updateData.billing_address = {
                address: vendor.address.substring(0, 500)
              };
              if (vendor.city || vendor.warehouse?.location?.city) {
                updateData.billing_address.city = (vendor.city || vendor.warehouse?.location?.city || '').substring(0, 100);
              }
              if (vendor.state || vendor.warehouse?.location?.state) {
                updateData.billing_address.state = (vendor.state || vendor.warehouse?.location?.state || '').substring(0, 100);
              }
              if (vendor.pincode || vendor.warehouse?.location?.pincode) {
                updateData.billing_address.zip = (vendor.pincode || vendor.warehouse?.location?.pincode || '').substring(0, 20);
              }
              if (vendor.country || vendor.warehouse?.location?.country) {
                updateData.billing_address.country = vendor.country || vendor.warehouse?.location?.country || 'India';
              }
            }
            
            if (Object.keys(updateData).length > 0) {
              await this.makeRequest('PUT', `contacts/${vendorId}`, { contact: updateData });
              console.log(`✅ Vendor updated with additional fields`);
            }
          } catch (updateError) {
            console.warn(`⚠️  Failed to update vendor with additional fields:`, updateError.message);
            // Don't fail - vendor was created successfully
          }
        })();
        
        return vendorId;
      }
      
      throw new Error('Failed to create vendor in Zoho Books');

    } catch (error) {
      console.error(`❌ Failed to create/get vendor in Zoho Books:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Public: Sync contact email/phone and primary contact person in Zoho before sending quote/SO/invoice email.
   * Call this before emailEstimate if Zoho returns "email not found" for the customer.
   */
  async syncContactForEmail(contactId, customer) {
    return this._syncContactEmailToZoho(contactId, customer);
  }

  /**
   * Sync Zoho contact with the email/name from the order (place-order payload) so Zoho's
   * email estimate/SO/invoice API can send to that address. Call before emailEstimate, emailSalesOrder, emailInvoice.
   */
  async syncContactWithOrderEmail(contactId, order, customer) {
    if (!contactId || !customer) return;
    const forZoho = {
      email: (order?.orderEmail && String(order.orderEmail).trim()) || customer.email || '',
      phone: customer.phone || '',
      name: (order?.orderReceiverName && String(order.orderReceiverName).trim()) || customer.name || 'Customer'
    };
    if (!forZoho.email && !forZoho.phone) return;
    return this._syncContactEmailToZoho(contactId, forZoho);
  }

  /**
   * Sync our User's email/phone to Zoho contact and ensure primary contact person exists
   * so Zoho shows "Primary contact information" and can send quote/SO/invoice emails.
   */
  async _syncContactEmailToZoho(contactId, customer) {
    if (!contactId || !customer) return;
    try {
      const updateData = {};
      if (customer.email && String(customer.email).trim()) {
        updateData.email = String(customer.email).trim().substring(0, 100);
      }
      if (customer.phone && String(customer.phone).trim()) {
        updateData.phone = String(customer.phone).trim().substring(0, 50);
      }
      if (Object.keys(updateData).length > 0) {
        await this.makeRequest('PUT', `contacts/${contactId}`, { contact: updateData });
        console.log(`✅ Zoho contact ${contactId} synced with email/phone from customer`);
      }
      await this._ensurePrimaryContactPerson(contactId, customer);
    } catch (err) {
      console.warn(`⚠️  Failed to sync email/phone to Zoho contact:`, err.message);
    }
  }

  /**
   * Build contact person JSON for POST /contacts/contactpersons (Zoho Books API v3).
   * Doc: https://www.zoho.com/books/api/v3/contact-persons/#create-a-contact-person
   * Sends: contact_id, salutation, first_name (required), last_name, email, phone, mobile, enable_portal.
   * Omits: communication_preference — doc marks is_sms_enabled/is_whatsapp_enabled as "SMS integration only" /
   * "WhatsApp integration only"; sending them when org has no such integration returns "Invalid Element is_whatsapp_enabled".
   * @param {string} contactId - Zoho contact_id
   * @param {Object} customer - User/customer with name, email, phone
   * @returns {Object} Request body for create contact person
   */
  _buildContactPersonBody(contactId, customer) {
    const customerName = (customer.name || 'Customer').trim();
    const nameParts = customerName.split(/\s+/);
    const firstName = (nameParts[0] || customerName).substring(0, 100);
    const lastName = (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '').substring(0, 100);
    const phoneVal = customer.phone && String(customer.phone).trim() ? String(customer.phone).trim().substring(0, 50) : '';
    const emailVal = customer.email && String(customer.email).trim() ? String(customer.email).trim().substring(0, 100) : '';
    const body = {
      contact_id: contactId,
      salutation: 'Mr',
      first_name: firstName,
      last_name: lastName,
      email: emailVal || undefined,
      phone: phoneVal || undefined,
      mobile: phoneVal || undefined,
      enable_portal: false
    };
    return body;
  }

  /**
   * Create primary contact person for a Zoho contact (used right after creating a new contact).
   * Same as Zoho UI "Add New" under Primary contact information; sends full contact person details.
   */
  async _createPrimaryContactPersonForContact(contactId, customer) {
    if (!contactId || !customer) return;
    const hasEmailOrPhone = (customer.email && String(customer.email).trim()) || (customer.phone && String(customer.phone).trim());
    if (!hasEmailOrPhone) return;
    const body = this._buildContactPersonBody(contactId, customer);
    const createRes = await this.makeRequest('POST', 'contacts/contactpersons', body);
    const personId = createRes.contact_person?.[0]?.contact_person_id || createRes.contact_person?.contact_person_id;
    if (personId) {
      await this.makeRequest('POST', `contacts/contactpersons/${personId}/primary`, null);
      console.log(`✅ Zoho contact ${contactId}: primary contact person created for emails`);
    }
  }

  /**
   * Ensure contact has a primary contact person (email/phone) so Zoho can send quote/SO/invoice emails.
   * If none exists, create one with full details and mark as primary.
   */
  async _ensurePrimaryContactPerson(contactId, customer) {
    if (!contactId || !customer) return;
    const hasEmailOrPhone = (customer.email && String(customer.email).trim()) || (customer.phone && String(customer.phone).trim());
    if (!hasEmailOrPhone) return;
    try {
      const listRes = await this.makeRequest('GET', `contacts/${contactId}/contactpersons`, null);
      const persons = listRes.contact_persons || [];
      const hasPrimaryWithEmail = persons.some(p => (p.is_primary_contact && p.email));
      if (hasPrimaryWithEmail) return;

      const body = this._buildContactPersonBody(contactId, customer);
      const createRes = await this.makeRequest('POST', 'contacts/contactpersons', body);
      const personId = createRes.contact_person?.[0]?.contact_person_id || createRes.contact_person?.contact_person_id;
      if (personId) {
        await this.makeRequest('POST', `contacts/contactpersons/${personId}/primary`, null);
        console.log(`✅ Zoho contact ${contactId}: primary contact person added for emails`);
      }
    } catch (err) {
      console.warn(`⚠️  Failed to ensure primary contact person for ${contactId}:`, err.message);
    }
  }

  /**
   * Create or get Customer in Zoho Books
   * @param {Object} customer - User object with customer role (must have name, email/phone from onboard)
   * @returns {Promise<string>} Zoho Customer ID
   */
  async createOrGetCustomer(customer) {
    try {
      // If customer already has Zoho ID, sync email/phone from our User model then return
      if (customer.zohoCustomerId) {
        await this._syncContactEmailToZoho(customer.zohoCustomerId, customer);
        return customer.zohoCustomerId;
      }

      // Check if customer exists by email (use /contacts endpoint)
      try {
        const existingContacts = await this.makeRequest('GET', 'contacts', null);
        if (existingContacts.contacts && Array.isArray(existingContacts.contacts)) {
          const existing = existingContacts.contacts.find(c => 
            c.email && customer.email && c.email.toLowerCase() === customer.email.toLowerCase() &&
            (c.contact_type === 'customer' || c.customer_type === 'customer')
          );
          if (existing && existing.contact_id) {
            console.log(`✅ Found existing customer in Zoho: ${existing.contact_id}`);
            if (!customer.zohoCustomerId) {
              customer.zohoCustomerId = existing.contact_id;
              await customer.save();
            }
            await this._syncContactEmailToZoho(existing.contact_id, customer);
            return existing.contact_id;
          }
        }
      } catch (error) {
        console.error('⚠️  Error checking existing customers:', error.message);
        // Continue to create new customer
      }

      // Step 1: Create contact (no contact_persons in body – Zoho API often does not set primary from inline contact_persons)
      // Per Zoho Books doc: Create a Contact + then Create a contact person + Mark as primary = same as UI "Add New" primary contact
      let customerName = (customer.name || 'Customer').trim();
      if (!customerName || customerName.length < 2) {
        throw new Error('Customer name is required and must be at least 2 characters');
      }
      customerName = customerName.substring(0, 100);

      const contactData = {
        contact_name: customerName,
        contact_type: 'customer',
        customer_sub_type: 'business'
      };
      if (customer.email && String(customer.email).trim()) {
        contactData.email = String(customer.email).trim().substring(0, 100);
      }
      if (customer.phone && String(customer.phone).trim()) {
        contactData.phone = String(customer.phone).trim().substring(0, 50);
      }
      if (customer.companyName && customer.companyName.trim()) {
        contactData.company_name = customer.companyName.trim().substring(0, 200);
      }

      // Billing and shipping address (from User address + pincode)
      const addressLine = (customer.address && String(customer.address).trim()) ? String(customer.address).trim().substring(0, 500) : '';
      const zip = (customer.pincode && String(customer.pincode).trim()) ? String(customer.pincode).trim().substring(0, 50) : '';
      if (addressLine || zip) {
        const addr = {
          address: addressLine || undefined,
          zip: zip || undefined,
          country: 'India'
        };
        if (addr.address || addr.zip) {
          contactData.billing_address = addr;
          contactData.shipping_address = addr;
        }
      }

      console.log('📤 Creating customer in Zoho (using /contacts):', JSON.stringify(contactData, null, 2));
      const response = await this.makeRequest('POST', 'contacts', contactData);

      if (!response.contact?.contact_id) {
        throw new Error('Failed to create customer in Zoho Books');
      }

      const customerId = response.contact.contact_id;
      console.log(`✅ Customer created in Zoho Books: ${customerId} for ${customer.name}`);

      // Step 2: Create primary contact person (same as Zoho UI "Add New" in Primary contact information)
      // Doc: POST /contacts/contactpersons – contact_id, first_name (required), last_name, email, phone, mobile, salutation, designation, department, communication_preference, enable_portal
      const hasEmailOrPhone = (customer.email && String(customer.email).trim()) || (customer.phone && String(customer.phone).trim());
      if (hasEmailOrPhone) {
        await this._createPrimaryContactPersonForContact(customerId, customer).catch((err) => {
          console.warn(`⚠️  Primary contact person not added for ${customerId}:`, err.message);
        });
      }

      return customerId;
    } catch (error) {
      console.error(`❌ Failed to create/get customer in Zoho Books:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get Purchase Order PDF
   * @param {string} purchaseOrderId - Zoho Purchase Order ID
   * @returns {Promise<Buffer>} PDF buffer
   */
  async getPurchaseOrderPDF(purchaseOrderId) {
    try {
      const token = await this.getAccessToken();
      const url = `${this.baseURL}/purchaseorders/${purchaseOrderId}`;
      
      const response = await axios.get(url, {
        params: {
          organization_id: this.organizationId,
          accept: 'pdf'
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error(`❌ Failed to get Purchase Order PDF:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get Sales Order PDF
   * @param {string} salesOrderId - Zoho Sales Order ID
   * @returns {Promise<Buffer>} PDF buffer
   */
  async getSalesOrderPDF(salesOrderId) {
    try {
      const token = await this.getAccessToken();
      const url = `${this.baseURL}/salesorders/${salesOrderId}`;
      
      const response = await axios.get(url, {
        params: {
          organization_id: this.organizationId,
          accept: 'pdf'
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error(`❌ Failed to get Sales Order PDF:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get Invoice PDF
   * @param {string} invoiceId - Zoho Invoice ID
   * @returns {Promise<Buffer>} PDF buffer
   */
  async getInvoicePDF(invoiceId) {
    try {
      const token = await this.getAccessToken();
      const url = `${this.baseURL}/invoices/${invoiceId}`;
      
      const response = await axios.get(url, {
        params: {
          organization_id: this.organizationId,
          accept: 'pdf'
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error(`❌ Failed to get Invoice PDF:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get public PDF URL for Invoice
   */
  async getInvoicePDFUrl(invoiceId) {
    try {
      const response = await this.makeRequest('GET', `invoices/${invoiceId}`);
      if (response.invoice?.pdf_url) {
        return response.invoice.pdf_url;
      }
      const baseDomain = this.baseURL.includes('zohoapis.in') ? 'books.zoho.in' : 'books.zoho.com';
      return `https://${baseDomain}/app#/books/invoice/${invoiceId}/pdf`;
    } catch (error) {
      console.error(`❌ Failed to get Invoice PDF URL:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Create Quote in Zoho Books
   * Called when: Admin creates quotation for customer order
   * Step 2: Order review → Create quotation → Send SMS/email with payment link
   */
  async createQuote(order, customer) {
    try {
      // Get or create customer in Zoho; always call so email/phone from our User model are synced (for quote email)
      let zohoCustomerId = null;
      if (customer) {
        try {
          zohoCustomerId = await this.createOrGetCustomer(customer);
          if (zohoCustomerId && !customer.zohoCustomerId) {
            customer.zohoCustomerId = zohoCustomerId;
            await customer.save();
          }
        } catch (error) {
          console.error(`⚠️  Customer creation failed:`, error.message);
          throw new Error(`Cannot create Quote: Customer must be created in Zoho first. Error: ${error.message}`);
        }
      }
      if (!zohoCustomerId) {
        throw new Error('Customer ID is required for Quote creation. Please create customer in Zoho first.');
      }

      // Build line items with real names and Zoho item_id when available (maintain inventory link)
      const lineItems = [];
      for (const orderItem of order.items) {
        const inventoryItem = orderItem.itemCode;
        let itemId = inventoryItem?.zohoItemId || null;
        if (!itemId && inventoryItem) {
          itemId = await this.createOrGetItem(inventoryItem);
        }
        const realName = (inventoryItem?.itemDescription || inventoryItem?.name || 'Item').trim();
        const nameForZoho = realName.length ? realName.substring(0, 255) : 'Item';
        if (itemId) {
          lineItems.push({ item_id: itemId, rate: orderItem.unitPrice, quantity: orderItem.qty, loadingCharges: orderItem.loadingCharges });
        } else {
          lineItems.push({ name: nameForZoho, rate: orderItem.unitPrice, quantity: orderItem.qty, loadingCharges: orderItem.loadingCharges });
        }
      }

      // Billing/shipping: ONLY from order (place order API). Never use Zoho contact/signup address.
      const deliveryAddr = this._getBillingAddressForZoho(order);
      if (!deliveryAddr) {
        console.warn(`⚠️  Quote will use Zoho contact address: order has no valid delivery address (order.deliveryAddress missing or "Address to be updated"). Ensure place order API was called with deliveryAddress.`);
      }

      const totalLoadingCharges = order.items.reduce(
        (sum, item) => sum + (item.loadingCharges || 0),
        0
      );

      // Build Quote payload (Zoho Estimates API)
      // reference_number = our order ID (leadId) for sync between our system and Zoho
      // is_inclusive_tax: true so Zoho does not add CGST/SGST on top – total matches our order total
      const quoteData = {
        customer_id: zohoCustomerId,
        date: new Date().toISOString().split('T')[0],
        reference_number: order.leadId || '',
        line_items: lineItems,
        is_inclusive_tax: true
      };
 
      // Add shipping charge if present
      if (order.deliveryCharges && order.deliveryCharges > 0) {
        quoteData.shipping_charge = String(totalLoadingCharges.toFixed(2));
      }
      
      // Add billing and shipping addresses (full address from order)
      if (deliveryAddr) {
        const safeAddr = this._truncateAddressForZoho(deliveryAddr);
        quoteData.billing_address = safeAddr;
        quoteData.shipping_address = safeAddr;
      }

      // IMPORTANT: Estimates API expects data WITHOUT { estimate: {...} } wrapper
      console.log('📤 Creating Quote in Zoho:', JSON.stringify(quoteData, null, 2));
      const response = await this.makeRequest('POST', 'estimates', quoteData);
      
      // Update with custom fields after creation
      if (response.estimate?.estimate_id) {
        try {
          const updateData = {};
          if (order.leadId) updateData.cf_lead_id = order.leadId;
          if (order.deliveryAddress) updateData.cf_delivery_address = order.deliveryAddress;
          if (order.deliveryPincode) updateData.cf_delivery_pincode = order.deliveryPincode;
          if (order.deliveryExpectedDate) updateData.cf_delivery_expected_date = new Date(order.deliveryExpectedDate).toISOString().split('T')[0];
          if (order.totalQty) updateData.cf_total_quantity = order.totalQty;
          if (order.deliveryCharges) updateData.cf_delivery_charges = totalLoadingCharges;
          
          if (Object.keys(updateData).length > 0) {
            // Estimates API expects data WITHOUT { estimate: {...} } wrapper
            await this.makeRequest('PUT', `estimates/${response.estimate.estimate_id}`, updateData);
            console.log(`✅ Quote updated with custom fields`);
          }
        } catch (updateError) {
          console.warn(`⚠️  Failed to update Quote with custom fields:`, updateError.message);
          // Don't fail - quote was created successfully
        }

        // Zoho often uses contact address for the PDF when create payload is ignored. Set document-level
        // billing and shipping address so the quote PDF shows the order delivery address.
        if (deliveryAddr) {
          const safeAddr = this._truncateAddressForZoho(deliveryAddr);
          try {
            await this.makeRequest('PUT', `estimates/${response.estimate.estimate_id}/address/billing`, safeAddr);
            await this.makeRequest('PUT', `estimates/${response.estimate.estimate_id}/address/shipping`, safeAddr);
            console.log(`✅ Quote billing/shipping address set on document (order delivery address)`);
          } catch (addrError) {
            console.warn(`⚠️  Failed to set quote billing/shipping address on document:`, addrError.message);
          }
        }
      }
      
      console.log(`✅ Quote created in Zoho Books: ${response.estimate?.estimate_id}`);
      return response.estimate;
    } catch (error) {
      console.error('❌ Failed to create Quote in Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Create Payment Receipt in Zoho Books
   * Called when: Payment is completed
   * Step 3: Payment completed → Generate payment receipt
   */
  async createPaymentReceipt(invoiceId, paymentData) {
    try {
      // paymentData should contain: amount, payment_mode, date, reference_number, etc.
      const receiptData = {
        customer_id: paymentData.customerId,
        invoice_id: invoiceId,
        payment_mode: paymentData.paymentMode || 'cash', // cash, bank_transfer, online, etc.
        amount: paymentData.amount,
        date: paymentData.date || new Date().toISOString().split('T')[0],
        reference_number: paymentData.referenceNumber || paymentData.utr || '',
        description: paymentData.description || 'Payment received'
      };

      console.log('📤 Creating Payment Receipt in Zoho:', JSON.stringify({ payment: receiptData }, null, 2));
      const response = await this.makeRequest('POST', 'customerpayments', { payment: receiptData });
      
      console.log(`✅ Payment Receipt created in Zoho Books: ${response.payment?.payment_id}`);
      return response.payment;
    } catch (error) {
      console.error('❌ Failed to create Payment Receipt in Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get Quote PDF
   */
  async getQuotePDF(quoteId) {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.baseURL}/estimates/${quoteId}`, {
        params: {
          organization_id: this.organizationId,
          accept: 'pdf'
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error(`❌ Failed to get Quote PDF:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get public PDF URL for Quote
   * Zoho Books provides public PDF URLs in the estimate response
   */
  async getQuotePDFUrl(estimateId) {
    try {
      const response = await this.makeRequest('GET', `estimates/${estimateId}`);
      // Zoho Books response may include pdf_url or we construct it
      if (response.estimate?.pdf_url) {
        return response.estimate.pdf_url;
      }
      // Fallback: construct public URL (format may vary by region)
      const baseDomain = this.baseURL.includes('zohoapis.in') ? 'books.zoho.in' : 'books.zoho.com';
      return `https://${baseDomain}/app#/books/estimate/${estimateId}/pdf`;
    } catch (error) {
      console.error(`❌ Failed to get Quote PDF URL:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Get Payment Receipt PDF
   */
  async getPaymentReceiptPDF(paymentId) {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.baseURL}/customerpayments/${paymentId}`, {
        params: {
          organization_id: this.organizationId,
          accept: 'pdf'
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error(`❌ Failed to get Payment Receipt PDF:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get Sales Order PDF
   */
  async getSalesOrderPDF(salesOrderId) {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.baseURL}/salesorders/${salesOrderId}`, {
        params: {
          organization_id: this.organizationId,
          accept: 'pdf'
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error(`❌ Failed to get Sales Order PDF:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get public PDF URL for Sales Order
   */
  async getSalesOrderPDFUrl(salesOrderId) {
    try {
      const response = await this.makeRequest('GET', `salesorders/${salesOrderId}`);
      if (response.salesorder?.pdf_url) {
        return response.salesorder.pdf_url;
      }
      const baseDomain = this.baseURL.includes('zohoapis.in') ? 'books.zoho.in' : 'books.zoho.com';
      return `https://${baseDomain}/app#/books/salesorder/${salesOrderId}/pdf`;
    } catch (error) {
      console.error(`❌ Failed to get Sales Order PDF URL:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Create E-Way Bill in Zoho Books
   * Called when: Order is dispatched
   * Step 5: Dispatch → Generate invoice and eway bill
   */
  /**
   * Create E-Way Bill in Zoho Books
   * Called when: Order is dispatched (in_transit or out_for_delivery status)
   * Step 5: Dispatch → Generate invoice and eway bill
   * 
   * Note: E-Way Bill API endpoint is not documented in official Zoho Books API docs.
   * Based on documentation patterns and error analysis, trying multiple endpoint formats.
   * If all fail, E-Way Bills may need to be created manually in Zoho Books dashboard.
   */
  async createEWayBill(invoiceId, ewayBillData) {
    try {
      if (!invoiceId) {
        throw new Error('Invoice ID is required for E-Way Bill creation. Invoice must be created in Zoho first.');
      }

      // ewayBillData should contain: distance, transportMode, vehicleNumber, vehicleType
      // Based on error "Invalid value passed for entity_id", try using entity_id instead of invoice_id
      // E-Way Bill payload structure - trying different field names based on error messages
      const ewayData = {
        entity_id: invoiceId, // Try entity_id (based on error message)
        entity_type: 'invoice', // Specify entity type
        distance: ewayBillData.distance || 0,
        transport_mode: ewayBillData.transportMode || 'Road', // Road, Rail, Air, Ship
        vehicle_number: ewayBillData.vehicleNumber || '',
        vehicle_type: ewayBillData.vehicleType || 'Regular'
      };

      console.log('📤 Creating E-Way Bill in Zoho:', JSON.stringify({ ewaybill: ewayData }, null, 2));
      
      // Based on error "Invalid value passed for entity_id" from /ewaybills endpoint,
      // the endpoint exists but needs entity_id field instead of invoice_id
      try {
        // Try with entity_id field
        const response = await this.makeRequest('POST', 'ewaybills', { ewaybill: ewayData });
        if (response.ewaybill?.ewaybill_id) {
          console.log(`✅ E-Way Bill created in Zoho Books: ${response.ewaybill.ewaybill_id}`);
          return response.ewaybill;
        }
      } catch (error) {
        // If entity_id doesn't work, E-Way Bills may need manual creation
        console.error('❌ E-Way Bill creation failed.');
        console.error('   Error:', error.response?.data || error.message);
        console.error('💡 E-Way Bills may need to be created manually in Zoho Books dashboard.');
        console.error('   Invoice ID:', invoiceId);
        throw new Error(`E-Way Bill creation via API failed: ${error.response?.data?.message || error.message}. Please create E-Way Bills manually in Zoho Books dashboard for invoice: ${invoiceId}`);
      }
    } catch (error) {
      console.error('❌ Failed to create E-Way Bill in Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }
}

// Export singleton instance
const zohoBooksService = new ZohoBooksService();
export default zohoBooksService;

