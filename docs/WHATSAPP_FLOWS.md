# WhatsApp Flows — create all of these in Meta

Link: https://business.facebook.com/wa/manage/flows/

For each: **Without Endpoint** → Create → paste JSON from file → **Publish** → copy Flow ID into `.env`

| Meta Flow name (suggested) | JSON file | Screen ID | `.env` key | UI |
|----------------------------|-----------|-----------|------------|-----|
| `laundry_press` | `flows/laundry-press.json` | `LAUNDRY` | `WHATSAPP_LAUNDRY_FLOW_ID` | CheckboxGroup |
| `housekeeping` | `flows/housekeeping.json` | `HOUSEKEEPING` | `WHATSAPP_HOUSEKEEPING_FLOW_ID` | CheckboxGroup |
| `valet` | `flows/valet.json` | `VALET` | `WHATSAPP_VALET_FLOW_ID` | RadioButtons |
| `transport` | `flows/transport.json` | `TRANSPORT` | `WHATSAPP_TRANSPORT_FLOW_ID` | Radio + notes |
| `maintenance` | `flows/maintenance.json` | `MAINTENANCE` | `WHATSAPP_MAINTENANCE_FLOW_ID` | Radio + TextArea |
| `checkout` | `flows/checkout.json` | `CHECKOUT` | `WHATSAPP_CHECKOUT_FLOW_ID` | Radio + time |
| `food_quick` | `flows/food-quick.json` | `FOOD` | `WHATSAPP_FOOD_FLOW_ID` | CheckboxGroup |

## `.env` example

```env
WHATSAPP_LAUNDRY_FLOW_ID=
WHATSAPP_HOUSEKEEPING_FLOW_ID=
WHATSAPP_VALET_FLOW_ID=
WHATSAPP_TRANSPORT_FLOW_ID=
WHATSAPP_MAINTENANCE_FLOW_ID=
WHATSAPP_CHECKOUT_FLOW_ID=
WHATSAPP_FOOD_FLOW_ID=
```

## Per Flow steps (same as laundry)

1. Create Flow → Without Endpoint → Default  
2. Name = table name above  
3. Category = Customer support  
4. Open JSON editor → paste file contents  
5. Preview → Publish  
6. Paste ID in `.env` → restart server  

Business verification pending ho to publish block ho sakta hai — IDs baad mein bhi daal sakte ho. Jab tak ID empty hai, purana button/list UI chalega.
