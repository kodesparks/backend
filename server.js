import express from "express";
import cors from "cors";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./config/db.js";
import authRoutes from './routes/auth.js'
import profileRoutes from './routes/profile.js'
import adminRoutes from './routes/admin.js'
import userRoutes from './routes/users.js'
import inventoryRoutes from './routes/inventory.js'
import orderRoutes from './routes/order.js'
import locationRoutes from './routes/location.js'
import deliveryRoutes from './routes/delivery.js'
import warehouseRoutes from './routes/warehouse.js'
// ✅ REMOVED: syncRoutes - Using direct model approach
import { initializeAdmin } from './utils/initAdmin.js';
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
dotenv.config();

// Connect to MongoDB
connectDB().then(() => {
  // Initialize admin user after database connection
  initializeAdmin();
});

// Middleware - CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or same-origin requests)
    if (!origin) {
      return callback(null, true);
    }

    // List of allowed origins
    const allowedOrigins = [
      'https://infraxpertv1.netlify.app',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
      'https://infraxpert.in',
      'https://www.infraxpert.in',
      'https://admin.infraxpert.in',
      'https://vendor.infraxpert.in',
      'https://customer.infraxpert.in'
    ];

    // In development, allow localhost with any port
    if (process.env.NODE_ENV !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }

    // Check if origin is in allowed list
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Authorization'],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));
app.use(express.json());

// Routes
app.get("/",(req,res)=>{
  res.send("Hello World");
});
app.use("/api/auth", authRoutes);
app.use("/api/user", profileRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/order", orderRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/warehouse", warehouseRoutes);
// ✅ REMOVED: app.use("/api/sync", syncRoutes) - Using direct model approach

// Basic Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Internal Server Error" });
});

// Start Server
const port = process.env.PORT || 5000;
const httpsPort = process.env.HTTPS_PORT || 5443;

// Try to start HTTPS server if certificates exist
const sslOptions = {
  key: process.env.SSL_KEY_PATH ? fs.readFileSync(process.env.SSL_KEY_PATH) : null,
  cert: process.env.SSL_CERT_PATH ? fs.readFileSync(process.env.SSL_CERT_PATH) : null
};

if (sslOptions.key && sslOptions.cert) {
  // Start HTTPS server
  https.createServer(sslOptions, app).listen(httpsPort, () => {
    console.log(`HTTPS Server running on port ${httpsPort}`);
  });
  
  // Also start HTTP server for fallback
  app.listen(port, () => {
    console.log(`HTTP Server running on port ${port}`);
  });
} else {
  // Start HTTP server only
  app.listen(port, () => {
    console.log(`HTTP Server running on port ${port}`);
    console.log('Note: HTTPS not configured. Set SSL_KEY_PATH and SSL_CERT_PATH environment variables to enable HTTPS.');
  });
}
