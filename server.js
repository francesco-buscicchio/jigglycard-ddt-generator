const express = require('express');
const cardtraderRoute = require('./routes/cardtrader');
const cardmarketRoute = require('./routes/cardmarket');
const app = express();
const { PORT } = require('./config/config');

app.use('/cardtrader', cardtraderRoute);
app.use('/cardmarket', cardmarketRoute);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
