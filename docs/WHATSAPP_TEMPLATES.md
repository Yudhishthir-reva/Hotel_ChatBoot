# WhatsApp Message Templates — create in Meta while verification is pending

Open: [WhatsApp Manager → Message templates](https://business.facebook.com/wa/manage/message-templates/)

Category for all of these: **Utility**  
Language: **English (en)** first (Hindi optional later)

Use exact **names** below — same names are in code (`src/services/template.service.js`).

---

## 1. `hotel_welcome`

| Field | Value |
|-------|--------|
| Name | `hotel_welcome` |
| Category | Utility |
| Language | English |
| Header | none |
| Body | `Hello {{1}}, welcome to {{2}}. Your room is {{3}}. Reply here for food, laundry, or hotel services.` |
| Footer | `In-room assistance` |
| Buttons | none |

Variables: 1 guest name · 2 hotel name · 3 room number

---

## 2. `food_order_confirmed`

| Field | Value |
|-------|--------|
| Name | `food_order_confirmed` |
| Category | Utility |
| Language | English |
| Body | `Your food order {{1}} for room {{2}} has been received. Total: INR {{3}}. Estimated delivery: {{4}} minutes. We will send status updates here.` |
| Footer | `Hotel dining` |

Vars: 1 order id · 2 room · 3 amount · 4 ETA

---

## 3. `food_order_status`

| Field | Value |
|-------|--------|
| Name | `food_order_status` |
| Category | Utility |
| Language | English |
| Body | `Update for food order {{1}}, room {{2}}: {{3}}` |
| Footer | `Hotel dining` |

Vars: 1 order id · 2 room · 3 status text  
Example {{3}}: `Your order is being prepared.`

---

## 4. `service_request_created`

| Field | Value |
|-------|--------|
| Name | `service_request_created` |
| Category | Utility |
| Language | English |
| Body | `Your {{1}} request {{2}} for room {{3}} has been created. Details: {{4}}. We will update you here.` |
| Footer | `Hotel services` |

Vars: 1 type (Laundry/Valet/...) · 2 request id · 3 room · 4 short details

---

## 5. `service_request_status`

| Field | Value |
|-------|--------|
| Name | `service_request_status` |
| Category | Utility |
| Language | English |
| Body | `Update for request {{1}}: {{2}}` |
| Footer | `Hotel services` |

Vars: 1 request id · 2 status text

---

## 6. `guest_not_checked_in`

| Field | Value |
|-------|--------|
| Name | `guest_not_checked_in` |
| Category | Utility |
| Language | English |
| Body | `We could not find an active stay on this WhatsApp number. Hotel services will be available after check-in.` |
| Footer | `Front desk` |

No variables.

---

## How to create (Meta UI)

1. https://business.facebook.com/wa/manage/message-templates/  
2. **Create template**  
3. Category **Utility**  
4. Name + language **English**  
5. Paste **Body** (keep `{{1}}` as-is)  
6. Submit → wait **Pending / Approved**

Unpublished test numbers can often use templates after approval on that WABA.

---

## After approved

Code already maps these names. Session (24h) pe pehle normal text jata hai; 24h khatam hone par template.

Do not change template **names** after submit without updating code.
