const express = require('express');
const cors = require('cors');
const app = express();

const CORS_OPTIONS = {
  exposedHeaders: ['content-length'],
};

app.use(cors(CORS_OPTIONS));

const ASSETS = require('./test-data.json');

app.use('/assets', express.static('assets'))

app.get('/api/assets/:id', (req, res, next) => {
  res.json(ASSETS.find((asset) => asset.id === req.params.id));
});

app.get('/api/assets/', (req, res, next) => {
  res.json(ASSETS);
});

app.get('*', function (req, res) {
  res.send(
    'Demo server is running. Use <a href="/api/assets/">/api/assets/</a> to get asset data.'
  );
});

app.listen(process.env.PORT || 3001, () => {
  console.log('Server is running');
});
