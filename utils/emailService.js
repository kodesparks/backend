import nodemailer from 'nodemailer';

/**
 * Email service for transactional emails (verification, OTP) sent by THIS backend.
 *
 * --- Zoho Books vs custom emails ---
 * Zoho Books can only send DOCUMENT emails (quote, sales order, invoice) when we call its API (e.g. POST estimates/{id}/email).
 * Zoho Books has NO API to send arbitrary/custom emails (e.g. "Verify your email", "Your OTP is 123456").
 * So: "We only need to trigger the email" is TRUE for quote/SO/invoice (we already do that). FALSE for verification/OTP.
 *
 * --- Options for verification/OTP (custom content) ---
 * 1. SMTP in .env (current): Gmail (smtp.gmail.com, port 587, SMTP_SECURE=false, App Password), Zoho Mail, or relay – host, port, user, pass; MAIL_FROM=no-reply@infraxpert.in.
 * 2. Zoho Mail API: No SMTP in app; OAuth + POST to Zoho Mail API. Needs Zoho Mail OAuth.
 * 3. Other: SendGrid, Mailgun, SES – set their SMTP in .env; MAIL_FROM=no-reply@infraxpert.in.
 *
 * Env: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, FRONTEND_URL
 */

function getTransporter() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) {
    return null;
  }
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    authMethod: 'LOGIN',
    tls: { rejectUnauthorized: true },
  });
}

/**
 * Send verification email to user (link with token).
 * @param {string} to - Recipient email
 * @param {string} name - Recipient name (for greeting)
 * @param {string} verifyUrl - Full URL user must open to verify (e.g. https://yourapp.com/verify-email?token=xxx)
 * @returns {Promise<boolean>} - true if sent, false if SMTP not configured or send failed
 */
export async function sendVerificationEmail(to, name, verifyUrl) {
  const trans = getTransporter();
  if (!trans) {
    console.warn('⚠️  Email verification skipped: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env). Use Zoho Mail SMTP or any SMTP provider.');
    return false;
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = 'Verify your email address';
  const html = `
    <p>Hi ${name || 'there'},</p>
    <p>Please verify your email by clicking the link below:</p>
    <p><a href="${verifyUrl}" style="color:#2563eb;">Verify my email</a></p>
    <p>Or copy this link: ${verifyUrl}</p>
    <p>This link expires in 24 hours.</p>
    <p>If you did not sign up, you can ignore this email.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ Verification email sent to ${to}`);
    return true;
  } catch (err) {
    const hint = /535|EAUTH|Authentication/i.test(err.message)
      ? ' Fix: In Zoho Mail go to Security → App Passwords, create one, then set SMTP_PASS in .env to that App Password (not your login password). Host must match region: smtp.zoho.in (India), smtp.zoho.eu (EU), smtp.zoho.com (US).'
      : '';
    console.warn('⚠️  Verification email failed:', err.message + (hint ? ' |' + hint : ''), '- Signup and Zoho customer linking are unaffected.');
    return false;
  }
}

/**
 * Send OTP code by email (e.g. for phone/account verification).
 * Uses same SMTP as verification emails (Zoho Mail, etc.).
 * @param {string} to - Recipient email
 * @param {string} name - Recipient name (for greeting)
 * @param {string} code - 6-digit OTP code
 * @returns {Promise<boolean>} - true if sent, false if SMTP not configured or send failed
 */
export async function sendOTPEmail(to, name, code) {
  const trans = getTransporter();
  if (!trans) {
    console.warn('⚠️  OTP email skipped: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env).');
    return false;
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = 'Your verification code';
  const html = `
    <p>Hi ${name || 'there'},</p>
    <p>Your verification code is: <strong>${code}</strong></p>
    <p>This code expires in 5 minutes. Do not share it with anyone.</p>
    <p>If you did not request this code, you can ignore this email.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ OTP email sent to ${to}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send OTP email:', err.message);
    return false;
  }
}

/**
 * Send "Order placed" confirmation email from our side (SMTP).
 * Use when customer places order – in addition to Zoho quote email if any.
 * @param {string} to - Customer email
 * @param {string} name - Customer name
 * @param {Object} orderDetails - { leadId, formattedLeadId, deliveryAddress, itemCount }
 * @returns {Promise<boolean>} - true if sent, false otherwise
 */
export async function sendOrderPlacedEmail(to, name, orderDetails) {
  const trans = getTransporter();
  if (!trans) {
    console.warn('⚠️  Order-placed email skipped: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env).');
    return false;
  }
  if (!to || !String(to).trim()) {
    console.warn('⚠️  Order-placed email skipped: no customer email');
    return false;
  }
  const { leadId, formattedLeadId, deliveryAddress, itemCount } = orderDetails || {};
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `Order placed – ${formattedLeadId || leadId || 'Order'}`;
  const html = `
    <p>Hi ${name || 'Customer'},</p>
    <p>Your order has been placed successfully.</p>
    <p><strong>Order ID:</strong> ${formattedLeadId || leadId || '–'}</p>
    ${itemCount ? `<p><strong>Items:</strong> ${itemCount}</p>` : ''}
    ${deliveryAddress ? `<p><strong>Delivery address:</strong> ${deliveryAddress}</p>` : ''}
    <p>You will receive a quote from the infraxpert shortly. You can also download the quote from your order page.</p>
    <p>Thank you for your order.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ Order-placed email sent to ${to} for order ${leadId || '–'}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send order-placed email:', err.message);
    return false;
  }
}

/**
 * Send "Order accepted" email from our SMTP when order is accepted (vendor_accepted).
 * No quote generated yet – quote is generated when order is confirmed.
 * @param {string} to - Customer email
 * @param {string} name - Customer name
 * @param {Object} orderDetails - { leadId, formattedLeadId }
 * @returns {Promise<boolean>}
 */
export async function sendOrderAcceptedEmail(to, name, orderDetails) {
  const trans = getTransporter();
  if (!trans || !to || !String(to).trim()) return false;
  const { leadId, formattedLeadId } = orderDetails || {};
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `Order accepted – ${formattedLeadId || leadId || 'Order'}`;
  const html = `
    <p>Hi ${name || 'Customer'},</p>
    <p>Your order <strong>${formattedLeadId || leadId || '–'}</strong> has been accepted.</p>
    <p>You will receive the quotation once the order is confirmed. You can then proceed to payment.</p>
    <p>Thank you.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ Order-accepted email sent to ${to} for order ${leadId || '–'}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send order-accepted email:', err.message);
    return false;
  }
}

/**
 * Send "Quote ready" email from our SMTP (always send for every quote generated).
 * Includes public PDF URL when available.
 * @param {string} to - Customer email
 * @param {string} name - Customer name
 * @param {string} leadId - Order/lead ID (e.g. CT-084)
 * @param {string} formattedLeadId - Formatted order ID for display
 * @param {string} pdfUrl - Optional public PDF URL from Zoho
 * @returns {Promise<boolean>}
 */
export async function sendQuoteReadyEmail(to, name, leadId, formattedLeadId, pdfUrl = null) {
  const trans = getTransporter();
  if (!trans || !to || !String(to).trim()) {
    return false;
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const frontendUrl = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  const orderUrl = frontendUrl ? `${frontendUrl}/orders` : 'your account';
  const subject = `Quote ready – ${formattedLeadId || leadId || 'Order'}`;
  const html = `
    <p>Hi ${name || 'Customer'},</p>
    <p>Your quote for order <strong>${formattedLeadId || leadId || '–'}</strong> is ready.</p>
    ${pdfUrl ? `<p><a href="${pdfUrl}" style="color:#2563eb; font-weight:bold;">View Quote PDF</a></p>` : ''}
    <p>Please log in to your account to view and download the quote.</p>
    ${orderUrl !== 'your account' ? `<p><a href="${orderUrl}" style="color:#2563eb;">View my orders</a></p>` : ''}
    <p>Thank you.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ Quote-ready email (our SMTP) sent to ${to} for order ${leadId || '–'}${pdfUrl ? ' (PDF URL included)' : ''}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send quote-ready email:', err.message);
    return false;
  }
}

/**
 * Send "Sales Order ready" email from our SMTP (always send for every sales order generated).
 * Includes public PDF URL when available.
 */
export async function sendSalesOrderReadyEmail(to, name, leadId, formattedLeadId, pdfUrl = null) {
  const trans = getTransporter();
  if (!trans || !to || !String(to).trim()) return false;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const frontendUrl = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  const orderUrl = frontendUrl ? `${frontendUrl}/orders` : 'your account';
  const subject = `Sales Order – ${formattedLeadId || leadId || 'Order'}`;
  const html = `
    <p>Hi ${name || 'Customer'},</p>
    <p>Your sales order for <strong>${formattedLeadId || leadId || '–'}</strong> is ready.</p>
    ${pdfUrl ? `<p><a href="${pdfUrl}" style="color:#2563eb; font-weight:bold;">View Sales Order PDF</a></p>` : ''}
    <p>You can also log in to your account to view and download.</p>
    ${orderUrl !== 'your account' ? `<p><a href="${orderUrl}" style="color:#2563eb;">View my orders</a></p>` : ''}
    <p>Thank you.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ Sales-order-ready email (our SMTP) sent to ${to} for order ${leadId || '–'}${pdfUrl ? ' (PDF URL included)' : ''}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send sales-order-ready email:', err.message);
    return false;
  }
}

/**
 * Send "Invoice ready" email from our SMTP (always send for every invoice generated).
 * Includes public PDF URL when available.
 */
export async function sendInvoiceReadyEmail(to, name, leadId, formattedLeadId, pdfUrl = null) {
  const trans = getTransporter();
  if (!trans || !to || !String(to).trim()) return false;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const frontendUrl = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  const orderUrl = frontendUrl ? `${frontendUrl}/orders` : 'your account';
  const subject = `Invoice – ${formattedLeadId || leadId || 'Order'}`;
  const html = `
    <p>Hi ${name || 'Customer'},</p>
    <p>Your invoice for order <strong>${formattedLeadId || leadId || '–'}</strong> is ready.</p>
    ${pdfUrl ? `<p><a href="${pdfUrl}" style="color:#2563eb; font-weight:bold;">View Invoice PDF</a></p>` : ''}
    <p>You can also log in to your account to view and download.</p>
    ${orderUrl !== 'your account' ? `<p><a href="${orderUrl}" style="color:#2563eb;">View my orders</a></p>` : ''}
    <p>Thank you.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log(`✅ Invoice-ready email (our SMTP) sent to ${to} for order ${leadId || '–'}${pdfUrl ? ' (PDF URL included)' : ''}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send invoice-ready email:', err.message);
    return false;
  }
}

/**
 * Send "Payment Receipt" email from our SMTP
 * Includes receipt PDF URL when available
 */
export async function sendPaymentReceiptEmail(
  to,
  name,
  leadId,
  formattedLeadId,
  receiptUrl = null
) {
  console.log('sending mail...')
  const trans = getTransporter();
  if (!trans || !to || !String(to).trim()) return false;

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const frontendUrl = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  const orderUrl = frontendUrl ? `${frontendUrl}/orders` : 'your account';

  const subject = `Payment Receipt – ${formattedLeadId || leadId || 'Order'}`;

  const html = 
    `<p>Hi ${name || 'Customer'},</p>
    <p>We have successfully received your payment for order <strong>${formattedLeadId || leadId || '–'}</strong></p>
    ${receiptUrl ? `<p><a href="${receiptUrl}" style="color:#2563eb; font-weight:bold;">View Payment Receipt</a></p>` : ''}
    <p>You can also log in to your account to view details.</p>
    ${orderUrl !== 'your account' ? `<p><a href="${orderUrl}" style="color:#2563eb;">View my orders</a></p>` : ''}
    <p>Thank you.</p>
  `;
  try {
    await trans.sendMail({ from, to, subject, html });
    console.log('mail sent')
    console.log(
      `✅ Payment receipt email sent to ${to} for order ${
        leadId || '–'
      }${receiptUrl ? ' (Receipt URL included)' : ''}`
    );

    return true;
  } catch (err) {
    console.error('❌ Failed to send payment receipt email:', err.message);
    return false;
  }
}

