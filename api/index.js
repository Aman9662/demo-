const { createApp } = require('../backend/server');
const path = require('path');

// Vercel serverless functions have a read-only filesystem except for /tmp.
// We configure the app to use /tmp/citizens.json for persistence in Vercel.
const app = createApp({
  dbFile: '/tmp/citizens.json'
});

module.exports = (req, res) => {
  // Emit the request to our custom Node HTTP server instance
  app.server.emit('request', req, res);
};

// Disable Vercel's default body parsing so our raw stream body parsers work correctly
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
