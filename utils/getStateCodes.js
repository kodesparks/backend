export const states = [
  { code: "01", state: "Jammu & Kashmir" },
  { code: "02", state: "Himachal Pradesh" },
  { code: "03", state: "Punjab" },
  { code: "04", state: "Chandigarh" },
  { code: "05", state: "Uttarakhand" },
  { code: "06", state: "Haryana" },
  { code: "07", state: "Delhi" },
  { code: "08", state: "Rajasthan" },
  { code: "09", state: "Uttar Pradesh" },
  { code: "10", state: "Bihar" },
  { code: "11", state: "Sikkim" },
  { code: "12", state: "Arunachal Pradesh" },
  { code: "13", state: "Nagaland" },
  { code: "14", state: "Manipur" },
  { code: "15", state: "Mizoram" },
  { code: "16", state: "Tripura" },
  { code: "17", state: "Meghalaya" },
  { code: "18", state: "Assam" },
  { code: "19", state: "West Bengal" },
  { code: "20", state: "Jharkhand" },
  { code: "21", state: "Odisha" },
  { code: "22", state: "Chhattisgarh" },
  { code: "23", state: "Madhya Pradesh" },
  { code: "24", state: "Gujarat" },
  { code: "26", state: "Dadra & Nagar Haveli and Daman & Diu" },
  { code: "27", state: "Maharashtra" },
  { code: "28", state: "Andhra Pradesh" },
  { code: "29", state: "Karnataka" },
  { code: "30", state: "Goa" },
  { code: "31", state: "Lakshadweep" },
  { code: "32", state: "Kerala" },
  { code: "33", state: "Tamil Nadu" },
  { code: "34", state: "Puducherry" },
  { code: "35", state: "Andaman & Nicobar Islands" },
  { code: "36", state: "Telangana" },
  { code: "37", state: "Andhra Pradesh (New)" },
  { code: "38", state: "Ladakh" },
  { code: "97", state: "Other Territory" }
];

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z]/g, "");
}

export default function getStateCode(input) {
  const normalizedInput = normalize(input);

  const match = states.find(s =>
    normalize(s.state).includes(normalizedInput)
  );

  return match ? match.code : null;
}
