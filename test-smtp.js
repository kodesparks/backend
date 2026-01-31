/**
 * Run: node test-smtp.js
 * Tests SMTP connection using .env (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS).
 * Use this to verify Zoho (or any SMTP) credentials and see the exact error if auth fails.
 */
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const host = (process.env.SMTP_HOST || '').trim();
const user = (process.env.SMTP_USER || '').trim();
const pass = (process.env.SMTP_PASS || '').trim();
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const secure = process.env.SMTP_SECURE === 'true';

console.log('SMTP config:', {
  host,
  port,
  secure,
  user,
  passSet: !!pass,
  passLength: pass ? pass.length : 0,
});
console.log('\nIf 535: (1) App Password must be for', user, '- create at accounts.zoho.in → Security → App Passwords.');
console.log('        (2) In Zoho Mail enable SMTP: Settings → Mail Accounts → [your account] → enable SMTP/external client access.\n');

if (!host || !user || !pass) {
  console.error('Missing SMTP_HOST, SMTP_USER, or SMTP_PASS in .env');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
  authMethod: 'LOGIN',
  tls: { rejectUnauthorized: true },
});

async function run() {
  try {
    console.log('\n1. Verifying SMTP connection (auth)...');
    await transporter.verify();
    console.log('   ✅ SMTP verify OK – auth succeeded.\n');

    console.log('2. Sending test email to', user, '...');
    const info = await transporter.sendMail({
      from: user,
      to: user,
      subject: 'SMTP test from backend',
      text: 'If you see this, SMTP is working.',
    });
    console.log('   ✅ Sent:', info.messageId, '\n');
  } catch (err) {
    console.error('\n   ❌ Error:', err.message);
    if (err.response) console.error('   response:', err.response);
    if (err.responseCode) console.error('   responseCode:', err.responseCode);
    if (err.command) console.error('   command:', err.command);
    process.exit(1);
  }
}

run();
