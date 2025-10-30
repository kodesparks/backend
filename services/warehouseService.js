import User from '../models/User.js';
import geocodingService from './geocodingService.js';

class WarehouseService {
  /**
   * Find the nearest warehouse for a given pincode and category
   * @param {string} pincode - Customer pincode
   * @param {string} category - Product category
   * @returns {Object} Nearest warehouse with delivery calculation
   */
  static async findNearestWarehouse(pincode, category) {
    try {
      console.log(`🏭 Finding nearest warehouse for pincode: ${pincode}, category: ${category}`);
      
      // Get customer coordinates from pincode
      const customerLocation = await geocodingService.validatePincode(pincode);
      if (!customerLocation.isValid) {
        throw new Error(`Invalid pincode: ${pincode}`);
      }
      
      // Find nearest warehouses for this category
      const nearestWarehouses = await this.findNearestWarehousesFromUsers(
        customerLocation.location,
        [category],
        500 // Max 500km radius
      );
      
      if (nearestWarehouses.length === 0) {
        console.log(`❌ No warehouses found for category: ${category} within 500km`);
        return {
          found: false,
          message: `No warehouses available for ${category} in your area`
        };
      }
      
      const nearestWarehouse = nearestWarehouses[0];
      console.log(`✅ Found nearest warehouse: ${nearestWarehouse.warehouseName} (${nearestWarehouse.distance.toFixed(2)}km)`);
      
      // Calculate delivery charges
      const deliveryCharge = this.calculateDeliveryCharge(
        nearestWarehouse.distance,
        nearestWarehouse.deliveryConfig
      );
      
      // Calculate delivery time
      const deliveryTime = this.calculateDeliveryTime(nearestWarehouse.distance);
      
      return {
        found: true,
        warehouse: {
          id: nearestWarehouse._id,
          name: nearestWarehouse.warehouseName,
          vendorId: nearestWarehouse.vendorId,
          location: nearestWarehouse.location,
          distance: nearestWarehouse.distance,
          deliveryConfig: nearestWarehouse.deliveryConfig,
          operatingHours: nearestWarehouse.operatingHours
        },
        delivery: {
          distance: nearestWarehouse.distance,
          deliveryCharge,
          deliveryTime,
          freeDeliveryThreshold: nearestWarehouse.deliveryConfig.freeDeliveryThreshold,
          freeDeliveryRadius: nearestWarehouse.deliveryConfig.freeDeliveryRadius
        }
      };
      
    } catch (error) {
      console.error('Error finding nearest warehouse:', error);
      return {
        found: false,
        message: error.message
      };
    }
  }
  
  /**
   * Find nearest warehouses for multiple categories
   * @param {string} pincode - Customer pincode
   * @param {Array} categories - Array of product categories
   * @returns {Object} Nearest warehouses for each category
   */
  static async findNearestWarehousesForCategories(pincode, categories) {
    try {
      console.log(`🏭 Finding nearest warehouses for pincode: ${pincode}, categories: ${categories.join(', ')}`);
      
      const results = {};
      
      // Process each category
      for (const category of categories) {
        results[category] = await this.findNearestWarehouse(pincode, category);
      }
      
      return results;
      
    } catch (error) {
      console.error('Error finding nearest warehouses for categories:', error);
      return {
        error: error.message
      };
    }
  }
  
  /**
   * Calculate delivery charge based on distance and warehouse config
   * @param {number} distance - Distance in km
   * @param {Object} deliveryConfig - Warehouse delivery configuration
   * @returns {number} Delivery charge
   */
  static calculateDeliveryCharge(distance, deliveryConfig) {
    const { baseDeliveryCharge, perKmCharge, freeDeliveryThreshold, freeDeliveryRadius } = deliveryConfig;
    
    // Check if within free delivery radius
    if (distance <= freeDeliveryRadius) {
      return 0;
    }
    
    // Calculate base charge + per km charge
    const totalCharge = baseDeliveryCharge + (distance * perKmCharge);
    
    return Math.round(totalCharge * 100) / 100; // Round to 2 decimal places
  }
  
  /**
   * Calculate estimated delivery time based on distance
   * @param {number} distance - Distance in km
   * @returns {string} Estimated delivery time
   */
  static calculateDeliveryTime(distance) {
    if (distance <= 10) {
      return "Same day delivery available";
    } else if (distance <= 50) {
      return "1-2 days delivery available";
    } else if (distance <= 100) {
      return "2-3 days delivery available";
    } else if (distance <= 200) {
      return "3-5 days delivery available";
    } else {
      return "5-7 days delivery available";
    }
  }
  
  /**
   * Calculate distance between two coordinates using Haversine formula
   * @param {number} lat1 - Latitude 1
   * @param {number} lon1 - Longitude 1
   * @param {number} lat2 - Latitude 2
   * @param {number} lon2 - Longitude 2
   * @returns {number} Distance in kilometers
   */
  static calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    return distance;
  }
  
  /**
   * Find nearest warehouses from User model (vendors with warehouse info)
   * @param {Object} customerCoordinates - Customer coordinates
   * @param {Array} categories - Product categories
   * @param {number} maxDistance - Maximum distance in km
   * @returns {Array} Nearest warehouses with distance
   */
  static async findNearestWarehousesFromUsers(customerCoordinates, categories, maxDistance = 500) {
    const { latitude: customerLat, longitude: customerLng } = customerCoordinates;
    
    // Find vendors that have warehouse info and serve the required categories
    const vendors = await User.find({
      role: 'vendor',
      isActive: true,
      'warehouse.categories': { $in: categories },
      'warehouse.location.coordinates.latitude': { $exists: true },
      'warehouse.location.coordinates.longitude': { $exists: true }
    }).select('name email phone companyName warehouse');
    
    // Calculate distances and filter by max distance
    const warehousesWithDistance = vendors
      .map(vendor => {
        const distance = this.calculateDistance(
          customerLat, customerLng,
          vendor.warehouse.location.coordinates.latitude,
          vendor.warehouse.location.coordinates.longitude
        );
        
        return {
          _id: vendor._id,
          vendorId: vendor._id,
          warehouseName: vendor.warehouse.warehouseName,
          location: vendor.warehouse.location,
          categories: vendor.warehouse.categories,
          deliveryConfig: vendor.warehouse.deliveryConfig,
          operatingHours: vendor.warehouse.operatingHours,
          isVerified: vendor.warehouse.isVerified,
          vendor: {
            name: vendor.name,
            email: vendor.email,
            phone: vendor.phone,
            companyName: vendor.companyName
          },
          distance
        };
      })
      .filter(warehouse => warehouse.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
    
    return warehousesWithDistance;
  }

  /**
   * Get warehouse by vendor ID
   * @param {string} vendorId - Vendor ID
   * @returns {Object} Warehouse details
   */
  static async getWarehouseByVendorId(vendorId) {
    try {
      const vendor = await User.findById(vendorId)
        .select('name email phone companyName warehouse');
      
      if (!vendor || !vendor.warehouse) {
        throw new Error('Warehouse not found for this vendor');
      }
      
      return {
        _id: vendor._id,
        vendorId: vendor._id,
        warehouseName: vendor.warehouse.warehouseName,
        location: vendor.warehouse.location,
        categories: vendor.warehouse.categories,
        deliveryConfig: vendor.warehouse.deliveryConfig,
        operatingHours: vendor.warehouse.operatingHours,
        isVerified: vendor.warehouse.isVerified,
        vendor: {
          name: vendor.name,
          email: vendor.email,
          phone: vendor.phone,
          companyName: vendor.companyName
        }
      };
    } catch (error) {
      console.error('Error getting warehouse by vendor ID:', error);
      throw error;
    }
  }
  
  /**
   * Update vendor warehouse information
   * @param {string} vendorId - Vendor ID
   * @param {Object} warehouseData - Warehouse data
   * @returns {Object} Updated vendor with warehouse
   */
  static async updateVendorWarehouse(vendorId, warehouseData) {
    try {
      const vendor = await User.findByIdAndUpdate(
        vendorId,
        { warehouse: warehouseData },
        { new: true, runValidators: true }
      );
      
      if (!vendor) {
        throw new Error('Vendor not found');
      }
      
      console.log(`✅ Updated warehouse for vendor: ${vendor.name}`);
      return vendor;
    } catch (error) {
      console.error('Error updating vendor warehouse:', error);
      throw error;
    }
  }
  
  /**
   * Get all vendors with warehouse information
   * @returns {Array} List of vendors with warehouses
   */
  static async getAllVendorsWithWarehouses() {
    try {
      const vendors = await User.find({
        role: 'vendor',
        isActive: true,
        'warehouse.warehouseName': { $exists: true }
      }).select('name email phone companyName warehouse');
      
      return vendors;
    } catch (error) {
      console.error('Error getting vendors with warehouses:', error);
      throw error;
    }
  }
}

export default WarehouseService;
