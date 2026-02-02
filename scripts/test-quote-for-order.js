#!/usr/bin/env node
/**
 * =============================================================================
 * TEST: Create Zoho Quote for an order (by leadId)
 * =============================================================================
 *
 * WHAT THIS DOES:
 *   1. Connects to DB (from .env MONGO_URI)
 *   2. Finds order by leadId (e.g. CT-120)
 *   3. If no zohoQuoteId: creates Quote in Zoho, saves ID, emails quote
 *   4. If zohoQuoteId exists: skips creation, prints info
 *
 * WHEN TO USE:
 *   - After an order is order_confirmed and you want to manually trigger quote
 *   - To verify quote creation works (Zoho + email)
 *
 * REQUIREMENTS:
 *   - .env: MONGO_URI, Zoho Books vars, SMTP for fallback email
 *   - Order must exist and have items with itemCode populated
 *
 * USAGE:
 *   npm run test:quote              # uses default leadId CT-120
 *   npm run test:quote -- CT-125     # quote for order CT-125
 *   node scripts/test-quote-for-order.js CT-125
 *
 * =============================================================================
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Order from '../models/Order.js';
import User from '../models/User.js';
import '../models/Inventory.js'; // register for order.items.itemCode populate
import zohoBooksService from '../utils/zohoBooks.js';
import { sendQuoteReadyEmail } from '../utils/emailService.js';

dotenv.config();

const leadId = process.argv[2] || process.env.TEST_LEAD_ID || 'CT-120';

const WORKFLOW_SUMMARY = `
Order workflow (Zoho docs):
  place order     → our SMTP: "order placed" email only
  vendor_accepted → our SMTP: "order accepted" email only
  order_confirmed → Zoho Quote created + emailed (this script can trigger same)
  payment_done    → Zoho Sales Order created + emailed
`;

async function main() {
  console.log('\n📋 Test: Create Zoho Quote for order', leadId);
  console.log('─'.repeat(50));

  try {
    await connectDB();
  } catch (err) {
    console.error('❌ DB connection failed:', err.message);
    process.exit(1);
  }

  try {
    const order = await Order.findOne({ leadId, isActive: true })
      .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId')
      .lean();

    if (!order) {
      console.error('❌ Order not found:', leadId);
      process.exit(1);
    }

    console.log('✅ Order found:', order.leadId, '| status:', order.orderStatus, '| zohoQuoteId:', order.zohoQuoteId || 'none');

    if (order.zohoQuoteId) {
      console.log('ℹ️  Quote already exists in Zoho:', order.zohoQuoteId);
      await mongoose.connection.close();
      process.exit(0);
    }

    const customer = await User.findById(order.custUserId);
    if (!customer) {
      console.error('❌ Customer not found for order');
      process.exit(1);
    }
    console.log('✅ Customer:', customer.email, '| name:', customer.name);

    // Need full Mongoose document for createQuote (order.items with itemCode refs)
    const orderDoc = await Order.findById(order._id)
      .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');

    console.log('\n📤 Creating Quote in Zoho...');
    const zohoQuote = await zohoBooksService.createQuote(orderDoc, customer);

    if (!zohoQuote?.estimate_id) {
      console.error('❌ Zoho did not return estimate_id');
      process.exit(1);
    }

    console.log('✅ Zoho Quote created:', zohoQuote.estimate_id);

    await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
    console.log('✅ Order updated with zohoQuoteId');

    if (customer.zohoCustomerId) {
      await zohoBooksService.syncContactForEmail(customer.zohoCustomerId, customer).catch(() => {});
    }

    console.log('\n📤 Emailing quote via Zoho...');
    const emailSent = await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch((err) => {
      console.warn('⚠️ Zoho quote email failed:', err?.message || err);
      return false;
    });

    if (!emailSent && customer.email) {
      console.log('📤 Sending fallback email from our SMTP...');
      await sendQuoteReadyEmail(customer.email, customer.name || 'Customer', order.leadId, order.formattedLeadId || order.leadId).catch(() => {});
    }

    console.log('\n✅ Done. Quote ID:', zohoQuote.estimate_id, '| Email:', emailSent ? 'sent via Zoho' : 'fallback SMTP or skipped');
    console.log(WORKFLOW_SUMMARY);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.response?.data) {
      console.error('   Zoho response:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

main();
