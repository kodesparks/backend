import Order from '../../models/Order.js';
import OrderStatus from '../../models/OrderStatus.js';
import OrderDelivery from '../../models/OrderDelivery.js';
import OrderPayment from '../../models/OrderPayment.js';
import Inventory from '../../models/Inventory.js';
// ✅ REMOVED: InventoryPrice import - Using direct model approach
import { validationResult } from 'express-validator';
import geocodingService from '../../services/geocodingService.js';
import distanceService from '../../services/distanceService.js';
import WarehouseService from '../../services/warehouseService.js';
import zohoBooksService from '../../utils/zohoBooks.js';
import { sendOrderPlacedEmail } from '../../utils/emailService.js';
import User from '../../models/User.js';

// Add item to cart (Create order)
export const addToCart = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { itemCode, qty, deliveryPincode } = req.body;
    const customerId = req.user.userId;

    // Get inventory item and pricing
    const inventoryItem = await Inventory.findById(itemCode);
    if (!inventoryItem) {
      return res.status(404).json({
        message: 'Inventory item not found'
      });
    }

    if (!inventoryItem.isActive) {
      return res.status(400).json({
        message: 'Item is not available'
      });
    }

    // Use direct pricing from Inventory model (no separate pricing model needed)
    if (!inventoryItem.pricing || !inventoryItem.pricing.unitPrice) {
      return res.status(404).json({
        message: 'Pricing not found for this item'
      });
    }

    // Phase 1: vendor optional; order can have vendorId null when no vendor portal
    const orderVendorId = inventoryItem.vendorId || null;

    // Calculate delivery charges using nearest warehouse for this specific item
    let deliveryCharges = 0;
    let deliveryDetails = null;
    
    if (deliveryPincode && inventoryItem.warehouses && inventoryItem.warehouses.length > 0) {
      try {
        // Get customer coordinates
        const pincodeResult = await geocodingService.validatePincode(deliveryPincode);
        if (pincodeResult.success) {
          const customerLocation = pincodeResult.data.location;
          
          // Find nearest warehouse by calculating distance to all warehouses
          let nearestWarehouse = null;
          let minDistance = Infinity;
          let distance = 0;
          
          for (const warehouse of inventoryItem.warehouses) {
            if (warehouse.isActive && warehouse.location?.coordinates) {
              const warehouseDistance = distanceService.calculateDistance(
                warehouse.location.coordinates,
                customerLocation
              );
              
              // Track nearest warehouse
              if (warehouseDistance < minDistance) {
                minDistance = warehouseDistance;
                nearestWarehouse = warehouse;
                distance = warehouseDistance;
              }
            }
          }
          
          if (nearestWarehouse) {
            const deliveryChargeDetails = distanceService.calculateDeliveryCharges(
              distance,
              nearestWarehouse.deliveryConfig,
              inventoryItem.pricing.unitPrice
            );
            
            deliveryCharges = deliveryChargeDetails.totalDeliveryCharge;
            
            deliveryDetails = {
              distance: Math.round(distance * 100) / 100,
              warehouse: nearestWarehouse.warehouseName,
              warehouseLocation: nearestWarehouse.location,
              warehouseId: nearestWarehouse.warehouseId,
              deliveryConfig: nearestWarehouse.deliveryConfig,
              isDeliveryAvailable: deliveryChargeDetails.isDeliveryAvailable,
              deliveryReason: deliveryChargeDetails.reason
            };
            
            console.log(`✅ Using nearest warehouse for item: ${nearestWarehouse.warehouseName} (${Math.round(distance * 100) / 100}km)`);
          } else {
            console.log(`❌ No active warehouse with location found for this item`);
            deliveryDetails = {
              message: 'No active warehouse available',
              deliveryConfig: {}
            };
          }
        } else {
          console.log(`❌ Invalid pincode: ${deliveryPincode}`);
          deliveryDetails = {
            message: 'Invalid pincode provided',
            deliveryConfig: {}
          };
        }
      } catch (error) {
        console.log('Delivery calculation failed:', error.message);
        deliveryDetails = {
          message: 'Delivery calculation failed',
          deliveryConfig: {}
        };
      }
    } else if (deliveryPincode) {
      deliveryDetails = {
        message: 'No warehouses configured for this item',
        deliveryConfig: {}
      };
    }

    // Always create a new order for each addToCart call
    const itemTotalCost = qty * inventoryItem.pricing.unitPrice;
    const totalAmount = itemTotalCost + deliveryCharges;
    
    const orderItems = [{
      itemCode,
      qty,
      unitPrice: inventoryItem.pricing.unitPrice,
      totalCost: itemTotalCost
    }];
    
    // Generate custom lead ID with category prefix
    const leadId = await Order.generateLeadId(orderItems);
    
    const order = new Order({
      leadId,
      custUserId: customerId,
      vendorId: orderVendorId,
      items: orderItems,
      totalQty: qty,
      totalAmount: totalAmount,
      deliveryCharges: deliveryCharges,
      deliveryAddress: req.body.deliveryAddress || 'Address to be updated',
      deliveryPincode: deliveryPincode || '000000',
      deliveryExpectedDate: req.body.deliveryExpectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      custPhoneNum: req.body.custPhoneNum || req.user.phone || '0000000000',
      receiverMobileNum: req.body.receiverMobileNum || req.user.phone || '0000000000'
    });

    await order.save();

    // Create initial status
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'pending',
      customerId,
      'Order created and added to cart'
    );

    // Populate order details
    await order.populate([
      { path: 'items.itemCode', select: 'itemDescription category subCategory primaryImage' },
      { path: 'vendorId', select: 'name email phone' },
      { path: 'custUserId', select: 'name email phone' }
    ]);

    res.status(201).json({
      message: 'Item added to cart successfully',
      order: {
        leadId: order.leadId,
        formattedLeadId: order.formattedLeadId,
        items: order.items,
        totalQty: order.totalQty,
        totalAmount: order.totalAmount,
        deliveryCharges: order.deliveryCharges,
        deliveryDetails: deliveryDetails,
        orderStatus: order.orderStatus,
        vendorId: order.vendorId,
        orderDate: order.orderDate,
        invcNum: order.invcNum
      }
    });

  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get customer's cart/orders
export const getCustomerOrders = async (req, res) => {
  try {
    const customerId = req.user.userId;
    const { status, page = 1, limit = 10 } = req.query;

    const options = {
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    let query = { custUserId: customerId, isActive: true };
    if (status) {
      query.orderStatus = status;
    }

    const orders = await Order.find(query)
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
      .populate('vendorId', 'name email phone')
      .populate('promoCode', 'promoName discountType discountValue')
      .sort({ orderDate: -1 })
      .limit(options.limit)
      .skip(options.skip);

    const totalOrders = await Order.countDocuments(query);

    res.status(200).json({
      message: 'Orders retrieved successfully',
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
    console.error('Get customer orders error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get single order details
export const getOrderDetails = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      isActive: true
    })
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage')
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
    const payment = await OrderPayment.findByInvoice(order.invcNum);

    // Build masked delivery view for customers
    const delivery = deliveryInfo ? {
      deliveryStatus: deliveryInfo.deliveryStatus,
      driverName: deliveryInfo.driverName || null,
      driverPhone: deliveryInfo.driverPhone || null,
      truckNumber: deliveryInfo.truckNumber || null,
      vehicleType: deliveryInfo.vehicleType || null,
      estimatedArrival: deliveryInfo.estimatedArrival || null,
      address: deliveryInfo.address,
      pincode: deliveryInfo.pincode,
      lastLocation: { address: deliveryInfo.lastLocation?.address || null },
      deliveryNotes: deliveryInfo.deliveryNotes || null,
      expectedDeliveryDate: deliveryInfo.deliveryExpectedDate,
      deliveredDate: deliveryInfo.deliveryActualDate
    } : null;

    // Format payment information (consistent with tracking endpoint)
    const paymentInfo = payment ? {
      paymentStatus: payment.paymentStatus,
      paymentMethod: payment.paymentType,
      paidAmount: payment.paidAmount,
      paymentDate: payment.paymentDate,
      transactionId: payment.transactionId,
      orderAmount: payment.orderAmount,
      refundAmount: payment.refundAmount,
      paymentMode: payment.paymentMode,
      utrNum: payment.utrNum
    } : {
      paymentStatus: 'pending',
      paymentMethod: null,
      paidAmount: 0,
      paymentDate: null,
      transactionId: null,
      orderAmount: order.totalAmount,
      refundAmount: 0,
      paymentMode: null,
      utrNum: null
    };

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

// Update order (add/remove items, update delivery info)
export const updateOrder = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { leadId } = req.params;
    const customerId = req.user.userId;
    const { items, deliveryAddress, deliveryPincode, deliveryExpectedDate, receiverMobileNum } = req.body;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      orderStatus: 'pending',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be updated'
      });
    }

    // Update items if provided
    if (items && Array.isArray(items)) {
      for (const itemUpdate of items) {
        const { itemCode, qty } = itemUpdate;
        
        // Find the item in the order by itemCode (MongoDB ObjectId)
        const existingItem = order.items.find(item => item.itemCode.toString() === itemCode);
        
        if (existingItem) {
          // Update quantity and recalculate total cost
          existingItem.qty = qty;
          existingItem.totalCost = qty * existingItem.unitPrice;
          console.log(`Updated item ${itemCode}: qty=${qty}, totalCost=${existingItem.totalCost}`);
        } else {
          console.log(`Item not found: ${itemCode} in order ${leadId}`);
          console.log('Available items:', order.items.map(item => item.itemCode.toString()));
        }
      }
    }

    // Update delivery information
    if (deliveryAddress) order.deliveryAddress = deliveryAddress;
    if (deliveryPincode) order.deliveryPincode = deliveryPincode;
    if (deliveryExpectedDate) order.deliveryExpectedDate = deliveryExpectedDate;
    if (receiverMobileNum) order.receiverMobileNum = receiverMobileNum;

    await order.save();

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'pending',
      customerId,
      'Order details updated'
    );

    res.status(200).json({
      message: 'Order updated successfully',
      order
    });

  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Remove item from cart
export const removeFromCart = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { itemCode } = req.body;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      orderStatus: 'pending',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be updated'
      });
    }

    await order.removeItem(itemCode);

    // If no items left, delete the order
    if (order.items.length === 0) {
      order.isActive = false;
      await order.save();
      
      return res.status(200).json({
        message: 'Order deleted as no items remaining',
        order: null
      });
    }

    await order.save();

    res.status(200).json({
      message: 'Item removed from cart successfully',
      order
    });

  } catch (error) {
    console.error('Remove from cart error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Remove entire order from cart
export const removeOrderFromCart = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      orderStatus: 'pending',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be removed'
      });
    }

    // Mark order as inactive (soft delete from cart only)
    order.isActive = false;
    await order.save();

    // Create status update (keep original status, just mark as removed from cart)
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      order.orderStatus, // Keep original status
      customerId,
      'Order removed from cart by customer'
    );

    res.status(200).json({
      message: 'Order removed from cart successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus, // Will show original status (pending, order_placed, etc.)
        isActive: order.isActive // Will be false (removed from cart)
      }
    });

  } catch (error) {
    console.error('Remove order from cart error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Clear entire cart (remove all pending orders)
// Download Quote PDF (created in Zoho when order is placed)
export const downloadQuotePDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!order.zohoQuoteId) {
      return res.status(404).json({ message: 'Quote not found in Zoho Books. It may still be generating; try again in a moment.' });
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

// Download Purchase Order PDF (only when vendor assigned and PO created in Zoho)
export const downloadPurchaseOrderPDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
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

// Download Invoice PDF
export const downloadInvoicePDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!order.zohoInvoiceId) {
      return res.status(404).json({
        message: 'Invoice not yet generated',
        code: 'INVOICE_NOT_READY',
        detail: 'The invoice is created when your order is shipped (delivery status: in transit or out for delivery).'
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

// Download Sales Order PDF (Customer; available after admin/vendor generates SO in Zoho)
export const downloadSalesOrderPDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
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
    res.setHeader('Content-Disposition', `attachment; filename="SalesOrder-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download Sales Order PDF error:', error);
    res.status(500).json({
      message: 'Failed to download Sales Order PDF',
      error: error.message
    });
  }
};

export const clearCart = async (req, res) => {
  try {
    const customerId = req.user.userId;

    // Find all pending orders for this customer
    const pendingOrders = await Order.find({
      custUserId: customerId,
      orderStatus: 'pending',
      isActive: true
    });

    if (pendingOrders.length === 0) {
      return res.status(200).json({
        message: 'Cart is already empty',
        clearedCount: 0
      });
    }

    // Mark all pending orders as inactive (soft delete)
    const updateResult = await Order.updateMany(
      {
        custUserId: customerId,
        orderStatus: 'pending',
        isActive: true
      },
      {
        isActive: false
      }
    );

    // Create status updates for each cleared order
    for (const order of pendingOrders) {
      await OrderStatus.createStatusUpdate(
        order.leadId,
        order.invcNum,
        order.vendorId,
        order.orderStatus,
        customerId,
        'Order removed from cart (cart cleared)'
      );
    }

    res.status(200).json({
      message: 'Cart cleared successfully',
      clearedCount: updateResult.modifiedCount,
      ordersCleared: pendingOrders.map(order => ({
        leadId: order.leadId,
        totalAmount: order.totalAmount
      }))
    });

  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Place order (Move from cart to placed)
export const placeOrder = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { leadId } = req.params;
    const customerId = req.user.userId;
    const { deliveryAddress, deliveryPincode, deliveryExpectedDate, receiverMobileNum } = req.body;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      orderStatus: 'pending',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be placed'
      });
    }

    if (order.items.length === 0) {
      return res.status(400).json({
        message: 'Cannot place empty order'
      });
    }

    // Update delivery information
    order.deliveryAddress = deliveryAddress;
    order.deliveryPincode = deliveryPincode;
    order.deliveryExpectedDate = deliveryExpectedDate;
    order.receiverMobileNum = receiverMobileNum;
    
    // Change order status from pending to order_placed
    order.orderStatus = 'order_placed';

    await order.save();

    // Create status update
    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'order_placed',
      customerId,
      'Order placed and sent to vendor'
    );

    // Create delivery record
    const delivery = new OrderDelivery({
      leadId: order.leadId,
      invcNum: order.invcNum,
      userId: customerId,
      address: deliveryAddress,
      pincode: deliveryPincode,
      deliveryExpectedDate: deliveryExpectedDate,
      deliveryStatus: 'pending'
    });

    await delivery.save();

    // Send order-placed confirmation email from our side (SMTP)
    (async () => {
      try {
        const customer = await User.findById(customerId).select('email name').lean();
        if (customer?.email) {
          await sendOrderPlacedEmail(
            customer.email,
            customer.name || 'Customer',
            {
              leadId: order.leadId,
              formattedLeadId: order.formattedLeadId,
              totalAmount: order.totalAmount,
              deliveryAddress: order.deliveryAddress,
              deliveryExpectedDate: order.deliveryExpectedDate,
              itemCount: order.items?.length || 0
            }
          );
        } else {
          console.warn(`⚠️  Order-placed email skipped: no email for customer ${customerId}`);
        }
      } catch (err) {
        console.warn('⚠️  Order-placed email failed:', err?.message || err);
      }
    })();

    // Create Quote (Estimate) in Zoho Books when order is placed – customer can download Quote PDF
    if (!order.zohoQuoteId) {
      (async () => {
        try {
          const customer = await User.findById(customerId);
          const populatedOrder = await Order.findById(order._id)
            .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
          if (!customer) return;
          const zohoQuote = await zohoBooksService.createQuote(populatedOrder, customer);
          if (zohoQuote?.estimate_id) {
            await Order.updateOne(
              { _id: order._id },
              { $set: { zohoQuoteId: zohoQuote.estimate_id } }
            );
            console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId}`);
            await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch((err) => {
              console.warn(`⚠️ Quote email failed for order ${order.leadId}:`, err?.message || err);
            });
          }
        } catch (error) {
          console.error(`❌ Failed to create Zoho Quote for order ${order.leadId}:`, error.message);
        }
      })();
    }

    res.status(200).json({
      message: 'Order placed successfully',
      order: {
        leadId: order.leadId,
        formattedLeadId: order.formattedLeadId,
        totalAmount: order.totalAmount,
        orderStatus: order.orderStatus,
        vendorId: order.vendorId,
        deliveryAddress: order.deliveryAddress,
        deliveryExpectedDate: order.deliveryExpectedDate
      }
    });

  } catch (error) {
    console.error('Place order error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Process payment (Simulate for now)
export const processPayment = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { leadId } = req.params;
    const customerId = req.user.userId;
    const { paymentType, paymentMode } = req.body;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      orderStatus: 'vendor_accepted',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or payment cannot be processed'
      });
    }

    // Create payment record
    const payment = new OrderPayment({
      invcNum: order.invcNum,
      paymentType,
      paymentMode,
      orderAmount: order.totalAmount,
      paymentStatus: 'processing'
    });

    await payment.save();

    // Simulate payment processing (for now)
    setTimeout(async () => {
      try {
        await payment.markAsSuccessful();
        
        // Update order status
        await order.updateStatus('payment_done');
        
        // Create status update
        await OrderStatus.createStatusUpdate(
          order.leadId,
          order.invcNum,
          order.vendorId,
          'payment_done',
          customerId,
          'Payment processed successfully'
        );

        // Update to order confirmed
        await order.updateStatus('order_confirmed');
        
        await OrderStatus.createStatusUpdate(
          order.leadId,
          order.invcNum,
          order.vendorId,
          'order_confirmed',
          customerId,
          'Order confirmed after successful payment'
        );

        // Invoice is created in Zoho only at delivery status (in_transit/out_for_delivery), not at payment_done.

      } catch (error) {
        console.error('Payment processing error:', error);
      }
    }, 2000); // 2 second delay to simulate processing

    res.status(200).json({
      message: 'Payment processing initiated',
      payment: {
        transactionId: payment.transactionId,
        paymentType: payment.paymentType,
        paymentMode: payment.paymentMode,
        orderAmount: payment.orderAmount,
        paymentStatus: payment.paymentStatus
      }
    });

  } catch (error) {
    console.error('Process payment error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get payment status
export const getPaymentStatus = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    const payment = await OrderPayment.findByInvoice(order.invcNum);

    if (!payment) {
      return res.status(404).json({
        message: 'Payment information not found'
      });
    }

    res.status(200).json({
      message: 'Payment status retrieved successfully',
      payment: payment.getPaymentSummary()
    });

  } catch (error) {
    console.error('Get payment status error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get order tracking information (Customer)
export const getOrderTracking = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    // Find the order
    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      isActive: true
    })
      .populate('vendorId', 'name email phone companyName')
      .populate('items.itemCode', 'itemDescription category subCategory primaryImage');

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      });
    }

    // Get status history
    const statusHistory = await OrderStatus.getOrderStatusHistory(leadId);

    // Get delivery information
    const delivery = await OrderDelivery.findByOrder(leadId);

    // Get payment information
    const payment = await OrderPayment.findByInvoice(order.invcNum);

    // Build tracking response
    const trackingInfo = {
      order: {
        leadId: order.leadId,
        formattedLeadId: order.formattedLeadId,
        invcNum: order.invcNum,
        orderStatus: order.orderStatus,
        orderDate: order.orderDate,
        totalAmount: order.totalAmount,
        totalQty: order.totalQty,
        deliveryAddress: order.deliveryAddress,
        deliveryPincode: order.deliveryPincode,
        deliveryExpectedDate: order.deliveryExpectedDate
      },
      vendor: order.vendorId ? {
        name: order.vendorId.name,
        companyName: order.vendorId.companyName,
        phone: order.vendorId.phone,
        email: order.vendorId.email
      } : null,
      items: order.items.map(item => ({
        itemDescription: item.itemCode?.itemDescription,
        category: item.itemCode?.category,
        subCategory: item.itemCode?.subCategory,
        primaryImage: item.itemCode?.primaryImage,
        qty: item.qty,
        unitPrice: item.unitPrice,
        totalCost: item.totalCost
      })),
      currentStatus: {
        status: order.orderStatus,
        statusLabel: getStatusLabel(order.orderStatus),
        statusDescription: getStatusDescription(order.orderStatus),
        lastUpdated: statusHistory[statusHistory.length - 1]?.updateDate || order.orderDate
      },
      statusTimeline: statusHistory.map(status => ({
        status: status.orderStatus,
        statusLabel: getStatusLabel(status.orderStatus),
        remarks: status.remarks,
        date: status.updateDate
      })),
      delivery: delivery ? {
        deliveryStatus: delivery.deliveryStatus,
        driverName: delivery.driverName || null,
        driverPhone: delivery.driverPhone || null,
        truckNumber: delivery.truckNumber || null,
        vehicleType: delivery.vehicleType || null,
        estimatedArrival: delivery.estimatedArrival || null,
        address: delivery.address,
        pincode: delivery.pincode,
        lastLocation: { address: delivery.lastLocation?.address || null },
        deliveryNotes: delivery.deliveryNotes || null
      } : null,
      payment: payment ? {
        paymentStatus: payment.paymentStatus,
        paymentMethod: payment.paymentType,
        paidAmount: payment.paidAmount,
        paymentDate: payment.paymentDate,
        transactionId: payment.transactionId
      } : {
        paymentStatus: 'pending',
        paymentMethod: null,
        paidAmount: 0,
        paymentDate: null
      },
      estimatedDelivery: order.deliveryExpectedDate,
      canCancel: ['pending', 'vendor_accepted'].includes(order.orderStatus)
    };

    res.status(200).json({
      message: 'Order tracking information retrieved successfully',
      tracking: trackingInfo
    });

  } catch (error) {
    console.error('Get order tracking error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Helper function to get status label
function getStatusLabel(status) {
  const labels = {
    'pending': 'Order Placed',
    'vendor_accepted': 'Order Accepted by Vendor',
    'payment_done': 'Payment Completed',
    'order_confirmed': 'Order Confirmed',
    'truck_loading': 'Loading for Dispatch',
    'in_transit': 'In Transit',
    'shipped': 'Shipped',
    'out_for_delivery': 'Out for Delivery',
    'delivered': 'Delivered',
    'cancelled': 'Cancelled'
  };
  return labels[status] || status;
}

// Helper function to get status description
function getStatusDescription(status) {
  const descriptions = {
    'pending': 'Your order has been placed and is waiting for vendor confirmation.',
    'order_placed': 'Your order has been placed and is waiting for vendor confirmation.',
    'vendor_accepted': 'Vendor has accepted your order and will process it soon.',
    'payment_done': 'Payment has been received and verified.',
    'order_confirmed': 'Your order is confirmed and being prepared for dispatch.',
    'truck_loading': 'Your order is being loaded for dispatch.',
    'in_transit': 'Your order is on the way to the delivery location.',
    'shipped': 'Your order has been shipped and is in transit.',
    'out_for_delivery': 'Your order is out for delivery and will reach you soon.',
    'delivered': 'Your order has been delivered successfully.',
    'cancelled': 'This order has been cancelled.'
  };
  return descriptions[status] || 'Order status information';
}

// Change delivery address (within same pincode, within 48 hours)
export const changeDeliveryAddress = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { newAddress, reason = '' } = req.body;
    const userId = req.user.userId;

    // Validate leadId parameter
    if (!leadId || leadId === 'undefined' || leadId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid lead ID is required in the URL parameter'
      });
    }

    // Validate input
    if (!newAddress || newAddress.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'New address is required'
      });
    }

    // Find the order
    const order = await Order.findOne({ 
      leadId, 
      custUserId: userId, 
      isActive: true 
    }).populate('custUserId', 'name email phone');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or you do not have permission to modify this order'
      });
    }

    // Check if order is in a modifiable status
    const allowedStatuses = ['order_placed', 'vendor_accepted', 'payment_done'];
    if (!allowedStatuses.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Address cannot be changed for orders with status: ${order.orderStatus}. Only allowed for: ${allowedStatuses.join(', ')}`
      });
    }

    // Check 48-hour time window
    const orderTime = new Date(order.orderDate);
    const currentTime = new Date();
    const timeDifference = currentTime - orderTime;
    const hoursDifference = timeDifference / (1000 * 60 * 60);

    if (hoursDifference > 48) {
      return res.status(400).json({
        success: false,
        message: 'Address can only be changed within 48 hours of order placement',
        orderPlacedAt: orderTime,
        hoursElapsed: Math.round(hoursDifference * 100) / 100
      });
    }

    // Store old address for history
    const oldAddress = order.deliveryAddress;
    const oldPincode = order.deliveryPincode;

    // Update the address (keeping same pincode)
    order.deliveryAddress = newAddress.trim();

    // Add to address change history
    order.addressChangeHistory.push({
      oldAddress,
      newAddress: newAddress.trim(),
      oldPincode,
      newPincode: oldPincode, // Same pincode
      changedBy: 'customer',
      reason: reason.trim()
    });

    await order.save();

    res.status(200).json({
      success: true,
      message: 'Delivery address updated successfully',
      order: {
        leadId: order.leadId,
        oldAddress,
        newAddress: order.deliveryAddress,
        pincode: order.deliveryPincode,
        changedAt: new Date(),
        reason
      }
    });

  } catch (error) {
    console.error('Error changing delivery address:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Change delivery date (within 48 hours)
export const changeDeliveryDate = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { newDeliveryDate, reason = '' } = req.body;
    const userId = req.user.userId;

    // Validate leadId parameter
    if (!leadId || leadId === 'undefined' || leadId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid lead ID is required in the URL parameter'
      });
    }

    // Validate input
    if (!newDeliveryDate) {
      return res.status(400).json({
        success: false,
        message: 'New delivery date is required'
      });
    }

    const requestedDate = new Date(newDeliveryDate);
    const currentDate = new Date();
    
    // Check if the new date is in the future
    if (requestedDate <= currentDate) {
      return res.status(400).json({
        success: false,
        message: 'Delivery date must be in the future'
      });
    }

    // Find the order
    const order = await Order.findOne({ 
      leadId, 
      custUserId: userId, 
      isActive: true 
    }).populate('custUserId', 'name email phone');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or you do not have permission to modify this order'
      });
    }

    // Check if order is in a modifiable status
    const allowedStatuses = ['order_placed', 'vendor_accepted', 'payment_done'];
    if (!allowedStatuses.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Delivery date cannot be changed for orders with status: ${order.orderStatus}. Only allowed for: ${allowedStatuses.join(', ')}`
      });
    }

    // Check 48-hour time window
    const orderTime = new Date(order.orderDate);
    const currentTime = new Date();
    const timeDifference = currentTime - orderTime;
    const hoursDifference = timeDifference / (1000 * 60 * 60);

    if (hoursDifference > 48) {
      return res.status(400).json({
        success: false,
        message: 'Delivery date can only be changed within 48 hours of order placement',
        orderPlacedAt: orderTime,
        hoursElapsed: Math.round(hoursDifference * 100) / 100
      });
    }

    // Store old date for history
    const oldDate = order.deliveryExpectedDate;

    // Update the delivery date
    order.deliveryExpectedDate = requestedDate;

    // Add to delivery date change history
    order.deliveryDateChangeHistory.push({
      oldDate,
      newDate: requestedDate,
      changedBy: 'customer',
      reason: reason.trim()
    });

    await order.save();

    res.status(200).json({
      success: true,
      message: 'Delivery date updated successfully',
      order: {
        leadId: order.leadId,
        oldDeliveryDate: oldDate,
        newDeliveryDate: order.deliveryExpectedDate,
        changedAt: new Date(),
        reason
      }
    });

  } catch (error) {
    console.error('Error changing delivery date:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Get address and delivery date change history
export const getOrderChangeHistory = async (req, res) => {
  try {
    const { leadId } = req.params;
    const userId = req.user.userId;

    // Find the order
    const order = await Order.findOne({ 
      leadId, 
      custUserId: userId, 
      isActive: true 
    }).select('addressChangeHistory deliveryDateChangeHistory orderDate orderStatus');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or you do not have permission to view this order'
      });
    }

    // Check if changes are still allowed (within 48 hours)
    const orderTime = new Date(order.orderDate);
    const currentTime = new Date();
    const timeDifference = currentTime - orderTime;
    const hoursDifference = timeDifference / (1000 * 60 * 60);
    const canMakeChanges = hoursDifference <= 48 && ['order_placed', 'vendor_accepted', 'payment_done'].includes(order.orderStatus);

    res.status(200).json({
      success: true,
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        orderPlacedAt: order.orderDate,
        canMakeChanges,
        hoursElapsed: Math.round(hoursDifference * 100) / 100,
        addressChangeHistory: order.addressChangeHistory || [],
        deliveryDateChangeHistory: order.deliveryDateChangeHistory || []
      }
    });

  } catch (error) {
    console.error('Error getting order change history:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
