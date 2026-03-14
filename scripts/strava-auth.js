#!/usr/bin/env node

/**
 * Strava OAuth Authentication
 * Run once to authorize and save tokens.
 * Usage: node scripts/strava-auth.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'strava-config.json');
const TOKENS_PATH = path.join(__dirname, '..', 'data', 'strava-tokens.json');
const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Load config
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing strava-config.json. Create it first with your Client ID and Secret.');
  console.error(`Expected at: ${CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { client_id, client_secret } = config;

if (!client_id || !client_secret) {
  console.error('strava-config.json must contain "client_id" and "client_secret"');
  process.exit(1);
}

const SCOPES = 'read,activity:read_all';
const AUTH_URL = `https://www.strava.com/oauth/authorize?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}&approval_prompt=auto`;

function exchangeToken(code) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      client_id,
      client_secret,
      code,
      grant_type: 'authorization_code',
    });

    const req = https.request({
      hostname: 'www.strava.com',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Token exchange failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Start local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authorization denied</h1><p>${error}</p>`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No authorization code received</h1>');
      server.close();
      process.exit(1);
    }

    try {
      const tokenData = await exchangeToken(code);

      // Save tokens
      const tokens = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
        athlete_id: tokenData.athlete?.id,
        athlete_name: `${tokenData.athlete?.firstname} ${tokenData.athlete?.lastname}`,
      };

      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:Inter,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h1 style="color:#ff6b35;">Connected!</h1>
            <p>Strava account linked: <strong>${tokens.athlete_name}</strong></p>
            <p style="color:#888;">You can close this tab. Run <code>node scripts/strava-sync.js</code> to pull your runs.</p>
          </div>
        </body></html>
      `);

      console.log(`\nAuthenticated as: ${tokens.athlete_name}`);
      console.log(`Tokens saved to: ${TOKENS_PATH}`);
      console.log('\nYou can now run: node scripts/strava-sync.js');

      setTimeout(() => { server.close(); process.exit(0); }, 1000);

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error</h1><pre>${err.message}</pre>`);
      console.error(err);
      server.close();
      process.exit(1);
    }
  } else {
    res.writeHead(302, { Location: AUTH_URL });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Opening Strava authorization page...`);
  console.log(`If it doesn't open, go to: http://localhost:${PORT}`);
  try {
    execSync(`open "http://localhost:${PORT}"`);
  } catch {
    // Fallback: user opens manually
  }
});
