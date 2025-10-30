import { validationResult } from 'express-validator';
import WarehouseService from '../services/warehouseService.js';
import User from '../models/User.js';
import Inventory from '../models/Inventory.js';

/**
 * Get all available warehouses for inventory creation
 * GET /api/warehouse/available
 */
export const getAvailableWarehouses = async (req, res) => {
  try {
    console.log('🏭 Getting available warehouses for inventory creation');
    
    const warehouses = await WarehouseService.getAllVendorsWithWarehouses();
    
    // Format warehouses for frontend selection
    const formattedWarehouses = warehouses.map(vendor => ({
      vendorId: vendor._id,
      vendorName: vendor.name,
      companyName: vendor.companyName,
      warehouse: {
        warehouseName: vendor.warehouse.warehouseName,
        location: vendor.warehouse.location,
        categories: vendor.warehouse.categories,
        deliveryConfig: vendor.warehouse.deliveryConfig,
        operatingHours: vendor.warehouse.operatingHours,
        isVerified: vendor.warehouse.isVerified
      }
    }));
    
    console.log(`✅ Found ${formattedWarehouses.length} available warehouses`);
    
    res.status(200).json({
      success: true,
      message: 'Available warehouses retrieved successfully',
      data: {
        warehouses: formattedWarehouses,
        count: formattedWarehouses.length
      }
    });
    
  } catch (error) {
    console.error('Get available warehouses error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Get warehouse details by vendor ID
 * GET /api/warehouse/vendor/:vendorId
 */
export const getWarehouseByVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;
    
    console.log(`🏭 Getting warehouse details for vendor: ${vendorId}`);
    
    const warehouse = await WarehouseService.getWarehouseByVendorId(vendorId);
    
    res.status(200).json({
      success: true,
      message: 'Warehouse details retrieved successfully',
      data: warehouse
    });
    
  } catch (error) {
    console.error('Get warehouse by vendor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Update vendor warehouse information
 * PUT /api/warehouse/vendor/:vendorId
 */
export const updateVendorWarehouse = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }
    
    const { vendorId } = req.params;
    const warehouseData = req.body;
    
    console.log(`🏭 Updating warehouse for vendor: ${vendorId}`);
    
    const updatedVendor = await WarehouseService.updateVendorWarehouse(vendorId, warehouseData);
    
    // 🔄 SYNC: Update all inventory items that reference this warehouse
    await syncInventoryWarehouseData(vendorId, updatedVendor.warehouse);
    
    res.status(200).json({
      success: true,
      message: 'Warehouse updated successfully',
      data: {
        vendorId: updatedVendor._id,
        vendorName: updatedVendor.name,
        warehouse: updatedVendor.warehouse
      }
    });
    
  } catch (error) {
    console.error('Update vendor warehouse error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Create a new warehouse (standalone warehouse creation)
 * POST /api/warehouse/create
 */
export const createWarehouse = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const {
      warehouseName,
      location,
      categories,
      deliveryConfig,
      operatingHours,
      isVerified = false
    } = req.body;

    console.log('🏭 Creating new warehouse:', warehouseName);

    // Create a new vendor user for this warehouse
    const vendorData = {
      name: `Vendor-${warehouseName}`,
      email: `vendor-${Date.now()}@warehouse.com`,
      phone: '0000000000',
      password: 'TempPassword123!',
      address: location.address,
      pincode: location.pincode,
      role: 'vendor',
      companyName: warehouseName,
      warehouse: {
        warehouseName,
        location,
        categories,
        deliveryConfig,
        operatingHours,
        isVerified
      }
    };

    const newVendor = new User(vendorData);
    await newVendor.save();

    console.log(`✅ Created warehouse: ${warehouseName} with vendor ID: ${newVendor._id}`);

    res.status(201).json({
      success: true,
      message: 'Warehouse created successfully',
      data: {
        vendorId: newVendor._id,
        vendorName: newVendor.name,
        warehouse: newVendor.warehouse
      }
    });

  } catch (error) {
    console.error('Create warehouse error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Delete a warehouse (soft delete by deactivating vendor)
 * DELETE /api/warehouse/:vendorId
 */
export const deleteWarehouse = async (req, res) => {
  try {
    const { vendorId } = req.params;

    console.log(`🏭 Deleting warehouse for vendor: ${vendorId}`);

    const vendor = await User.findById(vendorId);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      });
    }

    if (vendor.role !== 'vendor') {
      return res.status(400).json({
        success: false,
        message: 'User is not a vendor'
      });
    }

    // Soft delete by deactivating the vendor
    vendor.isActive = false;
    await vendor.save();

    console.log(`✅ Deleted warehouse for vendor: ${vendor.name}`);

    res.status(200).json({
      success: true,
      message: 'Warehouse deleted successfully',
      data: {
        vendorId: vendor._id,
        vendorName: vendor.name,
        isActive: vendor.isActive
      }
    });

  } catch (error) {
    console.error('Delete warehouse error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Search warehouses by location, categories, or name
 * GET /api/warehouse/search?q=searchTerm&category=Cement&city=Mumbai
 */
export const searchWarehouses = async (req, res) => {
  try {
    const { q, category, city, state, pincode, isVerified } = req.query;

    console.log('🔍 Searching warehouses with filters:', { q, category, city, state, pincode, isVerified });

    // Build search query
    const query = {
      role: 'vendor',
      isActive: true,
      'warehouse.warehouseName': { $exists: true }
    };

    // Add search filters
    if (q) {
      query.$or = [
        { 'warehouse.warehouseName': { $regex: q, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } },
        { companyName: { $regex: q, $options: 'i' } }
      ];
    }

    if (category) {
      query['warehouse.categories'] = { $in: [category] };
    }

    if (city) {
      query['warehouse.location.city'] = { $regex: city, $options: 'i' };
    }

    if (state) {
      query['warehouse.location.state'] = { $regex: state, $options: 'i' };
    }

    if (pincode) {
      query['warehouse.location.pincode'] = pincode;
    }

    if (isVerified !== undefined) {
      query['warehouse.isVerified'] = isVerified === 'true';
    }

    const warehouses = await User.find(query)
      .select('name companyName email phone warehouse')
      .sort({ 'warehouse.warehouseName': 1 });

    // Format response
    const formattedWarehouses = warehouses.map(vendor => ({
      vendorId: vendor._id,
      vendorName: vendor.name,
      companyName: vendor.companyName,
      email: vendor.email,
      phone: vendor.phone,
      warehouse: {
        warehouseName: vendor.warehouse.warehouseName,
        location: vendor.warehouse.location,
        categories: vendor.warehouse.categories,
        deliveryConfig: vendor.warehouse.deliveryConfig,
        operatingHours: vendor.warehouse.operatingHours,
        isVerified: vendor.warehouse.isVerified
      }
    }));

    console.log(`✅ Found ${formattedWarehouses.length} warehouses matching search criteria`);

    res.status(200).json({
      success: true,
      message: 'Warehouse search completed successfully',
      data: {
        warehouses: formattedWarehouses,
        count: formattedWarehouses.length,
        filters: { q, category, city, state, pincode, isVerified }
      }
    });

  } catch (error) {
    console.error('Search warehouses error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Get all warehouses with pagination and filtering
 * GET /api/warehouse/list?page=1&limit=10&category=Cement&verified=true
 */
export const listWarehouses = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      category,
      city,
      state,
      isVerified,
      sortBy = 'warehouseName',
      sortOrder = 'asc'
    } = req.query;

    console.log('📋 Listing warehouses with pagination:', { page, limit, category, city, state, isVerified });

    // Build query
    const query = {
      role: 'vendor',
      isActive: true,
      'warehouse.warehouseName': { $exists: true }
    };

    if (category) {
      query['warehouse.categories'] = { $in: [category] };
    }

    if (city) {
      query['warehouse.location.city'] = { $regex: city, $options: 'i' };
    }

    if (state) {
      query['warehouse.location.state'] = { $regex: state, $options: 'i' };
    }

    if (isVerified !== undefined) {
      query['warehouse.isVerified'] = isVerified === 'true';
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    const sortField = `warehouse.${sortBy}`;
    const sortDirection = sortOrder === 'desc' ? -1 : 1;

    // Execute query
    const warehouses = await User.find(query)
      .select('name companyName email phone warehouse')
      .sort({ [sortField]: sortDirection })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);

    // Format response
    const formattedWarehouses = warehouses.map(vendor => ({
      vendorId: vendor._id,
      vendorName: vendor.name,
      companyName: vendor.companyName,
      email: vendor.email,
      phone: vendor.phone,
      warehouse: {
        warehouseName: vendor.warehouse.warehouseName,
        location: vendor.warehouse.location,
        categories: vendor.warehouse.categories,
        deliveryConfig: vendor.warehouse.deliveryConfig,
        operatingHours: vendor.warehouse.operatingHours,
        isVerified: vendor.warehouse.isVerified
      }
    }));

    console.log(`✅ Listed ${formattedWarehouses.length} warehouses (page ${page} of ${Math.ceil(total / limit)})`);

    res.status(200).json({
      success: true,
      message: 'Warehouses listed successfully',
      data: {
        warehouses: formattedWarehouses,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          hasNext: skip + warehouses.length < total,
          hasPrev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('List warehouses error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Sync inventory warehouse data when warehouse configuration is updated
 * @param {string} vendorId - Vendor ID whose warehouse was updated
 * @param {Object} updatedWarehouse - Updated warehouse data
 */
const syncInventoryWarehouseData = async (vendorId, updatedWarehouse) => {
  try {
    console.log(`🔄 Syncing inventory warehouse data for vendor: ${vendorId}`);
    
    // Find all inventory items that reference this warehouse
    const inventoryItems = await Inventory.find({
      'warehouses.warehouseId': vendorId,
      isActive: true
    });
    
    console.log(`📦 Found ${inventoryItems.length} inventory items to sync`);
    
    // Update each inventory item's warehouse data
    const updatePromises = inventoryItems.map(async (inventory) => {
      console.log(`📦 Updating inventory: ${inventory.itemDescription}`);
      const updatedWarehouses = inventory.warehouses.map(warehouse => {
        console.log(`  - Checking warehouse: ${warehouse.warehouseName} (ID: ${warehouse.warehouseId}) vs ${vendorId}`);
        if (warehouse.warehouseId.toString() === vendorId) {
          console.log(`    ✅ Match found! Updating ${warehouse.warehouseName}`);
          console.log(`    Old maxDeliveryRadius: ${warehouse.deliveryConfig?.maxDeliveryRadius}km`);
          console.log(`    New maxDeliveryRadius: ${updatedWarehouse.deliveryConfig?.maxDeliveryRadius}km`);
          return {
            ...warehouse.toObject(),
            warehouseName: updatedWarehouse.warehouseName,
            location: updatedWarehouse.location,
            deliveryConfig: updatedWarehouse.deliveryConfig,
            operatingHours: updatedWarehouse.operatingHours,
            isVerified: updatedWarehouse.isVerified
          };
        }
        console.log(`    ❌ No match`);
        return warehouse;
      });
      
      inventory.warehouses = updatedWarehouses;
      return inventory.save();
    });
    
    await Promise.all(updatePromises);
    
    console.log(`✅ Successfully synced warehouse data for ${inventoryItems.length} inventory items`);
    
  } catch (error) {
    console.error('❌ Error syncing inventory warehouse data:', error);
    // Don't throw error to avoid breaking the main warehouse update
  }
};

/**
 * Clean up orphaned warehouse references in inventory items
 * This function removes warehouse references that don't exist in the User model
 */
const cleanupOrphanedWarehouseReferences = async () => {
  try {
    console.log('🧹 Cleaning up orphaned warehouse references...');
    
    // Get all valid vendor IDs that have warehouses
    const validVendors = await User.find({
      role: 'vendor',
      isActive: true,
      'warehouse.warehouseName': { $exists: true }
    }).select('_id');
    
    const validVendorIds = validVendors.map(vendor => vendor._id.toString());
    console.log(`📋 Found ${validVendorIds.length} valid vendors:`, validVendorIds);

    // SAFETY GUARD: If we cannot detect any valid vendors, skip cleanup to avoid destructive deletions
    if (validVendorIds.length === 0) {
      console.warn('⚠️  Skipping orphaned warehouse cleanup: no valid vendors detected');
      return;
    }
    
    // Find all inventory items with warehouses
    const inventoryItems = await Inventory.find({
      isActive: true,
      'warehouses.0': { $exists: true }
    });
    
    console.log(`📦 Found ${inventoryItems.length} inventory items with warehouses`);
    
    let cleanedCount = 0;
    const updatePromises = inventoryItems.map(async (inventory) => {
      const validWarehouses = inventory.warehouses.filter(warehouse => {
        const warehouseId = warehouse.warehouseId.toString();
        const isValid = validVendorIds.includes(warehouseId);
        if (!isValid) {
          console.log(`🗑️  Removing orphaned warehouse: ${warehouse.warehouseName} (${warehouseId}) from ${inventory.itemDescription}`);
          cleanedCount++;
        }
        return isValid;
      });
      
      if (validWarehouses.length !== inventory.warehouses.length) {
        inventory.warehouses = validWarehouses;
        return inventory.save();
      }
      return null;
    });
    
    const results = await Promise.all(updatePromises);
    const savedCount = results.filter(result => result !== null).length;
    
    console.log(`✅ Cleanup completed: ${cleanedCount} orphaned references removed from ${savedCount} inventory items`);
    
  } catch (error) {
    console.error('❌ Error cleaning up orphaned warehouse references:', error);
  }
};

/**
 * Manual sync endpoint to update all inventory warehouse data
 * POST /api/warehouse/sync-inventory
 */
export const syncAllInventoryWarehouses = async (req, res) => {
  try {
    console.log('🔄 Starting manual sync of all inventory warehouse data');
    
    // First, cleanup orphaned warehouse references
    await cleanupOrphanedWarehouseReferences();
    
    // Get all vendors with warehouses
    const vendors = await User.find({
      role: 'vendor',
      isActive: true,
      'warehouse.warehouseName': { $exists: true }
    }).select('_id warehouse');
    
    console.log(`📦 Found ${vendors.length} vendors with warehouses`);
    
    // Sync each vendor's warehouse data
    const syncPromises = vendors.map(vendor => 
      syncInventoryWarehouseData(vendor._id, vendor.warehouse)
    );
    
    await Promise.all(syncPromises);
    
    res.status(200).json({
      success: true,
      message: 'All inventory warehouse data synced successfully',
      data: {
        vendorsProcessed: vendors.length,
        syncedAt: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Manual sync error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

/**
 * Cleanup orphaned warehouse references endpoint
 * POST /api/warehouse/cleanup-orphaned
 */
export const cleanupOrphanedWarehouses = async (req, res) => {
  try {
    console.log('🧹 Starting cleanup of orphaned warehouse references');
    
    await cleanupOrphanedWarehouseReferences();
    
    res.status(200).json({
      success: true,
      message: 'Orphaned warehouse references cleaned up successfully',
      data: {
        cleanedAt: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
