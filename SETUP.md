# Setup Guide for Authentication System

## Prerequisites
- Node.js (v14 or higher)
- MongoDB running locally or accessible
- npm or yarn package manager

## Installation Steps

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory with the following variables:

```env
# JWT Secrets (IMPORTANT: Change these in production!)
ACCESS_TOKEN_SECRET=your-super-secret-access-token-key-here-change-this
REFRESH_TOKEN_SECRET=your-super-secret-refresh-token-key-here-change-this

# Database Connection
MONGODB_URI=mongodb://localhost:27017/your-database-name

# Server Configuration
PORT=5000
NODE_ENV=development

# Email (SMTP) – required for OTP verification at signup (e.g. Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
MAIL_FROM=no-reply@yourdomain.com
```

### 3. Start the Server
```bash
# Development mode with auto-restart
npm run dev

# Or production mode
npm start
```

The server will start on port 5000 (or the port specified in your .env file).

## Testing the API

### Option 1: Use the Test Script
```bash
node test-api.js
```

### Option 2: Use Postman or Similar Tool

#### Signup
```
POST http://localhost:5000/api/auth/signup
Content-Type: application/json

{
  "name": "Test User",
  "email": "test@example.com",
  "password": "password123",
  "phone": "+917386898469",
  "address": "123 Test St, Test City"
}
```

#### Login (with email)
```
POST http://localhost:5000/api/auth/login
Content-Type: application/json

{
  "email": "test@example.com",
  "password": "password123"
}
```

#### Login (with phone)
```
POST http://localhost:5000/api/auth/login
Content-Type: application/json

{
  "phone": "+917386898469",
  "password": "password123"
}
```

#### Access Protected Route
```
GET http://localhost:5000/api/user/profile
Authorization: Bearer YOUR_ACCESS_TOKEN_HERE
```

#### Refresh Token
```
POST http://localhost:5000/api/auth/refresh-token
Content-Type: application/json

{
  "refreshToken": "YOUR_REFRESH_TOKEN_HERE"
}
```

#### Logout
```
POST http://localhost:5000/api/auth/logout
Content-Type: application/json

{
  "refreshToken": "YOUR_REFRESH_TOKEN_HERE"
}
```

## Security Notes

1. **JWT Secrets**: Always use strong, unique secrets in production
2. **Password Policy**: Passwords are hashed with bcrypt (12 salt rounds)
3. **Token Expiry**: 
   - Access tokens: 15 minutes
   - Refresh tokens: 7 days
4. **Validation**: All inputs are validated and sanitized
5. **HTTPS**: Use HTTPS in production for secure token transmission

## Database Schema Changes

The User model has been updated to include:
- `email` (replaces `loginId`)
- `password` (hashed)
- `refreshToken` (for JWT refresh)
- `isEmailVerified` (new field)

## Troubleshooting

### Common Issues

1. **MongoDB Connection Error**
   - Ensure MongoDB is running
   - Check MONGODB_URI in .env file

2. **JWT Verification Failed**
   - Check ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET in .env
   - Ensure tokens are being sent in Authorization header

3. **Validation Errors**
   - Check request body format
   - Ensure all required fields are provided
   - Verify email format and phone number format

4. **Port Already in Use**
   - Change PORT in .env file
   - Or kill the process using the current port

### Logs
Check the console output for detailed error messages and debugging information.
