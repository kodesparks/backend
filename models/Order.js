import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  // Lead ID - Primary Key (Order ID) with category prefix
  leadId: {
    type: String,
    required: true,
    unique: true
  },
  
  // Customer Information
  custUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Order Items (Multiple items from same vendor)
  items: [{
    itemCode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true
    },
    qty: {
      type: Number,
      required: true,
      min: 1
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0
    },
    totalCost: {
      type: Number,
      required: true,
      min: 0
    }
  }],
  
  // Vendor Information (Single vendor per order)
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Order Totals
  totalQty: {
    type: Number,
    required: true,
    default: 0
  },
  totalAmount: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  deliveryCharges: {
    type: Number,
    required: false,
    default: 0,
    min: 0
  },
  
  // Delivery Information
  deliveryAddress: {
    type: String,
    required: false,
    default: 'Address to be updated'
  },
  deliveryPincode: {
    type: String,
    required: false,
    default: '000000',
    match: /^[1-9][0-9]{5}$|^000000$/
  },
  deliveryExpectedDate: {
    type: Date,
    required: false,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days from now
  },
  
  // Address Change Tracking
  addressChangeHistory: [{
    oldAddress: String,
    newAddress: String,
    oldPincode: String,
    newPincode: String,
    changedAt: {
      type: Date,
      default: Date.now
    },
    changedBy: {
      type: String,
      enum: ['customer', 'admin', 'vendor'],
      default: 'customer'
    },
    reason: String
  }],
  
  // Delivery Date Change Tracking
  deliveryDateChangeHistory: [{
    oldDate: Date,
    newDate: Date,
    changedAt: {
      type: Date,
      default: Date.now
    },
    changedBy: {
      type: String,
      enum: ['customer', 'admin', 'vendor'],
      default: 'customer'
    },
    reason: String
  }],
  
  // Contact Information
  custPhoneNum: {
    type: String,
    required: false,
    default: '0000000000',
    match: /^[6-9]\d{9}$|^0000000000$/
  },
  receiverMobileNum: {
    type: String,
    required: false,
    default: '0000000000',
    match: /^[6-9]\d{9}$|^0000000000$/
  },
  
  // Promo Information (Optional)
  promoCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Promo',
    default: null
  },
  promoDiscount: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Invoice Information
  invcNum: {
    type: String,
    unique: true,
    default: () => `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  },
  invcSumNum: {
    type: String,
    default: null
  },
  
  // Order Status
  orderStatus: {
    type: String,
    enum: ['pending', 'order_placed', 'vendor_accepted', 'payment_done', 'order_confirmed', 'truck_loading', 'in_transit', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
    default: 'pending'
  },
  
  // Timestamps
  orderDate: {
    type: Date,
    default: Date.now
  },
  orderTime: {
    type: String,
    default: () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
  },
  updateDate: {
    type: Date,
    default: Date.now
  },
  updateTimestamp: {
    type: String,
    default: () => new Date().toISOString()
  },
  
  // Soft Delete
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes
orderSchema.index({ leadId: 1 });
orderSchema.index({ custUserId: 1 });
orderSchema.index({ vendorId: 1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ orderDate: -1 });
orderSchema.index({ invcNum: 1 });

// Virtual for formatted lead ID
orderSchema.virtual('formattedLeadId').get(function() {
  return this.leadId; // Already formatted with category prefix
});

// Pre-save middleware to calculate totals
orderSchema.pre('save', function(next) {
  if (this.isModified('items')) {
    this.totalQty = this.items.reduce((sum, item) => sum + item.qty, 0);
    this.totalAmount = this.items.reduce((sum, item) => sum + item.totalCost, 0);
    
    // Add delivery charges to total amount
    if (this.deliveryCharges && this.deliveryCharges > 0) {
      this.totalAmount += this.deliveryCharges;
    }
    
    // Apply promo discount if exists
    if (this.promoDiscount > 0) {
      this.totalAmount = Math.max(0, this.totalAmount - this.promoDiscount);
    }
  }
  
  // Update timestamps
  this.updateDate = new Date();
  this.updateTimestamp = new Date().toISOString();
  
  next();
});

// Instance methods
orderSchema.methods.calculateTotal = function() {
  const subtotal = this.items.reduce((sum, item) => sum + item.totalCost, 0);
  const finalTotal = Math.max(0, subtotal - this.promoDiscount);
  return {
    subtotal,
    promoDiscount: this.promoDiscount,
    total: finalTotal
  };
};

orderSchema.methods.updateStatus = function(newStatus) {
  this.orderStatus = newStatus;
  this.updateDate = new Date();
  this.updateTimestamp = new Date().toISOString();
  return this.save();
};

orderSchema.methods.addItem = function(itemCode, qty, unitPrice) {
  const existingItemIndex = this.items.findIndex(item => 
    item.itemCode.toString() === itemCode.toString()
  );
  
  if (existingItemIndex >= 0) {
    // Update existing item
    this.items[existingItemIndex].qty += qty;
    this.items[existingItemIndex].totalCost = this.items[existingItemIndex].qty * unitPrice;
  } else {
    // Add new item
    this.items.push({
      itemCode,
      qty,
      unitPrice,
      totalCost: qty * unitPrice
    });
  }
  
  return this.save();
};

orderSchema.methods.removeItem = function(itemCode) {
  this.items = this.items.filter(item => 
    item.itemCode.toString() !== itemCode.toString()
  );
  return this.save();
};

// Static methods
orderSchema.statics.findByCustomer = function(customerId, options = {}) {
  return this.find({ custUserId: customerId, isActive: true })
    .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
    .populate('vendorId', 'name email phone')
    .populate('promoCode', 'promoName discountType discountValue')
    .sort({ orderDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderSchema.statics.findByVendor = function(vendorId, options = {}) {
  return this.find({ vendorId, isActive: true })
    .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
    .populate('custUserId', 'name email phone')
    .populate('promoCode', 'promoName discountType discountValue')
    .sort({ orderDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderSchema.statics.findByStatus = function(status, options = {}) {
  return this.find({ orderStatus: status, isActive: true })
    .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
    .populate('custUserId', 'name email phone')
    .populate('vendorId', 'name email phone')
    .populate('promoCode', 'promoName discountType discountValue')
    .sort({ orderDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

// Static method to generate custom lead ID with category prefix
orderSchema.statics.generateLeadId = async function(items) {
  try {
    // Get categories from items
    const categories = new Set();
    
    for (const item of items) {
      const inventoryItem = await this.model('Inventory').findById(item.itemCode);
      if (inventoryItem && inventoryItem.category) {
        categories.add(inventoryItem.category);
      }
    }
    
    // Determine category prefix
    let categoryPrefix = 'ORDER'; // Default prefix
    
    if (categories.size === 1) {
      // Single category - use specific prefix
      const category = Array.from(categories)[0];
      switch (category.toLowerCase()) {
        case 'cement':
          categoryPrefix = 'CEMENT';
          break;
        case 'iron':
          categoryPrefix = 'STEEL';
          break;
        case 'concrete mixer':
          categoryPrefix = 'MIXER';
          break;
        default:
          categoryPrefix = 'ORDER';
      }
    } else if (categories.size > 1) {
      // Multiple categories - use MIXED prefix
      categoryPrefix = 'MIXED';
    }
    
    // Generate unique ID
    const timestamp = Date.now().toString(36);
    const randomId = Math.random().toString(36).substr(2, 8);
    const leadId = `${categoryPrefix}-${timestamp}${randomId}`.toUpperCase();
    
    // Ensure uniqueness
    const existingOrder = await this.findOne({ leadId });
    if (existingOrder) {
      // If collision, add more randomness
      const extraRandom = Math.random().toString(36).substr(2, 4);
      return `${categoryPrefix}-${timestamp}${randomId}${extraRandom}`.toUpperCase();
    }
    
    return leadId;
  } catch (error) {
    console.error('Error generating lead ID:', error);
    // Fallback to generic ID
    const timestamp = Date.now().toString(36);
    const randomId = Math.random().toString(36).substr(2, 8);
    return `ORDER-${timestamp}${randomId}`.toUpperCase();
  }
};

export default mongoose.model('Order', orderSchema);
