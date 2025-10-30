/**
 * Distance calculation service using Haversine formula
 * Calculates distance between two coordinates and delivery charges
 */

class DistanceService {
  constructor() {
    this.EARTH_RADIUS_KM = 6371; // Earth's radius in kilometers
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   * @param {Object} coord1 - First coordinate {latitude, longitude}
   * @param {Object} coord2 - Second coordinate {latitude, longitude}
   * @returns {number} - Distance in kilometers
   */
  calculateDistance(coord1, coord2) {
    try {
      // Convert degrees to radians
      const lat1Rad = this.toRadians(coord1.latitude);
      const lat2Rad = this.toRadians(coord2.latitude);
      const deltaLatRad = this.toRadians(coord2.latitude - coord1.latitude);
      const deltaLonRad = this.toRadians(coord2.longitude - coord1.longitude);

      // Haversine formula
      const a = Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
                Math.cos(lat1Rad) * Math.cos(lat2Rad) *
                Math.sin(deltaLonRad / 2) * Math.sin(deltaLonRad / 2);
      
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = this.EARTH_RADIUS_KM * c;

      // Round to 2 decimal places
      return Math.round(distance * 100) / 100;

    } catch (error) {
      console.error('Distance calculation error:', error);
      throw new Error('Failed to calculate distance');
    }
  }

  /**
   * Calculate delivery charges based on distance and delivery configuration
   * @param {number} distance - Distance in kilometers
   * @param {Object} deliveryConfig - Delivery configuration
   * @param {number} orderAmount - Total order amount (for free delivery threshold)
   * @returns {Object} - Delivery charge details
   */
  calculateDeliveryCharges(distance, deliveryConfig, orderAmount = 0) {
    try {
      const {
        baseDeliveryCharge = 0,
        perKmCharge = 0,
        freeDeliveryThreshold = 0,
        freeDeliveryRadius = 0,
        maxDeliveryRadius = 0
      } = deliveryConfig;

      // Check if delivery is available (maxDeliveryRadius check)
      if (maxDeliveryRadius > 0 && distance > maxDeliveryRadius) {
        return {
          distance,
          baseCharge: 0,
          perKmCharge: 0,
          totalDeliveryCharge: 0,
          isFreeDelivery: false,
          isDeliveryAvailable: false,
          reason: `Delivery not available beyond ${maxDeliveryRadius}km radius`
        };
      }

      // Check for free delivery conditions
      if (freeDeliveryThreshold > 0 && orderAmount >= freeDeliveryThreshold) {
        return {
          distance,
          baseCharge: 0,
          perKmCharge: 0,
          totalDeliveryCharge: 0,
          isFreeDelivery: true,
          isDeliveryAvailable: true,
          reason: `Free delivery for orders above ₹${freeDeliveryThreshold}`
        };
      }

      if (freeDeliveryRadius > 0 && distance <= freeDeliveryRadius) {
        return {
          distance,
          baseCharge: 0,
          perKmCharge: 0,
          totalDeliveryCharge: 0,
          isFreeDelivery: true,
          isDeliveryAvailable: true,
          reason: `Free delivery within ${freeDeliveryRadius}km radius`
        };
      }

      // Calculate delivery charges
      const distanceCharge = distance * perKmCharge;
      const totalDeliveryCharge = baseDeliveryCharge + distanceCharge;

      return {
        distance,
        baseDeliveryCharge,
        perKmCharge,
        distanceCharge: Math.round(distanceCharge * 100) / 100,
        totalDeliveryCharge: Math.round(totalDeliveryCharge * 100) / 100,
        isFreeDelivery: false,
        isDeliveryAvailable: true,
        reason: null
      };

    } catch (error) {
      console.error('Delivery charge calculation error:', error);
      throw new Error('Failed to calculate delivery charges');
    }
  }

  /**
   * Estimate delivery time based on distance
   * @param {number} distance - Distance in kilometers
   * @returns {Object} - Delivery time estimation
   */
  estimateDeliveryTime(distance) {
    try {
      let deliveryTime;
      let deliveryTimeDescription;

      if (distance <= 10) {
        deliveryTime = 'Same day delivery available';
        deliveryTimeDescription = '0-1 days';
      } else if (distance <= 50) {
        deliveryTime = '1-2 days delivery available';
        deliveryTimeDescription = '1-2 days';
      } else if (distance <= 100) {
        deliveryTime = '2-3 days delivery available';
        deliveryTimeDescription = '2-3 days';
      } else if (distance <= 200) {
        deliveryTime = '3-5 days delivery available';
        deliveryTimeDescription = '3-5 days';
      } else {
        deliveryTime = '5-7 days delivery available';
        deliveryTimeDescription = '5-7 days';
      }

      return {
        distance,
        deliveryTime,
        deliveryTimeDescription,
        estimatedDays: this.getEstimatedDays(distance)
      };

    } catch (error) {
      console.error('Delivery time estimation error:', error);
      return {
        distance,
        deliveryTime: 'Delivery time to be confirmed',
        deliveryTimeDescription: 'TBD',
        estimatedDays: null
      };
    }
  }

  /**
   * Get estimated delivery days based on distance
   * @param {number} distance - Distance in kilometers
   * @returns {number|null} - Estimated days
   */
  getEstimatedDays(distance) {
    if (distance <= 10) return 1;
    if (distance <= 50) return 2;
    if (distance <= 100) return 3;
    if (distance <= 200) return 5;
    return 7;
  }

  /**
   * Calculate total price including delivery charges
   * @param {number} basePrice - Base product price
   * @param {number} quantity - Quantity of items
   * @param {Object} deliveryCharges - Delivery charge details
   * @returns {Object} - Total pricing breakdown
   */
  calculateTotalPrice(basePrice, quantity, deliveryCharges) {
    try {
      const subtotal = basePrice * quantity;
      const deliveryCharge = deliveryCharges.totalDeliveryCharge || 0;
      const totalPrice = subtotal + deliveryCharge;

      return {
        basePrice,
        quantity,
        subtotal: Math.round(subtotal * 100) / 100,
        deliveryCharge: Math.round(deliveryCharge * 100) / 100,
        totalPrice: Math.round(totalPrice * 100) / 100,
        isFreeDelivery: deliveryCharges.isFreeDelivery || false,
        freeDeliveryReason: deliveryCharges.reason || null
      };

    } catch (error) {
      console.error('Total price calculation error:', error);
      throw new Error('Failed to calculate total price');
    }
  }

  /**
   * Convert degrees to radians
   * @param {number} degrees - Degrees
   * @returns {number} - Radians
   */
  toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  /**
   * Validate coordinate object
   * @param {Object} coord - Coordinate object
   * @returns {boolean} - Whether coordinate is valid
   */
  isValidCoordinate(coord) {
    if (!coord || typeof coord !== 'object') return false;
    
    const { latitude, longitude } = coord;
    
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
    
    if (latitude < -90 || latitude > 90) return false;
    if (longitude < -180 || longitude > 180) return false;
    
    return true;
  }

  /**
   * Calculate delivery charges for multiple items from different warehouses
   * @param {Array} items - Array of items with warehouse locations
   * @param {Object} destinationCoord - Destination coordinates
   * @returns {Object} - Consolidated delivery information
   */
  calculateMultiWarehouseDelivery(items, destinationCoord) {
    try {
      const deliveryBreakdown = {};
      let totalDeliveryCharge = 0;
      let maxDistance = 0;
      let maxDeliveryTime = 0;

      for (const item of items) {
        const { itemId, warehouse, delivery, quantity, basePrice } = item;
        
        if (!this.isValidCoordinate(warehouse.location) || !this.isValidCoordinate(destinationCoord)) {
          throw new Error(`Invalid coordinates for item ${itemId}`);
        }

        const distance = this.calculateDistance(warehouse.location, destinationCoord);
        const deliveryCharges = this.calculateDeliveryCharges(distance, delivery, basePrice * quantity);
        const deliveryTime = this.estimateDeliveryTime(distance);

        deliveryBreakdown[itemId] = {
          distance,
          deliveryCharge: deliveryCharges.totalDeliveryCharge,
          deliveryTime: deliveryTime.deliveryTime,
          warehouse: warehouse.name,
          isFreeDelivery: deliveryCharges.isFreeDelivery,
          freeDeliveryReason: deliveryCharges.reason
        };

        totalDeliveryCharge += deliveryCharges.totalDeliveryCharge;
        maxDistance = Math.max(maxDistance, distance);
        maxDeliveryTime = Math.max(maxDeliveryTime, deliveryTime.estimatedDays || 0);
      }

      return {
        deliveryBreakdown,
        totalDeliveryCharge: Math.round(totalDeliveryCharge * 100) / 100,
        maxDistance: Math.round(maxDistance * 100) / 100,
        estimatedDeliveryDays: maxDeliveryTime,
        totalItems: items.length
      };

    } catch (error) {
      console.error('Multi-warehouse delivery calculation error:', error);
      throw new Error('Failed to calculate multi-warehouse delivery charges');
    }
  }

  /**
   * Get distance category for display purposes
   * @param {number} distance - Distance in kilometers
   * @returns {string} - Distance category
   */
  getDistanceCategory(distance) {
    if (distance <= 10) return 'Local';
    if (distance <= 50) return 'Regional';
    if (distance <= 100) return 'State';
    if (distance <= 200) return 'Inter-state';
    return 'Long Distance';
  }
}

// Create singleton instance
const distanceService = new DistanceService();

export default distanceService;
