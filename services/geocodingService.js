import axios from 'axios';

class GeocodingService {
  constructor() {
    this.apiKey = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCvQvl8Tho4uPSGbI5LAgNB2sk6oWBh5Xw';
    this.baseUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
    this.cache = new Map(); // Simple in-memory cache
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  }

  /**
   * Validate pincode and get coordinates using Google Maps API
   * @param {string} pincode - 6 digit pincode
   * @returns {Promise<Object>} - Validation result with coordinates
   */
  async validatePincode(pincode) {
    try {
      // Validate pincode format
      if (!this.isValidPincodeFormat(pincode)) {
        return {
          success: false,
          error: 'Invalid pincode format. Please enter a valid 6-digit pincode.',
          data: null
        };
      }

      // Check cache first
      const cachedResult = this.getFromCache(pincode);
      if (cachedResult) {
        console.log(`📍 Using cached data for pincode: ${pincode}`);
        return cachedResult;
      }

      // Call Google Maps API
      const result = await this.callGoogleMapsAPI(pincode);
      
      // Cache the result
      this.setCache(pincode, result);
      
      return result;

    } catch (error) {
      console.error('Geocoding service error:', error);
      
      // Try fallback methods
      const fallbackResult = await this.tryFallbackMethods(pincode);
      if (fallbackResult.success) {
        return fallbackResult;
      }

      return {
        success: false,
        error: 'Unable to validate pincode. Please try again later.',
        data: null
      };
    }
  }

  /**
   * Validate pincode format
   * @param {string} pincode - Pincode to validate
   * @returns {boolean} - Whether pincode format is valid
   */
  isValidPincodeFormat(pincode) {
    // Indian pincode format: 6 digits
    const pincodeRegex = /^[1-9][0-9]{5}$/;
    return pincodeRegex.test(pincode);
  }

  /**
   * Call Google Maps Geocoding API
   * @param {string} pincode - Pincode to geocode
   * @returns {Promise<Object>} - API response
   */
  async callGoogleMapsAPI(pincode) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          address: `${pincode}, India`,
          key: this.apiKey
        },
        timeout: 10000 // 10 second timeout
      });

      const data = response.data;

      if (data.status === 'OK' && data.results.length > 0) {
        const result = data.results[0];
        const location = result.geometry.location;
        const address = result.formatted_address;

        return {
          success: true,
          error: null,
          data: {
            pincode,
            location: {
              latitude: location.lat,
              longitude: location.lng,
              address
            },
            isValid: true
          }
        };
      } else if (data.status === 'ZERO_RESULTS') {
        return {
          success: false,
          error: 'Pincode not found. Please check and try again.',
          data: {
            pincode,
            location: null,
            isValid: false
          }
        };
      } else if (data.status === 'OVER_QUERY_LIMIT') {
        console.error('Google Maps API quota exceeded');
        return {
          success: false,
          error: 'Service temporarily unavailable. Please try again later.',
          data: null
        };
      } else {
        console.error('Google Maps API error:', data.status, data.error_message);
        return {
          success: false,
          error: 'Unable to validate pincode. Please try again later.',
          data: null
        };
      }

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        console.error('Google Maps API timeout');
        return {
          success: false,
          error: 'Request timeout. Please try again later.',
          data: null
        };
      }
      
      console.error('Google Maps API request error:', error.message);
      throw error;
    }
  }

  /**
   * Try fallback methods when Google Maps API fails
   * @param {string} pincode - Pincode to validate
   * @returns {Promise<Object>} - Fallback result
   */
  async tryFallbackMethods(pincode) {
    try {
      // Fallback 1: Use approximate coordinates based on pincode first digit
      const approximateLocation = this.getApproximateLocation(pincode);
      
      if (approximateLocation) {
        console.log(`📍 Using approximate location for pincode: ${pincode}`);
        return {
          success: true,
          error: null,
          data: {
            pincode,
            location: approximateLocation,
            isValid: true,
            isApproximate: true
          }
        };
      }

      return {
        success: false,
        error: 'Unable to validate pincode using fallback methods.',
        data: null
      };

    } catch (error) {
      console.error('Fallback methods error:', error);
      return {
        success: false,
        error: 'All validation methods failed.',
        data: null
      };
    }
  }

  /**
   * Get approximate location based on pincode first digit
   * @param {string} pincode - Pincode
   * @returns {Object|null} - Approximate coordinates
   */
  getApproximateLocation(pincode) {
    const firstDigit = pincode.charAt(0);
    
    // Approximate coordinates for Indian regions based on pincode first digit
    const regionCoordinates = {
      '1': { latitude: 28.7041, longitude: 77.1025, region: 'Delhi/NCR' },
      '2': { latitude: 28.7041, longitude: 77.1025, region: 'Delhi/NCR' },
      '3': { latitude: 26.2389, longitude: 73.0243, region: 'Rajasthan' },
      '4': { latitude: 19.0760, longitude: 72.8777, region: 'Maharashtra' },
      '5': { latitude: 17.3850, longitude: 78.4867, region: 'Telangana/Andhra Pradesh' },
      '6': { latitude: 12.9716, longitude: 77.5946, region: 'Karnataka' },
      '7': { latitude: 22.5726, longitude: 88.3639, region: 'West Bengal' },
      '8': { latitude: 23.0225, longitude: 72.5714, region: 'Gujarat' },
      '9': { latitude: 30.7333, longitude: 76.7794, region: 'Punjab/Haryana' }
    };

    const region = regionCoordinates[firstDigit];
    if (region) {
      return {
        latitude: region.latitude,
        longitude: region.longitude,
        address: `Approximate location in ${region.region} region (Pincode: ${pincode})`
      };
    }

    return null;
  }

  /**
   * Get data from cache
   * @param {string} pincode - Pincode
   * @returns {Object|null} - Cached result
   */
  getFromCache(pincode) {
    const cached = this.cache.get(pincode);
    if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
      return cached.data;
    }
    
    // Remove expired cache entry
    if (cached) {
      this.cache.delete(pincode);
    }
    
    return null;
  }

  /**
   * Set data in cache
   * @param {string} pincode - Pincode
   * @param {Object} data - Data to cache
   */
  setCache(pincode, data) {
    this.cache.set(pincode, {
      data,
      timestamp: Date.now()
    });

    // Simple cache cleanup - remove oldest entries if cache gets too large
    if (this.cache.size > 1000) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    console.log('🗑️  Geocoding cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} - Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: 1000,
      expiryHours: 24
    };
  }
}

// Create singleton instance
const geocodingService = new GeocodingService();

export default geocodingService;
