const express = require('express');
const ordersRoute = require('./routes/orders');
const app = express();
const { PORT } = require('./config/config');

app.use('/orders', ordersRoute);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
