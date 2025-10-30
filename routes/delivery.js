import express from 'express';
import { 
  calculateDelivery, 
  estimateDeliveryTime,
  calculateDeliveryRules 
} from '../controllers/delivery.js';

const router = express.Router();

/**
 * @route   POST /api/delivery/calculate
 * @desc    Calculate delivery charges for items based on pincode
 * @access  Public
 * @body    { 
 *   pincode: string, 
 *   items: [{ itemId: string, quantity: number }] 
 * }
 * @returns { 
 *   success: boolean, 
 *   data: { 
 *     pincode, 
 *     destination: { address, coordinates }, 
 *     deliveryCharges: { itemId: { distance, deliveryCharge, deliveryTime, warehouse } },
 *     totalDeliveryCharge: number,
 *     totalItems: number,
 *     calculatedAt: string
 *   } 
 * }
 */
router.post('/calculate', calculateDeliveryRules, calculateDelivery);

/**
 * @route   GET /api/delivery/estimate-time/:pincode
 * @desc    Get delivery time estimation for a pincode from all warehouses
 * @access  Public
 * @params  pincode: string (6-digit pincode)
 * @returns { 
 *   success: boolean, 
 *   data: { 
 *     pincode, 
 *     destination: { address, coordinates },
 *     deliveryEstimates: [{ warehouse, category, distance, deliveryTime, estimatedDays }],
 *     fastestDelivery: number,
 *     slowestDelivery: number
 *   } 
 * }
 */
router.get('/estimate-time/:pincode', estimateDeliveryTime);

export default router;
