import Inventory from '../models/Inventory.js';
import Promo from '../models/Promo.js';
import User from '../models/User.js';
import { deleteImageFromS3, deleteMultipleImagesFromS3 } from '../utils/awsS3.js';
import zohoBooksService from '../utils/zohoBooks.js';

// ========================================
// INVENTORY CONTROLLERS
// ========================================

// Use same Zoho item creation as test script (createOrGetItem → createItemInZoho: plain name, no suffix).
async function syncInventoryToZoho(inventory) {
  try {
    const zohoItemId = await zohoBooksService.createOrGetItem(inventory);
    if (zohoItemId) {
      inventory.zohoItemId = zohoItemId;
      await inventory.save();
    }
  } catch (err) {
    console.error(`❌ Zoho sync for item ${inventory.itemCode}:`, err?.message || err);
  }
}

// Create Inventory Item
export const createInventory = async (req, res, next) => {
  try {
    const {
      itemDescription,
      category,
      subCategory,
      grade,
      units,
      details,
      specification,
      deliveryInformation,
      hscCode,
      vendorId,
      pricing,
      warehouses
    } = req.body;

    if (vendorId) {
      const vendor = await User.findById(vendorId);
      if (!vendor || vendor.role !== 'vendor') {
        return res.status(400).json({
          message: "Invalid vendor ID or vendor not found"
        });
      }
      if (req.user.role === 'vendor' && req.user._id.toString() !== vendorId) {
        return res.status(403).json({
          message: "You can only create inventory for your own vendor account"
        });
      }
    }

    const inventory = new Inventory({
      itemDescription,
      category,
      subCategory,
      grade,
      units,
      details,
      specification,
      deliveryInformation,
      hscCode,
      ...(vendorId && { vendorId }),
      createdBy: req.user.userId,
      ...(pricing && { pricing }),
      ...(warehouses && { warehouses })
    });

    await inventory.save();

    if (inventory.vendorId) {
      await inventory.populate('vendorId', 'name email role');
    }

    // Zoho sync in background so API returns quickly (avoids frontend timeout)
    syncInventoryToZoho(inventory).catch((err) => {
      console.error('Zoho sync (background):', err?.message || err);
    });

    res.status(201).json({
      message: "Inventory item created successfully",
      inventory
    });
  } catch (error) {
    next(error);
  }
};

// Get All Inventory Items
export const getAllInventory = async (req, res, next) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      category, 
      subCategory, 
      vendorId, 
      search,
      isActive 
    } = req.query;

    const filter = {};
    
    // Only filter by isActive if explicitly provided
    if (isActive !== undefined && isActive !== null) {
      filter.isActive = isActive === 'true';
    }

    // Apply filters based on user role
    if (req.user.role === 'vendor') {
      filter.vendorId = req.user._id;
    } else if (vendorId) {
      filter.vendorId = vendorId;
    }

    if (category) filter.category = category;
    if (subCategory) filter.subCategory = subCategory;
    if (search) {
      filter.$or = [
        { itemDescription: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        { subCategory: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * limit;

    const inventory = await Inventory.find(filter)
      .populate('vendorId', 'name email role')
      .populate('createdBy', 'name email role')
      .select('itemDescription category subCategory grade units details specification pricing warehouses vendorId createdBy isActive itemCode images primaryImage shipping warehouse createdDate timestamp updateDate updateTime createdAt updatedAt __v formattedItemCode zohoItemId id') // Include zohoItemId for frontend Zoho link
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Inventory.countDocuments(filter);

    res.status(200).json({
      inventory,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        hasNext: skip + inventory.length < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    next(error);
  }
};

//Get All Inventory without pagination
export const getAllInventoryWOPagination = async (req, res, next) => {
  try {
    const { 
      category, 
      subCategory, 
      vendorId, 
      search,
      isActive 
    } = req.query;

    const filter = {};
    
    // Only filter by isActive if explicitly provided
    if (isActive !== undefined && isActive !== null) {
      filter.isActive = isActive === 'true';
    }

    // Apply filters based on user role
    if (req.user.role === 'vendor') {
      filter.vendorId = req.user._id;
    } else if (vendorId) {
      filter.vendorId = vendorId;
    }

    if (category) filter.category = category;
    if (subCategory) filter.subCategory = subCategory;

    if (search) {
      filter.$or = [
        { itemDescription: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        { subCategory: { $regex: search, $options: 'i' } }
      ];
    }

    const inventory = await Inventory.find(filter)
      .populate('vendorId', 'name email role')
      .populate('createdBy', 'name email role')
      .select('itemDescription category subCategory grade units details specification pricing warehouses vendorId createdBy isActive itemCode images primaryImage shipping warehouse createdDate timestamp updateDate updateTime createdAt updatedAt __v formattedItemCode zohoItemId id')
      .sort({ createdAt: -1 });

    res.status(200).json({
      count: inventory.length,
      inventory
    });

  } catch (error) {
    next(error);
  }
};

// Get Inventory Item by ID
export const getInventoryById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const inventory = await Inventory.findById(id)
      .populate('vendorId', 'name email role')
      .populate('createdBy', 'name email role')
      .select('itemDescription category subCategory grade units details specification pricing warehouses vendorId createdBy isActive itemCode images primaryImage shipping warehouse createdDate timestamp updateDate updateTime createdAt updatedAt __v formattedItemCode zohoItemId id'); // Include zohoItemId for frontend Zoho link

    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.status(200).json({ inventory });
  } catch (error) {
    next(error);
  }
};

// Update Inventory Item
export const updateInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Remove fields that shouldn't be updated
    delete updateData.itemCode;
    delete updateData.vendorId;
    delete updateData.createdBy;

    // Preserve existing warehouses if not provided in update
    if (!updateData.warehouses && inventory.warehouses && inventory.warehouses.length > 0) {
      updateData.warehouses = inventory.warehouses;
    }

    // Preserve existing pricing if not provided in update
    if (!updateData.pricing && inventory.pricing) {
      updateData.pricing = inventory.pricing;
    }

    // Preserve existing delivery if not provided in update
    if (!updateData.delivery && inventory.delivery) {
      updateData.delivery = inventory.delivery;
    }

    // Preserve existing shipping if not provided in update
    if (!updateData.shipping && inventory.shipping) {
      updateData.shipping = inventory.shipping;
    }

    Object.assign(inventory, updateData);
    await inventory.save();

    await inventory.populate('vendorId', 'name email role');

    res.status(200).json({
      message: "Inventory item updated successfully",
      inventory
    });
  } catch (error) {
    next(error);
  }
};

// Delete/Deactivate Inventory Item
export const deleteInventory = async (req, res, next) => {
  try {
    const { id } = req.params;

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Soft delete by setting isActive to false
    inventory.isActive = false;
    await inventory.save();

    res.status(200).json({ message: "Inventory item deactivated successfully" });
  } catch (error) {
    next(error);
  }
};

// ========================================
// INVENTORY PRICE CONTROLLERS
// ========================================

// Create/Update Inventory Price
export const updateInventoryPricing = async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const { basePrice, unitPrice, currency, isActive, baseCharge, perKmCharge, freeDeliveryThreshold, freeDeliveryRadius, warehouseName, warehouseLatitude, warehouseLongitude } = req.body;

    // Find the inventory item
    const inventoryItem = await Inventory.findById(itemId);
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
        data: null
      });
    }

    // Update pricing
    if (basePrice !== undefined || unitPrice !== undefined || currency !== undefined || isActive !== undefined) {
      inventoryItem.pricing = {
        basePrice: basePrice !== undefined ? basePrice : inventoryItem.pricing?.basePrice || 0,
        unitPrice: unitPrice !== undefined ? unitPrice : inventoryItem.pricing?.unitPrice || 0,
        currency: currency || inventoryItem.pricing?.currency || 'INR',
        isActive: isActive !== undefined ? isActive : inventoryItem.pricing?.isActive || true
      };
    }

    // Update delivery
    if (baseCharge !== undefined || perKmCharge !== undefined || freeDeliveryThreshold !== undefined || freeDeliveryRadius !== undefined) {
      inventoryItem.delivery = {
        baseCharge: baseCharge !== undefined ? baseCharge : inventoryItem.delivery?.baseCharge || 0,
        perKmCharge: perKmCharge !== undefined ? perKmCharge : inventoryItem.delivery?.perKmCharge || 0,
        freeDeliveryThreshold: freeDeliveryThreshold !== undefined ? freeDeliveryThreshold : inventoryItem.delivery?.freeDeliveryThreshold || 0,
        freeDeliveryRadius: freeDeliveryRadius !== undefined ? freeDeliveryRadius : inventoryItem.delivery?.freeDeliveryRadius || 0
      };
    }

    // Note: Warehouse updates should be done through the main updateInventory function
    // This function is for pricing and delivery updates only
    // The warehouses array should be managed separately

    await inventoryItem.save();

    // ✅ Direct model approach - no separate pricing models needed

    return res.status(200).json({
      success: true,
      message: 'Inventory pricing updated successfully',
      data: {
        inventory: inventoryItem,
        pricing: inventoryItem.pricing,
        delivery: inventoryItem.delivery,
        warehouse: inventoryItem.warehouse
      }
    });

  } catch (error) {
    console.error('Update inventory pricing error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// ✅ REMOVED: createInventoryPrice - Use updateInventoryPricing instead (direct model approach)

// ✅ REMOVED: getInventoryPrices - Use /inventory/pricing API instead (direct model approach)

// ========================================
// INVENTORY SHIPPING PRICE CONTROLLERS
// ========================================

// ✅ REMOVED: createInventoryShipPrice - Use updateInventoryPricing instead (direct model approach)

// ✅ REMOVED: getShippingPrice - Use /delivery/calculate API instead (direct model approach)

// ========================================
// PROMO CONTROLLERS
// ========================================

// Create Promo
export const createPromo = async (req, res, next) => {
  try {
    const {
      itemCode,
      promoName,
      discount,
      discountAmount,
      discountType,
      startDate,
      endDate,
      minOrderValue,
      maxDiscountAmount,
      usageLimit
    } = req.body;

    // Check if inventory item exists
    const inventory = await Inventory.findById(itemCode);
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const promo = new Promo({
      itemCode,
      promoName,
      discount,
      discountAmount,
      discountType,
      startDate,
      endDate,
      minOrderValue,
      maxDiscountAmount,
      usageLimit,
      createdBy: req.user.userId
    });

    await promo.save();

    await promo.populate('itemCode', 'itemDescription category subCategory');
    await promo.populate('createdBy', 'name email role');

    res.status(201).json({
      message: "Promo created successfully",
      promo
    });
  } catch (error) {
    next(error);
  }
};

// Get Active Promos
export const getActivePromos = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, itemCode } = req.query;

    let filter = {};
    if (itemCode) {
      filter.itemCode = itemCode;
    }

    const skip = (page - 1) * limit;

    const promos = await Promo.getActivePromos()
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Promo.countDocuments({
      ...filter,
      isActive: true,
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() }
    });

    res.status(200).json({
      promos,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        hasNext: skip + promos.length < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    next(error);
  }
};

// Calculate Promo Discount
export const calculatePromoDiscount = async (req, res, next) => {
  try {
    const { promoId, orderValue } = req.body;

    const promo = await Promo.findById(promoId);
    if (!promo) {
      return res.status(404).json({ message: "Promo not found" });
    }

    const discountAmount = promo.calculateDiscount(parseFloat(orderValue));

    res.status(200).json({
      promoId,
      promoName: promo.promoName,
      orderValue: parseFloat(orderValue),
      discountAmount,
      finalAmount: parseFloat(orderValue) - discountAmount,
      isValid: promo.isValid()
    });
  } catch (error) {
    next(error);
  }
};

// ========================================
// UTILITY CONTROLLERS
// ========================================

// Get All Categories and Subcategories
// Map Zoho Item ID to Inventory Item (Admin/Manager)
export const mapZohoItem = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { zohoItemId } = req.body;

    if (!zohoItemId) {
      return res.status(400).json({ message: 'Zoho Item ID is required' });
    }

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }

    inventory.zohoItemId = zohoItemId;
    await inventory.save();

    res.status(200).json({
      message: 'Zoho Item ID mapped successfully',
      inventory: {
        _id: inventory._id,
        itemDescription: inventory.itemDescription,
        zohoItemId: inventory.zohoItemId
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get unmapped items (Admin/Manager)
export const getUnmappedItems = async (req, res, next) => {
  try {
    const items = await Inventory.find({
      isActive: true,
      $or: [
        { zohoItemId: { $exists: false } },
        { zohoItemId: null }
      ]
    })
    .select('_id itemCode itemDescription category subCategory units pricing zohoItemId')
    .limit(100);

    res.status(200).json({
      message: 'Unmapped items retrieved successfully',
      count: items.length,
      items
    });
  } catch (error) {
    next(error);
  }
};

export const getAllCategories = async (req, res, next) => {
  try {
    const categories = Inventory.getAllCategories();
    
    res.status(200).json({
      message: "Categories retrieved successfully",
      categories
    });
  } catch (error) {
    next(error);
  }
};

// Get All Vendors (for admin to select when creating inventory)
export const getAllVendors = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    
    const filter = { role: 'vendor', isActive: true };
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (page - 1) * limit;
    
    const vendors = await User.find(filter)
      .select('_id name email companyName phone address isActive createdAt')
      .sort({ name: 1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(filter);
    
    res.status(200).json({
      message: "Vendors retrieved successfully",
      vendors,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        hasNext: skip + vendors.length < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get Subcategories for a Category
export const getSubCategories = async (req, res, next) => {
  try {
    const { category } = req.params;
    
    if (!['Cement', 'Iron', 'Concrete Mixer'].includes(category)) {
      return res.status(400).json({ 
        message: "Invalid category. Valid categories: Cement, Iron, Concrete Mixer" 
      });
    }
    
    const subCategories = Inventory.getSubCategories(category);
    
    res.status(200).json({
      message: "Subcategories retrieved successfully",
      category,
      subCategories
    });
  } catch (error) {
    next(error);
  }
};

// ========================================
// IMAGE MANAGEMENT CONTROLLERS
// ========================================

// Add Images to Inventory Item
export const addImagesToInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No images provided" });
    }

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Process uploaded images
    const imageData = req.files.map(file => {
      // Handle both S3 and local storage
      const isS3 = file.location && file.key;
      const isLocal = file.path && file.filename;
      
      return {
        url: isS3 ? file.location : `http://localhost:${process.env.PORT || 5000}/${file.path}`,
        key: isS3 ? file.key : file.filename,
        originalName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        uploadedAt: new Date(),
        isPrimary: false
      };
    });

    // Add images to inventory
    for (const image of imageData) {
      await inventory.addImage(image);
    }

    await inventory.populate('vendorId', 'name email role');

    res.status(200).json({
      message: "Images added successfully",
      inventory,
      addedImages: imageData.length
    });
  } catch (error) {
    next(error);
  }
};

// Remove Image from Inventory Item
export const removeImageFromInventory = async (req, res, next) => {
  try {
    const { id, imageKey } = req.params;

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Find the image
    const image = inventory.images.find(img => img.key === imageKey);
    if (!image) {
      return res.status(404).json({ message: "Image not found" });
    }

    // Remove from S3
    const s3Deleted = await deleteImageFromS3(imageKey);
    if (!s3Deleted) {
      console.warn(`Failed to delete image ${imageKey} from S3`);
    }

    // Remove from database
    await inventory.removeImage(imageKey);

    await inventory.populate('vendorId', 'name email role');

    res.status(200).json({
      message: "Image removed successfully",
      inventory
    });
  } catch (error) {
    next(error);
  }
};

// Set Primary Image
export const setPrimaryImage = async (req, res, next) => {
  try {
    const { id, imageKey } = req.params;

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Set primary image
    const success = await inventory.setPrimaryImage(imageKey);
    if (!success) {
      return res.status(404).json({ message: "Image not found" });
    }

    await inventory.populate('vendorId', 'name email role');

    res.status(200).json({
      message: "Primary image updated successfully",
      inventory
    });
  } catch (error) {
    next(error);
  }
};

// Get Images for Inventory Item
export const getInventoryImages = async (req, res, next) => {
  try {
    const { id } = req.params;

    const inventory = await Inventory.findById(id).select('images primaryImage');
    if (!inventory) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (!inventory.canAccess(req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const images = inventory.getImageUrls();

    res.status(200).json({
      message: "Images retrieved successfully",
      images,
      primaryImage: inventory.primaryImage,
      totalImages: images.length
    });
  } catch (error) {
    next(error);
  }
};

// Get Inventory Statistics
export const getInventoryStats = async (req, res, next) => {
  try {
    const filter = { isActive: true };

    // Apply vendor filter for vendor role
    if (req.user.role === 'vendor') {
      filter.vendorId = req.user._id;
    }

    const totalItems = await Inventory.countDocuments(filter);
    const totalPrices = await Inventory.countDocuments({ ...filter, 'pricing.unitPrice': { $gt: 0 } });
    const totalShipPrices = await Inventory.countDocuments({ ...filter, 'shipping.price0to50k': { $gt: 0 } });
    const activePromos = await Promo.countDocuments({
      isActive: true,
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() }
    });

    // Category breakdown
    const categoryStats = await Inventory.aggregate([
      { $match: filter },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      stats: {
        totalItems: totalItems || 0,
        totalPrices: totalPrices || 0,
        totalShipPrices: totalShipPrices || 0,
        activePromos: activePromos || 0,
        categoryBreakdown: categoryStats || []
      }
    });
  } catch (error) {
    next(error);
  }
};

// ========================================
// SINGLE ITEM DATA CONTROLLERS (FOR EDIT MODAL)
// ========================================

// ✅ REMOVED: getSingleItemPrice - Use /inventory/pricing/:itemId API instead (direct model approach)

// ✅ REMOVED: getSingleItemShipping - Use /inventory/pricing/:itemId API instead (direct model approach)

// Get promo data for a single inventory item
export const getSingleItemPromos = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { active = true } = req.query;
    let filter = { itemCode: id };
    if (active === 'true') {
      filter.isActive = true;
      filter.startDate = { $lte: new Date() };
      filter.endDate = { $gte: new Date() };
    }
    const promos = await Promo.find(filter)
      .populate('itemCode', 'itemDescription category subCategory')
      .populate('vendorId', 'name email')
      .sort({ createdAt: -1 });
    res.json({
      message: 'Promo data retrieved successfully',
      promos,
      count: promos.length
    });
  } catch (error) {
    next(error);
  }
};
