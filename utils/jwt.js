import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

// Validate that secrets are provided
if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error('ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be set in environment variables');
}

// Generate access token (short lived - 15 minutes)
export const generateAccessToken = (user) => {
  return jwt.sign(
    { 
      userId: user._id,
      email: user.email,
      role: user.role,
      name: user.name
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '1h' }
  );
};

// Generate refresh token (long lived - 7 days)
export const generateRefreshToken = (userId) => {
  return jwt.sign(
    { userId: userId._id || userId }, // Only pass the user ID string
    REFRESH_TOKEN_SECRET,
    { expiresIn: '7d' }
  );
};

// Verify access token
export const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, ACCESS_TOKEN_SECRET);
  } catch (error) {
    return null;
  }
};

// Verify refresh token
export const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, REFRESH_TOKEN_SECRET);
  } catch (error) {
    // Log error for debugging (remove in production if needed)
    if (error.name === 'TokenExpiredError') {
      console.log('Refresh token expired:', error.expiredAt);
    } else if (error.name === 'JsonWebTokenError') {
      console.log('Invalid refresh token format:', error.message);
    } else {
      console.log('Refresh token verification error:', error.message);
    }
    return null;
  }
};

// Generate both tokens
export const generateTokens = (user) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  return { accessToken, refreshToken };
};

/** Token for public quote PDF link (email). No login required; valid 30 days. */
export const generateQuotePdfToken = (leadId) => {
  if (!ACCESS_TOKEN_SECRET) return null;
  return jwt.sign(
    { leadId: String(leadId), purpose: 'quote-pdf' },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '30d' }
  );
};

export const verifyQuotePdfToken = (token) => {
  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET);
    return payload?.purpose === 'quote-pdf' && payload?.leadId ? payload : null;
  } catch {
    return null;
  }
};

/** Token for public Sales Order PDF link (email). Valid 30 days. */
export const generateSalesOrderPdfToken = (leadId) => {
  if (!ACCESS_TOKEN_SECRET) return null;
  return jwt.sign(
    { leadId: String(leadId), purpose: 'sales-order-pdf' },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '30d' }
  );
};

export const verifySalesOrderPdfToken = (token) => {
  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET);
    return payload?.purpose === 'sales-order-pdf' && payload?.leadId ? payload : null;
  } catch {
    return null;
  }
};

/** Token for public Invoice PDF link (email). Valid 30 days. */
export const generateInvoicePdfToken = (leadId) => {
  if (!ACCESS_TOKEN_SECRET) return null;
  return jwt.sign(
    { leadId: String(leadId), purpose: 'invoice-pdf' },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '30d' }
  );
};

export const verifyInvoicePdfToken = (token) => {
  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET);
    return payload?.purpose === 'invoice-pdf' && payload?.leadId ? payload : null;
  } catch {
    return null;
  }
};
