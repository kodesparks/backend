import crypto from "crypto";
import Token from "../models/TokenModel.js";

export const generateToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

export const createDocumentToken = async (docType, docId) => {
  const token = generateToken();

  const record = await Token.create({
    token,
    docType,
    docId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 15 mins
  });

  return record.token;
};

export const validateToken = async (token) => {
  const record = await Token.findOne({ token });

  if (!record) throw new Error("Invalid token");
  if (record.expiresAt < new Date()) throw new Error("Token expired");
//   if (record.isUsed) throw new Error("Token already used");

  return record;
};

export const markTokenUsed = async (token) => {
  await Token.updateOne({ token }, { isUsed: true });
};
