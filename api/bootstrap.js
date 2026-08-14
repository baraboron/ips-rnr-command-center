const {logAppOpen} = require('../lib/server/telemetry.server.cjs');

async function bootstrapHandler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }

  try {
    await logAppOpen({source: 'app_bootstrap'});
  } catch {
    // Telemetry must never prevent the application from opening.
  }

  res.statusCode = 204;
  res.end();
}

module.exports=bootstrapHandler;
