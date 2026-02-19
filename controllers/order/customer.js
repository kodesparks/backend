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
import { sendOrderPlacedEmail, sendQuoteReadyEmail, sendSalesOrderReadyEmail, sendInvoiceReadyEmail } from '../../utils/emailService.js';
import User from '../../models/User.js';
import { generateQuotePdfToken, verifyQuotePdfToken, generateSalesOrderPdfToken, verifySalesOrderPdfToken, generateInvoicePdfToken, verifyInvoicePdfToken } from '../../utils/jwt.js';
import { createDocumentToken, validateToken } from '../../services/tokenService.js';

/** Email and name for quote/SO/invoice notifications: prefer order-place values, else customer profile. */
export function getOrderNotificationContact(order, customer) {
  const email = (order?.orderEmail && String(order.orderEmail).trim()) || customer?.email || null;
  const name = (order?.orderReceiverName && String(order.orderReceiverName).trim()) || customer?.name || 'Customer';
  return { email, name };
}

// Add item to cart (Create order)
export const addToCartNew = async (req, res) => {
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

//New add to cart (Create order)

export const addToCart = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { itemCode, qty, deliveryPincode, customerContact } = req.body;
    let customerId;
    let isAdmin = false;
    if(req.user.role === 'admin') {
      isAdmin = true;
      const user = await User.findOne({
        phone: customerContact
      });
      if (!user) {
        const error = new Error("Customer not found with this phone number");
        error.status = 404;
        throw error;
      }
      customerId = user.id;
    } else {
      customerId = req.user.userId;
    }
    console.log(customerId);

    // 1️⃣ Get inventory item
    const inventoryItem = await Inventory.findById(itemCode);
    if (!inventoryItem || !inventoryItem.isActive) {
      return res.status(404).json({ message: 'Item not available' });
    }

    if (!inventoryItem.pricing?.unitPrice) {
      return res.status(404).json({ message: 'Pricing not found for this item' });
    }

    const vendorId = inventoryItem.vendorId || null;

    // 2️⃣ Calculate delivery charges (same logic as before)
    let deliveryCharges = 0;
    let deliveryDetails = null;

    if (deliveryPincode && inventoryItem.warehouses?.length) {
      try {
        const pincodeResult = await geocodingService.validatePincode(deliveryPincode);
        if (pincodeResult.success) {
          const customerLocation = pincodeResult.data.location;

          let nearestWarehouse = null;
          let minDistance = Infinity;
          let distance = 0;

          for (const warehouse of inventoryItem.warehouses) {
            if (warehouse.isActive && warehouse.location?.coordinates) {
              const d = distanceService.calculateDistance(
                warehouse.location.coordinates,
                customerLocation
              );
              if (d < minDistance) {
                minDistance = d;
                nearestWarehouse = warehouse;
                distance = d;
              }
            }
          }

          if (nearestWarehouse) {
            const deliveryChargeDetails =
              distanceService.calculateDeliveryCharges(
                distance,
                nearestWarehouse.deliveryConfig,
                inventoryItem.pricing.unitPrice
              );

            deliveryCharges = deliveryChargeDetails.totalDeliveryCharge;
            deliveryDetails = {
              distance: Math.round(distance * 100) / 100,
              warehouse: nearestWarehouse.warehouseName
            };
          }
        }
      } catch (err) {
        console.error('Delivery calc failed:', err.message);
      }
    }

    // 3️⃣ Find existing pending order for same customer + vendor
    let order = await Order.findOne({
      custUserId: customerId,
      vendorId,
      orderStatus: 'pending',
      isActive: true
    });

    const itemUnitPrice = inventoryItem.pricing.unitPrice;
    const itemTotalCost = qty * itemUnitPrice;

    // 4️⃣ If order exists → update it
    if (order && !isAdmin) {
      const itemIndex = order.items.findIndex(
        (i) => i.itemCode.toString() === itemCode
      );

      if (itemIndex > -1) {
        order.items[itemIndex].qty += qty;
        order.items[itemIndex].totalCost =
          order.items[itemIndex].qty * order.items[itemIndex].unitPrice;
      } else {
        order.items.push({
          itemCode,
          qty,
          unitPrice: itemUnitPrice,
          totalCost: itemTotalCost
        });
      }

      order.totalQty = order.items.reduce((s, i) => s + i.qty, 0);
      const itemsTotal = order.items.reduce((s, i) => s + i.totalCost, 0);

      order.deliveryCharges = deliveryCharges;
      order.totalAmount = itemsTotal + deliveryCharges;

      await order.save();
      if(isAdmin) {
        placeOrder(req, res);
      } else {
        await order.populate([
          { path: 'items.itemCode', select: 'itemDescription category subCategory primaryImage' },
          { path: 'vendorId', select: 'name email phone' }
        ]);

        return res.status(200).json({
          message: 'Item added to existing cart',
          order
        });
      }
      
    }

    // 5️⃣ Else → create new order
    const orderItems = [{
      itemCode,
      qty,
      unitPrice: itemUnitPrice,
      totalCost: itemTotalCost
    }];

    const leadId = await Order.generateLeadId(orderItems);

    order = new Order({
      leadId,
      custUserId: customerId,
      vendorId,
      items: orderItems,
      totalQty: qty,
      deliveryCharges,
      totalAmount: itemTotalCost + deliveryCharges,
      deliveryAddress: req.body.deliveryAddress || 'Address to be updated',
      deliveryPincode: deliveryPincode || '000000',
      deliveryExpectedDate:
        req.body.deliveryExpectedDate ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      custPhoneNum: isAdmin ? customerContact : req.body.custPhoneNum || req.user.phone,
      receiverMobileNum: isAdmin ? req.body.receiverPhoneNumber : req.body.receiverMobileNum || req.user.phone,
      orderStatus: 'pending',
      isActive: true
    });

    await order.save();

    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      'pending',
      customerId,
      'Order created and added to cart'
    );

    await order.populate([
      { path: 'items.itemCode', select: 'itemDescription category subCategory primaryImage' },
      { path: 'vendorId', select: 'name email phone' }
    ]);

    return res.status(201).json({
      message: 'Item added to cart successfully',
      order
    });

  } catch (error) {
    console.error('Add to cart error:', error);
    return res.status(500).json({
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
    } else {
      query.orderStatus = { $ne: 'pending' };
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
    const { items, deliveryAddress, deliveryPincode, deliveryExpectedDate, receiverMobileNum, accNumber, utrNum, paidAmount } = req.body;

    let order;
    if(accNumber) {
      order = await Order.findOne({
        leadId,
        custUserId: customerId,
        orderStatus: 'vendor_accepted',
        isActive: true
      });
    } else {
      order = await Order.findOne({
        leadId,
        custUserId: customerId,
        orderStatus: 'pending',
        isActive: true
      });
    }
    

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
    order.customerPaymentDetails = {
      ...order.customerPaymentDetails,
      ...(utrNum && { utrNum }),
      ...(accNumber && { accNum: accNumber }),
      ...(paidAmount && { paidAmount: paidAmount })
    };
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
// export const removeOrderFromCart = async (req, res) => {
//   try {
//     const { leadId } = req.params;
//     const customerId = req.user.userId;

//     const order = await Order.findOne({
//       leadId,
//       custUserId: customerId,
//       orderStatus: 'pending',
//       isActive: true
//     });

//     if (!order) {
//       return res.status(404).json({
//         message: 'Order not found or cannot be removed'
//       });
//     }

//     // Mark order as inactive (soft delete from cart only)
//     order.isActive = false;
//     await order.save();

//     // Create status update (keep original status, just mark as removed from cart)
//     await OrderStatus.createStatusUpdate(
//       order.leadId,
//       order.invcNum,
//       order.vendorId,
//       order.orderStatus, // Keep original status
//       customerId,
//       'Order removed from cart by customer'
//     );

//     res.status(200).json({
//       message: 'Order removed from cart successfully',
//       order: {
//         leadId: order.leadId,
//         orderStatus: order.orderStatus, // Will show original status (pending, order_placed, etc.)
//         isActive: order.isActive // Will be false (removed from cart)
//       }
//     });

//   } catch (error) {
//     console.error('Remove order from cart error:', error);
//     res.status(500).json({
//       message: 'Internal server error',
//       error: error.message
//     });
//   }
// };

export const removeOrderFromCart = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { itemCode } = req.body; // optional
    const customerId = req.user.userId;

    const order = await Order.findOne({
      leadId,
      custUserId: customerId,
      orderStatus: 'pending',
      isActive: true
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found or cannot be modified'
      });
    }

    // 🔹 CASE 1: Remove specific item
    if (itemCode) {
      const initialLength = order.items.length;

      order.items = order.items.filter(
        item => item.itemCode.toString() !== itemCode
      );

      if (order.items.length === initialLength) {
        return res.status(404).json({
          message: 'Item not found in order'
        });
      }

      // If no items left → deactivate entire order
      if (order.items.length === 0) {
        order.isActive = false;

        await OrderStatus.createStatusUpdate(
          order.leadId,
          order.invcNum,
          order.vendorId,
          order.orderStatus,
          customerId,
          'Order removed from cart (last item deleted)'
        );

      } else {
        // Recalculate totals
        order.totalQty = order.items.reduce(
          (sum, item) => sum + item.qty,
          0
        );

        const itemsTotal = order.items.reduce(
          (sum, item) => sum + item.totalCost,
          0
        );

        order.totalAmount = itemsTotal + (order.deliveryCharges || 0);

        await OrderStatus.createStatusUpdate(
          order.leadId,
          order.invcNum,
          order.vendorId,
          order.orderStatus,
          customerId,
          `Item removed from cart (${itemCode})`
        );
      }

      await order.save();

      return res.status(200).json({
        message: 'Item removed from cart successfully',
        order: {
          leadId: order.leadId,
          isActive: order.isActive,
          totalQty: order.totalQty,
          totalAmount: order.totalAmount,
          items: order.items
        }
      });
    }

    // 🔹 CASE 2: Remove entire order (no itemCode provided)
    order.isActive = false;
    await order.save();

    await OrderStatus.createStatusUpdate(
      order.leadId,
      order.invcNum,
      order.vendorId,
      order.orderStatus,
      customerId,
      'Order removed from cart by customer'
    );

    return res.status(200).json({
      message: 'Order removed from cart successfully',
      order: {
        leadId: order.leadId,
        orderStatus: order.orderStatus,
        isActive: order.isActive
      }
    });

  } catch (error) {
    console.error('Remove order from cart error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
};


// Clear entire cart (remove all pending orders)
// Download Quote PDF (created in Zoho when order is confirmed; created on-demand here if missing)
export const downloadQuotePDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    let order = await Order.findOne({
      leadId,
      custUserId: customerId,
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
            console.log(`✅ Quote created on-demand for order ${order.leadId} (customer PDF request)`);
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
        message: 'Quote is not available yet. It is generated when the order is confirmed by admin.'
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

/**
 * Public quote PDF (no login). Used by the link in quote-ready email.
 * GET /api/order/quote-pdf?token=<jwt>
 * Token is generated with generateQuotePdfToken(leadId) and valid 30 days.
 */
export const getPublicQuotePDF = async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ message: 'Missing token' });
    }
    const payload = await validateToken(token, "quote");
    // const payload = verifyQuotePdfToken(token);
    //docId is leadId here
    if (!payload?.docId) {
      return res.status(403).json({ message: 'Invalid or expired link' });
    }
    const order = await Order.findOne({
      leadId: payload.docId,
      isActive: true,
      zohoQuoteId: { $exists: true, $ne: null }
    });
    if (!order?.zohoQuoteId) {
      return res.status(404).json({ message: 'Quote not found or not ready yet' });
    }
    const pdfBuffer = await zohoBooksService.getQuotePDF(order.zohoQuoteId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Quote-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Public Quote PDF error:', error);
    res.status(500).json({
      message: 'Failed to load Quote PDF',
      error: error.message
    });
  }
};

/** Public Sales Order PDF (no login). Used by link in sales-order-ready email. */
export const getPublicSalesOrderPDF = async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ message: 'Missing token' });
    
    const payload = await validateToken(token, "so");
    // const payload = verifySalesOrderPdfToken(token);
    if (!payload?.docId) return res.status(403).json({ message: 'Invalid or expired link' });
    const order = await Order.findOne({ leadId: payload.docId, isActive: true, zohoSalesOrderId: { $exists: true, $ne: null } });
    if (!order?.zohoSalesOrderId) return res.status(404).json({ message: 'Sales Order not found or not ready yet' });
    const pdfBuffer = await zohoBooksService.getSalesOrderPDF(order.zohoSalesOrderId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="SalesOrder-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Public Sales Order PDF error:', error);
    res.status(500).json({ message: 'Failed to load Sales Order PDF', error: error.message });
  }
};

/** Public Payment PDF (no login). Used by link in payment receipt email. */
export const getPublicPaymentPDF = async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ message: 'Missing token' });
    // const payload = verifyInvoicePdfToken(token);
    const payload = await validateToken(token, "payment");
    if (!payload?.docId) return res.status(403).json({ message: 'Invalid or expired link' });
    const order = await Order.findOne({ leadId: payload.docId, isActive: true, zohoPaymentId: { $exists: true, $ne: null } });
    if (!order?.zohoPaymentId) return res.status(404).json({ message: 'payment not found or not ready yet' });
    const pdfBuffer = await zohoBooksService.getPaymentPDF(order.zohoPaymentId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payment-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Public payment PDF error:', error);
    res.status(500).json({ message: 'Failed to load payment PDF', error: error.message });
  }
};

/** Public Invoice PDF (no login). Used by link in invoice-ready email. */
export const getPublicInvoicePDF = async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ message: 'Missing token' });
    // const payload = verifyInvoicePdfToken(token);
    const payload = await validateToken(token, "invoice");
    if (!payload?.docId) return res.status(403).json({ message: 'Invalid or expired link' });
    const order = await Order.findOne({ leadId: payload.docId, isActive: true, zohoInvoiceId: { $exists: true, $ne: null } });
    if (!order?.zohoInvoiceId) return res.status(404).json({ message: 'Invoice not found or not ready yet' });
    const pdfBuffer = await zohoBooksService.getInvoicePDF(order.zohoInvoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${order.leadId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Public Invoice PDF error:', error);
    res.status(500).json({ message: 'Failed to load Invoice PDF', error: error.message });
  }
};

/** Build public quote PDF URL for email (no Zoho login required). */
export async function getPublicQuotePdfUrl(leadId) {
  const base = (process.env.BACKEND_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
  // const token = generateQuotePdfToken(leadId);
  const token = await createDocumentToken('quote', leadId);
  console.log('token created');
  return token ? `${base}/api/order/quote-pdf?token=${token}` : null;
}

/** Build public Sales Order PDF URL for email. */
export async function getPublicSalesOrderPdfUrl(leadId) {
  const base = (process.env.BACKEND_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
  // const token = generateSalesOrderPdfToken(leadId);
  const token = await createDocumentToken('so', leadId);
  console.log('token created for so');
  return token ? `${base}/api/order/sales-order-pdf?token=${token}` : null;
}

/** Build public Invoice PDF URL for email. */
export async function getPublicInvoicePdfUrl(leadId) {
  const base = (process.env.BACKEND_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
  // const token = generateInvoicePdfToken(leadId);
  const token = await createDocumentToken('invoice', leadId);
  return token ? `${base}/api/order/invoice-pdf?token=${token}` : null;
}

/** Build public Invoice PDF URL for email. */
export async function getPublicPaymentPdfUrl(leadId) {
  const base = (process.env.BACKEND_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
  // const token = generateInvoicePdfToken(leadId);
  const token = await createDocumentToken('payment', leadId);
  return token ? `${base}/api/order/payment-receipt-pdf?token=${token}` : null;
}

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

// Download Invoice PDF (created in Zoho when status is in_transit or out_for_delivery; created on-demand here if missing)
export const downloadInvoicePDF = async (req, res) => {
  try {
    const { leadId } = req.params;
    const customerId = req.user.userId;

    let order = await Order.findOne({
      leadId,
      custUserId: customerId,
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
            await zohoBooksService.emailInvoice(zohoInvoice.invoice_id).catch(() => {});
            const notif = getOrderNotificationContact(order, customer);
            if (notif.email) {
              const pdfUrl = await getPublicInvoicePdfUrl(order.leadId);
              await sendInvoiceReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId || order.leadId, pdfUrl).catch(() => {});
            }
            console.log(`✅ Invoice created on-demand for order ${order.leadId} (customer PDF request)`);
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
        message: 'Invoice not yet generated',
        code: 'INVOICE_NOT_READY',
        detail: 'The invoice is created when your order is in transit or out for delivery.'
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
    const { deliveryAddress, deliveryPincode, deliveryExpectedDate, receiverMobileNum, email: payloadEmail, receiverName: payloadReceiverName, city: deliveryCity, state: deliveryState } = req.body;

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

    // Save ONLY the address from this request (place order API). This is what we use for Quote/SO/Invoice in Zoho – never contact/signup address.
    // const addressTrimmed = (deliveryAddress != null && String(deliveryAddress).trim()) ? String(deliveryAddress).trim() : '';
    // if (!addressTrimmed) {
    //   return res.status(400).json({
    //     message: 'Delivery address is required when placing order'
    //   });
    // }
    // order.deliveryAddress = addressTrimmed;
    order.deliveryPincode = deliveryPincode != null ? String(deliveryPincode).trim() : order.deliveryPincode;
    if (deliveryCity != null && String(deliveryCity).trim()) order.deliveryCity = String(deliveryCity).trim();
    if (deliveryState != null && String(deliveryState).trim()) order.deliveryState = String(deliveryState).trim();
    order.deliveryExpectedDate = deliveryExpectedDate;
    order.receiverMobileNum = receiverMobileNum;
    // Store email/name from place order for quote, sales order, and invoice notifications
    const profile = await User.findById(customerId).select('email name').lean();
    order.orderEmail = (payloadEmail && String(payloadEmail).trim()) || profile?.email || null;
    order.orderReceiverName = (payloadReceiverName && String(payloadReceiverName).trim()) || profile?.name || null;
    
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
      address: "",
      pincode: deliveryPincode,
      deliveryExpectedDate: deliveryExpectedDate,
      deliveryStatus: 'pending'
    });

    await delivery.save();

    // Send order-placed confirmation email from our side (SMTP) – use stored order email/name
    (async () => {
      try {
        const emailToSend = order.orderEmail;
        const nameToUse = order.orderReceiverName || 'Customer';
        if (emailToSend) {
          await sendOrderPlacedEmail(
            emailToSend,
            nameToUse,
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
          console.warn(`⚠️  Order-placed email skipped: no email in payload and no profile email for customer ${customerId}`);
        }
      } catch (err) {
        console.warn('⚠️  Order-placed email failed:', err?.message || err);
      }
    })();

    // Quote is created when order is CONFIRMED (order_confirmed), not on place. See admin updateOrderStatus.

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

        // When payment_done: ensure Quote exists and was emailed, then create Sales Order (Zoho SO) and email it
        const currentOrder = await Order.findById(order._id);
        if (currentOrder && !currentOrder.zohoSalesOrderId) {
          try {
            const vendor = currentOrder.vendorId ? await User.findById(currentOrder.vendorId) : null;
            const customer = await User.findById(currentOrder.custUserId);
            let orderForQuote = await Order.findById(order._id);

            // If no Quote yet, create it and send quote-ready email first
            if (!orderForQuote.zohoQuoteId && customer) {
              try {
                const populatedForQuote = await Order.findById(order._id)
                  .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
                const zohoQuote = await zohoBooksService.createQuote(populatedForQuote, customer);
                if (zohoQuote?.estimate_id) {
                  await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
                  orderForQuote = await Order.findById(order._id);
                  if (customer.zohoCustomerId) {
                    await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, orderForQuote, customer).catch(() => {});
                  }
                  await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => {});
                  const notifQuote = getOrderNotificationContact(orderForQuote, customer);
                  if (notifQuote.email) {
                    const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
                    await sendQuoteReadyEmail(notifQuote.email, notifQuote.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
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
          } catch (err) {
            console.error(`❌ Failed to create Zoho Sales Order for order ${order.leadId}:`, err?.message || err);
          }
        }

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

        // When order_confirmed: create Quote (Zoho estimate) and email it
        const orderAfterConfirm = await Order.findById(order._id);
        if (orderAfterConfirm && !orderAfterConfirm.zohoQuoteId) {
          try {
            const customer = await User.findById(order.custUserId);
            const populatedOrder = await Order.findById(order._id)
              .populate('items.itemCode', 'itemDescription category subCategory units pricing zohoItemId');
            if (customer) {
              const zohoQuote = await zohoBooksService.createQuote(populatedOrder, customer);
              if (zohoQuote?.estimate_id) {
                await Order.updateOne({ _id: order._id }, { $set: { zohoQuoteId: zohoQuote.estimate_id } });
                console.log(`✅ Zoho Quote created: ${zohoQuote.estimate_id} for order ${order.leadId}`);
                if (customer.zohoCustomerId) {
                  await zohoBooksService.syncContactWithOrderEmail(customer.zohoCustomerId, order, customer).catch(() => {});
                }
                await zohoBooksService.emailEstimate(zohoQuote.estimate_id).catch(() => {});
                const notif = getOrderNotificationContact(order, customer);
                if (notif.email) {
                  const pdfUrl = await getPublicQuotePdfUrl(order.leadId);
                  await sendQuoteReadyEmail(notif.email, notif.name, order.leadId, order.formattedLeadId, pdfUrl).catch(() => {});
                }
              }
            }
          } catch (err) {
            console.error(`❌ Failed to create Zoho Quote for order ${order.leadId}:`, err?.message || err);
          }
        }

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
