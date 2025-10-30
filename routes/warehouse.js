import express from 'express';
import { body, param } from 'express-validator';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
  getAvailableWarehouses,
  getWarehouseByVendor,
  updateVendorWarehouse,
  createWarehouse,
  deleteWarehouse,
  searchWarehouses,
  listWarehouses,
  syncAllInventoryWarehouses,
  cleanupOrphanedWarehouses
} from '../controllers/warehouse.js';

const router = express.Router();

// Validation middleware
const vendorIdValidation = [
  param('vendorId')
    .isMongoId()
    .withMessage('Valid vendor ID is required')
];

const warehouseValidation = [
  body('warehouseName')
    .notEmpty()
    .withMessage('Warehouse name is required')
    .trim(),
  body('location.address')
    .notEmpty()
    .withMessage('Warehouse address is required')
    .trim(),
  body('location.city')
    .notEmpty()
    .withMessage('City is required')
    .trim(),
  body('location.state')
    .notEmpty()
    .withMessage('State is required')
    .trim(),
  body('location.pincode')
    .matches(/^[1-9][0-9]{5}$/)
    .withMessage('Valid 6-digit pincode is required'),
  body('location.coordinates.latitude')
    .isFloat({ min: -90, max: 90 })
    .withMessage('Valid latitude is required'),
  body('location.coordinates.longitude')
    .isFloat({ min: -180, max: 180 })
    .withMessage('Valid longitude is required'),
  body('categories')
    .isArray({ min: 1 })
    .withMessage('At least one category is required'),
  body('categories.*')
    .isIn(['Cement', 'Iron', 'Steel', 'Concrete Mixer', 'Concrete Mix'])
    .withMessage('Invalid category'),
  body('deliveryConfig.baseDeliveryCharge')
    .isFloat({ min: 0 })
    .withMessage('Base delivery charge must be a positive number'),
  body('deliveryConfig.perKmCharge')
    .isFloat({ min: 0 })
    .withMessage('Per km charge must be a positive number'),
  body('deliveryConfig.minimumOrder')
    .isFloat({ min: 0 })
    .withMessage('Minimum order must be a positive number')
];

const warehouseUpdateValidation = [
  body('warehouseName')
    .optional()
    .notEmpty()
    .withMessage('Warehouse name cannot be empty')
    .trim(),
  body('location.address')
    .optional()
    .notEmpty()
    .withMessage('Warehouse address cannot be empty')
    .trim(),
  body('location.city')
    .optional()
    .notEmpty()
    .withMessage('City cannot be empty')
    .trim(),
  body('location.state')
    .optional()
    .notEmpty()
    .withMessage('State cannot be empty')
    .trim(),
  body('location.pincode')
    .optional()
    .matches(/^[1-9][0-9]{5}$/)
    .withMessage('Valid 6-digit pincode is required'),
  body('location.coordinates.latitude')
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage('Valid latitude is required'),
  body('location.coordinates.longitude')
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage('Valid longitude is required'),
  body('categories')
    .optional()
    .isArray({ min: 1 })
    .withMessage('At least one category is required'),
  body('categories.*')
    .optional()
    .isIn(['Cement', 'Iron', 'Steel', 'Concrete Mixer', 'Concrete Mix'])
    .withMessage('Invalid category'),
  body('deliveryConfig.baseDeliveryCharge')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Base delivery charge must be a positive number'),
  body('deliveryConfig.perKmCharge')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Per km charge must be a positive number'),
  body('deliveryConfig.minimumOrder')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Minimum order must be a positive number')
];

// Public routes (no authentication required)
router.get('/available', getAvailableWarehouses);
router.get('/search', searchWarehouses);
router.get('/list', listWarehouses);

// Admin/Manager routes
router.post('/create',
  authenticateToken,
  requireRole(['admin', 'manager']),
  warehouseValidation,
  createWarehouse
);

router.get('/vendor/:vendorId',
  authenticateToken,
  requireRole(['admin', 'manager']),
  vendorIdValidation,
  getWarehouseByVendor
);

router.put('/vendor/:vendorId',
  authenticateToken,
  requireRole(['admin', 'manager']),
  vendorIdValidation,
  warehouseUpdateValidation,
  updateVendorWarehouse
);

router.delete('/:vendorId',
  authenticateToken,
  requireRole(['admin', 'manager']),
  vendorIdValidation,
  deleteWarehouse
);

// Manual sync endpoint for inventory warehouse data
router.post('/sync-inventory',
  authenticateToken,
  requireRole(['admin', 'manager']),
  syncAllInventoryWarehouses
);

// Cleanup orphaned warehouse references
router.post('/cleanup-orphaned',
  authenticateToken,
  requireRole(['admin', 'manager']),
  cleanupOrphanedWarehouses
);

export default router;
