import mongoose from 'mongoose';

const orderStatusSchema = new mongoose.Schema({
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
  
  // Vendor ID (optional for Phase 1 when no vendor portal)
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },
  
  // Order Status
  orderStatus: {
    type: String,
    enum: ['pending', 'order_placed', 'vendor_accepted', 'payment_done', 'order_confirmed', 'truck_loading', 'in_transit', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
    required: true
  },
  
  // Status Details
  remarks: {
    type: String,
    default: null
  },
  
  // Status Change Information
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  changeReason: {
    type: String,
    default: null
  },
  
  // Timestamps
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
orderStatusSchema.index({ leadId: 1 });
orderStatusSchema.index({ invcNum: 1 });
orderStatusSchema.index({ vendorId: 1 });
orderStatusSchema.index({ orderStatus: 1 });
orderStatusSchema.index({ updateDate: -1 });

// Compound index for efficient queries
orderStatusSchema.index({ leadId: 1, updateDate: -1 });

// Pre-save middleware
orderStatusSchema.pre('save', function(next) {
  this.updateDate = new Date();
  this.updateTimestamp = new Date().toISOString();
  next();
});

// Instance methods
orderStatusSchema.methods.getStatusHistory = function() {
  return this.constructor.find({ leadId: this.leadId, isActive: true })
    .populate('changedBy', 'name email role')
    .sort({ updateDate: -1 });
};

// Static methods
orderStatusSchema.statics.createStatusUpdate = async function(leadId, invcNum, vendorId, newStatus, changedBy, remarks = null, changeReason = null) {
  const statusUpdate = new this({
    leadId,
    invcNum,
    vendorId,
    orderStatus: newStatus,
    changedBy,
    remarks,
    changeReason
  });
  
  return await statusUpdate.save();
};

orderStatusSchema.statics.getOrderStatusHistory = function(leadId) {
  return this.find({ leadId, isActive: true })
    .populate('changedBy', 'name email role')
    .populate('vendorId', 'name email')
    .sort({ updateDate: -1 });
};

orderStatusSchema.statics.getCurrentStatus = function(leadId) {
  return this.findOne({ leadId, isActive: true })
    .populate('changedBy', 'name email role')
    .populate('vendorId', 'name email')
    .sort({ updateDate: -1 });
};

orderStatusSchema.statics.getOrdersByStatus = function(status, options = {}) {
  return this.find({ orderStatus: status, isActive: true })
    .populate('changedBy', 'name email role')
    .populate('vendorId', 'name email')
    .sort({ updateDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderStatusSchema.statics.getVendorOrdersByStatus = function(vendorId, status, options = {}) {
  return this.find({ vendorId, orderStatus: status, isActive: true })
    .populate('changedBy', 'name email role')
    .sort({ updateDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

export default mongoose.model('OrderStatus', orderStatusSchema);
