import { body, validationResult } from 'express-validator';
import geocodingService from '../services/geocodingService.js';
import distanceService from '../services/distanceService.js';
import Inventory from '../models/Inventory.js';

/**
 * Calculate delivery charges for items based on pincode
 * POST /api/delivery/calculate
 */
export const calculateDelivery = async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array(),
        data: null
      });
    }

    const { pincode, items } = req.body;

    console.log(`🚚 Calculating delivery for pincode: ${pincode}, items: ${items.length}`);

    // Step 1: Validate pincode and get coordinates
    const pincodeResult = await geocodingService.validatePincode(pincode);
    if (!pincodeResult.success) {
      return res.status(400).json({
        success: false,
        error: pincodeResult.error,
        data: null
      });
    }

    const destinationCoord = pincodeResult.data.location;

    // Step 2: Get inventory items and validate
    const itemIds = items.map(item => item.itemId);
    const inventoryItems = await Inventory.find({
      _id: { $in: itemIds },
      isActive: true
    }).select('_id itemDescription category pricing delivery warehouse');

    if (inventoryItems.length !== items.length) {
      const foundIds = inventoryItems.map(item => item._id.toString());
      const missingIds = itemIds.filter(id => !foundIds.includes(id));
      return res.status(404).json({
        success: false,
        error: `Items not found: ${missingIds.join(', ')}`,
        data: null
      });
    }

    // Step 3: Calculate delivery charges for each item
    const deliveryCharges = {};
    let totalDeliveryCharge = 0;

    for (const item of items) {
      const inventoryItem = inventoryItems.find(inv => inv._id.toString() === item.itemId);
      
      if (!inventoryItem) {
        return res.status(404).json({
          success: false,
          error: `Item not found: ${item.itemId}`,
          data: null
        });
      }

      // Calculate distance
      const distance = distanceService.calculateDistance(
        inventoryItem.warehouse.location,
        destinationCoord
      );

      // Calculate delivery charges
      const orderAmount = inventoryItem.pricing.unitPrice * item.quantity;
      const deliveryChargeDetails = distanceService.calculateDeliveryCharges(
        distance,
        inventoryItem.delivery,
        orderAmount
      );

      // Estimate delivery time
      const deliveryTime = distanceService.estimateDeliveryTime(distance);

      deliveryCharges[item.itemId] = {
        distance: Math.round(distance * 100) / 100,
        deliveryCharge: deliveryChargeDetails.totalDeliveryCharge,
        deliveryTime: deliveryTime.deliveryTime,
        warehouse: inventoryItem.warehouse.name,
        isFreeDelivery: deliveryChargeDetails.isFreeDelivery,
        freeDeliveryReason: deliveryChargeDetails.reason,
        estimatedDays: deliveryTime.estimatedDays,
        distanceCategory: distanceService.getDistanceCategory(distance)
      };

      totalDeliveryCharge += deliveryChargeDetails.totalDeliveryCharge;
    }

    console.log(`✅ Delivery calculation completed. Total charge: ₹${totalDeliveryCharge}`);

    return res.status(200).json({
      success: true,
      error: null,
      data: {
        pincode: pincodeResult.data.pincode,
        destination: {
          address: pincodeResult.data.location.address,
          coordinates: {
            latitude: destinationCoord.latitude,
            longitude: destinationCoord.longitude
          }
        },
        deliveryCharges,
        totalDeliveryCharge: Math.round(totalDeliveryCharge * 100) / 100,
        totalItems: items.length,
        calculatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Delivery calculation error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.',
      data: null
    });
  }
};

/**
 * Get delivery time estimation for a pincode
 * GET /api/delivery/estimate-time/:pincode
 */
export const estimateDeliveryTime = async (req, res) => {
  try {
    const { pincode } = req.params;

    // Validate pincode format
    if (!/^[1-9][0-9]{5}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pincode format',
        data: null
      });
    }

    // Get pincode coordinates
    const pincodeResult = await geocodingService.validatePincode(pincode);
    if (!pincodeResult.success) {
      return res.status(400).json({
        success: false,
        error: pincodeResult.error,
        data: null
      });
    }

    const destinationCoord = pincodeResult.data.location;

    // Get all warehouses and calculate distances
    const warehouses = [
      {
        name: 'Cement Warehouse Mumbai',
        location: { latitude: 19.0760, longitude: 72.8777 },
        category: 'Cement'
      },
      {
        name: 'Steel Warehouse Delhi',
        location: { latitude: 28.7041, longitude: 77.1025 },
        category: 'Steel'
      },
      {
        name: 'Concrete Mixer Warehouse Bangalore',
        location: { latitude: 12.9716, longitude: 77.5946 },
        category: 'Concrete Mixer'
      }
    ];

    const deliveryEstimates = warehouses.map(warehouse => {
      const distance = distanceService.calculateDistance(warehouse.location, destinationCoord);
      const deliveryTime = distanceService.estimateDeliveryTime(distance);
      
      return {
        warehouse: warehouse.name,
        category: warehouse.category,
        distance: Math.round(distance * 100) / 100,
        deliveryTime: deliveryTime.deliveryTime,
        estimatedDays: deliveryTime.estimatedDays,
        distanceCategory: distanceService.getDistanceCategory(distance)
      };
    });

    return res.status(200).json({
      success: true,
      error: null,
      data: {
        pincode,
        destination: {
          address: pincodeResult.data.location.address,
          coordinates: destinationCoord
        },
        deliveryEstimates,
        fastestDelivery: Math.min(...deliveryEstimates.map(e => e.estimatedDays)),
        slowestDelivery: Math.max(...deliveryEstimates.map(e => e.estimatedDays))
      }
    });

  } catch (error) {
    console.error('Delivery time estimation error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.',
      data: null
    });
  }
};

// Validation rules for delivery calculation
export const calculateDeliveryRules = [
  body('pincode')
    .notEmpty()
    .withMessage('Pincode is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('Pincode must be exactly 6 digits')
    .isNumeric()
    .withMessage('Pincode must contain only numbers')
    .custom((value) => {
      if (value.startsWith('0')) {
        throw new Error('Pincode cannot start with 0');
      }
      return true;
    }),
  
  body('items')
    .isArray({ min: 1 })
    .withMessage('Items array is required and must contain at least one item'),
  
  body('items.*.itemId')
    .notEmpty()
    .withMessage('Item ID is required for each item')
    .isMongoId()
    .withMessage('Item ID must be a valid MongoDB ObjectId'),
  
  body('items.*.quantity')
    .isInt({ min: 1 })
    .withMessage('Quantity must be a positive integer')
];
