import express from 'express';
import { body, param, query } from 'express-validator';
import {
  // Customer controllers
  addToCart,
  getCustomerOrders,
  getOrderDetails,
  updateOrder,
  removeFromCart,
  removeOrderFromCart,
  placeOrder,
  processPayment,
  getPaymentStatus,
  getOrderTracking,
  changeDeliveryAddress,
  changeDeliveryDate,
  getOrderChangeHistory
} from '../controllers/order/customer.js';

import {
  // Vendor controllers
  getVendorOrders,
  getVendorOrderDetails,
  acceptOrder,
  rejectOrder,
  updateDeliveryTracking,
  getVendorOrderStats,
  getPendingOrders,
  updateVendorOrderStatus
} from '../controllers/order/vendor.js';

import {
  // Admin controllers
  getAllOrders,
  getOrderDetails as getAdminOrderDetails,
  getOrderStats,
  getOrdersByDateRange,
  cancelOrder,
  getPaymentStats,
  getDeliveryStats,
  markPaymentDone,
  confirmOrder,
  updateOrderStatus,
  getPaymentDetails,
  getAllPayments,
  updateDelivery,
  getDeliveryDetails,
  markDelivered,
  getStatusHistory
} from '../controllers/order/admin.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/auth.js';

const router = express.Router();

// ==================== VALIDATION RULES ====================

const addToCartValidation = [
  body('itemCode')
    .isMongoId()
    .withMessage('Valid item code is required'),
  body('qty')
    .isInt({ min: 1 })
    .withMessage('Quantity must be a positive integer'),
  body('deliveryAddress')
    .optional()
    .isString()
    .withMessage('Delivery address must be a string'),
  body('deliveryPincode')
    .optional()
    .custom((value) => {
      if (value && !/^[1-9][0-9]{5}$/.test(value)) {
        throw new Error('Valid pincode is required');
      }
      return true;
    }),
  body('deliveryExpectedDate')
    .optional()
    .isISO8601()
    .withMessage('Valid delivery date is required'),
  body('custPhoneNum')
    .optional()
    .custom((value) => {
      if (value && !/^[6-9]\d{9}$/.test(value)) {
        throw new Error('Valid phone number is required');
      }
      return true;
    }),
  body('receiverMobileNum')
    .optional()
    .custom((value) => {
      if (value && !/^[6-9]\d{9}$/.test(value)) {
        throw new Error('Valid receiver mobile number is required');
      }
      return true;
    })
];

const updateOrderValidation = [
  body('deliveryAddress')
    .optional()
    .isString()
    .withMessage('Delivery address must be a string'),
  body('deliveryPincode')
    .optional()
    .matches(/^[1-9][0-9]{5}$/)
    .withMessage('Valid pincode is required'),
  body('deliveryExpectedDate')
    .optional()
    .isISO8601()
    .withMessage('Valid delivery date is required'),
  body('receiverMobileNum')
    .optional()
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Valid receiver mobile number is required')
];

const placeOrderValidation = [
  body('deliveryAddress')
    .isString()
    .withMessage('Delivery address is required'),
  body('deliveryPincode')
    .matches(/^[1-9][0-9]{5}$/)
    .withMessage('Valid pincode is required'),
  body('deliveryExpectedDate')
    .isISO8601()
    .withMessage('Valid delivery date is required'),
  body('receiverMobileNum')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Valid receiver mobile number is required')
];

const processPaymentValidation = [
  body('paymentType')
    .isIn(['credit_card', 'debit_card', 'upi', 'net_banking', 'wallet', 'cash_on_delivery', 'bank_transfer'])
    .withMessage('Valid payment type is required'),
  body('paymentMode')
    .isIn(['online', 'offline', 'cash_on_delivery'])
    .withMessage('Valid payment mode is required')
];

const updateDeliveryTrackingValidation = [
  body('trackingNumber')
    .optional()
    .isString()
    .withMessage('Tracking number must be a string'),
  body('courierService')
    .optional()
    .isString()
    .withMessage('Courier service must be a string'),
  body('trackingUrl')
    .optional()
    .isURL()
    .withMessage('Valid tracking URL is required'),
  body('deliveryStatus')
    .optional()
    .isIn(['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'])
    .withMessage('Valid delivery status is required'),
  body('deliveryNotes')
    .optional()
    .isString()
    .withMessage('Delivery notes must be a string')
];

const leadIdValidation = [
  param('leadId')
    .isString()
    .withMessage('Valid lead ID is required')
];

// ==================== CUSTOMER ROUTES ====================

// Add item to cart (Create order)
router.post('/cart/add', 
  authenticateToken,
  addToCartValidation,
  addToCart
);

// Get customer's orders/cart
router.get('/customer/orders',
  authenticateToken,
  [
    query('status')
      .optional()
      .isIn(['pending', 'order_placed', 'vendor_accepted', 'payment_done', 'order_confirmed', 'shipped', 'delivered', 'cancelled'])
      .withMessage('Valid status is required'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  getCustomerOrders
);

// Remove item from cart
router.delete('/customer/orders/:leadId/items',
  authenticateToken,
  leadIdValidation,
  [
    body('itemCode')
      .isMongoId()
      .withMessage('Valid item code is required')
  ],
  removeFromCart
);

// Remove entire order from cart
router.delete('/customer/orders/:leadId',
  authenticateToken,
  leadIdValidation,
  removeOrderFromCart
);

// Get single order details
router.get('/customer/orders/:leadId',
  authenticateToken,
  leadIdValidation,
  getOrderDetails
);

// Update order (delivery info, etc.)
router.put('/customer/orders/:leadId',
  authenticateToken,
  leadIdValidation,
  updateOrderValidation,
  updateOrder
);

// Place order (Move from cart to placed)
router.post('/customer/orders/:leadId/place',
  authenticateToken,
  leadIdValidation,
  placeOrderValidation,
  placeOrder
);

// Process payment
router.post('/customer/orders/:leadId/payment',
  authenticateToken,
  leadIdValidation,
  processPaymentValidation,
  processPayment
);

// Get payment status
router.get('/customer/orders/:leadId/payment',
  authenticateToken,
  leadIdValidation,
  getPaymentStatus
);

// Get order tracking (Customer)
router.get('/customer/orders/:leadId/tracking',
  authenticateToken,
  leadIdValidation,
  getOrderTracking
);

// Change delivery address (within same pincode, within 48 hours)
router.put('/customer/orders/:leadId/address',
  authenticateToken,
  leadIdValidation,
  [
    body('newAddress')
      .notEmpty()
      .withMessage('New address is required')
      .isLength({ min: 10, max: 500 })
      .withMessage('Address must be between 10 and 500 characters'),
    body('reason')
      .optional()
      .isLength({ max: 200 })
      .withMessage('Reason must be less than 200 characters')
  ],
  changeDeliveryAddress
);

// Change delivery date (within 48 hours)
router.put('/customer/orders/:leadId/delivery-date',
  authenticateToken,
  leadIdValidation,
  [
    body('newDeliveryDate')
      .notEmpty()
      .withMessage('New delivery date is required')
      .isISO8601()
      .withMessage('Invalid date format'),
    body('reason')
      .optional()
      .isLength({ max: 200 })
      .withMessage('Reason must be less than 200 characters')
  ],
  changeDeliveryDate
);

// Get order change history
router.get('/customer/orders/:leadId/change-history',
  authenticateToken,
  leadIdValidation,
  getOrderChangeHistory
);

// ==================== VENDOR ROUTES ====================

// Get vendor order statistics (Must be BEFORE /:leadId)
router.get('/vendor/orders/stats',
  authenticateToken,
  requireRole(['vendor']),
  getVendorOrderStats
);

// Get pending orders for vendor (Must be BEFORE /:leadId)
router.get('/vendor/orders/pending',
  authenticateToken,
  requireRole(['vendor']),
  [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  getPendingOrders
);

// Get vendor's orders
router.get('/vendor/orders',
  authenticateToken,
  requireRole(['vendor']),
  [
    query('status')
      .optional()
      .isIn(['pending', 'order_placed', 'vendor_accepted', 'payment_done', 'order_confirmed', 'shipped', 'delivered', 'cancelled'])
      .withMessage('Valid status is required'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  getVendorOrders
);

// Get single vendor order details (Must be AFTER specific routes)
router.get('/vendor/orders/:leadId',
  authenticateToken,
  requireRole(['vendor']),
  leadIdValidation,
  getVendorOrderDetails
);

// Accept order
router.post('/vendor/orders/:leadId/accept',
  authenticateToken,
  requireRole(['vendor']),
  leadIdValidation,
  [
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  acceptOrder
);

// Reject order
router.post('/vendor/orders/:leadId/reject',
  authenticateToken,
  requireRole(['vendor']),
  leadIdValidation,
  [
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  rejectOrder
);

// Update delivery tracking
router.put('/vendor/orders/:leadId/delivery',
  authenticateToken,
  requireRole(['vendor']),
  leadIdValidation,
  updateDeliveryTrackingValidation,
  updateDeliveryTracking
);

// Update order status (Vendor - for shipping statuses)
router.put('/vendor/orders/:leadId/status',
  authenticateToken,
  requireRole(['vendor']),
  leadIdValidation,
  [
    body('orderStatus')
      .isIn(['truck_loading', 'in_transit', 'shipped', 'out_for_delivery', 'delivered'])
      .withMessage('Valid order status is required. Vendors can update to: truck_loading, in_transit, shipped, out_for_delivery, delivered'),
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  updateVendorOrderStatus
);

// ==================== ADMIN ROUTES ====================

// Admin stats routes (Must be BEFORE dynamic routes)
router.get('/admin/orders/stats',
  authenticateToken,
  requireRole(['admin']),
  getOrderStats
);

router.get('/admin/payments/stats',
  authenticateToken,
  requireRole(['admin']),
  getPaymentStats
);

router.get('/admin/deliveries/stats',
  authenticateToken,
  requireRole(['admin']),
  getDeliveryStats
);

// Get orders by date range
router.get('/admin/orders/date-range',
  authenticateToken,
  requireRole(['admin']),
  [
    query('startDate')
      .isISO8601()
      .withMessage('Valid start date is required'),
    query('endDate')
      .isISO8601()
      .withMessage('Valid end date is required'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  getOrdersByDateRange
);

// Get all orders
router.get('/admin/orders',
  authenticateToken,
  requireRole(['admin']),
  [
    query('status')
      .optional()
      .isIn(['pending', 'order_placed', 'vendor_accepted', 'payment_done', 'order_confirmed', 'shipped', 'delivered', 'cancelled'])
      .withMessage('Valid status is required'),
    query('vendorId')
      .optional()
      .isMongoId()
      .withMessage('Valid vendor ID is required'),
    query('customerId')
      .optional()
      .isMongoId()
      .withMessage('Valid customer ID is required'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  getAllOrders
);

// Get all payments
router.get('/admin/payments',
  authenticateToken,
  requireRole(['admin']),
  [
    query('paymentStatus')
      .optional()
      .isIn(['pending', 'processing', 'successful', 'failed', 'cancelled', 'refunded', 'partially_refunded'])
      .withMessage('Valid payment status is required'),
    query('paymentMethod')
      .optional()
      .isString()
      .withMessage('Payment method must be a string'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  getAllPayments
);

// Get single order details (Admin)
router.get('/admin/orders/:leadId',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  getAdminOrderDetails
);

// Get order status history
router.get('/admin/orders/:leadId/status-history',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  getStatusHistory
);

// Get payment details for specific order
router.get('/admin/payments/:leadId',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  getPaymentDetails
);

// Get delivery details for specific order
router.get('/admin/deliveries/:leadId',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  getDeliveryDetails
);

// Mark payment as done (Manual payment confirmation)
router.post('/admin/orders/:leadId/payment',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  [
    body('paidAmount')
      .isFloat({ min: 0.01 })
      .withMessage('Valid paid amount is required'),
    body('paymentMethod')
      .optional()
      .isIn(['credit_card', 'debit_card', 'upi', 'net_banking', 'wallet', 'cash_on_delivery', 'bank_transfer'])
      .withMessage('Valid payment method is required'),
    body('transactionId')
      .optional()
      .isString()
      .withMessage('Transaction ID must be a string'),
    body('paymentDate')
      .optional()
      .isISO8601()
      .withMessage('Valid payment date is required'),
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  markPaymentDone
);

// Confirm order after payment
router.post('/admin/orders/:leadId/confirm',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  [
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  confirmOrder
);

// Update order status manually
router.put('/admin/orders/:leadId/status',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  [
    body('orderStatus')
      .isIn(['pending', 'vendor_accepted', 'payment_done', 'order_confirmed', 'truck_loading', 'in_transit', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'])
      .withMessage('Valid order status is required'),
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  updateOrderStatus
);

// Update delivery information
router.put('/admin/orders/:leadId/delivery',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  [
    body('deliveryStatus')
      .optional()
      .isIn(['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'])
      .withMessage('Valid delivery status is required'),
    body('trackingNumber')
      .optional()
      .isString()
      .withMessage('Tracking number must be a string'),
    body('courierService')
      .optional()
      .isString()
      .withMessage('Courier service must be a string'),
    body('expectedDeliveryDate')
      .optional()
      .isISO8601()
      .withMessage('Valid expected delivery date is required')
  ],
  updateDelivery
);

// Mark order as delivered
router.post('/admin/orders/:leadId/delivered',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  [
    body('deliveredDate')
      .optional()
      .isISO8601()
      .withMessage('Valid delivered date is required'),
    body('receivedBy')
      .optional()
      .isString()
      .withMessage('Received by must be a string'),
    body('remarks')
      .optional()
      .isString()
      .withMessage('Remarks must be a string')
  ],
  markDelivered
);

// Cancel order (Admin)
router.post('/admin/orders/:leadId/cancel',
  authenticateToken,
  requireRole(['admin']),
  leadIdValidation,
  [
    body('reason')
      .optional()
      .isString()
      .withMessage('Reason must be a string')
  ],
  cancelOrder
);

export default router;
