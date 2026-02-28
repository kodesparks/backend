const taxes = {
  "orgState": "AD",
  "orgStateName": "Andhra Pradesh",
  "orgStateCode": "37",
  "taxes": [
    {
      "state_code": '37', 
      "tax_id": "3422894000000075399",
      "tax_name": "GST18",
      "tax_percentage": 18,
      "tax_type": "tax_group",
      "tax_specific_type": "",
      "is_inactive": false,
      "is_default_tax": false,
      "is_editable": true,
      "tax_specification": "intra",
      "diff_rate_reason": "",
      "start_date": "",
      "end_date": "",
      "last_modified_time": "2026-01-29T22:12:07+0530",
      "status": "Active"
    },        
    {
      "state_code": "36",
      "tax_id": "3422894000000075239",
      "tax_name": "IGST18",
      "tax_percentage": 18,
      "tax_type": "tax",
      "tax_specific_type": "igst",
      "tax_authority_id": "3422894000000032020",
      "tax_authority_name": "INTD",
      "output_tax_account_name": "Output IGST",
      "tax_account_id": "3422894000000075177",
      "is_inactive": false,
      "is_default_tax": false,
      "is_editable": false,
      "tax_specification": "inter",
      "diff_rate_reason": "",
      "start_date": "",
      "end_date": "",
      "last_modified_time": "2026-01-29T22:12:06+0530",
      "status": "Active"
    }    
  ]
};

export const getTaxId = (stateCode) => {
    if(!stateCode) return '';
    if(taxes.orgState === stateCode) {
        return taxes.taxes[0].tax_id;
    }
    return taxes.taxes[1].tax_id;
}