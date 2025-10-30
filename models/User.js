import mongoose from "mongoose";

// Role-based access control configuration
const ROLE_ACCESS_LEVELS = {
  admin: {
    accessLevel: 'all_sites',
    permissions: [
      'admin_page',
      'inventory_page', 
      'bank_payments',
      'vendor_details',
      'role_user_creation',
      'app_access',
      'web_access'
    ],
    requiredFields: [
      'name', 'employeeId', 'phone', 'email', 'address', 'pincode', 'aadharNumber'
    ]
  },
  manager: {
    accessLevel: 'all_sites',
    permissions: [
      'admin_page',
      'inventory_page',
      'bank_payments', 
      'vendor_details'
    ],
    requiredFields: [
      'name', 'employeeId', 'phone', 'email', 'address', 'pincode', 'aadharNumber'
    ]
  },
  employee: {
    accessLevel: 'restricted',
    permissions: [
      'order_pages'
    ],
    requiredFields: [
      'name', 'employeeId', 'phone', 'email', 'address', 'pincode',
      'aadharNumber', 'panCard', 'joiningDate', 'terminationDate', 'employeeType'
    ]
  },
  vendor: {
    accessLevel: 'vendor_portal',
    permissions: [
      'vendor_portal'
    ],
    requiredFields: [
      'name', 'employeeId', 'phone', 'email', 'address', 'pincode',
      'aadharNumber', 'panCard', 'joiningDate', 'terminationDate', 
      'employeeType', 'companyName'
    ]
  },
  customer: {
    accessLevel: 'app_web',
    permissions: [
      'app_access',
      'web_access'
    ],
    requiredFields: [
      'name'
    ]
  }
};

const userSchema = new mongoose.Schema(
  {
    // Basic Information (Required for all roles)
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    pincode: {
      type: String,
      trim: true,
    },

    // Role and Access Control
    role: {
      type: String,
      enum: ['admin', 'manager', 'employee', 'vendor', 'customer'],
      default: 'customer',
      required: true
    },
    accessLevel: {
      type: String,
      enum: ['all_sites', 'restricted', 'vendor_portal', 'app_web'],
      default: 'app_web'
    },
    permissions: [{
      type: String,
      enum: [
        'admin_page', 'inventory_page', 'bank_payments', 'vendor_details',
        'role_user_creation', 'app_access', 'web_access', 'order_pages', 'vendor_portal'
      ]
    }],

    // Employee Information (Required for admin, manager, supervisor, employee, vendor)
    employeeId: {
      type: String,
      unique: true,
      sparse: true, // Allows null values but ensures uniqueness when present
      trim: true,
    },
    aadharNumber: {
      type: String,
      trim: true,
    },
    panCard: {
      type: String,
      trim: true,
    },
    joiningDate: {
      type: Date,
    },
    terminationDate: {
      type: Date,
    },
    employeeType: {
      type: String,
      enum: ['full_time', 'part_time', 'contract', 'intern'],
    },

    // Vendor Specific Information
    companyName: {
      type: String,
      trim: true,
    },
    
    // Warehouse Information (for vendors)
    warehouse: {
      warehouseName: {
        type: String,
        trim: true,
      },
      location: {
        address: {
          type: String,
          trim: true,
        },
        city: {
          type: String,
          trim: true,
        },
        state: {
          type: String,
          trim: true,
        },
        pincode: {
          type: String,
          trim: true,
          match: /^[1-9][0-9]{5}$/,
        },
        coordinates: {
          latitude: {
            type: Number,
            min: -90,
            max: 90,
          },
          longitude: {
            type: Number,
            min: -180,
            max: 180,
          },
        },
      },
      categories: [{
        type: String,
        enum: ['Cement', 'Iron', 'Steel', 'Concrete Mixer', 'Concrete Mix'],
      }],
      deliveryConfig: {
        baseDeliveryCharge: {
          type: Number,
          min: 0,
          default: 0,
        },
        perKmCharge: {
          type: Number,
          min: 0,
          default: 0,
        },
        minimumOrder: {
          type: Number,
          min: 0,
          default: 0,
        },
        freeDeliveryThreshold: {
          type: Number,
          default: 0,
          min: 0,
        },
        freeDeliveryRadius: {
          type: Number,
          default: 0,
          min: 0,
        },
        maxDeliveryRadius: {
          type: Number,
          default: 500,
          min: 0,
        },
      },
      operatingHours: {
        monday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
        tuesday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
        wednesday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
        thursday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
        friday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
        saturday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
        sunday: { open: String, close: String, isOpen: { type: Boolean, default: false } },
      },
      isVerified: {
        type: Boolean,
        default: false,
      },
    },

    // Account Status
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // Authentication
    refreshToken: {
      type: String,
      default: null
    },

    // Audit Fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lastLoginAt: {
      type: Date,
    },
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual for account lock status
userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Pre-save middleware to set access level and permissions based on role
userSchema.pre('save', function(next) {
  if (this.isModified('role')) {
    const roleConfig = ROLE_ACCESS_LEVELS[this.role];
    if (roleConfig) {
      this.accessLevel = roleConfig.accessLevel;
      this.permissions = roleConfig.permissions;
    }
  }
  next();
});

// Method to check if user has specific permission
userSchema.methods.hasPermission = function(permission) {
  return this.permissions && this.permissions.includes(permission);
};

// Method to check if user has any of the specified permissions
userSchema.methods.hasAnyPermission = function(permissions) {
  if (!this.permissions) return false;
  return permissions.some(permission => this.permissions.includes(permission));
};

// Method to get required fields for user's role
userSchema.methods.getRequiredFields = function() {
  const roleConfig = ROLE_ACCESS_LEVELS[this.role];
  return roleConfig ? roleConfig.requiredFields : [];
};

// Method to validate required fields are present
userSchema.methods.validateRequiredFields = function() {
  const requiredFields = this.getRequiredFields();
  const missingFields = [];
  
  requiredFields.forEach(field => {
    if (!this[field] || (typeof this[field] === 'string' && this[field].trim() === '')) {
      missingFields.push(field);
    }
  });
  
  return {
    isValid: missingFields.length === 0,
    missingFields
  };
};

// Static method to get role configuration
userSchema.statics.getRoleConfig = function(role) {
  return ROLE_ACCESS_LEVELS[role] || null;
};

// Indexes for better performance
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ employeeId: 1 });
userSchema.index({ email: 1 });
userSchema.index({ phone: 1 });

export default mongoose.model("User", userSchema);
