import mongoose from 'mongoose';

const orderDeliverySchema = new mongoose.Schema({
  // Lead ID - Foreign Key to Orders
  leadId: {
    type: String,
    ref: 'Order',
    required: true
  },
  
  // Invoice Number - Foreign Key
  invcNum: {
    type: String,
    ref: 'Order',
    required: true
  },
  
  // User ID - Foreign Key (Delivery personnel or managing user)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Delivery Address Information
  multipleAddress: {
    type: Boolean,
    default: false
  },
  address: {
    type: String,
    default: ''
  },
  pincode: {
    type: String,
    required: true,
    match: /^[1-9][0-9]{5}$/
  },
  
  // Delivery Dates
  deliveryExpectedDate: {
    type: Date,
    required: true
  },
  deliveryActualDate: {
    type: Date,
    default: null
  },
  
  // Tracking Information
  // Deprecated courier fields (kept for backward compatibility)
  trackingNumber: { type: String, default: null },
  courierService: { type: String, default: null },
  trackingUrl: { type: String, default: null },

  // In-house fleet tracking (NEW)
  driverName: { type: String, default: null },
  driverPhone: { type: String, default: null, match: /^[0-9+\- ]{7,15}$/ },
  driverLicenseNo: { type: String, default: null },
  truckNumber: { type: String, default: null },
  vehicleType: { type: String, default: null },
  capacityTons: { type: Number, default: null, min: 0 },
  startTime: { type: Date, default: null },
  estimatedArrival: { type: Date, default: null },
  lastLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    address: { type: String, default: null }
  },
  
  // Delivery Status
  deliveryStatus: {
    type: String,
    enum: ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'],
    default: 'pending'
  },
  
  // Delivery Notes
  deliveryNotes: {
    type: String,
    default: null
  },
  deliveryInstructions: {
    type: String,
    default: null
  },
  
  // Contact Information
  deliveryContactName: {
    type: String,
    default: null
  },
  deliveryContactPhone: {
    type: String,
    default: null,
    match: /^[6-9]\d{9}$/
  },
  
  // Delivery Proof
  deliveryProof: {
    type: String,
    default: null
  },
  deliverySignature: {
    type: String,
    default: null
  },
  
  // Timestamps
  updateDate: {
    type: Date,
    default: Date.now
  },
  updateTime: {
    type: String,
    default: () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
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
orderDeliverySchema.index({ leadId: 1 });
orderDeliverySchema.index({ invcNum: 1 });
orderDeliverySchema.index({ userId: 1 });
orderDeliverySchema.index({ deliveryStatus: 1 });
orderDeliverySchema.index({ deliveryExpectedDate: 1 });
orderDeliverySchema.index({ trackingNumber: 1 });

// Pre-save middleware
orderDeliverySchema.pre('save', function(next) {
  this.updateDate = new Date();
  this.updateTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  next();
});

// Instance methods
orderDeliverySchema.methods.updateDeliveryStatus = function(newStatus, notes = null) {
  this.deliveryStatus = newStatus;
  if (notes) {
    this.deliveryNotes = notes;
  }
  
  if (newStatus === 'delivered') {
    this.deliveryActualDate = new Date();
  }
  
  this.updateDate = new Date();
  this.updateTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  
  return this.save();
};

orderDeliverySchema.methods.addTrackingInfo = function(trackingNumber, courierService, trackingUrl = null) {
  this.trackingNumber = trackingNumber;
  this.courierService = courierService;
  this.trackingUrl = trackingUrl;
  this.deliveryStatus = 'in_transit';
  
  this.updateDate = new Date();
  this.updateTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  
  return this.save();
};

// New helper to update in-house fleet details
orderDeliverySchema.methods.updateFleetInfo = function(partial) {
  const fields = [
    'driverName','driverPhone','driverLicenseNo','truckNumber','vehicleType','capacityTons',
    'startTime','estimatedArrival','deliveryNotes'
  ];
  for (const f of fields) {
    if (partial[f] !== undefined) this[f] = partial[f];
  }
  if (partial.lastLocation) {
    this.lastLocation = this.lastLocation || {};
    const locFields = ['lat','lng','address'];
    for (const lf of locFields) {
      if (partial.lastLocation[lf] !== undefined) this.lastLocation[lf] = partial.lastLocation[lf];
    }
  }
  if (partial.deliveryStatus) this.deliveryStatus = partial.deliveryStatus;
  this.updateDate = new Date();
  this.updateTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  return this.save();
};

// Static methods
orderDeliverySchema.statics.findByOrder = function(leadId) {
  return this.findOne({ leadId, isActive: true })
    .populate('userId', 'name email phone');
};

orderDeliverySchema.statics.findByTrackingNumber = function(trackingNumber) {
  return this.findOne({ trackingNumber, isActive: true })
    .populate('userId', 'name email phone');
};

orderDeliverySchema.statics.getDeliveriesByStatus = function(status, options = {}) {
  return this.find({ deliveryStatus: status, isActive: true })
    .populate('userId', 'name email phone')
    .sort({ updateDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderDeliverySchema.statics.getDeliveriesByDateRange = function(startDate, endDate, options = {}) {
  return this.find({
    deliveryExpectedDate: {
      $gte: startDate,
      $lte: endDate
    },
    isActive: true
  })
    .populate('userId', 'name email phone')
    .sort({ deliveryExpectedDate: 1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderDeliverySchema.statics.getPendingDeliveries = function(options = {}) {
  return this.find({
    deliveryStatus: { $in: ['pending', 'picked_up', 'in_transit', 'out_for_delivery'] },
    isActive: true
  })
    .populate('userId', 'name email phone')
    .sort({ deliveryExpectedDate: 1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

export default mongoose.model('OrderDelivery', orderDeliverySchema);
