#!/usr/bin/env node
/**
 * =============================================================================
 * TEST: Full Zoho flow — Quote → Sales Order → Invoice
 * =============================================================================
 *
 * WHAT THIS DOES:
 *   1. Connects to DB (from .env MONGO_URI).
 *   2. Finds order by leadId (e.g. CT-120). If NOT FOUND → creates a new test
 *      order (using existing customer, vendor, inventory from DB).
 *   3. Runs the flow clearly:
 *      STEP 1: Quote   — create in Zoho (if missing), email, save zohoQuoteId.
 *      STEP 2: Sales Order — create in Zoho (if missing), email, save zohoSalesOrderId.
 *      STEP 3: Invoice  — create in Zoho (if missing), email, save zohoInvoiceId.
 *
 * WHEN TO USE:
 *   - To verify the full flow: Quote correct → Sales Order → Invoice all generated.
 *   - When no order exists: script creates one and then runs the flow.
 *
 * REQUIREMENTS:
 *   - .env: MONGO_URI, Zoho Books vars, SMTP for fallback email.
 *   - At least one customer, one vendor, one inventory item in DB (for creating test order).
 *
 * USAGE:
 *   npm run test:zoho-flow              # uses default leadId or creates new order
 *   npm run test:zoho-flow -- CT-125     # use order CT-125 (or create if not found)
 *   node scripts/test-zoho-flow.js CT-125
 *
 * =============================================================================
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Order from '../models/Order.js';
import User from '../models/User.js';
import OrderPayment from '../models/OrderPayment.js';
import '../models/Inventory.js';
import zohoBooksService from '../utils/zohoBooks.js';
import { sendQuoteReadyEmail } from '../utils/emailService.js';

dotenv.config();

const leadIdArg = process.argv[2] || process.env.TEST_LEAD_ID;

function logStep(stepNum, title, status, detail = '') {
  const pre = `\n  [STEP ${stepNum}] ${title}`;
  const icon = status === 'ok' ? '✅' : status === 'skip' ? 'ℹ️' : '❌';
  console.log(`${pre} ${icon} ${detail}`);
}

async function ensureOrder(leadId) {
  if (leadId) {
    const existing = await Order.findOne({ leadId, isActive: true })
      .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId')
      .populate('custUserId', 'name email zohoCustomerId')
      .populate('vendorId', 'name email zohoVendorId')
      .lean();
    if (existing) return { order: existing, created: false };
  }

  const customer = await User.findOne({ role: 'customer', isActive: true });
  const vendor = await User.findOne({ role: 'vendor', isActive: true });
  const inventoryItem = await mongoose.model('Inventory').findOne({ isActive: true });

  if (!customer || !inventoryItem) {
    throw new Error(
      'Cannot create test order: need at least one customer and one inventory item in DB. ' +
      'Customer: ' + (customer ? 'yes' : 'no') + ', Inventory: ' + (inventoryItem ? 'yes' : 'no')
    );
  }

  const unitPrice = inventoryItem.pricing?.unitPrice ?? 100;
  const qty = 2;
  const orderItems = [
    {
      itemCode: inventoryItem._id,
      qty,
      unitPrice,
      totalCost: unitPrice * qty
    }
  ];

  const newLeadId = await Order.generateLeadId(orderItems);
  const orderDoc = new Order({
    leadId: newLeadId,
    custUserId: customer._id,
    vendorId: vendor?._id || null,
    items: orderItems,
    totalQty: qty,
    totalAmount: unitPrice * qty,
    orderStatus: 'order_confirmed',
    deliveryAddress: 'Test Address, Test City',
    deliveryPincode: '500001',
    deliveryExpectedDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });
  await orderDoc.save();

  let order = await Order.findById(orderDoc._id)
    .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId')
    .populate('custUserId', 'name email zohoCustomerId')
    .populate('vendorId', 'name email zohoVendorId')
    .lean();

  return { order, created: true, newLeadId };
}

async function runQuote(orderDoc, customer) {
  if (orderDoc.zohoQuoteId) {
    logStep(1, 'Quote', 'skip', `Already exists: ${orderDoc.zohoQuoteId}`);
    return { estimate_id: orderDoc.zohoQuoteId, emailed: null };
  }

  logStep(1, 'Quote', 'ok', 'Creating in Zoho...');
  const zohoQuote = await zohoBooksService.createQuote(orderDoc, customer);
  if (!zohoQuote?.estimate_id) throw new Error('Zoho did not return estimate_id');

  await Order.updateOne({ _id: orderDoc._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
  orderDoc.zohoQuoteId = zohoQuote.estimate_id;

  if (customer?.zohoCustomerId) {
    await zohoBooksService.syncContactForEmail(customer.zohoCustomerId, customer).catch(() => {});
  }

  let emailed = await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => false);
  if (!emailed && customer?.email) {
    await sendQuoteReadyEmail(
      customer.email,
      customer.name || 'Customer',
      orderDoc.leadId,
      orderDoc.formattedLeadId || orderDoc.leadId
    ).catch(() => {});
    emailed = 'fallback';
  }
  logStep(1, 'Quote', 'ok', `Created: ${zohoQuote.estimate_id} | Email: ${emailed ? (emailed === 'fallback' ? 'SMTP fallback' : 'Zoho') : 'skipped'}`);
  return { estimate_id: zohoQuote.estimate_id, emailed };
}

async function runSalesOrder(orderDoc, vendor, customer) {
  if (orderDoc.zohoSalesOrderId) {
    logStep(2, 'Sales Order', 'skip', `Already exists: ${orderDoc.zohoSalesOrderId}`);
    return { salesorder_id: orderDoc.zohoSalesOrderId, emailed: null };
  }

  logStep(2, 'Sales Order', 'ok', 'Creating in Zoho...');
  const zohoSO = await zohoBooksService.createSalesOrder(orderDoc, vendor || null, customer);
  if (!zohoSO?.salesorder_id) throw new Error('Zoho did not return salesorder_id');

  await Order.updateOne({ _id: orderDoc._id }, { $set: { zohoSalesOrderId: zohoSO.salesorder_id } });
  orderDoc.zohoSalesOrderId = zohoSO.salesorder_id;

  const emailed = await zohoBooksService.emailSalesOrder(zohoSO.salesorder_id).catch(() => false);
  logStep(2, 'Sales Order', 'ok', `Created: ${zohoSO.salesorder_id} | Email: ${emailed ? 'Zoho' : 'skipped'}`);
  return { salesorder_id: zohoSO.salesorder_id, emailed };
}

async function runInvoice(orderDoc, vendor, customer) {
  if (orderDoc.zohoInvoiceId) {
    logStep(3, 'Invoice', 'skip', `Already exists: ${orderDoc.zohoInvoiceId}`);
    return { invoice_id: orderDoc.zohoInvoiceId, emailed: null };
  }

  let payment = await OrderPayment.findOne({ invcNum: orderDoc.invcNum, isActive: true });
  if (!payment) {
    payment = await OrderPayment.create({
      invcNum: orderDoc.invcNum,
      orderAmount: orderDoc.totalAmount,
      paidAmount: orderDoc.totalAmount,
      paymentType: 'bank_transfer',
      paymentMode: 'offline',
      paymentStatus: 'successful',
      transactionId: `TEST-${Date.now()}`
    });
    logStep(3, 'Invoice', 'ok', 'Test payment record created.');
  }

  logStep(3, 'Invoice', 'ok', 'Creating in Zoho...');
  const zohoInvoice = await zohoBooksService.createInvoice(orderDoc, payment, vendor || null, customer);
  if (!zohoInvoice?.invoice_id) throw new Error('Zoho did not return invoice_id');

  await Order.updateOne({ _id: orderDoc._id }, { $set: { zohoInvoiceId: zohoInvoice.invoice_id } });
  orderDoc.zohoInvoiceId = zohoInvoice.invoice_id;

  const emailed = await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch(() => false);
  logStep(3, 'Invoice', 'ok', `Created: ${zohoInvoice.invoice_id} | Email: ${emailed ? 'Zoho' : 'skipped'}`);
  return { invoice_id: zohoInvoice.invoice_id, emailed };
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  FULL ZOHO FLOW TEST — Quote → Sales Order → Invoice');
  console.log('═'.repeat(60));

  try {
    await connectDB();
  } catch (err) {
    console.error('❌ DB connection failed:', err.message);
    process.exit(1);
  }

  try {
    const leadId = leadIdArg || null;
    if (leadId) {
      console.log('\n📋 Looking for order:', leadId);
    } else {
      console.log('\n📋 No leadId provided — will create new test order if none exists.');
    }

    const { order, created, newLeadId } = await ensureOrder(leadId);
    const effectiveLeadId = order.leadId || newLeadId;
    console.log(created ? `✅ New test order created: ${effectiveLeadId}` : `✅ Order found: ${effectiveLeadId}`);
    console.log('   Status:', order.orderStatus, '| Quote:', order.zohoQuoteId || '–', '| SO:', order.zohoSalesOrderId || '–', '| Invoice:', order.zohoInvoiceId || '–');

    const customer = await User.findById(order.custUserId?._id || order.custUserId);
    if (!customer) throw new Error('Customer not found for order');
    const vendor = order.vendorId ? await User.findById(order.vendorId._id || order.vendorId) : null;

    const orderDoc = await Order.findById(order._id)
      .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId')
      .populate('custUserId', 'name email zohoCustomerId')
      .populate('vendorId', 'name email zohoVendorId');

    console.log('\n' + '─'.repeat(60));
    console.log('  RUNNING FLOW: Quote → Sales Order → Invoice');
    console.log('─'.repeat(60));

    await runQuote(orderDoc, customer);
    await runSalesOrder(orderDoc, vendor, customer);
    await runInvoice(orderDoc, vendor, customer);

    const updated = await Order.findById(order._id).select('leadId zohoQuoteId zohoSalesOrderId zohoInvoiceId').lean();
    console.log('\n' + '═'.repeat(60));
    console.log('  RESULT');
    console.log('═'.repeat(60));
    console.log('  Order:', updated.leadId);
    console.log('  Quote ID:   ', updated.zohoQuoteId || '–');
    console.log('  Sales Order:', updated.zohoSalesOrderId || '–');
    console.log('  Invoice:    ', updated.zohoInvoiceId || '–');
    console.log('═'.repeat(60) + '\n');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.response?.data) console.error('   Zoho:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

main();
