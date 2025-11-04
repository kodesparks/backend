import { query, validationResult } from 'express-validator';
import geocodingService from '../services/geocodingService.js';
import distanceService from '../services/distanceService.js';
import WarehouseService from '../services/warehouseService.js';
import Inventory from '../models/Inventory.js';

/**
 * Get inventory items with calculated pricing including delivery
 * GET /api/inventory/pricing
 */
export const getInventoryWithPricing = async (req, res) => {
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

    const { pincode, page = 1, limit = 20, category, subCategory, search } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    console.log(`📦 Getting inventory with pricing. Pincode: ${pincode || 'none'}, Page: ${pageNum}, Limit: ${limitNum}`);

    // Build query
    let query = { isActive: true };
    if (category) query.category = category;
    if (subCategory) query.subCategory = subCategory;
    if (search) {
      query.$or = [
        { itemDescription: { $regex: search, $options: 'i' } },
        { grade: { $regex: search, $options: 'i' } },
        { details: { $regex: search, $options: 'i' } }
      ];
    }

    // Get inventory items
    const skip = (pageNum - 1) * limitNum;
    const inventoryItems = await Inventory.find(query)
      .populate('vendorId', 'name email phone companyName')
      .select('itemDescription category subCategory grade units details specification pricing delivery warehouses primaryImage images')
      .sort({ createdDate: -1 })
      .limit(limitNum)
      .skip(skip);

    const totalItems = await Inventory.countDocuments(query);

    // If pincode is provided, get customer coordinates for distance calculation
    let destinationCoord = null;
    if (pincode) {
      const pincodeResult = await geocodingService.validatePincode(pincode);
      if (pincodeResult.success) {
        destinationCoord = pincodeResult.data.location;
        console.log(`📍 Customer location: ${destinationCoord.address}`);
      } else {
        return res.status(400).json({
          success: false,
          error: pincodeResult.error,
          data: null
        });
      }
    }

    // Process inventory items with pricing
    const processedItems = await Promise.all(
      inventoryItems.map(async (item) => {
        const baseItem = {
          _id: item._id,
          itemDescription: item.itemDescription,
          category: item.category,
          subCategory: item.subCategory,
          grade: item.grade,
          units: item.units,
          details: item.details,
          specification: item.specification,
          primaryImage: item.primaryImage,
          images: item.images,
          vendor: item.vendorId ? {
            name: item.vendorId.name,
            companyName: item.vendorId.companyName,
            email: item.vendorId.email,
            phone: item.vendorId.phone
          } : null,
          pricing: {
            basePrice: item.pricing?.basePrice || 0,
            unitPrice: item.pricing?.unitPrice || 0,
            currency: item.pricing?.currency || 'INR',
            isActive: item.pricing?.isActive || false
          }
        };

        // Process warehouses for this item - find nearest warehouse to customer
        if (item.warehouses && item.warehouses.length > 0) {
          let nearestWarehouse = null;
          let minDistance = Infinity;
          let distance = 0;
          let deliveryCharge = 0;
          let deliveryChargeDetails = {
            isDeliveryAvailable: true,
            reason: null
          };
          
          // Calculate distance from customer pincode to ALL warehouses for this item
          if (destinationCoord) {
            // Find nearest warehouse by calculating distance to each
            for (const warehouse of item.warehouses) {
              if (warehouse.isActive && warehouse.location?.coordinates) {
                const warehouseDistance = distanceService.calculateDistance(
                  warehouse.location.coordinates,
                  destinationCoord
                );
                
                // Track nearest warehouse
                if (warehouseDistance < minDistance) {
                  minDistance = warehouseDistance;
                  nearestWarehouse = warehouse;
                  distance = warehouseDistance;
                }
              }
            }
            
            // Calculate delivery charges for nearest warehouse
            if (nearestWarehouse) {
              deliveryChargeDetails = distanceService.calculateDeliveryCharges(
                distance,
                nearestWarehouse.deliveryConfig,
                item.pricing?.unitPrice || 0
              );
              
              deliveryCharge = deliveryChargeDetails.totalDeliveryCharge;
            }
          } else {
            // No pincode provided - use first active warehouse or first warehouse
            nearestWarehouse = item.warehouses.find(wh => wh.isActive) || item.warehouses[0];
          }
          
          // Return nearest warehouse object
          if (nearestWarehouse) {
            baseItem.warehouse = {
              warehouseId: nearestWarehouse.warehouseId,
              warehouseName: nearestWarehouse.warehouseName,
              location: nearestWarehouse.location,
              distance: Math.round(distance * 100) / 100,
              deliveryConfig: nearestWarehouse.deliveryConfig,
              stock: nearestWarehouse.stock,
              isActive: nearestWarehouse.isActive,
              isDeliveryAvailable: deliveryChargeDetails.isDeliveryAvailable !== false,
              deliveryReason: deliveryChargeDetails.reason,
              totalPrice: (item.pricing?.unitPrice || 0) + deliveryCharge
            };
            
            // Add warehouse info at root level for easier frontend access
            baseItem.warehouseName = nearestWarehouse.warehouseName;
            baseItem.distance = Math.round(distance * 100) / 100;
            baseItem.deliveryConfig = nearestWarehouse.deliveryConfig;
            baseItem.stock = nearestWarehouse.stock;
            baseItem.isDeliveryAvailable = deliveryChargeDetails.isDeliveryAvailable !== false;
            baseItem.deliveryReason = deliveryChargeDetails.reason;
            baseItem.totalPrice = (item.pricing?.unitPrice || 0) + deliveryCharge;
          } else {
            // No active warehouse found
            baseItem.warehouse = null;
            baseItem.totalPrice = item.pricing?.unitPrice || 0;
            baseItem.warehouseName = 'No Warehouse Available';
            baseItem.distance = 0;
            baseItem.deliveryConfig = {};
            baseItem.stock = {};
            baseItem.isDeliveryAvailable = false;
            baseItem.deliveryReason = 'No active warehouse available';
          }
        } else {
          // No warehouse configured for this item
          baseItem.warehouse = null;
          baseItem.totalPrice = item.pricing?.unitPrice || 0;
          
          // Add default values at root level
          baseItem.warehouseName = 'No Warehouse Available';
          baseItem.distance = 0;
          baseItem.deliveryConfig = {};
          baseItem.stock = {};
          baseItem.isDeliveryAvailable = false;
          baseItem.deliveryReason = 'No warehouse assigned';
        }

        return baseItem;
      })
    );

    console.log(`✅ Retrieved ${processedItems.length} inventory items with pricing`);

    return res.status(200).json({
      success: true,
      error: null,
      data: {
        inventory: processedItems,
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(totalItems / limitNum),
          totalItems,
          hasNext: pageNum < Math.ceil(totalItems / limitNum),
          hasPrev: pageNum > 1,
          limit: limitNum
        },
        pincode: pincode || null,
        destination: destinationCoord ? {
          address: destinationCoord.address,
          coordinates: {
            latitude: destinationCoord.latitude,
            longitude: destinationCoord.longitude
          }
        } : null,
        calculatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get inventory with pricing error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.',
      data: null
    });
  }
};

/**
 * Get single inventory item with pricing
 * GET /api/inventory/pricing/:itemId
 */
export const getSingleItemWithPricing = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { pincode } = req.query;

    console.log(`📦 Getting single item pricing. Item: ${itemId}, Pincode: ${pincode || 'none'}`);

    // Get inventory item
    const item = await Inventory.findById(itemId)
      .populate('vendorId', 'name email phone companyName')
      .select('itemDescription category subCategory grade units details specification pricing delivery warehouse primaryImage images');

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Item not found',
        data: null
      });
    }

    if (!item.isActive) {
      return res.status(400).json({
        success: false,
        error: 'Item is not available',
        data: null
      });
    }

    // Build response
    const response = {
      _id: item._id,
      itemDescription: item.itemDescription,
      category: item.category,
      subCategory: item.subCategory,
      grade: item.grade,
      units: item.units,
      details: item.details,
      specification: item.specification,
      primaryImage: item.primaryImage,
      images: item.images,
      vendor: item.vendorId ? {
        name: item.vendorId.name,
        companyName: item.vendorId.companyName,
        email: item.vendorId.email,
        phone: item.vendorId.phone
      } : null,
      pricing: {
        basePrice: item.pricing?.basePrice || 0,
        unitPrice: item.pricing?.unitPrice || 0,
        currency: item.pricing?.currency || 'INR',
        isActive: item.pricing?.isActive || false
      }
    };

    // If pincode provided, calculate delivery charges
    if (pincode) {
      const pincodeResult = await geocodingService.validatePincode(pincode);
      if (!pincodeResult.success) {
        return res.status(400).json({
          success: false,
          error: pincodeResult.error,
          data: null
        });
      }

      const destinationCoord = pincodeResult.data.location;
      if (item.warehouse?.location && item.delivery) {
        const distance = distanceService.calculateDistance(
          item.warehouse.location,
          destinationCoord
        );

        const deliveryChargeDetails = distanceService.calculateDeliveryCharges(
          distance,
          item.delivery,
          item.pricing?.unitPrice || 0
        );

        const deliveryTime = distanceService.estimateDeliveryTime(distance);

        response.delivery = {
          distance: Math.round(distance * 100) / 100,
          deliveryCharge: deliveryChargeDetails.totalDeliveryCharge,
          deliveryTime: deliveryTime.deliveryTime,
          estimatedDays: deliveryTime.estimatedDays,
          warehouse: item.warehouse.name,
          isFreeDelivery: deliveryChargeDetails.isFreeDelivery,
          freeDeliveryReason: deliveryChargeDetails.reason,
          distanceCategory: distanceService.getDistanceCategory(distance)
        };

        response.totalPrice = (item.pricing?.unitPrice || 0) + deliveryChargeDetails.totalDeliveryCharge;
      } else {
        response.delivery = {
          message: 'Warehouse or delivery configuration missing'
        };
        response.totalPrice = item.pricing?.unitPrice || 0;
      }
      response.destination = {
        address: destinationCoord.address,
        coordinates: {
          latitude: destinationCoord.latitude,
          longitude: destinationCoord.longitude
        }
      };
    } else {
      response.delivery = {
        message: 'Provide pincode to calculate delivery charges'
      };
      response.totalPrice = item.pricing?.unitPrice || 0;
    }

    console.log(`✅ Retrieved item ${itemId} with pricing`);

    return res.status(200).json({
      success: true,
      error: null,
      data: {
        item: response,
        pincode: pincode || null,
        calculatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get single item pricing error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.',
      data: null
    });
  }
};

// Validation rules for inventory pricing
export const inventoryPricingRules = [
  query('pincode')
    .optional()
    .isLength({ min: 6, max: 6 })
    .withMessage('Pincode must be exactly 6 digits')
    .isNumeric()
    .withMessage('Pincode must contain only numbers')
    .custom((value) => {
      if (value && value.startsWith('0')) {
        throw new Error('Pincode cannot start with 0');
      }
      return true;
    }),
  
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  
  query('category')
    .optional()
    .isIn(['Cement', 'Iron', 'Concrete Mixer'])
    .withMessage('Category must be one of: Cement, Iron, Concrete Mixer'),
  
  query('subCategory')
    .optional()
    .isString()
    .withMessage('SubCategory must be a string'),
  
  query('search')
    .optional()
    .isString()
    .withMessage('Search must be a string')
];
