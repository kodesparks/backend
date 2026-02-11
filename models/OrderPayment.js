import mongoose from 'mongoose';

const orderPaymentSchema = new mongoose.Schema({
  // Invoice Number - Primary Key
  invcNum: {
    type: String,
    ref: 'Order',
    required: true,
    unique: true
  },
  
  // Transaction ID
  transactionId: {
    type: String,
    required: true,
    unique: true,
    default: () => `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  },
  
  // Payment Information
  paymentType: {
    type: String,
    enum: ['credit_card', 'debit_card', 'upi', 'net_banking', 'wallet', 'cash_on_delivery', 'bank_transfer', 'manual_utr'],
    required: true
  },
  
  paymentStatus: {
    type: String,
    enum: ['pending', 'processing', 'successful', 'failed', 'cancelled', 'refunded', 'partially_refunded'],
    default: 'pending'
  },
  
  paymentMode: {
    type: String,
    enum: ['online', 'offline', 'cash_on_delivery'],
    required: true
  },
  
  // Payment Amounts
  orderAmount: {
    type: Number,
    required: true,
    min: 0
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  refundAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Payment Gateway Information (for future integration)
  gatewayName: {
    type: String,
    default: null
  },
  gatewayTransactionId: {
    type: String,
    default: null
  },
  gatewayResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // UTR Number (for bank transfers)
  utrNum: {
    type: String,
    default: null
  },

  // Account Number
  accNumber: {
    type: String,
    default: null
  },
  
  // Payment Details
  paymentMethod: {
    type: String,
    default: null
  },
  paymentReference: {
    type: String,
    default: null
  },
  
  // Payment Dates
  paymentDate: {
    type: Date,
    default: null
  },
  paymentTime: {
    type: String,
    default: null
  },
  
  // Refund Information
  refundDate: {
    type: Date,
    default: null
  },
  refundReason: {
    type: String,
    default: null
  },
  refundUTR: {
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
orderPaymentSchema.index({ invcNum: 1 });
orderPaymentSchema.index({ transactionId: 1 });
orderPaymentSchema.index({ paymentStatus: 1 });
orderPaymentSchema.index({ paymentDate: -1 });
orderPaymentSchema.index({ utrNum: 1 });
orderPaymentSchema.index({ gatewayTransactionId: 1 });

// Pre-save middleware
orderPaymentSchema.pre('save', function(next) {
  this.updateDate = new Date();
  this.updateTimestamp = new Date().toISOString();
  
  // Set payment date when status changes to successful
  if (this.isModified('paymentStatus') && this.paymentStatus === 'successful' && !this.paymentDate) {
    this.paymentDate = new Date();
    this.paymentTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  }
  
  // Set refund date when refund is processed
  if (this.isModified('refundAmount') && this.refundAmount > 0 && !this.refundDate) {
    this.refundDate = new Date();
  }
  
  next();
});

// Instance methods
orderPaymentSchema.methods.markAsSuccessful = function(gatewayTransactionId = null, utrNum = null) {
  this.paymentStatus = 'successful';
  this.paidAmount = this.orderAmount;
  this.paymentDate = new Date();
  this.paymentTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  
  if (gatewayTransactionId) {
    this.gatewayTransactionId = gatewayTransactionId;
  }
  
  if (utrNum) {
    this.utrNum = utrNum;
  }
  
  return this.save();
};

orderPaymentSchema.methods.markAsFailed = function(reason = null) {
  this.paymentStatus = 'failed';
  this.paidAmount = 0;
  
  if (reason) {
    this.gatewayResponse = { error: reason };
  }
  
  return this.save();
};

orderPaymentSchema.methods.processRefund = function(refundAmount, reason = null, refundUTR = null) {
  if (refundAmount > this.paidAmount) {
    throw new Error('Refund amount cannot exceed paid amount');
  }
  
  this.refundAmount = refundAmount;
  this.refundReason = reason;
  this.refundUTR = refundUTR;
  this.refundDate = new Date();
  
  if (refundAmount === this.paidAmount) {
    this.paymentStatus = 'refunded';
  } else {
    this.paymentStatus = 'partially_refunded';
  }
  
  return this.save();
};

orderPaymentSchema.methods.getPaymentSummary = function() {
  return {
    transactionId: this.transactionId,
    paymentType: this.paymentType,
    paymentStatus: this.paymentStatus,
    orderAmount: this.orderAmount,
    paidAmount: this.paidAmount,
    refundAmount: this.refundAmount,
    netAmount: this.paidAmount - this.refundAmount,
    paymentDate: this.paymentDate,
    utrNum: this.utrNum
  };
};

// Static methods
orderPaymentSchema.statics.findByInvoice = function(invcNum) {
  return this.findOne({ invcNum, isActive: true });
};

orderPaymentSchema.statics.findByTransactionId = function(transactionId) {
  return this.findOne({ transactionId, isActive: true });
};

orderPaymentSchema.statics.findByUTR = function(utrNum) {
  return this.findOne({ utrNum, isActive: true });
};

orderPaymentSchema.statics.getPaymentsByStatus = function(status, options = {}) {
  return this.find({ paymentStatus: status, isActive: true })
    .sort({ updateDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderPaymentSchema.statics.getPaymentsByDateRange = function(startDate, endDate, options = {}) {
  return this.find({
    paymentDate: {
      $gte: startDate,
      $lte: endDate
    },
    isActive: true
  })
    .sort({ paymentDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderPaymentSchema.statics.getSuccessfulPayments = function(options = {}) {
  return this.find({ paymentStatus: 'successful', isActive: true })
    .sort({ paymentDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderPaymentSchema.statics.getPendingPayments = function(options = {}) {
  return this.find({ paymentStatus: { $in: ['pending', 'processing'] }, isActive: true })
    .sort({ updateDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

orderPaymentSchema.statics.getRefundedPayments = function(options = {}) {
  return this.find({ 
    paymentStatus: { $in: ['refunded', 'partially_refunded'] }, 
    isActive: true 
  })
    .sort({ refundDate: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

export default mongoose.model('OrderPayment', orderPaymentSchema);
