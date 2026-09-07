# WhatsApp Flows — create all of these in Meta

Link: https://business.facebook.com/wa/manage/flows/

For each: **Without Endpoint** → Create → paste JSON from file → **Publish** → copy Flow ID into `.env`

> **Important:** Do **not** put `data_api_version` in JSON. That forces an endpoint Flow (publish fails). These Flows use static `complete` — webhook gets `nfm_reply`.

## Published / existing

| Meta Flow name | JSON file | Screen ID | `.env` key |
|----------------|-----------|-----------|------------|
| `laundry_press` | `flows/laundry-press.json` | `LAUNDRY` | `WHATSAPP_LAUNDRY_FLOW_ID` |
| `housekeeping` | `flows/housekeeping.json` | `HOUSEKEEPING` | `WHATSAPP_HOUSEKEEPING_FLOW_ID` |
| `valet` | `flows/valet.json` | `VALET` | `WHATSAPP_VALET_FLOW_ID` |
| `transport` | `flows/transport.json` | `TRANSPORT` | `WHATSAPP_TRANSPORT_FLOW_ID` |
| `maintenance` | `flows/maintenance.json` | `MAINTENANCE` | `WHATSAPP_MAINTENANCE_FLOW_ID` |
| `checkout` | `flows/checkout.json` | `CHECKOUT` | `WHATSAPP_CHECKOUT_FLOW_ID` |
| `food_fast` | `flows/food-quick.json` | `FOOD` | `WHATSAPP_FOOD_FLOW_ID` | CheckboxGroup + images; pages of 10 via More Items |

## New — create & publish these

| Meta Flow name | JSON file | Screen ID | `.env` key | Notes |
|----------------|-----------|-----------|------------|--------|
| `food_edit` | `flows/food-edit.json` | `FOOD` | `WHATSAPP_FOOD_EDIT_FLOW_ID` | Same CheckboxGroup + images; More Items pages |
| `facilities` | `flows/facilities.json` | `FACILITIES` | `WHATSAPP_FACILITIES_FLOW_ID` | FAQ list from DB |

**Re-publish laundry:** `flows/laundry-press.json` now uses per-item qty (0–10), not checkboxes. Update the existing laundry Flow JSON in Meta and publish again (same Flow ID OK).

**Re-publish food_fast:** paste latest `flows/food-quick.json` (Select products → Qty → Confirm → Place Order).

## `.env` example

```env
USE_WHATSAPP_FLOWS=true
WHATSAPP_LAUNDRY_FLOW_ID=
WHATSAPP_HOUSEKEEPING_FLOW_ID=
WHATSAPP_VALET_FLOW_ID=
WHATSAPP_TRANSPORT_FLOW_ID=
WHATSAPP_MAINTENANCE_FLOW_ID=
WHATSAPP_CHECKOUT_FLOW_ID=
WHATSAPP_FOOD_FLOW_ID=
WHATSAPP_FOOD_EDIT_FLOW_ID=
WHATSAPP_FACILITIES_FLOW_ID=
```

## Per Flow steps

1. Create Flow → **Without Endpoint** → Default  
2. Name = table name above  
3. Category = Customer support  
4. JSON editor → paste file  
5. Preview → **Publish**  
6. Paste ID in `.env` → restart server  
