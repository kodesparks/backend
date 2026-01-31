import axios from "axios";
import { Buffer } from "buffer";

const getAuthString = () =>
  Buffer.from(
    `${process.env.ENGAGELAB_DEV_KEY}:${process.env.ENGAGELAB_DEV_SECRET}`
  ).toString("base64");

// Engagelab API client
const engagelabClient = axios.create({
  baseURL: "https://otp.api.engagelab.cc",
  headers: {
    "Content-Type": "application/json",
  },
});

// Add Basic Auth interceptor
engagelabClient.interceptors.request.use((config) => {
  const authString = getAuthString();
  config.headers.Authorization = `Basic ${authString}`;
  return config;
});

// Send OTP
const sendOTP = async (phone) => {
  try {
    const response = await engagelabClient.post("/v1/messages", {
      to: phone,
      template: {
        id: process.env.ENGAGELAB_TEMPLATE_ID,
        language: "default",
      },
    });
    console.log("Engagelab Send OTP Response:", response.data); // Debug log
    return {
      messageId: response.data.message_id,
      sendChannel: response.data.send_channel,
    };
  } catch (error) {
    console.error("Engagelab Send OTP Error:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    throw new Error(
      `Failed to send OTP: ${error.response?.data?.error || error.message}`
    );
  }
};

// Verify OTP
const verifyOTP = async (messageId, otp) => {
  try {
    const response = await engagelabClient.post("/v1/verifications", {
      message_id: messageId,
      verify_code: otp,
    });
    console.log("Engagelab Verify OTP Response:", response.data); // Debug log
    return response.data.verified;
  } catch (error) {
    console.error("Engagelab Verify OTP Error:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    throw new Error(
      `Failed to verify OTP: ${error.response?.data?.error || error.message}`
    );
  }
};

export { sendOTP, verifyOTP };
