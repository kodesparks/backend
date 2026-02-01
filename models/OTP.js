import mongoose from "mongoose";

const otpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
    },
    otp: {
      type: String,
      required: true, // Hashed OTP when sent via email
    },
    type: {
      type: String,
      enum: ["signup"],
      default: "signup",
    },
    isUsed: {
      type: Boolean,
      default: false,
    },
    messageId: {
      type: String, // Optional; reserved for future use
      required: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 300,
    },
  },
  { timestamps: true }
);

export default mongoose.model("OTP", otpSchema);
