import User from "../models/User.js";
import OTP from "../models/OTP.js";
import { sendOTP, verifyOTP } from "../utils/engagelab.js";
import bcrypt from "bcryptjs";
import { generateTokens, verifyRefreshToken } from "../utils/jwt.js";

const signup = async (req, res, next) => {
  try {
    const { 
      name, phone, email, password, address, pincode, role = 'customer',
      employeeId, aadharNumber, panCard, joiningDate, terminationDate, 
      employeeType, companyName, warehouse, createdBy 
    } = req.body;
    
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
    
    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);
    
    // Save refresh token to user
    user.refreshToken = refreshToken;
    await user.save();
    
    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.refreshToken;
    
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
    const sanitizedPhone = phone.replace(/\s/g, ""); // Ensure no spaces
    const user = await User.findOne({ phone: sanitizedPhone });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const { messageId, sendChannel } = await sendOTP(sanitizedPhone);
    // Store messageId in OTP model for verification
    const otpDoc = new OTP({
      phone: sanitizedPhone,
      otp: "engagelab-managed",
      type: "signup",
      messageId,
    });
    await otpDoc.save();
    res.status(200).json({ message: "OTP sent", messageId, sendChannel });
  } catch (error) {
    next(error);
  }
};

const verifyOTPController = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    const sanitizedPhone = phone.replace(/\s/g, ""); // Ensure no spaces
    const otpDoc = await OTP.findOne({
      phone: sanitizedPhone,
      type: "signup",
      isUsed: false,
    });
    if (!otpDoc) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }
    const verified = await verifyOTP(otpDoc.messageId, otp);
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
    res.status(200).json({ message: "OTP verified", user });
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
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // Find user
    const user = await User.findById(decoded.userId);
    if (!user || user.refreshToken !== token) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);
    
    // Update refresh token
    user.refreshToken = newRefreshToken;
    await user.save();
    
    res.status(200).json({ 
      accessToken,
      refreshToken: newRefreshToken
    });
  } catch (error) {
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

export { 
  signup, generateOTPController, verifyOTPController, login, refreshToken, logout,
  createUser, getAllUsers, getUserById, updateUser, deleteUser, getRoleConfig, getAllRoles
};
