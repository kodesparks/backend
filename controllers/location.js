import { body, validationResult } from 'express-validator';
import geocodingService from '../services/geocodingService.js';

/**
 * Validate pincode and get coordinates using Google Maps API
 * POST /api/location/validate-pincode
 */
export const validatePincode = async (req, res) => {
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

    const { pincode } = req.body;

    console.log(`📍 Validating pincode: ${pincode}`);

    // Call geocoding service
    const result = await geocodingService.validatePincode(pincode);

    if (result.success) {
      console.log(`✅ Pincode ${pincode} validated successfully`);
      return res.status(200).json({
        success: true,
        error: null,
        data: result.data
      });
    } else {
      console.log(`❌ Pincode ${pincode} validation failed: ${result.error}`);
      return res.status(400).json({
        success: false,
        error: result.error,
        data: result.data
      });
    }

  } catch (error) {
    console.error('Pincode validation error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.',
      data: null
    });
  }
};

/**
 * Get cache statistics for geocoding service
 * GET /api/location/cache-stats
 */
export const getCacheStats = async (req, res) => {
  try {
    const stats = geocodingService.getCacheStats();
    
    return res.status(200).json({
      success: true,
      data: {
        cache: stats,
        message: 'Cache statistics retrieved successfully'
      }
    });

  } catch (error) {
    console.error('Cache stats error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve cache statistics',
      data: null
    });
  }
};

/**
 * Clear geocoding cache
 * DELETE /api/location/cache
 */
export const clearCache = async (req, res) => {
  try {
    geocodingService.clearCache();
    
    return res.status(200).json({
      success: true,
      data: {
        message: 'Cache cleared successfully'
      }
    });

  } catch (error) {
    console.error('Clear cache error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to clear cache',
      data: null
    });
  }
};

// Validation rules for pincode validation
export const validatePincodeRules = [
  body('pincode')
    .notEmpty()
    .withMessage('Pincode is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('Pincode must be exactly 6 digits')
    .isNumeric()
    .withMessage('Pincode must contain only numbers')
    .custom((value) => {
      // Check if pincode starts with 0 (invalid in India)
      if (value.startsWith('0')) {
        throw new Error('Pincode cannot start with 0');
      }
      return true;
    })
];
