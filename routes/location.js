import express from 'express';
import { 
  validatePincode, 
  getCacheStats, 
  clearCache,
  validatePincodeRules 
} from '../controllers/location.js';

const router = express.Router();

/**
 * @route   POST /api/location/validate-pincode
 * @desc    Validate pincode and get coordinates using Google Maps API
 * @access  Public
 * @body    { pincode: string }
 * @returns { success: boolean, data: { pincode, location: { latitude, longitude, address }, isValid } }
 */
router.post('/validate-pincode', validatePincodeRules, validatePincode);

/**
 * @route   GET /api/location/cache-stats
 * @desc    Get geocoding cache statistics
 * @access  Public
 * @returns { success: boolean, data: { cache: { size, maxSize, expiryHours } } }
 */
router.get('/cache-stats', getCacheStats);

/**
 * @route   DELETE /api/location/cache
 * @desc    Clear geocoding cache
 * @access  Public
 * @returns { success: boolean, data: { message } }
 */
router.delete('/cache', clearCache);

export default router;
