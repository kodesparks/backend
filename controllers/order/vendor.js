import Order from '../../models/Order.js';
import OrderStatus from '../../models/OrderStatus.js';
import OrderDelivery from '../../models/OrderDelivery.js';
import OrderPayment from '../../models/OrderPayment.js';
import { validationResult } from 'express-validator';
import zohoBooksService from '../../utils/zohoBooks.js';
import User from '../../models/User.js';

// Get vendor's orders
export const getVendorOrders = async (req, res) => {
  try {
    const vendorId = req.user.userId;
    const { status, page = 1, limit = 10 } = req.query;

    const options = {
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    let query = { vendorId, isActive: true };
    if (status) {
      query.orderStatus = status;
    }

    const orders = await Order.find(query)
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('custUserId', 'name email phone')
      .populate('promoCode', 'promoName discountType discountValue')
      .sort({ orderDate: -1 })
      .limit(options.limit)
      .skip(options.skip);

    const totalOrders = await Order.countDocuments(query);

    res.status(200).json({
      message: 'Vendor orders retrieved successfully',
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
    console.error('Get vendor orders error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get single vendor order details
export const getVendorOrderDetails = async (req, res) => {
  try {
    const { leadId } = req.params;
    const vendorId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      vendorId,
      isActive: true
    })
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('custUserId', 'name email phone')
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

    // Shape delivery info to include new fleet fields
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
      message: 'Vendor order details retrieved successfully',
      order,
      statusHistory,
      deliveryInfo: delivery
    });

  } catch (error) {
    console.error('Get vendor order details error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Accept order (Vendor)
export const acceptOrder = async (req, res) => {
  try {
    const { leadId } = req.params;
    const vendorId = req.user.userId;
    const { remarks } = req.body;

    const order = await Order.findOne({
      leadId,
      vendorId,
      orderStatus: 'order_placed',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be accepted'
      });
    }

    // Update order status
    await order.updateStatus('vendor_accepted');

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'vendor_accepted',
      vendorId,
      remarks || 'Order accepted by vendor'
    );

    // Create Quote in Zoho Books if not already created (background, non-blocking)
    // Step 2: Admin creates quotation → Create Quote in Zoho
    // Quote should be created when order is accepted (by admin or vendor)
    if (!order.zohoQuoteId) {
      (async () => {
        try {
          const customer = await User.findById(order.custUserId);
          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
          
          const zohoQuote = await zohoBooksService.createQuote(populatedOrder, customer);
          if (zohoQuote?.estimate_id) {
            order.zohoQuoteId = zohoQuote.estimate_id;
            await order.save();
            console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId}`);
            await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch((err) => {
              console.warn(`⚠️ Quote email failed for order ${order.leadId}:`, err?.message || err);
            });
          }
        } catch (error) {
          console.error(`❌ Failed to create Zoho Quote for order ${order.leadId}:`, error.message);
          // Don't fail the main request if Zoho integration fails
        }
      })();
    }

    // Create Sales Order in Zoho Books (background, non-blocking)
    // Step 4: Admin generates SO → Create Sales Order in Zoho
    if (!order.zohoSalesOrderId) {
      (async () => {
        try {
          const vendor = await User.findById(vendorId);
          const customer = await User.findById(order.custUserId);
          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
          
          const zohoSO = await zohoBooksService.createSalesOrder(populatedOrder, vendor, customer);
          if (zohoSO?.salesorder_id) {
            order.zohoSalesOrderId = zohoSO.salesorder_id;
            await order.save();
            console.log(`✅ Zoho Sales Order created: ${zohoSO.salesorder_id} for order ${order.leadId}`);
            await zohoBooksService.emailSalesOrder(zohoSO.salesorder_id).catch((err) => {
              console.warn(`⚠️ Sales Order email failed for order ${order.leadId}:`, err?.message || err);
            });
          }
        } catch (error) {
          console.error(`❌ Failed to create Zoho Sales Order for order ${order.leadId}:`, error.message);
          // Don't fail the main request if Zoho integration fails
        }
      })();
    }

    res.status(200).json({
      message: 'Order accepted successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        totalAmount: order.totalAmount
      }
    });

  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Reject order (Vendor)
export const rejectOrder = async (req, res) => {
  try {
    const { leadId } = req.params;
    const vendorId = req.user.userId;
    const { remarks } = req.body;

    const order = await Order.findOne({
      leadId,
      vendorId,
      orderStatus: 'order_placed',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be rejected'
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
      vendorId,
      remarks || 'Order rejected by vendor'
    );

    res.status(200).json({
      message: 'Order rejected successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus
      }
    });

  } catch (error) {
    console.error('Reject order error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Update delivery tracking (Vendor)
export const updateDeliveryTracking = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { leadId } = req.params;
    const vendorId = req.user.userId;
    const {
      // deprecated courier fields (still accepted)
      trackingNumber, courierService, trackingUrl,
      // new fleet fields
      driverName, driverPhone, driverLicenseNo, truckNumber, vehicleType,
      capacityTons, startTime, estimatedArrival, lastLocation, deliveryStatus, deliveryNotes
    } = req.body;

    const order = await Order.findOne({
      leadId,
      vendorId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Get or create delivery record
    let delivery = await OrderDelivery.findByOrder(leadId);
    
    if (!delivery) {
      delivery = new OrderDelivery({
        leadId: order.leadId,
        invcNum: order.invcNum,
        userId: vendorId,
        address: order.deliveryAddress,
        pincode: order.deliveryPincode,
        deliveryExpectedDate: order.deliveryExpectedDate,
        deliveryStatus: 'pending'
      });
    }

    // Update tracking information
    if (trackingNumber && courierService) {
      await delivery.addTrackingInfo(trackingNumber, courierService, trackingUrl);
    }

    // Update fleet info (driver + truck)
    await delivery.updateFleetInfo({
      driverName, driverPhone, driverLicenseNo, truckNumber, vehicleType,
      capacityTons, startTime, estimatedArrival, lastLocation, deliveryStatus, deliveryNotes
    });

    // Update order status based on delivery status
    if (deliveryStatus === 'delivered') {
      await order.updateStatus('delivered');
      
      // Create status update
      await OrderStatus.createStatusUpdate(
        order.leadId,
        order.invcNum,
        order.vendorId,
        'delivered',
        vendorId,
        'Order delivered successfully'
      );
    } else if (deliveryStatus === 'in_transit') {
      await order.updateStatus('shipped');
      await OrderStatus.createStatusUpdate(
        order.leadId,
        order.invcNum,
        order.vendorId,
        'shipped',
        vendorId,
        'Order shipped and in transit'
      );
    } else if (deliveryStatus === 'out_for_delivery') {
      await order.updateStatus('shipped');
      await OrderStatus.createStatusUpdate(
        order.leadId,
        order.invcNum,
        order.vendorId,
        'shipped',
        vendorId,
        'Order out for delivery'
      );

      // Step 5: Only at out_for_delivery → Create Invoice (if not exists) then E-Way Bill in Zoho Books (background, non-blocking)
      // Invoice and E-Way Bill are generated only when delivery status is out_for_delivery, NOT at in_transit or shipped.
      (async () => {
        try {
          let currentOrder = order;
          // 1) Create Invoice in Zoho if not already created
          if (!currentOrder.zohoInvoiceId) {
            const populatedOrder = await Order.findById(currentOrder._id)
              .populate('items.itemCode', 'itemDescription category subCategory zohoItemId');
            const payment = await OrderPayment.findByInvoice(currentOrder.invcNum);
            const vendor = currentOrder.vendorId ? await User.findById(currentOrder.vendorId) : null;
            const customer = await User.findById(currentOrder.custUserId);
            const zohoInvoice = await zohoBooksService.createInvoice(populatedOrder, payment, vendor, customer);
            if (zohoInvoice?.invoice_id) {
              currentOrder.zohoInvoiceId = zohoInvoice.invoice_id;
              await currentOrder.save();
              console.log(`✅ Zoho Invoice created: ${zohoInvoice.invoice_id} for order ${currentOrder.leadId}`);
              await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch((err) => {
                console.warn(`⚠️ Invoice email failed for order ${currentOrder.leadId}:`, err?.message || err);
              });
            }
          }
          // 2) Create E-Way Bill if we have invoice and not already created
          if (currentOrder.zohoInvoiceId && !currentOrder.zohoEWayBillId) {
            const ewayBillData = {
              distance: delivery.distance || 0,
              transportMode: 'Road',
              vehicleNumber: delivery.truckNumber || '',
              vehicleType: delivery.vehicleType || 'Regular'
            };
            const zohoEWayBill = await zohoBooksService.createEWayBill(currentOrder.zohoInvoiceId, ewayBillData);
            if (zohoEWayBill?.ewaybill_id) {
              currentOrder.zohoEWayBillId = zohoEWayBill.ewaybill_id;
              await currentOrder.save();
              console.log(`✅ Zoho E-Way Bill created: ${zohoEWayBill.ewaybill_id} for order ${currentOrder.leadId}`);
            }
          }
        } catch (error) {
          console.error(`❌ Zoho Invoice/E-Way Bill for order ${order.leadId}:`, error.message);
        }
      })();
    }

    res.status(200).json({
      message: 'Delivery tracking updated successfully',
      delivery: {
        leadId: delivery.leadId,
        deliveryStatus: delivery.deliveryStatus,
        deliveryNotes: delivery.deliveryNotes,
        trackingNumber: delivery.trackingNumber,
        courierService: delivery.courierService,
        trackingUrl: delivery.trackingUrl,
        driverName: delivery.driverName,
        driverPhone: delivery.driverPhone,
        driverLicenseNo: delivery.driverLicenseNo,
        truckNumber: delivery.truckNumber,
        vehicleType: delivery.vehicleType,
        capacityTons: delivery.capacityTons,
        startTime: delivery.startTime,
        estimatedArrival: delivery.estimatedArrival,
        lastLocation: delivery.lastLocation
      }
    });

  } catch (error) {
    console.error('Update delivery tracking error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Download Sales Order PDF
export const downloadSalesOrderPDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const vendorId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      vendorId,
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

// Get vendor order statistics
export const getVendorOrderStats = async (req, res) => {
  try {
    const vendorId = req.user.userId;

    const stats = await Order.aggregate([
      { $match: { vendorId: vendorId, isActive: true } },
      {
        $group: {
          _id: '$orderStatus',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ]);

    const totalOrders = await Order.countDocuments({ vendorId, isActive: true });
    const totalRevenue = await Order.aggregate([
      { $match: { vendorId: vendorId, isActive: true, orderStatus: { $in: ['order_confirmed', 'shipped', 'delivered'] } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    res.status(200).json({
      message: 'Vendor order statistics retrieved successfully',
      stats: {
        totalOrders: totalOrders || 0,
        totalRevenue: totalRevenue[0]?.total || 0,
        statusBreakdown: stats || []
      }
    });

  } catch (error) {
    console.error('Get vendor order stats error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get pending orders for vendor (orders placed by customers, waiting for vendor response)
export const getPendingOrders = async (req, res) => {
  try {
    const vendorId = req.user.userId;
    const { page = 1, limit = 10 } = req.query;

    const options = {
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    const orders = await Order.find({
      vendorId,
      orderStatus: 'order_placed',
      isActive: true
    })
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('custUserId', 'name email phone')
      .sort({ orderDate: -1 })
      .limit(options.limit)
      .skip(options.skip);

    const totalOrders = await Order.countDocuments({
      vendorId,
      orderStatus: 'order_placed',
      isActive: true
    });

    res.status(200).json({
      message: 'Pending orders retrieved successfully',
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
    console.error('Get pending orders error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Update order status (Vendor - for shipping statuses)
export const updateVendorOrderStatus = async (req, res) => {
  try {
    const { leadId } = req.params;
    const vendorId = req.user.userId;
    const { orderStatus, remarks } = req.body;

    if (!orderStatus) {
      return res.status(400).json({
        message: 'Order status is required'
      });
    }

    // Vendor can only update to specific statuses (shipping-related)
    const allowedStatuses = [
      'truck_loading',
      'in_transit', 
      'shipped',
      'out_for_delivery',
      'delivered'
    ];

    if (!allowedStatuses.includes(orderStatus)) {
      return res.status(400).json({
        message: `Vendors can only update status to: ${allowedStatuses.join(', ')}`
      });
    }

    // Find the order
    const order = await Order.findOne({
      leadId,
      vendorId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or you do not have permission to update this order'
      });
    }

    // Check if order is in a state where vendor can update
    const allowedCurrentStatuses = ['order_confirmed', 'truck_loading', 'in_transit', 'shipped', 'out_for_delivery'];
    if (!allowedCurrentStatuses.includes(order.orderStatus)) {
      return res.status(400).json({
        message: `Cannot update order status from ${order.orderStatus}. Order must be confirmed first.`
      });
    }

    // Update order status
    await order.updateStatus(orderStatus);

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      orderStatus,
      vendorId,
      remarks || `Order status updated to ${orderStatus} by vendor`
    );

    // If status is delivered, update delivery record
    if (orderStatus === 'delivered') {
      let delivery = await OrderDelivery.findByOrder(leadId);
      if (delivery) {
        delivery.deliveryStatus = 'delivered';
        delivery.deliveredDate = new Date();
        await delivery.save();
      }
    }

    // Create Invoice in Zoho only when vendor sets status to out_for_delivery (if not already created)
    if (orderStatus === 'out_for_delivery' && !order.zohoInvoiceId) {
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
            await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch((err) => {
              console.warn(`⚠️ Invoice email failed for order ${currentOrder.leadId}:`, err?.message || err);
            });
          }
        } catch (err) {
          console.error(`❌ Zoho Invoice for order ${order.leadId}:`, err.message);
        }
      })();
    }

    res.status(200).json({
      message: 'Order status updated successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        totalAmount: order.totalAmount,
        formattedLeadId: order.formattedLeadId
      }
    });

  } catch (error) {
    console.error('Update vendor order status error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};
