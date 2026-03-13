const crypto = require('crypto');

function createAuth(config, noAuth) {
  const authUsername = config.username || null;
  const authPassword = config.password || null;
  const authEnabled = !noAuth && !!authUsername && !!authPassword;

  function checkBasicAuth(req) {
    if (!authEnabled) return true;
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Basic ')) return false;
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const sep = decoded.indexOf(':');
    if (sep === -1) return false;
    const user = decoded.substring(0, sep);
    const pass = decoded.substring(sep + 1);
    const userMatch = user.length === authUsername.length &&
      crypto.timingSafeEqual(Buffer.from(user), Buffer.from(authUsername));
    const passMatch = pass.length === authPassword.length &&
      crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(authPassword));
    return userMatch && passMatch;
  }

  function rejectUnauthorized(res) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="Terminal Mirror"',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  return { authEnabled, checkBasicAuth, rejectUnauthorized };
}

module.exports = { createAuth };
