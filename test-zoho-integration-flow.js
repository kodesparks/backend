import dotenv from 'dotenv';
import connectDB from './config/db.js';
import Order from './models/Order.js';
import User from './models/User.js';
import Inventory from './models/Inventory.js';
import OrderPayment from './models/OrderPayment.js';
import OrderDelivery from './models/OrderDelivery.js';
import zohoBooksService from './utils/zohoBooks.js';
import mongoose from 'mongoose';

dotenv.config();

/**
 * Complete Zoho Books Integration Flow Test
 * Tests each service per Zoho Books API v3 (https://www.zoho.com/books/api/v3/introduction/#organization-id)
 * Flow: Customer onboarding → Inventory sync → Quote → Sales Order → Invoice → PDFs
 * 1. Customer onboarding: createOrGetCustomer → zohoCustomerId saved
 * 2. Inventory: createOrGetItem / createItemInZoho → zohoItemId saved
 * 3. Quote (Estimate) → Email via Zoho
 * 4. Sales Order → Email via Zoho
 * 5. Invoice at delivery (in_transit/out_for_delivery)
 * 6. PDF downloads for Quote, SO, Invoice
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function separator(title = '') {
  const line = '━'.repeat(60);
  if (title) {
    log(`\n${line}`, 'cyan');
    log(`  ${title}`, 'bright');
    log(`${line}\n`, 'cyan');
  } else {
    log(`${line}\n`, 'cyan');
  }
}

async function testZohoFlow() {
  let testOrder = null;
  let customer = null;
  let vendor = null;
  let inventoryItem = null;

  try {
    separator('🧪 COMPLETE ZOHO BOOKS INTEGRATION FLOW TEST');

    // Step 0: Connect to database
    log('🔌 Connecting to database...', 'blue');
    await connectDB();
    log('✅ Database connected\n', 'green');

    // Step 1: Test Zoho Connection
    separator('📋 Test 1: Zoho Books Connection');
    try {
      const token = await zohoBooksService.getAccessToken();
      log('✅ Zoho Books connection successful', 'green');
      log(`   Access Token: ${token.substring(0, 20)}...\n`, 'cyan');
    } catch (error) {
      log('❌ Zoho Books connection failed:', 'red');
      log(`   ${error.message}`, 'red');
      log('\n💡 Check your .env file for:', 'yellow');
      log('   - ZOHO_ORGANIZATION_ID', 'yellow');
      log('   - ZOHO_CLIENT_ID', 'yellow');
      log('   - ZOHO_CLIENT_SECRET', 'yellow');
      log('   - ZOHO_REFRESH_TOKEN\n', 'yellow');
      await mongoose.connection.close();
      return;
    }

    // Step 2: Prepare Test Data
    separator('📋 Test 2: Preparing Test Data');
    
    customer = await User.findOne({ role: 'customer', isActive: true });
    vendor = await User.findOne({ role: 'vendor', isActive: true });
    inventoryItem = await Inventory.findOne({ isActive: true });

    if (!customer || !vendor || !inventoryItem) {
      log('❌ Missing required test data:', 'red');
      log(`   Customer: ${customer ? '✅' : '❌'}`, customer ? 'green' : 'red');
      log(`   Vendor: ${vendor ? '✅' : '❌'}`, vendor ? 'green' : 'red');
      log(`   Inventory Item: ${inventoryItem ? '✅' : '❌'}`, inventoryItem ? 'green' : 'red');
      log('\n💡 Please create test data first.\n', 'yellow');
      await mongoose.connection.close();
      return;
    }

    log(`✅ Customer: ${customer.name} (${customer.email})`, 'green');
    log(`✅ Vendor: ${vendor.name} (${vendor.email})`, 'green');
    log(`✅ Inventory Item: ${inventoryItem.itemDescription || inventoryItem._id}\n`, 'green');

    // Step 2a: Customer onboarding – ensure zohoCustomerId (Zoho Contact) for Quote/SO/Invoice
    separator('📋 Test 2a: Customer onboarding (Zoho Contact / zohoCustomerId)');
    try {
      const beforeCustId = customer.zohoCustomerId;
      const zohoCustomerId = await zohoBooksService.createOrGetCustomer(customer);
      await customer.save?.();
      const refreshedCustomer = await User.findById(customer._id).select('name email zohoCustomerId').lean();
      if (zohoCustomerId || refreshedCustomer?.zohoCustomerId) {
        log(`✅ Customer linked to Zoho: ${refreshedCustomer?.zohoCustomerId || zohoCustomerId}`, 'green');
        log(`   ${refreshedCustomer?.name} (${refreshedCustomer?.email})\n`, 'cyan');
        if (refreshedCustomer) customer.zohoCustomerId = refreshedCustomer.zohoCustomerId || zohoCustomerId;
      } else {
        log(`⚠️  No zohoCustomerId yet\n`, 'yellow');
      }
    } catch (err) {
      log(`⚠️  Customer onboarding step: ${err.message}\n`, 'yellow');
    }

    // Step 2b: Ensure Inventory–Zoho link (zohoItemId) for real line items in Quote/SO/Invoice
    separator('📋 Test 2b: Inventory–Zoho link (zohoItemId)');
    try {
      const beforeId = inventoryItem.zohoItemId;
      const zohoItemId = await zohoBooksService.createOrGetItem(inventoryItem);
      const refreshed = await Inventory.findById(inventoryItem._id).select('itemCode itemDescription zohoItemId').lean();
      if (zohoItemId || refreshed?.zohoItemId) {
        log(`✅ Inventory linked to Zoho: ${refreshed?.zohoItemId || zohoItemId}`, 'green');
        log(`   Item: ${refreshed?.itemDescription || inventoryItem.itemDescription} (SKU: ${refreshed?.itemCode || inventoryItem.itemCode})\n`, 'cyan');
        if (refreshed) inventoryItem.zohoItemId = refreshed.zohoItemId || zohoItemId;
      } else {
        log(`⚠️  No zohoItemId yet (line items will use real name in Zoho)\n`, 'yellow');
      }
    } catch (err) {
      log(`⚠️  Inventory–Zoho link step: ${err.message}\n`, 'yellow');
    }

    // Step 3: Create Test Order
    separator('📋 Test 3: Create Test Order (Step 1: Customer Places Order)');
    
    testOrder = await Order.findOne({
      orderStatus: { $in: ['order_placed', 'vendor_accepted', 'payment_done', 'order_confirmed'] },
      isActive: true
    })
    .populate('items.itemCode', 'itemDescription category subCategory zohoItemId')
    .populate('vendorId', 'name email zohoVendorId')
    .populate('custUserId', 'name email zohoCustomerId');

    if (testOrder) {
      log(`✅ Using existing order: ${testOrder.leadId}`, 'green');
      log(`   Status: ${testOrder.orderStatus}`, 'cyan');
      log(`   Total Amount: ₹${testOrder.totalAmount}\n`, 'cyan');
    } else {
      log('⚠️  No existing order found. Creating new test order...\n', 'yellow');
      
      const orderItems = [{
        itemCode: inventoryItem._id,
        qty: 2,
        unitPrice: inventoryItem.pricing?.unitPrice || 100,
        totalCost: (inventoryItem.pricing?.unitPrice || 100) * 2
      }];

      const leadId = await Order.generateLeadId(orderItems);
      
      testOrder = new Order({
        leadId,
        custUserId: customer._id,
        vendorId: vendor._id,
        items: orderItems,
        totalQty: 2,
        totalAmount: orderItems[0].totalCost,
        orderStatus: 'order_placed',
        deliveryAddress: '123 Test Street, Test City',
        deliveryPincode: '500001',
        deliveryExpectedDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });

      await testOrder.save();
      log(`✅ Test order created: ${testOrder.leadId}`, 'green');
      log(`   Status: ${testOrder.orderStatus}\n`, 'cyan');

      testOrder = await Order.findById(testOrder._id)
        .populate('items.itemCode', 'itemDescription category subCategory zohoItemId')
        .populate('vendorId', 'name email zohoVendorId')
        .populate('custUserId', 'name email zohoCustomerId');
    }

    // Step 4: Test Quote Creation
    separator('📋 Test 4: Quote Creation (Step 2: Admin Creates Quotation)');
    
    if (testOrder.zohoQuoteId) {
      log(`✅ Quote already exists: ${testOrder.zohoQuoteId}`, 'green');
      log(`   Check Zoho Dashboard: Estimates → ${testOrder.zohoQuoteId}\n`, 'cyan');
    } else {
      log('⚠️  Quote not found. Creating Quote in Zoho...\n', 'yellow');
      
      try {
        const zohoQuote = await zohoBooksService.createQuote(testOrder, customer);
        
        if (zohoQuote?.estimate_id) {
          testOrder.zohoQuoteId = zohoQuote.estimate_id;
          await testOrder.save();
          log(`✅ Quote created successfully!`, 'green');
          log(`   Quote ID: ${zohoQuote.estimate_id}`, 'cyan');
          log(`   Quote Number: ${zohoQuote.estimate_number || 'N/A'}`, 'cyan');
          log(`   Check Zoho Dashboard: Estimates → ${zohoQuote.estimate_number || zohoQuote.estimate_id}\n`, 'cyan');
        } else {
          log('❌ Quote creation returned no ID\n', 'red');
        }
      } catch (error) {
        log('❌ Failed to create Quote:', 'red');
        log(`   ${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message}`, 'red');
        log('\n💡 Common issues:', 'yellow');
        log('   - Customer must exist in Zoho', 'yellow');
        log('   - Check API credentials\n', 'yellow');
      }
    }

    // Step 5: Test Sales Order Creation
    separator('📋 Test 5: Sales Order Creation (Step 4: Admin Generates SO)');
    
    testOrder = await Order.findById(testOrder._id)
      .populate('items.itemCode', 'itemDescription category subCategory zohoItemId')
      .populate('vendorId', 'name email zohoVendorId')
      .populate('custUserId', 'name email zohoCustomerId');

    if (testOrder.zohoSalesOrderId) {
      log(`✅ Sales Order already exists: ${testOrder.zohoSalesOrderId}`, 'green');
      log(`   Check Zoho Dashboard: Sales Orders → ${testOrder.zohoSalesOrderId}\n`, 'cyan');
    } else {
      log('⚠️  Sales Order not found. Creating Sales Order in Zoho...\n', 'yellow');
      
      if (testOrder.orderStatus === 'order_placed') {
        await testOrder.updateStatus('vendor_accepted');
        log(`✅ Order status updated to: vendor_accepted`, 'green');
      }

      try {
        const zohoSO = await zohoBooksService.createSalesOrder(testOrder, vendor, customer);
        
        if (zohoSO?.salesorder_id) {
          testOrder.zohoSalesOrderId = zohoSO.salesorder_id;
          await testOrder.save();
          log(`✅ Sales Order created successfully!`, 'green');
          log(`   SO ID: ${zohoSO.salesorder_id}`, 'cyan');
          log(`   SO Number: ${zohoSO.salesorder_number || 'N/A'}`, 'cyan');
          log(`   Check Zoho Dashboard: Sales Orders → ${zohoSO.salesorder_number || zohoSO.salesorder_id}\n`, 'cyan');
        } else {
          log('❌ Sales Order creation returned no ID\n', 'red');
        }
      } catch (error) {
        log('❌ Failed to create Sales Order:', 'red');
        log(`   ${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message}`, 'red');
        log('\n💡 Common issues:', 'yellow');
        log('   - Customer must exist in Zoho', 'yellow');
        log('   - Vendor must exist in Zoho\n', 'yellow');
      }
    }

    // Step 6: Test Invoice Creation (in app: created when delivery → in_transit/out_for_delivery)
    separator('📋 Test 6: Invoice Creation (at delivery status)');
    
    testOrder = await Order.findById(testOrder._id)
      .populate('items.itemCode', 'itemDescription category subCategory zohoItemId')
      .populate('vendorId', 'name email zohoVendorId')
      .populate('custUserId', 'name email zohoCustomerId');

    if (testOrder.zohoInvoiceId) {
      log(`✅ Invoice already exists: ${testOrder.zohoInvoiceId}`, 'green');
      log(`   Check Zoho Dashboard: Invoices → ${testOrder.zohoInvoiceId}\n`, 'cyan');
    } else {
      log('⚠️  Invoice not found. Creating Invoice in Zoho...\n', 'yellow');
      
      let payment = await OrderPayment.findOne({
        invcNum: testOrder.invcNum,
        isActive: true
      });

      if (!payment) {
        payment = new OrderPayment({
          invcNum: testOrder.invcNum,
          leadId: testOrder.leadId,
          orderAmount: testOrder.totalAmount,
          paidAmount: testOrder.totalAmount,
          paymentType: 'bank_transfer',
          paymentMode: 'offline',
          paymentStatus: 'successful',
          transactionId: `TEST-${Date.now()}`,
          paymentDate: new Date()
        });
        await payment.save();
        log(`✅ Test payment record created`, 'green');
      }

      if (testOrder.orderStatus !== 'payment_done' && testOrder.orderStatus !== 'order_confirmed') {
        await testOrder.updateStatus('payment_done');
        log(`✅ Order status updated to: payment_done`, 'green');
      }

      try {
        const zohoInvoice = await zohoBooksService.createInvoice(testOrder, payment, vendor, customer);
        
        if (zohoInvoice?.invoice_id) {
          testOrder.zohoInvoiceId = zohoInvoice.invoice_id;
          await testOrder.save();
          log(`✅ Invoice created successfully!`, 'green');
          log(`   Invoice ID: ${zohoInvoice.invoice_id}`, 'cyan');
          log(`   Invoice Number: ${zohoInvoice.invoice_number || 'N/A'}`, 'cyan');
          log(`   Check Zoho Dashboard: Invoices → ${zohoInvoice.invoice_number || zohoInvoice.invoice_id}\n`, 'cyan');
        } else {
          log('❌ Invoice creation returned no ID\n', 'red');
        }
      } catch (error) {
        log('❌ Failed to create Invoice:', 'red');
        log(`   ${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message}`, 'red');
        log('\n💡 Common issues:', 'yellow');
        log('   - Customer must exist in Zoho', 'yellow');
        log('   - Payment record required\n', 'yellow');
      }
    }

    // Step 7: Test E-Way Bill Creation (after Invoice, at dispatch)
    separator('📋 Test 7: E-Way Bill Creation');
    
    testOrder = await Order.findById(testOrder._id);

    if (!testOrder.zohoInvoiceId) {
      log('⚠️  Invoice is required for E-Way Bill creation. Skipping...\n', 'yellow');
    } else if (testOrder.zohoEWayBillId) {
      log(`✅ E-Way Bill already exists: ${testOrder.zohoEWayBillId}`, 'green');
      log(`   Check Zoho Dashboard: Invoices → ${testOrder.zohoInvoiceId} → E-Way Bill\n`, 'cyan');
    } else {
      log('⚠️  E-Way Bill not found. Creating E-Way Bill in Zoho...\n', 'yellow');
      
      let delivery = await OrderDelivery.findOne({
        leadId: testOrder.leadId,
        isActive: true
      });

      if (!delivery) {
        delivery = new OrderDelivery({
          leadId: testOrder.leadId,
          invcNum: testOrder.invcNum,
          userId: testOrder.custUserId,
          address: testOrder.deliveryAddress || '123 Test Street, Test City',
          pincode: testOrder.deliveryPincode || '500001',
          deliveryExpectedDate: testOrder.deliveryExpectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          deliveryStatus: 'in_transit',
          distance: 50,
          truckNumber: 'TS-01-AB-1234',
          vehicleType: 'Regular'
        });
        await delivery.save();
        log(`✅ Test delivery record created`, 'green');
      }

      const ewayBillData = {
        distance: delivery.distance || 50,
        transportMode: 'Road',
        vehicleNumber: delivery.truckNumber || 'TS-01-AB-1234',
        vehicleType: delivery.vehicleType || 'Regular'
      };

      try {
        const zohoEWayBill = await zohoBooksService.createEWayBill(testOrder.zohoInvoiceId, ewayBillData);
        
        if (zohoEWayBill?.ewaybill_id) {
          testOrder.zohoEWayBillId = zohoEWayBill.ewaybill_id;
          await testOrder.save();
          log(`✅ E-Way Bill created successfully!`, 'green');
          log(`   E-Way Bill ID: ${zohoEWayBill.ewaybill_id}`, 'cyan');
          log(`   E-Way Bill Number: ${zohoEWayBill.ewaybill_number || 'N/A'}`, 'cyan');
          log(`   Check Zoho Dashboard: Invoices → ${testOrder.zohoInvoiceId} → E-Way Bill\n`, 'cyan');
        } else {
          log('❌ E-Way Bill creation returned no ID\n', 'red');
        }
      } catch (error) {
        log('❌ Failed to create E-Way Bill:', 'red');
        log(`   ${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message}`, 'red');
        log('\n💡 Note: E-Way Bills may need to be created manually in Zoho Books dashboard.', 'yellow');
        log(`   Invoice ID: ${testOrder.zohoInvoiceId}\n`, 'yellow');
      }
    }

    // Step 8: Test PDF Downloads
    separator('📋 Test 8: PDF Download Tests');
    
    testOrder = await Order.findById(testOrder._id);

    const pdfTests = [
      {
        name: 'Quote PDF',
        id: testOrder.zohoQuoteId,
        method: 'getQuotePDF',
        endpoint: `/admin/orders/${testOrder.leadId}/pdf/quote`
      },
      {
        name: 'Sales Order PDF',
        id: testOrder.zohoSalesOrderId,
        method: 'getSalesOrderPDF',
        endpoint: `/admin/orders/${testOrder.leadId}/pdf/so`
      },
      {
        name: 'Invoice PDF',
        id: testOrder.zohoInvoiceId,
        method: 'getInvoicePDF',
        endpoint: `/admin/orders/${testOrder.leadId}/pdf/invoice`
      }
    ];

    for (const pdfTest of pdfTests) {
      if (pdfTest.id) {
        try {
          log(`📄 Testing ${pdfTest.name} (ID: ${pdfTest.id})...`, 'blue');
          const pdfBuffer = await zohoBooksService[pdfTest.method](pdfTest.id);
          log(`✅ ${pdfTest.name} downloaded: ${pdfBuffer.length} bytes`, 'green');
          log(`   API Endpoint: GET /api${pdfTest.endpoint}\n`, 'cyan');
        } catch (error) {
          log(`❌ Failed to download ${pdfTest.name}:`, 'red');
          log(`   ${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message}`, 'red');
          log(`   Make sure the document exists in Zoho dashboard\n`, 'yellow');
        }
      } else {
        log(`⚠️  No ${pdfTest.name} ID - skipping PDF test\n`, 'yellow');
      }
    }

    // Final Summary
    separator('📊 TEST SUMMARY');
    
    const finalOrder = await Order.findById(testOrder._id);
    
    log(`Order ID: ${finalOrder.leadId}`, 'bright');
    log(`Status: ${finalOrder.orderStatus}`, 'cyan');
    log(`Total Amount: ₹${finalOrder.totalAmount}`, 'cyan');
    
    log(`\nZoho Document IDs:`, 'bright');
    log(`  Quote: ${finalOrder.zohoQuoteId || '❌ Not created'}`, finalOrder.zohoQuoteId ? 'green' : 'red');
    log(`  Sales Order: ${finalOrder.zohoSalesOrderId || '❌ Not created'}`, finalOrder.zohoSalesOrderId ? 'green' : 'red');
    log(`  Invoice: ${finalOrder.zohoInvoiceId || '❌ Not created'}`, finalOrder.zohoInvoiceId ? 'green' : 'red');
    log(`  E-Way Bill: ${finalOrder.zohoEWayBillId || '❌ Not created'}`, finalOrder.zohoEWayBillId ? 'green' : 'red');

    log(`\n📝 Next Steps:`, 'bright');
    log(`  1. Check Zoho Books Dashboard:`, 'yellow');
    if (finalOrder.zohoQuoteId) {
      log(`     → Estimates → Find Quote with ID: ${finalOrder.zohoQuoteId}`, 'cyan');
    }
    if (finalOrder.zohoSalesOrderId) {
      log(`     → Sales Orders → Find SO with ID: ${finalOrder.zohoSalesOrderId}`, 'cyan');
    }
    if (finalOrder.zohoInvoiceId) {
      log(`     → Invoices → Find Invoice with ID: ${finalOrder.zohoInvoiceId}`, 'cyan');
      if (finalOrder.zohoEWayBillId) {
        log(`     → Invoices → ${finalOrder.zohoInvoiceId} → E-Way Bill: ${finalOrder.zohoEWayBillId}`, 'cyan');
      }
    }
    
    log(`\n  2. Test API Endpoints:`, 'yellow');
    if (finalOrder.zohoQuoteId) {
      log(`     → GET /api/admin/orders/${finalOrder.leadId}/pdf/quote`, 'cyan');
    }
    if (finalOrder.zohoSalesOrderId) {
      log(`     → GET /api/admin/orders/${finalOrder.leadId}/pdf/so`, 'cyan');
    }
    if (finalOrder.zohoInvoiceId) {
      log(`     → GET /api/admin/orders/${finalOrder.leadId}/pdf/invoice`, 'cyan');
    }

    log(`\n  3. Integration Flow Status:`, 'yellow');
    log(`     Step 1: Customer places order → ✅`, 'green');
    log(`     Step 2: Quote (Zoho) + reference_number → ${finalOrder.zohoQuoteId ? '✅' : '❌'}`, finalOrder.zohoQuoteId ? 'green' : 'red');
    log(`     Step 3: Payment done (app, no Zoho Invoice yet) → ✅`, 'green');
    log(`     Step 4: Sales Order (Zoho) + reference_number → ${finalOrder.zohoSalesOrderId ? '✅' : '❌'}`, finalOrder.zohoSalesOrderId ? 'green' : 'red');
    log(`     Step 5: Invoice (Zoho, at delivery) + reference_number → ${finalOrder.zohoInvoiceId ? '✅' : '❌'}`, finalOrder.zohoInvoiceId ? 'green' : 'red');
    log(`     Step 5b: E-Way Bill (Zoho) → ${finalOrder.zohoEWayBillId ? '✅' : '❌ (create manually if needed)'}`, finalOrder.zohoEWayBillId ? 'green' : 'yellow');

    log('\n✅ Test completed!\n', 'green');

  } catch (error) {
    log('\n❌ Test failed with error:', 'red');
    log(error.message, 'red');
    if (error.stack) {
      log('\nStack trace:', 'yellow');
      log(error.stack, 'yellow');
    }
  } finally {
    await mongoose.connection.close();
    log('🔌 Database connection closed', 'blue');
  }
}

// Run the test
testZohoFlow();
  