import Order from '../../models/Order.js';
import OrderStatus from '../../models/OrderStatus.js';
import OrderDelivery from '../../models/OrderDelivery.js';
import OrderPayment from '../../models/OrderPayment.js';
import User from '../../models/User.js';
import mongoose from 'mongoose';
import zohoBooksService from '../../utils/zohoBooks.js';
import { sendOrderAcceptedEmail, sendQuoteReadyEmail, sendSalesOrderReadyEmail, sendInvoiceReadyEmail, sendPaymentReceiptEmail } from '../../utils/emailService.js';
import { getPublicQuotePdfUrl, getPublicSalesOrderPdfUrl, getPublicInvoicePdfUrl, getOrderNotificationContact, getPublicPaymentPdfUrl } from './customer.js';

// Get all orders (Admin)
export const getAllOrders = async (req, res) => {
  try {
    const { status, vendorId, customerId, page = 1, limit = 20 } = req.query;

    const options = {
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    let query = { isActive: true };
    if (status) {
      query.orderStatus = status;
    } else {
      query.orderStatus = { $ne: 'pending' };
    }
    if (vendorId) query.vendorId = vendorId;
    if (customerId) query.custUserId = customerId;

    const orders = await Order.find(query)
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('custUserId', 'name email phone')
      .populate('vendorId', 'name email phone')
      .populate('promoCode', 'promoName discountType discountValue')
      .sort({ orderDate: -1 })
      .limit(options.limit)
      .skip(options.skip);

    const totalOrders = await Order.countDocuments(query);

    res.status(200).json({
      message: 'All orders retrieved successfully',
      orders,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalOrders / parseInt(limit)),
        totalItems: totalOrders,
        hasNext: parseInt(page) < Math.ceil(totalOrders / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });

  } catch (error) {
    console.error('Get all orders error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get single order details (Admin)
export const getOrderDetails = async (req, res) => {
  try {
    const { leadId } = req.params;

    const order = await Order.findOne({
      leadId,
      isActive: true
    })
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('custUserId', 'name email phone')
      .populate('vendorId', 'name email phone')
      .populate('promoCode', 'promoName discountType discountValue');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Get order status history
    const statusHistory = await OrderStatus.getOrderStatusHistory(leadId);

    // Get delivery information
    const deliveryInfo = await OrderDelivery.findByOrder(leadId);

    // Get payment information
    const paymentInfo = await OrderPayment.findByInvoice(order.invcNum);

    const delivery = deliveryInfo ? {
      leadId: deliveryInfo.leadId,
      deliveryStatus: deliveryInfo.deliveryStatus,
      deliveryNotes: deliveryInfo.deliveryNotes,
      trackingNumber: deliveryInfo.trackingNumber,
      courierService: deliveryInfo.courierService,
      trackingUrl: deliveryInfo.trackingUrl,
      address: deliveryInfo.address,
      pincode: deliveryInfo.pincode,
      deliveryExpectedDate: deliveryInfo.deliveryExpectedDate,
      deliveryActualDate: deliveryInfo.deliveryActualDate,
      driverName: deliveryInfo.driverName,
      driverPhone: deliveryInfo.driverPhone,
      driverLicenseNo: deliveryInfo.driverLicenseNo,
      truckNumber: deliveryInfo.truckNumber,
      vehicleType: deliveryInfo.vehicleType,
      capacityTons: deliveryInfo.capacityTons,
      startTime: deliveryInfo.startTime,
      estimatedArrival: deliveryInfo.estimatedArrival,
      lastLocation: deliveryInfo.lastLocation
    } : null;

    res.status(200).json({
      message: 'Order details retrieved successfully',
      order,
      statusHistory,
      deliveryInfo: delivery,
      paymentInfo
    });

  } catch (error) {
    console.error('Get order details error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get order statistics (Admin)
export const getOrderStats = async (req, res) => {
  try {
    const stats = await Order.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$orderStatus',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ]);

    const totalOrders = await Order.countDocuments({ isActive: true });
    const totalRevenue = await Order.aggregate([
      { $match: { isActive: true, orderStatus: { $in: ['order_confirmed', 'shipped', 'delivered'] } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    // Get vendor-wise statistics
    const vendorStats = await Order.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$vendorId',
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' },
          completedOrders: {
            $sum: {
              $cond: [
                { $in: ['$orderStatus', ['delivered']] },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'vendor'
        }
      },
      {
        $unwind: '$vendor'
      },
      {
        $project: {
          vendorName: '$vendor.name',
          vendorEmail: '$vendor.email',
          totalOrders: 1,
          totalRevenue: 1,
          completedOrders: 1
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 }
    ]);

    // Get customer-wise statistics
    const customerStats = await Order.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$custUserId',
          totalOrders: { $sum: 1 },
          totalSpent: { $sum: '$totalAmount' }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'customer'
        }
      },
      {
        $unwind: '$customer'
      },
      {
        $project: {
          customerName: '$customer.name',
          customerEmail: '$customer.email',
          totalOrders: 1,
          totalSpent: 1
        }
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 }
    ]);

    res.status(200).json({
      message: 'Order statistics retrieved successfully',
      stats: {
        totalOrders: totalOrders || 0,
        totalRevenue: totalRevenue[0]?.total || 0,
        statusBreakdown: stats || [],
        topVendors: vendorStats || [],
        topCustomers: customerStats || []
      }
    });

  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get orders by date range (Admin)
export const getOrdersByDateRange = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 20 } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: 'Start date and end date are required'
      });
    }

    const options = {
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    const query = {
      isActive: true,
      orderDate: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      }
    };

    const orders = await Order.find(query)
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('custUserId', 'name email phone')
      .populate('vendorId', 'name email phone')
      .populate('promoCode', 'promoName discountType discountValue')
      .sort({ orderDate: -1 })
      .limit(options.limit)
      .skip(options.skip);

    const totalOrders = await Order.countDocuments(query);

    res.status(200).json({
      message: 'Orders by date range retrieved successfully',
      orders,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalOrders / parseInt(limit)),
        totalItems: totalOrders,
        hasNext: parseInt(page) < Math.ceil(totalOrders / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });

  } catch (error) {
    console.error('Get orders by date range error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Cancel order (Admin)
export const cancelOrder = async (req, res) => {
  try {
    const { leadId } = req.params;
    const adminId = req.user.userId;
    const { reason } = req.body || {};

    const order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    if (order.orderStatus === 'delivered') {
      return res.status(400).json({
        message: 'Cannot cancel delivered order'
      });
    }

    // Update order status
    await order.updateStatus('cancelled');

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'cancelled',
      adminId,
      reason?.reason || 'Order cancelled by admin'
    );

    res.status(200).json({
      message: 'Order cancelled successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus
      }
    });

  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get payment statistics (Admin)
export const getPaymentStats = async (req, res) => {
  try {
    const paymentStats = await OrderPayment.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$paymentStatus',
          count: { $sum: 1 },
          totalAmount: { $sum: '$orderAmount' }
        }
      }
    ]);

    const totalPayments = await OrderPayment.countDocuments({ isActive: true });
    const successfulPayments = await OrderPayment.countDocuments({ 
      isActive: true, 
      paymentStatus: 'successful' 
    });

    const totalRevenue = await OrderPayment.aggregate([
      { $match: { isActive: true, paymentStatus: 'successful' } },
      { $group: { _id: null, total: { $sum: '$orderAmount' } } }
    ]);

    res.status(200).json({
      message: 'Payment statistics retrieved successfully',
      stats: {
        totalPayments: totalPayments || 0,
        successfulPayments: successfulPayments || 0,
        totalRevenue: totalRevenue[0]?.total || 0,
        paymentStatusBreakdown: paymentStats || []
      }
    });

  } catch (error) {
    console.error('Get payment stats error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get delivery statistics (Admin)
export const getDeliveryStats = async (req, res) => {
  try {
    const deliveryStats = await OrderDelivery.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$deliveryStatus',
          count: { $sum: 1 }
        }
      }
    ]);

    const totalDeliveries = await OrderDelivery.countDocuments({ isActive: true });
    const completedDeliveries = await OrderDelivery.countDocuments({ 
      isActive: true, 
      deliveryStatus: 'delivered' 
    });

    const pendingDeliveries = await OrderDelivery.countDocuments({ 
      isActive: true, 
      deliveryStatus: { $in: ['pending', 'picked_up', 'in_transit', 'out_for_delivery'] }
    });

    res.status(200).json({
      message: 'Delivery statistics retrieved successfully',
      stats: {
        totalDeliveries: totalDeliveries || 0,
        completedDeliveries: completedDeliveries || 0,
        pendingDeliveries: pendingDeliveries || 0,
        deliveryStatusBreakdown: deliveryStats || []
      }
    });

  } catch (error) {
    console.error('Get delivery stats error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Mark payment as done (Admin - Manual payment confirmation)
export const markPaymentDone = async (req, res) => {
  try {
    const { leadId } = req.params;
    const adminId = req.user.userId;
    const { 
      paidAmount, 
      paymentMethod = 'bank_transfer', 
      transactionId, 
      paymentDate = new Date(),
      remarks 
    } = req.body;

    // Find the order
    const order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Check if order is in correct state
    if (order.orderStatus !== 'vendor_accepted') {
      return res.status(400).json({
        message: `Cannot mark payment for order in ${order.orderStatus} status. Order must be in vendor_accepted status.`
      });
    }

    // Validate paid amount
    if (!paidAmount || paidAmount <= 0) {
      return res.status(400).json({
        message: 'Valid paid amount is required'
      });
    }

    // Map paymentMethod to paymentType and paymentMode
    const paymentMapping = {
      'credit_card': { paymentType: 'credit_card', paymentMode: 'online' },
      'debit_card': { paymentType: 'debit_card', paymentMode: 'online' },
      'upi': { paymentType: 'upi', paymentMode: 'online' },
      'net_banking': { paymentType: 'net_banking', paymentMode: 'online' },
      'wallet': { paymentType: 'wallet', paymentMode: 'online' },
      'cash_on_delivery': { paymentType: 'cash_on_delivery', paymentMode: 'cash_on_delivery' },
      'bank_transfer': { paymentType: 'bank_transfer', paymentMode: 'offline' }
    };

    const paymentInfo = paymentMapping[paymentMethod] || { 
      paymentType: 'bank_transfer', 
      paymentMode: 'offline' 
    };

    // Create or update payment record
    let payment = await OrderPayment.findOne({ invcNum: order.invcNum });
    const customer = await User.findById(order.custUserId);
    if (payment) {
      // Update existing payment
      payment.paidAmount = paidAmount;
      payment.paymentStatus = 'successful';
      payment.paymentType = paymentInfo.paymentType;
      payment.paymentMode = paymentInfo.paymentMode;
      payment.paymentMethod = paymentMethod;
      if (transactionId) {
        payment.transactionId = transactionId;
        payment.utrNum = transactionId; // Store as UTR for bank transfers
      }
      payment.paymentDate = paymentDate;
      payment.refNum = order.leadId || '';

      const createPayReciept = await zohoBooksService.createPaymentReceipt(payment, customer);

      await payment.save();
      if (createPayReciept?.payment_id) {
        order.zohoPaymentId = createPayReciept.payment_id;
        await order.save();
        console.log(`✅ Zoho Payment created: ${createPayReciept.payment_id} for order ${order.leadId}`);
        if (customer?.zohoCustomerId) {
          await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => { });
        }
        // await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch((err) => {
        //   console.warn(`⚠️ Invoice email (Zoho) failed for order ${currentOrder.leadId}:`, err?.message || err);
        // });
        const notifInv = getOrderNotificationContact(order, customer);
        if (notifInv.email) {
          const pdfUrl = await getPublicPaymentPdfUrl(order.leadId);
          await sendPaymentReceiptEmail(notifInv.email, notifInv.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => { });
        }
      }
    } else {
      // Create new payment record
      const paymentData = {
        invcNum: order.invcNum,
        paymentType: paymentInfo.paymentType,
        paymentMode: paymentInfo.paymentMode,
        paymentStatus: 'successful',
        orderAmount: order.totalAmount,
        paidAmount: paidAmount,
        paymentMethod: paymentMethod,
        paymentDate: paymentDate,
        refNum: order.leadId || ''
      };

      // Add transactionId if provided, otherwise let default generate
      if (transactionId) {
        paymentData.transactionId = transactionId;
        paymentData.utrNum = transactionId; // Store as UTR for bank transfers
      }

      payment = await OrderPayment.create(paymentData);
      const createPayReciept = await zohoBooksService.createPaymentReceipt(payment, customer);
      await payment.save();
      if (createPayReciept?.payment_id) {
        order.zohoPaymentId = createPayReciept.payment_id;
        await order.save();
        console.log(`✅ Zoho Payment created: ${createPayReciept.payment_id} for order ${order.leadId}`);
        if (customer?.zohoCustomerId) {
          await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => { });
        }
        const notifInv = getOrderNotificationContact(order, customer);
        if (notifInv.email) {
          const pdfUrl = await getPublicPaymentPdfUrl(order.leadId);
          await sendPaymentReceiptEmail(notifInv.email, notifInv.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => { });
        }
      }
    }
    // Update order status to payment_done
    await order.updateStatus('payment_done');

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'payment_done',
      adminId,
      remarks || `Payment of ₹${paidAmount} received via ${paymentMethod}${transactionId ? ` (Transaction ID: ${transactionId})` : ''}`
    );

    // When payment_done: ensure Quote exists and was emailed, then create Sales Order (Zoho SO) and email it
    if (!order.zohoSalesOrderId) {
      (async () => {
        try {
          const vendor = order.vendorId ? await User.findById(order.vendorId) : null;
          const customer = await User.findById(order.custUserId);
          let currentOrder = await Order.findById(order._id);

          // If no Quote yet, create it and send quote-ready email first
          if (!currentOrder.zohoQuoteId && customer) {
            try {
              const populatedForQuote = await Order.findById(order._id)
                .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
              const zohoQuote = await zohoBooksService.createQuote(populatedForQuote, customer);
              if (zohoQuote?.estimate_id) {
                await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
                currentOrder = await Order.findById(order._id);
                console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId} (before SO)`);
                if (customer.zohoCustomerId) {
                  await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, currentOrder, customer).catch(() => {});
                }
                await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => {});
                const notifQuote = getOrderNotificationContact(currentOrder, customer);
                if (notifQuote.email) {
                  const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
                  await sendQuoteReadyEmail(notifQuote.email, notifQuote.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
                  console.log(`✅ Quote-ready email (with PDF) sent for order ${order.leadId}`);
                }
              }
            } catch (quoteErr) {
              console.warn(`⚠️ Quote creation before SO failed for ${order.leadId}:`, quoteErr?.message || quoteErr);
            }
          }

          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
          const zohoSO = await zohoBooksService.createSalesOrder(populatedOrder, vendor, customer);
          if (zohoSO?.salesorder_id) {
            await Order.updateOne({ _id: order._id }, { $set: { zohoSalesOrderId: zohoSO.salesorder_id } });
            console.log(`✅ Zoho Sales Order created: ${zohoSO.salesorder_id} for order ${order.leadId}`);
            if (customer?.zohoCustomerId) {
              await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
            }
            await zohoBooksService.emailSalesOrder(zohoSO.salesorder_id).catch(() => {});
            const notif = getOrderNotificationContact(order, customer);
            if (notif.email) {
              const pdfUrl = await getPublicSalesOrderPdfUrl(order.leadId);
              await sendSalesOrderReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
            }
          }
        } catch (error) {
          console.error(`❌ Failed to create Zoho Sales Order for order ${order.leadId}:`, error.message);
        }
      })();
    }

    // Invoice is created in Zoho only at delivery status (in_transit/out_for_delivery), not at payment_done.

    res.status(200).json({
      message: 'Payment marked as done successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        totalAmount: order.totalAmount
      },
      payment: {
        transactionId: payment.transactionId,
        paidAmount: payment.paidAmount,
        paymentStatus: payment.paymentStatus,
        paymentType: payment.paymentType,
        paymentMode: payment.paymentMode,
        paymentDate: payment.paymentDate
      }
    });

  } catch (error) {
    console.error('Mark payment done error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Confirm order after payment (Admin)
export const confirmOrder = async (req, res) => {
  try {
    const { leadId } = req.params;
    const adminId = req.user.userId;
    const { remarks = '', items
      ,vendorId,
      vendorPhone,
      vendorEmail,
      gstNumber
     } = req.body || {};

    // Find the order
    const order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Check if order is in correct state
    if (order.orderStatus !== 'payment_done') {
      return res.status(400).json({
        message: `Cannot confirm order in ${order.orderStatus} status. Payment must be completed first.`
      });
    }

    for (const updatedItem of items) {
        const orderItem = order.items.find(
          i => i.itemCode.toString() === updatedItem.itemCode
        );
        if (!orderItem) {
          return res.status(400).json({
            message: `Invalid itemCode: ${updatedItem.itemCode}`
          });
        }
        const unitPrice = Number(updatedItem.vendorUnitPrice);
        const loadingCharges = Number(updatedItem.vendorLoadingCharges || 0);

        if (!unitPrice || isNaN(unitPrice) || unitPrice <= 0) {
          return res.status(400).json({
            message: 'Valid unit price required for all items'
          });
        }

        if (isNaN(loadingCharges) || loadingCharges < 0) {
          return res.status(400).json({
            message: 'Valid loading charges required'
          });
        }

        orderItem.vendorUnitPrice = unitPrice;
        orderItem.vendorLoadingCharges = loadingCharges;

        orderItem.vendorTotalCost =
          (orderItem.qty * unitPrice) + loadingCharges;
      }


      // Create PO in Zoho as soon as order is confirmed – then send PO email (so customer gets it without downloading PDF)
          if (!order.zohoPurchaseOrderId) {
            try {
              const populatedOrder = await Order.findById(order._id)
                .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
              const zohoQuote = await zohoBooksService.createPurchaseOrder(populatedOrder, {vendorEmail, vendorId, vendorEmail, vendorName, gstNumber});
              if (zohoQuote?.estimate_id) {
                await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
                console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId} (at vendor_accepted)`);
                if (customer.zohoCustomerId) {
                  await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
                }
                await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => {});
                const notif = getOrderNotificationContact(order, customer);
                if (notif.email) {
                  const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
                  await sendQuoteReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
                  console.log(`✅ Quote-ready email (with PDF) sent to order email for ${order.leadId}`);
                }
              }
            } catch (quoteErr) {
              console.warn(`⚠️ Quote creation at vendor_accepted failed for ${order.leadId}:`, quoteErr?.message || quoteErr);
            }
          }
    // Update order status to order_confirmed
    await order.updateStatus('order_confirmed');

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'order_confirmed',
      adminId,
      remarks || 'Order confirmed by admin, ready for dispatch'
    );

    res.status(200).json({
      message: 'Order confirmed successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        totalAmount: order.totalAmount
      }
    });

  } catch (error) {
    console.error('Confirm order error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Update order status manually (Admin override). Optional: pass truck details in same request.
export const updateOrderStatus = async (req, res) => {
  try {
    const { leadId } = req.params;
    const adminId = req.user.userId;
    const {
      orderStatus,
      remarks = '',
      driverName,
      driverPhone,
      driverLicenseNo,
      truckNumber,
      vehicleType,
      capacityTons,
      deliveryNotes,
      items,
      deliveryAddress,
      deliveryState,
      deliveryPincode,
      email,
      receiverMobileNum,
      receiverName
    } = req.body || {};

    if (!orderStatus) {
      return res.status(400).json({
        message: 'Order status is required'
      });
    }

    const validStatuses = [
      'pending', 'vendor_accepted', 'payment_done', 'order_confirmed',
      'truck_loading', 'in_transit', 'shipped', 'out_for_delivery',
      'delivered', 'cancelled'
    ];

    if (!validStatuses.includes(orderStatus)) {
      return res.status(400).json({
        message: `Invalid order status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Find the order
    const order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    if (orderStatus === 'vendor_accepted') {
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          message: 'Items with pricing are required'
        });
      }
    }
    // Store previous status before updating
    const previousStatus = order.orderStatus;

    // Update order status
    await order.updateStatus(orderStatus);

    //update admin pricing
    if (orderStatus === 'vendor_accepted') {
      for (const updatedItem of items) {
        const orderItem = order.items.find(
          i => i.itemCode.toString() === updatedItem.itemCode
        );
        if (!orderItem) {
          return res.status(400).json({
            message: `Invalid itemCode: ${updatedItem.itemCode}`
          });
        }
        const unitPrice = Number(updatedItem.unitPrice);
        const loadingCharges = Number(updatedItem.loadingCharges || 0);

        if (!unitPrice || isNaN(unitPrice) || unitPrice <= 0) {
          return res.status(400).json({
            message: 'Valid unit price required for all items'
          });
        }

        if (isNaN(loadingCharges) || loadingCharges < 0) {
          return res.status(400).json({
            message: 'Valid loading charges required'
          });
        }

        orderItem.unitPrice = unitPrice;
        orderItem.loadingCharges = loadingCharges;

        orderItem.totalCost =
          (orderItem.qty * unitPrice) + loadingCharges;
      }

      // Recalculate totals
      order.totalQty = order.items.reduce(
        (sum, item) => sum + item.qty,
        0
      );

      const itemsTotal = order.items.reduce(
        (sum, item) => sum + item.totalCost,
        0
      );

      order.totalAmount = itemsTotal;
      //Shipping details from admin
      const addressTrimmed = (deliveryAddress != null && String(deliveryAddress).trim()) ? String(deliveryAddress).trim() : '';
      if (!addressTrimmed) {
        return res.status(400).json({
          message: 'Delivery address is required'
        });
      }
      order.deliveryAddress = addressTrimmed;
      order.deliveryPincode = deliveryPincode != null ? String(deliveryPincode).trim() : order.deliveryPincode;
      if (deliveryState != null && String(deliveryState).trim()) order.deliveryState = String(deliveryState).trim();
      order.receiverMobileNum = receiverMobileNum;
      order.orderEmail = (email && String(email).trim()) || order.orderEmail;
      order.orderReceiverName = (receiverName && String(receiverName).trim()) || order.orderReceiverName;
          
    }

      await order.save();
    
    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      orderStatus,
      adminId,
      remarks || `Order status updated to ${orderStatus} by admin`
    );

    // If admin sent truck details, save to delivery record (same as vendor flow)
    const hasTruckDetails = [driverName, driverPhone, driverLicenseNo, truckNumber, vehicleType, capacityTons, deliveryNotes].some(
      (v) => v !== undefined && v !== null && String(v).trim() !== ''
    );
    if (hasTruckDetails) {
      let delivery = await OrderDelivery.findByOrder(leadId);
      if (!delivery) {
        delivery = await OrderDelivery.create({
          leadId,
          invcNum: order.invcNum,
          userId: order.custUserId,
          address: order.deliveryAddress || 'Address to be updated',
          pincode: order.deliveryPincode || '000000',
          deliveryExpectedDate: order.deliveryExpectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          deliveryStatus: 'pending'
        });
      }
      await delivery.updateFleetInfo({
        driverName: driverName || undefined,
        driverPhone: driverPhone || undefined,
        driverLicenseNo: driverLicenseNo || undefined,
        truckNumber: truckNumber || undefined,
        vehicleType: vehicleType || undefined,
        capacityTons: capacityTons != null ? Number(capacityTons) : undefined,
        deliveryNotes: deliveryNotes || undefined
      });
    }

    // When order is ACCEPTED (vendor_accepted): create Quote in Zoho, send quote email to order email, then order-accepted email
    if (orderStatus === 'vendor_accepted') {
      (async () => {
        try {
          const customer = await User.findById(order.custUserId);
          // if (customer?.email) {
          //   await sendOrderAcceptedEmail(
          //     getOrderNotificationContact(order, customer).email || customer.email,
          //     getOrderNotificationContact(order, customer).name || customer.name || 'Customer',
          //     { leadId: order.leadId, formattedLeadId: order.formattedLeadId }
          //   ).catch(() => {});
          // }
          // Create Quote in Zoho as soon as order is accepted – then send quote email (so customer gets it without downloading PDF)
          if (!order.zohoQuoteId && customer) {
            try {
              const populatedOrder = await Order.findById(order._id)
                .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
              const zohoQuote = await zohoBooksService.createQuote(populatedOrder, customer);
              if (zohoQuote?.estimate_id) {
                await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
                console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId} (at vendor_accepted)`);
                if (customer.zohoCustomerId) {
                  await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
                }
                await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => {});
                const notif = getOrderNotificationContact(order, customer);
                if (notif.email) {
                  const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
                  await sendQuoteReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
                  console.log(`✅ Quote-ready email (with PDF) sent to order email for ${order.leadId}`);
                }
              }
            } catch (quoteErr) {
              console.warn(`⚠️ Quote creation at vendor_accepted failed for ${order.leadId}:`, quoteErr?.message || quoteErr);
            }
          }
        } catch (err) {
          console.warn('⚠️ Order-accepted email failed:', err?.message || err);
        }
      })();
    }

    // When order is CONFIRMED (order_confirmed): create Quote (Zoho estimate) and email it
    if (orderStatus === 'order_confirmed' && !order.zohoQuoteId) {
      console.log(`📋 Order status set to order_confirmed – creating Zoho Quote for ${order.leadId}`);
      (async () => {
        try {
          const customer = await User.findById(order.custUserId);
          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
          if (!customer) return;
          const zohoQuote = await zohoBooksService.createQuote(populatedOrder, customer);
          if (zohoQuote?.estimate_id) {
            await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
            console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId}`);
            if (customer.zohoCustomerId) {
              await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
            }
            await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch((err) => {
              console.warn(`⚠️ Quote email (Zoho) failed for order ${order.leadId}:`, err?.message || err);
            });
            const notif = getOrderNotificationContact(order, customer);
            if (notif.email) {
              const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
              await sendQuoteReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
            }
          }
        } catch (error) {
          console.error(`❌ Failed to create Zoho Quote for order ${order.leadId}:`, error.message);
        }
      })();
    }

    // When PAYMENT DONE (payment_done): ensure Quote exists and was emailed, then create Sales Order (Zoho SO) and email it
    if (orderStatus === 'payment_done' && !order.zohoSalesOrderId) {
      (async () => {
        try {
          const vendor = order.vendorId ? await User.findById(order.vendorId) : null;
          const customer = await User.findById(order.custUserId);
          let currentOrder = await Order.findById(order._id);

          // If no Quote yet, create it and send quote-ready email first (so customer always gets quote with PDF)
          if (!currentOrder.zohoQuoteId && customer) {
            try {
              const populatedForQuote = await Order.findById(order._id)
                .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
              const zohoQuote = await zohoBooksService.createQuote(populatedForQuote, customer);
              if (zohoQuote?.estimate_id) {
                await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
                currentOrder = await Order.findById(order._id);
                console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId} (before SO)`);
                if (customer.zohoCustomerId) {
                  await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, currentOrder, customer).catch(() => {});
                }
                await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => {});
                const notifQuote = getOrderNotificationContact(currentOrder, customer);
                if (notifQuote.email) {
                  const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
                  await sendQuoteReadyEmail(notifQuote.email, notifQuote.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
                  console.log(`✅ Quote-ready email (with PDF) sent for order ${order.leadId}`);
                }
              }
            } catch (quoteErr) {
              console.warn(`⚠️ Quote creation before SO failed for ${order.leadId}:`, quoteErr?.message || quoteErr);
            }
          }

          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
          const zohoSO = await zohoBooksService.createSalesOrder(populatedOrder, vendor, customer);
          if (zohoSO?.salesorder_id) {
            await Order.updateOne({ _id: order._id }, { $set: { zohoSalesOrderId: zohoSO.salesorder_id } });
            console.log(`✅ Zoho Sales Order created: ${zohoSO.salesorder_id} for order ${order.leadId}`);
            if (customer?.zohoCustomerId) {
              await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
            }
            await zohoBooksService.emailSalesOrder(zohoSO.salesorder_id).catch(() => {});
            const notifSO = getOrderNotificationContact(order, customer);
            if (notifSO.email) {
              const pdfUrl = await getPublicSalesOrderPdfUrl(order.leadId);
              await sendSalesOrderReadyEmail(notifSO.email, notifSO.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
            }
          }
        } catch (error) {
          console.error(`❌ Failed to create Zoho Sales Order for order ${order.leadId}:`, error.message);
        }
      })();
    }

    // Create Invoice in Zoho when order status is in_transit or out_for_delivery (if not already created)
    if ((orderStatus === 'in_transit' || orderStatus === 'out_for_delivery') && !order.zohoInvoiceId) {
      (async () => {
        try {
          const currentOrder = await Order.findById(order._id);
          if (!currentOrder || currentOrder.zohoInvoiceId) return;
          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
          const payment = await OrderPayment.findByInvoice(currentOrder.invcNum);
          const vendor = currentOrder.vendorId ? await User.findById(currentOrder.vendorId) : null;
          const customer = await User.findById(currentOrder.custUserId);
          const zohoInvoice = await zohoBooksService.createInvoice(populatedOrder, payment, vendor, customer);
          if (zohoInvoice?.invoice_id) {
            currentOrder.zohoInvoiceId = zohoInvoice.invoice_id;
            await currentOrder.save();
            console.log(`✅ Zoho Invoice created: ${zohoInvoice.invoice_id} for order ${currentOrder.leadId}`);
            if (customer?.zohoCustomerId) {
              await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, currentOrder, customer).catch(() => {});
            }
            await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch((err) => {
              console.warn(`⚠️ Invoice email (Zoho) failed for order ${currentOrder.leadId}:`, err?.message || err);
            });
            const notifInv = getOrderNotificationContact(currentOrder, customer);
            if (notifInv.email) {
              const pdfUrl = await getPublicInvoicePdfUrl(currentOrder.leadId);
              await sendInvoiceReadyEmail(notifInv.email, notifInv.name, currentOrder.leadId, currentOrder.formattedLeadId, pdfUrl).catch(() => {});
            }
          }
        } catch (err) {
          console.error(`❌ Zoho Invoice for order ${order.leadId}:`, err.message);
        }
      })();
    }

    // Include delivery (truck) info in response when present
    let deliveryInfo = null;
    const deliveryRecord = await OrderDelivery.findByOrder(leadId);
    if (deliveryRecord) {
      deliveryInfo = {
        deliveryStatus: deliveryRecord.deliveryStatus,
        driverName: deliveryRecord.driverName,
        driverPhone: deliveryRecord.driverPhone,
        driverLicenseNo: deliveryRecord.driverLicenseNo,
        truckNumber: deliveryRecord.truckNumber,
        vehicleType: deliveryRecord.vehicleType,
        capacityTons: deliveryRecord.capacityTons,
        deliveryNotes: deliveryRecord.deliveryNotes
      };
    }

    res.status(200).json({
      message: 'Order status updated successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        totalAmount: order.totalAmount
      },
      deliveryInfo
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get payment details for specific order (Admin)
export const getPaymentDetails = async (req, res) => {
  try {
    const { leadId } = req.params;

    const order = await Order.findOne({ leadId, isActive: true });
    
    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    const payment = await OrderPayment.findByInvoice(order.invcNum);

    if (!payment) {
      return res.status(404).json({
        message: 'Payment details not found'
      });
    }

    res.status(200).json({
      message: 'Payment details retrieved successfully',
      payment
    });

  } catch (error) {
    console.error('Get payment details error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get all payments (Admin)
export const getAllPayments = async (req, res) => {
  try {
    const { paymentStatus, paymentMethod, page = 1, limit = 20 } = req.query;

    const options = {
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    let query = { isActive: true };
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (paymentMethod) query.paymentMethod = paymentMethod;

    const payments = await OrderPayment.find(query)
      .populate('custUserId', 'name email phone')
      .populate('vendorId', 'name email phone')
      .sort({ paymentDate: -1 })
      .limit(options.limit)
      .skip(options.skip);

    const totalPayments = await OrderPayment.countDocuments(query);

    res.status(200).json({
      message: 'Payments retrieved successfully',
      payments,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalPayments / parseInt(limit)),
        totalItems: totalPayments,
        hasNext: parseInt(page) < Math.ceil(totalPayments / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });

  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Update delivery information (Admin)
export const updateDelivery = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { 
      deliveryStatus,
      trackingNumber,
      courierService,
      expectedDeliveryDate,
      remarks,
      // new fleet fields
      driverName, driverPhone, driverLicenseNo, truckNumber, vehicleType,
      capacityTons, startTime, estimatedArrival, lastLocation, deliveryNotes
    } = req.body;

    const order = await Order.findOne({ leadId, isActive: true });
    
    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    let delivery = await OrderDelivery.findByOrder(leadId);

    if (!delivery) {
      // Create new delivery record (userId required by schema – use customer for order link)
      delivery = await OrderDelivery.create({
        leadId,
        // ✅ Receiver Data (priority → request → fallback order)
        // receiverName: receiverName || order.customerName,
        // receiverPhone: receiverPhone || order.customerPhone,
        // receiverEmail: receiverEmail || order.customerEmail,
        // address: receiverAddress || order.deliveryAddress || 'Address to be updated',
        
        invcNum: order.invcNum,
        userId: order.custUserId,
        address: order.deliveryAddress || 'Address to be updated',
        pincode: order.deliveryPincode || '000000',
        deliveryExpectedDate: order.deliveryExpectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        deliveryStatus: deliveryStatus || 'pending',
        trackingNumber: trackingNumber || undefined,
        courierService: courierService || undefined,
        driverName, driverPhone, driverLicenseNo, truckNumber, vehicleType,
        capacityTons, startTime, estimatedArrival,
        lastLocation: lastLocation || undefined,
        deliveryNotes
      });
    } else {
      // Update existing delivery
      if (trackingNumber || courierService || expectedDeliveryDate) {
        if (trackingNumber) delivery.trackingNumber = trackingNumber;
        if (courierService) delivery.courierService = courierService;
        if (expectedDeliveryDate) delivery.expectedDeliveryDate = expectedDeliveryDate;
      }
      await delivery.updateFleetInfo({
        driverName, driverPhone, driverLicenseNo, truckNumber, vehicleType,
        capacityTons, startTime, estimatedArrival, lastLocation, deliveryStatus, deliveryNotes
      });
    }

    res.status(200).json({
      message: 'Delivery information updated successfully',
      delivery
    });

  } catch (error) {
    console.error('Update delivery error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get delivery details for specific order (Admin)
export const getDeliveryDetails = async (req, res) => {
  try {
    const { leadId } = req.params;

    const delivery = await OrderDelivery.findByOrder(leadId);

    if (!delivery) {
      return res.status(404).json({
        message: 'Delivery details not found'
      });
    }

    res.status(200).json({
      message: 'Delivery details retrieved successfully',
      delivery
    });

  } catch (error) {
    console.error('Get delivery details error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Mark order as delivered (Admin)
export const markDelivered = async (req, res) => {
  try {
    const { leadId } = req.params;
    const adminId = req.user.userId;
    const { deliveredDate = new Date(), receivedBy = '', remarks = '' } = req.body || {};

    const order = await Order.findOne({ leadId, isActive: true });
    
    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Update order status to delivered
    await order.updateStatus('delivered');

    // Update delivery record
    let delivery = await OrderDelivery.findByOrder(leadId);
    if (delivery) {
      delivery.deliveryStatus = 'delivered';
      delivery.deliveredDate = deliveredDate;
      if (receivedBy) delivery.receivedBy = receivedBy;
      await delivery.save();
    }

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'delivered',
      adminId,
      remarks || `Order delivered successfully${receivedBy ? `, received by ${receivedBy}` : ''}`
    );

    res.status(200).json({
      message: 'Order marked as delivered successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus
      },
      delivery: {
        deliveryStatus: delivery?.deliveryStatus,
        deliveredDate: delivery?.deliveredDate
      }
    });

  } catch (error) {
    console.error('Mark delivered error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Download Purchase Order PDF (Admin)
export const downloadPurchaseOrderPDF = async (req, res) => {
  try {
    const { leadId } = req.params;

    const order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!order.zohoPurchaseOrderId) {
      return res.status(404).json({ message: 'Purchase Order not found in Zoho Books' });
    }

    const pdfBuffer = await zohoBooksService.getPurchaseOrderPDF(order.zohoPurchaseOrderId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download PO PDF error:', error);
    res.status(500).json({
      message: 'Failed to download Purchase Order PDF',
      error: error.message
    });
  }
};

// Download Sales Order PDF (Admin)
export const downloadSalesOrderPDF = async (req, res) => {
  try {
    const { leadId } = req.params;

    const order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!order.zohoSalesOrderId) {
      return res.status(404).json({ message: 'Sales Order not found in Zoho Books' });
    }

    const pdfBuffer = await zohoBooksService.getSalesOrderPDF(order.zohoSalesOrderId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="SO-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download SO PDF error:', error);
    res.status(500).json({
      message: 'Failed to download Sales Order PDF',
      error: error.message
    });
  }
};

// Download Quote PDF (Admin) – creates Quote in Zoho on-demand if missing (when order is accepted/confirmed)
export const downloadQuotePDF = async (req, res) => {
  try {
    const { leadId } = req.params;

    let order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Create Quote on-demand if missing (when order is accepted or confirmed)
    const quoteEligibleStatuses = ['vendor_accepted', 'order_confirmed', 'payment_done', 'truck_loading', 'in_transit', 'shipped', 'out_for_delivery', 'delivered'];
    if (!order.zohoQuoteId && quoteEligibleStatuses.includes(order.orderStatus)) {
      const customer = await User.findById(order.custUserId);
      const populatedOrder = await Order.findById(order._id)
        .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
      if (customer) {
        try {
          const zohoQuote = await zohoBooksService.createQuote(populatedOrder, customer);
          if (zohoQuote?.estimate_id) {
            await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
            order.zohoQuoteId = zohoQuote.estimate_id;
            if (customer.zohoCustomerId) {
              await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
            }
            await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => false);
            const notif = getOrderNotificationContact(order, customer);
            if (notif.email) {
              const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
              await sendQuoteReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId || order.leadId, pdfUrl).catch(() => {});
            }
            console.log(`✅ Quote created on-demand for order ${order.leadId} (admin PDF request)`);
          }
        } catch (err) {
          console.error('Download Quote PDF – create on-demand failed:', err.message);
          return res.status(503).json({
            message: 'Quote could not be generated right now. Please try again in a moment.',
            error: err.message
          });
        }
      }
    }

    if (!order.zohoQuoteId) {
      return res.status(404).json({
        message: 'Quote is not available yet. It is generated when the order is confirmed (status: vendor_accepted or order_confirmed).'
      });
    }

    const pdfBuffer = await zohoBooksService.getQuotePDF(order.zohoQuoteId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quote-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download Quote PDF error:', error);
    res.status(500).json({
      message: 'Failed to download Quote PDF',
      error: error.message
    });
  }
};

// Download Invoice PDF (Admin)
export const downloadInvoicePDF = async (req, res) => {
  try {
    const { leadId } = req.params;

    let order = await Order.findOne({
      leadId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Create Invoice on-demand if missing (when order is in_transit or out_for_delivery)
    const invoiceEligibleStatuses = ['in_transit', 'shipped', 'out_for_delivery', 'delivered'];
    if (!order.zohoInvoiceId && invoiceEligibleStatuses.includes(order.orderStatus)) {
      const customer = await User.findById(order.custUserId);
      const populatedOrder = await Order.findById(order._id)
        .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
      let payment = await OrderPayment.findByInvoice(order.invcNum);
      if (!payment) {
        payment = await OrderPayment.create({
          invcNum: order.invcNum,
          orderAmount: order.totalAmount,
          paidAmount: order.totalAmount,
          paymentType: 'bank_transfer',
          paymentMode: 'offline',
          paymentStatus: 'successful',
          transactionId: `INV-${Date.now()}`
        });
      }
      const vendor = order.vendorId ? await User.findById(order.vendorId) : null;
      if (customer) {
        try {
          const zohoInvoice = await zohoBooksService.createInvoice(populatedOrder, payment, vendor, customer);
          if (zohoInvoice?.invoice_id) {
            await Order.updateOne({ _id: order._id }, { $set: { zohoInvoiceId: zohoInvoice.invoice_id } });
            order.zohoInvoiceId = zohoInvoice.invoice_id;
            if (customer.zohoCustomerId) {
              await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
            }
            await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch(() => {});
            const notif = getOrderNotificationContact(order, customer);
            if (notif.email) {
              const pdfUrl = await getPublicInvoicePdfUrl(order.leadId);
              await sendInvoiceReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId || order.leadId, pdfUrl).catch(() => {});
            }
            console.log(`✅ Invoice created on-demand for order ${order.leadId} (admin PDF request)`);
          }
        } catch (err) {
          console.error('Download Invoice PDF – create on-demand failed:', err.message);
          return res.status(503).json({
            message: 'Invoice could not be generated right now. Please try again in a moment.',
            error: err.message
          });
        }
      }
    }

    if (!order.zohoInvoiceId) {
      return res.status(404).json({
        message: 'Invoice not found in Zoho Books. It is created when order is in transit or out for delivery.'
      });
    }

    const pdfBuffer = await zohoBooksService.getInvoicePDF(order.zohoInvoiceId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download Invoice PDF error:', error);
    res.status(500).json({
      message: 'Failed to download Invoice PDF',
      error: error.message
    });
  }
};

// Get order status history (Admin)
export const getStatusHistory = async (req, res) => {
  try {
    const { leadId } = req.params;

    const statusHistory = await OrderStatus.getOrderStatusHistory(leadId);

    res.status(200).json({
      message: 'Status history retrieved successfully',
      statusHistory,
      count: statusHistory.length
    });

  } catch (error) {
    console.error('Get status history error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};
