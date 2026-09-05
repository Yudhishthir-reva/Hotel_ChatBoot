require('dotenv').config();
const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Hotel WhatsApp CRM running on http://localhost:${PORT}`);
  console.log(`Admin CRM: http://localhost:${PORT}/admin`);
  console.log(`Webhook:   http://localhost:${PORT}/webhook`);
});
