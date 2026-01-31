import User from "../models/User.js";
import OTP from "../models/OTP.js";
import { sendVerificationEmail, sendOTPEmail } from "../utils/emailService.js";
import { generateOTP } from "../utils/generateOTP.js";
import bcrypt from "bcryptjs";
import { generateTokens, verifyRefreshToken } from "../utils/jwt.js";
import zohoBooksService from "../utils/zohoBooks.js";

const signup = async (req, res, next) => {
  try {
    const { 
      name, phone, email, password, address, pincode, role = 'customer',
      employeeId, aadharNumber, panCard, joiningDate, terminationDate, 
      employeeType, companyName, warehouse, createdBy 
    } = req.body;
    
    // Check if user already exists (tell frontend which one: email or phone)
    const existingByEmail = await User.findOne({ email: email.toLowerCase() });
    const existingByPhone = await User.findOne({ phone: phone.replace(/\s/g, "") });
    if (existingByEmail && existingByPhone && existingByEmail._id.toString() !== existingByPhone._id.toString()) {
      return res.status(400).json({ message: "Email and phone already registered", code: "BOTH_EXIST" });
    }
    if (existingByEmail) {
      return res.status(400).json({ message: "Email already registered", code: "EMAIL_EXISTS" });
    }
    if (existingByPhone) {
      return res.status(400).json({ message: "Phone number already registered", code: "PHONE_EXISTS" });
    }

    // Check if employeeId already exists (for employee roles)
    if (employeeId) {
      const existingEmployee = await User.findOne({ employeeId });
      if (existingEmployee) {
        return res
          .status(400)
          .json({ message: "Employee ID already exists" });
      }
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user object with role-specific fields
    const userData = { 
      name, 
      phone: phone.replace(/\s/g, ""), 
      email: email.toLowerCase(), 
      password: hashedPassword,
      address,
      pincode,
      role,
      createdBy
    };

    // Add role-specific fields
    if (['admin', 'manager', 'employee', 'vendor'].includes(role)) {
      userData.employeeId = employeeId;
      userData.aadharNumber = aadharNumber;
      userData.panCard = panCard;
      userData.joiningDate = joiningDate;
      userData.terminationDate = terminationDate;
      userData.employeeType = employeeType;
    }

    if (role === 'vendor') {
      userData.companyName = companyName;
      // Add warehouse data if provided
      if (warehouse) {
        userData.warehouse = warehouse;
      }
    }

    const user = new User(userData);
    
    // Validate required fields for the role
    const validation = user.validateRequiredFields();
    if (!validation.isValid) {
      return res.status(400).json({
        message: "Missing required fields for role",
        missingFields: validation.missingFields,
        role,
        requiredFields: user.getRequiredFields()
      });
    }
    
    await user.save();

    // Create customer in Zoho Books when role is customer (non-blocking)
    if (role === 'customer') {
      (async () => {
        try {
          const zohoCustomerId = await zohoBooksService.createOrGetCustomer(user);
          if (zohoCustomerId && !user.zohoCustomerId) {
            user.zohoCustomerId = zohoCustomerId;
            await user.save();
            console.log(`✅ Zoho customer created/linked for ${user.email}: ${zohoCustomerId}`);
          }
        } catch (err) {
          console.warn(`⚠️  Zoho customer creation skipped for ${user.email}:`, err.message);
        }
      })();
    }

    // Send email verification OTP when customer onboard (uses SMTP; 6-digit code in email).
    if (role === 'customer' && user.email) {
      (async () => {
        try {
          const code = generateOTP();
          const hashedOtp = await bcrypt.hash(code, 10);
          const expires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
          await User.findByIdAndUpdate(user._id, {
            emailVerificationOtp: hashedOtp,
            emailVerificationOtpExpires: expires
          });
          await sendOTPEmail(user.email, user.name, code);
        } catch (err) {
          console.warn(`⚠️  Verification OTP email skipped for ${user.email}:`, err.message, '- User and Zoho link are already saved.');
        }
      })();
    }

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;

    // For customer: do NOT return tokens until they verify (email or OTP). Frontend shows verify page.
    if (role === 'customer') {
      return res.status(201).json({
        message: "Please verify your email to continue",
        user: userResponse,
        requiresVerification: true
      });
    }

    // For admin/manager/employee/vendor: log in immediately (return tokens)
    const { accessToken, refreshToken } = generateTokens(user);
    user.refreshToken = refreshToken;
    await user.save();
    res.status(201).json({
      message: "User created successfully",
      user: userResponse,
      accessToken,
      refreshToken
    });
  } catch (error) {
    next(error);
  }
};

const generateOTPController = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const sanitizedPhone = phone.replace(/\s/g, "");
    const user = await User.findOne({ phone: sanitizedPhone });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!user.email) {
      return res.status(400).json({ message: "User has no email; cannot send OTP" });
    }
    const code = generateOTP();
    const hashedOtp = await bcrypt.hash(code, 10);
    const otpDoc = new OTP({
      phone: sanitizedPhone,
      otp: hashedOtp,
      type: "signup",
    });
    await otpDoc.save();
    const sent = await sendOTPEmail(user.email, user.name, code);
    if (!sent) {
      return res.status(503).json({ message: "Failed to send OTP email; check SMTP config" });
    }
    res.status(200).json({ message: "OTP sent to your email", sendChannel: "email" });
  } catch (error) {
    next(error);
  }
};

const verifyOTPController = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    const sanitizedPhone = phone.replace(/\s/g, "");
    const otpDoc = await OTP.findOne({
      phone: sanitizedPhone,
      type: "signup",
      isUsed: false,
    });
    if (!otpDoc) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }
    const verified = await bcrypt.compare(otp, otpDoc.otp);
    if (!verified) {
      return res.status(400).json({ message: "OTP verification failed" });
    }
    otpDoc.isUsed = true;
    await otpDoc.save();
    const user = await User.findOneAndUpdate(
      { phone: sanitizedPhone },
      { isPhoneVerified: true },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    // After OTP verify: give tokens so frontend can log in and redirect to home
    const { accessToken, refreshToken } = generateTokens(user);
    user.refreshToken = refreshToken;
    await user.save();
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;
    res.status(200).json({
      message: "OTP verified",
      user: userResponse,
      accessToken,
      refreshToken
    });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, phone, password } = req.body;
    
    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone is required" });
    }
    
    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    // Find user by email or phone
    let user;
    if (email) {
      user = await User.findOne({ email: email.toLowerCase() });
    } else {
      user = await User.findOne({ phone: phone.replace(/\s/g, "") });
    }

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({ message: "Account is deactivated" });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Generate new tokens
    const { accessToken, refreshToken } = generateTokens(user);
    
    // Save refresh token to user
    user.refreshToken = refreshToken;
    await user.save();
    
    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;
    
    res.status(200).json({ 
      message: "Login successful", 
      user: userResponse,
      accessToken,
      refreshToken
    });
  } catch (error) {
    next(error);
  }
};

const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    
    if (!token) {
      return res.status(401).json({ message: "Refresh token is required" });
    }

    // Verify refresh token
    const decoded = verifyRefreshToken(token);
    if (!decoded) {
      return res.status(401).json({ 
        message: "Invalid or expired refresh token",
        error: "Token verification failed"
      });
    }

    // Find user
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ 
        message: "Invalid refresh token",
        error: "User not found"
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({ 
        message: "Account is deactivated",
        error: "User account is inactive"
      });
    }

    // Check if stored refresh token matches
    if (!user.refreshToken || user.refreshToken !== token) {
      return res.status(401).json({ 
        message: "Invalid refresh token",
        error: "Token mismatch - user may have logged in from another device"
      });
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);
    
    // Update refresh token
    user.refreshToken = newRefreshToken;
    await user.save();
    
    res.status(200).json({ 
      message: "Token refreshed successfully",
      accessToken,
      refreshToken: newRefreshToken
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    
    if (!token) {
      return res.status(400).json({ message: "Refresh token is required" });
    }

    // Find user and remove refresh token
    const user = await User.findOneAndUpdate(
      { refreshToken: token },
      { refreshToken: null },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ message: "Invalid refresh token" });
    }

    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
};

// Change password (requires current password verification)
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!currentPassword) {
      return res.status(400).json({ message: "Current password is required" });
    }

    if (!newPassword) {
      return res.status(400).json({ message: "New password is required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ 
        message: "New password must be at least 6 characters long" 
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword, 
      user.password
    );

    if (!isCurrentPasswordValid) {
      return res.status(401).json({ 
        message: "Current password is incorrect" 
      });
    }

    // Check if new password is same as current password
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({ 
        message: "New password must be different from current password" 
      });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({ 
      message: "Password changed successfully" 
    });
  } catch (error) {
    next(error);
  }
};

// User Management Controllers
const createUser = async (req, res, next) => {
  try {
    const { 
      name, phone, email, password, address, pincode, role,
      employeeId, aadharNumber, panCard, joiningDate, terminationDate, 
      employeeType, companyName, warehouse 
    } = req.body;
    
    // Only admin can create users with specific roles
    if (req.user.role !== 'admin' && role !== 'customer') {
      return res.status(403).json({ 
        message: "Only admin can create users with roles other than customer" 
      });
    }
    
    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ phone: phone.replace(/\s/g, "") }, { email: email.toLowerCase() }],
    });
    
    if (existingUser) {
      return res
        .status(400)
        .json({ message: "Phone or email already exists" });
    }

    // Check if employeeId already exists (for employee roles)
    if (employeeId) {
      const existingEmployee = await User.findOne({ employeeId });
      if (existingEmployee) {
        return res
          .status(400)
          .json({ message: "Employee ID already exists" });
      }
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user object with role-specific fields
    const userData = { 
      name, 
      phone: phone.replace(/\s/g, ""), 
      email: email.toLowerCase(), 
      password: hashedPassword,
      address,
      pincode,
      role: role || 'customer',
      createdBy: req.user.userId
    };

    // Add role-specific fields
    if (['admin', 'manager', 'employee', 'vendor'].includes(role)) {
      userData.employeeId = employeeId;
      userData.aadharNumber = aadharNumber;
      userData.panCard = panCard;
      userData.joiningDate = joiningDate;
      userData.terminationDate = terminationDate;
      userData.employeeType = employeeType;
    }

    if (role === 'vendor') {
      userData.companyName = companyName;
      // Add warehouse data if provided
      if (warehouse) {
        userData.warehouse = warehouse;
      }
    }

    const user = new User(userData);
    
    // Validate required fields for the role
    const validation = user.validateRequiredFields();
    if (!validation.isValid) {
      return res.status(400).json({
        message: "Missing required fields for role",
        missingFields: validation.missingFields,
        role,
        requiredFields: user.getRequiredFields()
      });
    }
    
    await user.save();
    
    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;
    
    res.status(201).json({ 
      message: "User created successfully", 
      user: userResponse
    });
  } catch (error) {
    next(error);
  }
};

const getAllUsers = async (req, res, next) => {
  try {
    const { role, isActive, page = 1, limit = 10 } = req.query;
    const filter = {};
    
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    
    const skip = (page - 1) * limit;
    
    const users = await User.find(filter)
      .select('-password -refreshToken')
      .populate('createdBy', 'name email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(filter);
    
    res.status(200).json({
      users,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalUsers: total,
        hasNext: skip + users.length < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    next(error);
  }
};

const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id)
      .select('-password -refreshToken')
      .populate('createdBy', 'name email role');
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
};

const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Handle password update separately
    if (updateData.password) {
      const saltRounds = 12;
      updateData.password = await bcrypt.hash(updateData.password, saltRounds);
    }
    
    // Remove sensitive fields that shouldn't be updated directly
    delete updateData.refreshToken;
    delete updateData.createdBy;
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && req.user.userId !== id) {
      return res.status(403).json({ 
        message: "You can only update your own profile" 
      });
    }
    
    // Only admin can change roles
    if (updateData.role && req.user.role !== 'admin') {
      return res.status(403).json({ 
        message: "Only admin can change user roles" 
      });
    }
    
    // Update user
    Object.assign(user, updateData);
    
    // Validate required fields if role is being changed
    if (updateData.role) {
      const validation = user.validateRequiredFields();
      if (!validation.isValid) {
        return res.status(400).json({
          message: "Missing required fields for role",
          missingFields: validation.missingFields,
          role: updateData.role,
          requiredFields: user.getRequiredFields()
        });
      }
    }
    
    await user.save();
    
    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;
    
    res.status(200).json({ 
      message: "User updated successfully", 
      user: userResponse
    });
  } catch (error) {
    next(error);
  }
};

const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Only admin can delete users
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        message: "Only admin can delete users" 
      });
    }
    
    // Prevent admin from deleting themselves
    if (req.user.userId === id) {
      return res.status(400).json({ 
        message: "Admin cannot delete their own account" 
      });
    }
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Soft delete by setting isActive to false
    user.isActive = false;
    await user.save();
    
    res.status(200).json({ message: "User deactivated successfully" });
  } catch (error) {
    next(error);
  }
};

const getRoleConfig = async (req, res, next) => {
  try {
    const { role } = req.params;
    
    const roleConfig = User.getRoleConfig(role);
    if (!roleConfig) {
      return res.status(404).json({ message: "Role not found" });
    }
    
    res.status(200).json({ 
      role,
      config: roleConfig
    });
  } catch (error) {
    next(error);
  }
};

const getAllRoles = async (req, res, next) => {
  try {
    const roles = Object.keys(User.getRoleConfig('admin') ? 
      require('../models/User.js').default.schema.paths.role.enumValues : 
      ['admin', 'manager', 'employee', 'vendor', 'customer']
    );
    
    const roleConfigs = {};
    roles.forEach(role => {
      roleConfigs[role] = User.getRoleConfig(role);
    });
    
    res.status(200).json({ 
      roles,
      roleConfigs
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Send verification OTP email to the authenticated user (customer onboard flow).
 * Uses SMTP – sends 6-digit OTP in email.
 */
const sendVerifyEmailController = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).select("+emailVerificationOtp +emailVerificationOtpExpires");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (user.isEmailVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }
    if (!user.email) {
      return res.status(400).json({ message: "No email to send verification to" });
    }
    const code = generateOTP();
    const hashedOtp = await bcrypt.hash(code, 10);
    const expires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    user.emailVerificationOtp = hashedOtp;
    user.emailVerificationOtpExpires = expires;
    await user.save({ validateBeforeSave: false });

    const sent = await sendOTPEmail(user.email, user.name, code);
    if (!sent) {
      return res.status(503).json({
        message: "Verification email could not be sent. SMTP may not be configured.",
        hint: "Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env"
      });
    }
    res.status(200).json({ message: "Verification code sent to your email." });
  } catch (error) {
    next(error);
  }
};

/**
 * Verify email using OTP (from verification email) or legacy token (link). No auth required.
 * POST/GET: ?email=...&otp=... or body { email, otp } for OTP; ?token=... or body { token } for legacy link.
 */
const verifyEmailController = async (req, res, next) => {
  try {
    const email = (req.query.email || req.body?.email || "").toString().toLowerCase().trim();
    const otp = (req.query.otp || req.body?.otp || "").toString().trim();
    const token = (req.query.token || req.body?.token || "").toString().trim();

    // OTP flow: email + 6-digit OTP
    if (email && otp) {
      const user = await User.findOne({ email }).select("+emailVerificationOtp +emailVerificationOtpExpires");
      if (!user) {
        return res.status(400).json({ message: "Invalid or expired verification code" });
      }
      if (!user.emailVerificationOtp || !user.emailVerificationOtpExpires || user.emailVerificationOtpExpires < new Date()) {
        return res.status(400).json({ message: "Verification code expired. Request a new one." });
      }
      const verified = await bcrypt.compare(otp, user.emailVerificationOtp);
      if (!verified) {
        return res.status(400).json({ message: "Invalid verification code" });
      }
      user.isEmailVerified = true;
      user.emailVerificationOtp = undefined;
      user.emailVerificationOtpExpires = undefined;
      await user.save({ validateBeforeSave: false });

      const { accessToken, refreshToken } = generateTokens(user);
      user.refreshToken = refreshToken;
      await user.save({ validateBeforeSave: false });

      const userResponse = user.toObject();
      delete userResponse.password;
      delete userResponse.refreshToken;
      delete userResponse.emailVerificationOtp;
      delete userResponse.emailVerificationOtpExpires;
      return res.status(200).json({
        message: "Email verified successfully",
        user: userResponse,
        accessToken,
        refreshToken
      });
    }

    // Legacy: token (link) flow
    if (!token) {
      return res.status(400).json({ message: "Email and OTP are required, or verification token" });
    }
    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationTokenExpires: { $gt: new Date() }
    }).select("+emailVerificationToken +emailVerificationTokenExpires");
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired verification link" });
    }
    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationTokenExpires = undefined;
    await user.save({ validateBeforeSave: false });

    const { accessToken, refreshToken } = generateTokens(user);
    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;
    delete userResponse.emailVerificationToken;
    delete userResponse.emailVerificationTokenExpires;
    res.status(200).json({
      message: "Email verified successfully",
      user: userResponse,
      accessToken,
      refreshToken
    });
  } catch (error) {
    next(error);
  }
};

export { 
  signup, generateOTPController, verifyOTPController, login, refreshToken, logout, changePassword,
  sendVerifyEmailController, verifyEmailController,
  createUser, getAllUsers, getUserById, updateUser, deleteUser, getRoleConfig, getAllRoles
};
