import mongoose from "mongoose";

const inventorySchema = new mongoose.Schema(
  {
    // Auto-generated ITEM_CD from MongoDB ObjectId
    itemCode: {
      type: String,
      unique: true,
      default: function() {
        return this._id.toString();
      }
    },
    
    // Basic Product Information
    itemDescription: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      required: true,
      enum: ['Cement', 'Iron', 'Concrete Mixer'],
      trim: true
    },
    subCategory: {
      type: String,
      required: true,
      trim: true
    },
    grade: {
      type: String,
      trim: true
    },
    units: {
      type: String,
      required: true,
      trim: true // e.g., "KG", "TON", "PIECE", "BAG"
    },
    details: {
      type: String,
      trim: true
    },
    specification: {
      type: String,
      trim: true
    },
    deliveryInformation: {
      type: String,
      trim: true
    },
    hscCode: {
      type: String,
      trim: true
    },

    // Image Management
    images: [{
      url: {
        type: String,
        required: true
      },
      key: {
        type: String,
        required: true
      },
      originalName: {
        type: String,
        required: true
      },
      size: {
        type: Number,
        required: true
      },
      mimeType: {
        type: String,
        required: true
      },
      uploadedAt: {
        type: Date,
        default: Date.now
      },
      isPrimary: {
        type: Boolean,
        default: false
      }
    }],
    primaryImage: {
      type: String, // URL of primary image
      default: null
    },

    // Pricing Information
    pricing: {
      basePrice: {
        type: Number,
        required: false,
        min: 0,
        default: 0
      },
      unitPrice: {
        type: Number,
        required: false,
        min: 0,
        default: 0
      },
      currency: {
        type: String,
        default: 'INR',
        enum: ['INR', 'USD', 'EUR']
      },
      isActive: {
        type: Boolean,
        default: true
      }
    },

    // Delivery Information
    delivery: {
      baseCharge: {
        type: Number,
        required: false,
        min: 0,
        default: 0
      },
      perKmCharge: {
        type: Number,
        required: false,
        min: 0,
        default: 0
      },
      freeDeliveryThreshold: {
        type: Number,
        default: 0,
        min: 0
      },
      freeDeliveryRadius: {
        type: Number,
        default: 0,
        min: 0
      }
    },

    // Warehouse Information - Array of warehouses where this item is available
    warehouses: [{
      warehouseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // Reference to vendor who owns this warehouse
        required: true
      },
      warehouseName: {
        type: String,
        required: true,
        trim: true
      },
      location: {
        address: {
          type: String,
          required: true,
          trim: true
        },
        city: {
          type: String,
          required: true,
          trim: true
        },
        state: {
          type: String,
          required: true,
          trim: true
        },
        pincode: {
          type: String,
          required: true,
          trim: true
        },
        coordinates: {
          latitude: {
            type: Number,
            required: true,
            min: -90,
            max: 90
          },
          longitude: {
            type: Number,
            required: true,
            min: -180,
            max: 180
          }
        }
      },
      deliveryConfig: {
        baseDeliveryCharge: {
          type: Number,
          required: true,
          min: 0,
          default: 0
        },
        perKmCharge: {
          type: Number,
          required: true,
          min: 0,
          default: 0
        },
        minimumOrder: {
          type: Number,
          required: true,
          min: 0,
          default: 0
        },
        freeDeliveryThreshold: {
          type: Number,
          default: 0,
          min: 0
        },
        freeDeliveryRadius: {
          type: Number,
          default: 0,
          min: 0
        },
        maxDeliveryRadius: {
          type: Number,
          default: 500,
          min: 0
        }
      },
      stock: {
        available: {
          type: Number,
          default: 0,
          min: 0
        },
        reserved: {
          type: Number,
          default: 0,
          min: 0
        }
      },
      isActive: {
        type: Boolean,
        default: true
      }
    }],

    // Zoho Books Integration
    zohoItemId: {
      type: String,
      default: null,
      index: true,
      trim: true
    },

    // Relationships (vendorId optional for Phase 1 when vendor portal is not launched)
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      default: null
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Status
    isActive: {
      type: Boolean,
      default: true
    },

    // Audit Fields
    createdDate: {
      type: Date,
      default: Date.now
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    updateDate: {
      type: Date,
      default: Date.now
    },
    updateTime: {
      type: Date,
      default: Date.now
    }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual for formatted item code
inventorySchema.virtual('formattedItemCode').get(function() {
  return `ITEM-${this.itemCode}`;
});

// Pre-save middleware to update timestamps
inventorySchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.updateDate = new Date();
    this.updateTime = new Date();
  }
  next();
});

// Indexes for better performance
// itemCode index is automatically created due to unique: true
inventorySchema.index({ vendorId: 1, isActive: 1 });
inventorySchema.index({ category: 1, subCategory: 1 });
inventorySchema.index({ createdBy: 1 });
inventorySchema.index({ isActive: 1 });

// Static method to get inventory by vendor
inventorySchema.statics.getByVendor = function(vendorId) {
  return this.find({ vendorId, isActive: true }).populate('vendorId', 'name email');
};

// Static method to get inventory by category
inventorySchema.statics.getByCategory = function(category, subCategory = null) {
  const filter = { category, isActive: true };
  if (subCategory) {
    filter.subCategory = subCategory;
  }
  return this.find(filter).populate('vendorId', 'name email');
};

// Static method to get valid subcategories for a category
inventorySchema.statics.getSubCategories = function(category) {
  const subCategories = {
    'Cement': ['PPC', 'OPC', 'PSC'],
    'Iron': ['TMT Bars', 'Mild Steel', 'Stainless Steel'],
    'Concrete Mixer': ['Manual Mixer', 'Electric Mixer', 'Diesel Mixer']
  };
  return subCategories[category] || [];
};

// Static method to get all categories with their subcategories
inventorySchema.statics.getAllCategories = function() {
  return {
    'Cement': ['PPC', 'OPC', 'PSC'],
    'Iron': ['TMT Bars', 'Mild Steel', 'Stainless Steel'],
    'Concrete Mixer': ['Manual Mixer', 'Electric Mixer', 'Diesel Mixer']
  };
};

// Method to add image to inventory
inventorySchema.methods.addImage = function(imageData) {
  // Set first image as primary if no primary exists
  if (this.images.length === 0) {
    imageData.isPrimary = true;
    this.primaryImage = imageData.url;
  }
  
  this.images.push(imageData);
  return this.save();
};

// Method to remove image from inventory
inventorySchema.methods.removeImage = function(imageKey) {
  const imageIndex = this.images.findIndex(img => img.key === imageKey);
  if (imageIndex === -1) return false;
  
  const removedImage = this.images[imageIndex];
  this.images.splice(imageIndex, 1);
  
  // If removed image was primary, set new primary
  if (removedImage.isPrimary && this.images.length > 0) {
    this.images[0].isPrimary = true;
    this.primaryImage = this.images[0].url;
  } else if (this.images.length === 0) {
    this.primaryImage = null;
  }
  
  return this.save();
};

// Method to set primary image
inventorySchema.methods.setPrimaryImage = function(imageKey) {
  // Remove primary from all images
  this.images.forEach(img => img.isPrimary = false);
  
  // Set new primary
  const targetImage = this.images.find(img => img.key === imageKey);
  if (targetImage) {
    targetImage.isPrimary = true;
    this.primaryImage = targetImage.url;
    return this.save();
  }
  
  return false;
};

// Method to get image URLs for frontend
inventorySchema.methods.getImageUrls = function() {
  return this.images.map(img => ({
    url: img.url,
    key: img.key,
    isPrimary: img.isPrimary,
    originalName: img.originalName
  }));
};

// Method to check if user can access this inventory
inventorySchema.methods.canAccess = function(user) {
  // Admin can access everything
  if (user.role === 'admin') return true;
  
  // Manager can access everything
  if (user.role === 'manager') return true;
  
  // Vendor can only access their own inventory
  if (user.role === 'vendor' && this.vendorId.toString() === user._id.toString()) return true;
  
  // Employee and customer can view all active inventory
  if (['employee', 'customer'].includes(user.role)) return this.isActive;
  
  return false;
};

export default mongoose.model("Inventory", inventorySchema);
