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
