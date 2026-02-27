import mongoose from "mongoose";

const TokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  docType: { type: String, enum: ["quote", "so", "invoice", "payment", "po"], required: true },
  docId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  isUsed: { type: Boolean, default: false }
}, { timestamps: true });

// Auto delete expired tokens 🔥
TokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("Token", TokenSchema);
