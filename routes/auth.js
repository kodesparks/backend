import express from "express";
import { check, validationResult } from "express-validator";
import { authenticateToken } from "../middleware/auth.js";
import {
  signup,
  generateOTPController,
  verifyOTPController,
  login,
  refreshToken,
  logout,
  changePassword,
  sendVerifyEmailController,
  verifyEmailController
} from "../controllers/auth.js";

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Custom phone number validator for Indian numbers
const isValidPhoneNumber = (value) => {
  // Indian mobile numbers: 10 digits starting with 6,7,8,9
  return /^[6-9]\d{9}$/.test(value.replace(/\s/g, ""));
};

// Custom email validator
const isValidEmail = (value) => {
  return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(value);
};

router.post(
  "/signup",
  [
    check("name").notEmpty().withMessage("Name is required").trim(),
    check("phone")
      .custom(isValidPhoneNumber)
      .withMessage(
        "Invalid phone number. Enter 10-digit Indian mobile number (e.g., 9876543210)"
      )
      .customSanitizer((value) => value.replace(/\s/g, "")), // Remove spaces
    check("email")
      .custom(isValidEmail)
      .withMessage("Please enter a valid email address")
      .customSanitizer((value) => value.toLowerCase()),
    check("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters long"),
    check("address").notEmpty().withMessage("Address is required").trim(),
  ],
  validate,
  signup
);

router.post(
  "/login",
  [
    check("password").notEmpty().withMessage("Password is required"),
    check("email")
      .optional()
      .custom(isValidEmail)
      .withMessage("Please enter a valid email address")
      .customSanitizer((value) => value.toLowerCase()),
    check("phone")
      .optional()
      .custom(isValidPhoneNumber)
      .withMessage(
        "Invalid phone number. Enter 10-digit Indian mobile number (e.g., 9876543210)"
      )
      .customSanitizer((value) => value.replace(/\s/g, "")),
  ],
  validate,
  (req, res, next) => {
    // Custom validation to ensure either email or phone is provided
    if (!req.body.email && !req.body.phone) {
      return res.status(400).json({ 
        errors: [{ msg: "Either email or phone is required" }] 
      });
    }
    next();
  },
  login
);

router.post(
  "/refresh-token",
  [
    check("refreshToken").notEmpty().withMessage("Refresh token is required"),
  ],
  validate,
  refreshToken
);

router.post(
  "/logout",
  [
    check("refreshToken").notEmpty().withMessage("Refresh token is required"),
  ],
  validate,
  logout
);

router.post(
  "/otp/generate",
  [
    check("phone")
      .custom(isValidPhoneNumber)
      .withMessage(
        "Invalid phone number. Enter 10-digit Indian mobile number (e.g., 9876543210)"
      )
      .customSanitizer((value) => value.replace(/\s/g, "")), // Remove spaces
  ],
  validate,
  generateOTPController
);

router.post(
  "/otp/verify",
  [
    check("phone")
      .custom(isValidPhoneNumber)
      .withMessage(
        "Invalid phone number. Enter 10-digit Indian mobile number (e.g., 9876543210)"
      )
      .customSanitizer((value) => value.replace(/\s/g, "")), // Remove spaces
    check("otp")
      .isLength({ min: 6, max: 6 })
      .withMessage("OTP must be 6 digits"),
  ],
  validate,
  verifyOTPController
);

// Change password (protected route - requires authentication)
router.put(
  "/change-password",
  authenticateToken,
  [
    check("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    check("newPassword")
      .isLength({ min: 6 })
      .withMessage("New password must be at least 6 characters long"),
  ],
  validate,
  changePassword
);

// Email verification (customer onboard flow – uses SMTP, not Zoho Books API)
router.post("/send-verify-email", authenticateToken, sendVerifyEmailController);
router.get("/verify-email", verifyEmailController);
router.post(
  "/verify-email",
  [
    check("token").optional().trim(),
    check("email").optional().trim().toLowerCase(),
    check("otp").optional().trim().isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits"),
    check().custom((_value, { req }) => {
      const hasToken = (req.body?.token || req.query?.token || "").toString().trim();
      const hasEmail = (req.body?.email || req.query?.email || "").toString().trim();
      const hasOtp = (req.body?.otp || req.query?.otp || "").toString().trim();
      if (hasToken) return true;
      if (hasEmail && hasOtp) return true;
      throw new Error("Either verification token or both email and OTP are required");
    })
  ],
  validate,
  verifyEmailController
);

export default router;
