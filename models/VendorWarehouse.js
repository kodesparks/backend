import mongoose from 'mongoose';

const vendorWarehouseSchema = new mongoose.Schema({
  // Vendor Information
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Warehouse Information
  warehouseName: {
    type: String,
    required: true,
    trim: true
  },
  
  // Location Information
  location: {
    address: {
      type: String,
      required: true,
      trim: true
    },
    city: {
      type: String,
      required: true,
      trim: true
    },
    state: {
      type: String,
      required: true,
      trim: true
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
      match: /^[1-9][0-9]{5}$/
    },
    coordinates: {
      latitude: {
        type: Number,
        required: true,
        min: -90,
        max: 90
      },
      longitude: {
        type: Number,
        required: true,
        min: -180,
        max: 180
      }
    }
  },
  
  // Product Categories Served
  categories: [{
    type: String,
    enum: ['Cement', 'Iron', 'Steel', 'Concrete Mixer', 'Concrete Mix'],
    required: true
  }],
  
  // Delivery Configuration
  deliveryConfig: {
    baseDeliveryCharge: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    perKmCharge: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    minimumOrder: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    freeDeliveryThreshold: {
      type: Number,
      default: 0,
      min: 0
    },
    freeDeliveryRadius: {
      type: Number,
      default: 0,
      min: 0
    },
    maxDeliveryRadius: {
      type: Number,
      default: 500, // km
      min: 0
    }
  },
  
  // Operating Hours
  operatingHours: {
    monday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
    tuesday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
    wednesday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
    thursday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
    friday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
    saturday: { open: String, close: String, isOpen: { type: Boolean, default: true } },
    sunday: { open: String, close: String, isOpen: { type: Boolean, default: false } }
  },
  
  // Status and Metadata
  isActive: {
    type: Boolean,
    default: true
  },
  
  isVerified: {
    type: Boolean,
    default: false
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
vendorWarehouseSchema.index({ vendorId: 1 });
vendorWarehouseSchema.index({ 'location.coordinates.latitude': 1, 'location.coordinates.longitude': 1 });
vendorWarehouseSchema.index({ categories: 1 });
vendorWarehouseSchema.index({ isActive: 1, isVerified: 1 });

// Pre-save middleware
vendorWarehouseSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static method to find nearest warehouses
vendorWarehouseSchema.statics.findNearestWarehouses = async function(customerCoordinates, categories, maxDistance = 500) {
  const { latitude: customerLat, longitude: customerLng } = customerCoordinates;
  
  // Find warehouses that serve the required categories
  const warehouses = await this.find({
    categories: { $in: categories },
    isActive: true,
    isVerified: true
  });
  
  // Calculate distances and filter by max distance
  const warehousesWithDistance = warehouses
    .map(warehouse => {
      const distance = calculateDistance(
        customerLat, customerLng,
        warehouse.location.coordinates.latitude,
        warehouse.location.coordinates.longitude
      );
      
      return {
        ...warehouse.toObject(),
        distance
      };
    })
    .filter(warehouse => warehouse.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);
  
  return warehousesWithDistance;
};

// Helper function to calculate distance using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
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

const VendorWarehouse = mongoose.model('VendorWarehouse', vendorWarehouseSchema);

export default VendorWarehouse;
