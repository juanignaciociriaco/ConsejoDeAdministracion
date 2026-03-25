require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*' // En producción reemplazá por tu dominio: 'https://consorciolaenriqueta.com'
}));

// ── FRONTEND EN EL MISMO PROCESO ──
app.use(express.static(__dirname));
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'la-enriqueta.html'));
});

// ── PADRÓN DESDE CSV (LOTE + MÚLTIPLES DNI) ──
const PADRON_CSV_PATH = process.env.PADRON_CSV_PATH || path.join(__dirname, 'padron_propietarios.csv');
const PADRON_SHEETS_CSV_URL = String(process.env.PADRON_SHEETS_CSV_URL || '').trim();
const PADRON_REFRESH_MS = Number(process.env.PADRON_REFRESH_MS || 3600000);
const PADRON_FETCH_TIMEOUT_MS = Number(process.env.PADRON_FETCH_TIMEOUT_MS || 8000);
const GOOGLE_SERVICE_ACCOUNT_FILE = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim();
const GOOGLE_SHEETS_ID = String(process.env.GOOGLE_SHEETS_ID || '').trim();
const GOOGLE_SHEETS_GID = String(process.env.GOOGLE_SHEETS_GID || '0').trim();
// SA activa cuando el archivo de clave existe en disco
const SA_FILE_OK = Boolean(GOOGLE_SERVICE_ACCOUNT_FILE && GOOGLE_SHEETS_ID && fs.existsSync(GOOGLE_SERVICE_ACCOUNT_FILE));
const REMOTE_PADRON_AVAILABLE = SA_FILE_OK || Boolean(PADRON_SHEETS_CSV_URL);
const RESERVA_CC_EMAIL = process.env.RESERVA_CC_EMAIL || 'consejo@consorciolaenriqueta.com';
const RESERVAS_DB_PATH = process.env.RESERVAS_DB_PATH || path.join(__dirname, 'data', 'reservas.sqlite');
let padronPorLote = new Map();
let padronMtimeMs = 0;
let padronLastRefreshMs = 0;
let padronSource = 'none';

const reservasDbDir = path.dirname(RESERVAS_DB_PATH);
if (!fs.existsSync(reservasDbDir)) {
  fs.mkdirSync(reservasDbDir, { recursive: true });
}

const reservasDb = new sqlite3.Database(RESERVAS_DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    reservasDb.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    reservasDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    reservasDb.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

async function initReservasDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      apellido TEXT NOT NULL,
      dni TEXT NOT NULL,
      lote TEXT NOT NULL,
      celular TEXT NOT NULL,
      email TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      jitsi_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fecha, hora)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS restricted_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE,
      clave TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Usuario inicial para el área restringida.
  await dbRun(
    'INSERT OR IGNORE INTO restricted_users (usuario, clave) VALUES (?, ?)',
    ['consejo', '1234']
  );

  console.log(`✅ SQLite listo en ${RESERVAS_DB_PATH}`);
}

function isUniqueConstraintError(err) {
  return Boolean(err && (err.code === 'SQLITE_CONSTRAINT' || String(err.message || '').includes('UNIQUE constraint failed')));
}

function normalizeLote(value) {
  return String(value ?? '').trim();
}

function normalizeDni(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8);
}

function parseCsvLine(line) {
  return line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
}

function parsearPadronCsv(raw, sourceLabel) {
  const lineas = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lineas.length === 0) {
    throw new Error('El archivo CSV de padrón está vacío.');
  }

  const header = parseCsvLine(lineas[0]).map((h) => h.toLowerCase().trim());
  const idxLote = header.indexOf('lote') !== -1
    ? header.indexOf('lote')
    : header.indexOf('numero_lote');
  const dniColumnIndexes = header
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => /^dni\d*$/.test(name))
    .map(({ index }) => index);

  if (idxLote === -1 || dniColumnIndexes.length === 0) {
    throw new Error('El CSV debe tener encabezado "lote" o "numero_lote" y al menos una columna DNI (por ejemplo "dni", "dni1", "dni2").');
  }

  const nuevoPadron = new Map();

  for (let i = 1; i < lineas.length; i += 1) {
    const linea = lineas[i];
    if (linea.startsWith('#')) continue;

    const columnas = parseCsvLine(linea);
    const lote = normalizeLote(columnas[idxLote]);
    if (!lote) continue;

    if (!nuevoPadron.has(lote)) {
      nuevoPadron.set(lote, new Set());
    }

    dniColumnIndexes.forEach((idx) => {
      const dni = normalizeDni(columnas[idx]);
      if (dni) {
        nuevoPadron.get(lote).add(dni);
      }
    });

    if (nuevoPadron.get(lote).size === 0) {
      nuevoPadron.delete(lote);
    }
  }

  return nuevoPadron;
}

function actualizarPadronEnMemoria(nuevoPadron, sourceLabel) {
  padronPorLote = nuevoPadron;
  padronLastRefreshMs = Date.now();
  padronSource = sourceLabel;
  console.log(`✅ Padrón cargado: ${padronPorLote.size} lotes desde ${sourceLabel}`);
}

function cargarPadronCsvLocal() {
  const raw = fs.readFileSync(PADRON_CSV_PATH, 'utf8');
  const nuevoPadron = parsearPadronCsv(raw, PADRON_CSV_PATH);
  actualizarPadronEnMemoria(nuevoPadron, PADRON_CSV_PATH);
}

// ── Google SA JWT: implementación manual con crypto built-in, sin deps externos ──
function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function obtenerAccessTokenSA() {
  const crypto = require('crypto');
  const saJson = JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  const privateKeyRaw = String(saJson.private_key || '');
  const privateKey = privateKeyRaw.includes('\\n') ? privateKeyRaw.replace(/\\n/g, '\n') : privateKeyRaw;
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
    ...(saJson.private_key_id ? { kid: saJson.private_key_id } : {}),
  }));
  // Tolerancia a desfase de reloj entre host y Google para evitar invalid_grant.
  const iat = now - 60;
  const payload = base64UrlEncode(JSON.stringify({
    iss: saJson.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: iat + 3600,
    iat,
  }));
  const unsignedToken = `${header}.${payload}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsignedToken), privateKey);
  const jwt = `${unsignedToken}.${base64UrlEncode(sig)}`;

  const tokenBody = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });

  const tokenRaw = await tokenRes.text();
  let tokenJson = null;
  try {
    tokenJson = JSON.parse(tokenRaw);
  } catch (_) {
    tokenJson = null;
  }

  if (!tokenRes.ok) {
    const detail = tokenJson?.error_description || tokenJson?.error || tokenRaw || 'sin detalle';
    throw new Error(`Token request HTTP ${tokenRes.status}: ${detail}`);
  }

  if (!tokenJson?.access_token) {
    throw new Error('Token response sin access_token');
  }

  return tokenJson.access_token;
}

async function cargarPadronDesdeGoogleSheetsAPI() {
  const accessToken = await obtenerAccessTokenSA();

  // Sheets API v4: funciona con SA aunque la hoja no sea pública
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEETS_ID}/values/A1:Z2000?majorDimension=ROWS`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PADRON_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json();
    const rows = json.values || [];

    // Convertir array de filas a CSV para reusar parsearPadronCsv
    const raw = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const nuevoPadron = parsearPadronCsv(raw, 'Google Sheets API v4 (Service Account)');
    actualizarPadronEnMemoria(nuevoPadron, 'Google Sheets API v4 (Service Account)');
  } finally {
    clearTimeout(timeout);
  }
}

async function cargarPadronDesdeGoogleSheets() {
  if (SA_FILE_OK) return cargarPadronDesdeGoogleSheetsAPI();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PADRON_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(PADRON_SHEETS_CSV_URL, {
      method: 'GET',
      headers: { Accept: 'text/csv,text/plain,*/*' },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = await response.text();
    const nuevoPadron = parsearPadronCsv(raw, 'Google Sheets CSV');
    actualizarPadronEnMemoria(nuevoPadron, 'Google Sheets CSV');
  } finally {
    clearTimeout(timeout);
  }
}

async function asegurarPadronActualizado({ forzar = false } = {}) {
  if (REMOTE_PADRON_AVAILABLE) {
    const necesitaRefresh = forzar || !padronLastRefreshMs || (Date.now() - padronLastRefreshMs) >= PADRON_REFRESH_MS;
    if (necesitaRefresh) {
      try {
        await cargarPadronDesdeGoogleSheets();
        return;
      } catch (err) {
        console.error(`⚠️ No se pudo actualizar padrón desde Google Sheets: ${err.message}`);
        if (padronPorLote.size > 0) {
          console.log(`ℹ️ Usando padrón en memoria (${padronPorLote.size} lotes) como fallback.`);
          return;
        }
      }
    } else {
      return;
    }
  }

  const stat = fs.statSync(PADRON_CSV_PATH);
  if (stat.mtimeMs !== padronMtimeMs || padronPorLote.size === 0) {
    cargarPadronCsvLocal();
    padronMtimeMs = stat.mtimeMs;
  }
}

function validarLoteDniContraPadron(lote, dni) {
  const loteNormalizado = normalizeLote(lote);
  const dniNormalizado = normalizeDni(dni);
  const dnisDelLote = padronPorLote.get(loteNormalizado);
  return Boolean(dnisDelLote && dnisDelLote.has(dniNormalizado));
}

(async () => {
  try {
    await initReservasDb();
  } catch (err) {
    console.error(`❌ No se pudo inicializar SQLite: ${err.message}`);
  }

  try {
    await asegurarPadronActualizado({ forzar: true });
  } catch (err) {
    console.error(`❌ No se pudo cargar el padrón inicial: ${err.message}`);
  }

  if (REMOTE_PADRON_AVAILABLE) {
    setInterval(async () => {
      try {
        await cargarPadronDesdeGoogleSheets();
      } catch (err) {
        console.error(`⚠️ Refresh periódico fallido: ${err.message}`);
      }
    }, PADRON_REFRESH_MS);
    console.log(`🔄 Refresh automático del padrón cada ${PADRON_REFRESH_MS / 60000} minutos.`);
  }
})();

// ── TRANSPORTER SMTP CARBONIO ──
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,       // false = STARTTLS en puerto 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false // útil si el cert es autofirmado en Carbonio
  }
});

// ── VERIFICAR CONEXIÓN AL ARRANCAR ──
transporter.verify((error) => {
  if (error) {
    console.error('❌ Error SMTP:', error.message);
  } else {
    console.log('✅ SMTP Carbonio conectado y listo');
  }
});

// ── TEMPLATE HTML DEL MAIL ──
function buildMailHtml({ nombre, apellido, lote, dni, celular, fechaStr, hora, jitsiUrl }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmación de turno</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- CABECERA -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="
                    background:#2d4a2d;
                    border-radius:50%;
                    width:64px;height:64px;
                    text-align:center;
                    vertical-align:middle;
                    font-size:28px;
                    line-height:64px;
                  ">🏡</td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#5a6e5a;">
                Consorcio Club de Campo
              </div>
              <div style="font-size:28px;font-weight:300;color:#2d4a2d;margin-top:4px;letter-spacing:-0.5px;">
                La Enriqueta
              </div>
            </td>
          </tr>

          <!-- CUERPO -->
          <tr>
            <td style="
              background:#ffffff;
              border-radius:20px;
              padding:36px 40px;
              border:1px solid rgba(45,74,45,0.12);
              box-shadow:0 4px 24px rgba(45,74,45,0.08);
            ">
              <div style="font-size:22px;font-weight:300;color:#2d4a2d;margin-bottom:6px;">
                ¡Turno confirmado, ${nombre}!
              </div>
              <div style="font-size:14px;color:#5a6e5a;margin-bottom:28px;line-height:1.6;">
                Tu reunión con el Consejo de Administración quedó registrada.<br>
                Guardá este mail — tiene el link para ingresar a la videollamada.
              </div>

              <!-- DETALLE TURNO -->
              <table width="100%" cellpadding="0" cellspacing="0" style="
                background:#f5f0e8;
                border-radius:12px;
                padding:20px 24px;
                margin-bottom:28px;
              ">
                <tr>
                  <td style="padding:6px 0;">
                    <span style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5a6e5a;">Fecha y hora</span><br>
                    <span style="font-size:17px;color:#1a2e1a;font-weight:500;">📅 &nbsp;${fechaStr} · ${hora} hs</span>
                  </td>
                </tr>
                <tr><td style="border-top:1px solid #e8e0d0;padding-top:12px;margin-top:8px;"></td></tr>
                <tr>
                  <td style="padding:6px 0 6px;">
                    <span style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5a6e5a;">Propietario</span><br>
                    <span style="font-size:15px;color:#1a2e1a;">👤 &nbsp;${nombre} ${apellido}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;">
                    <span style="font-size:15px;color:#1a2e1a;">🏡 &nbsp;Lote ${lote} &nbsp;·&nbsp; DNI ${dni}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;">
                    <span style="font-size:15px;color:#1a2e1a;">📱 &nbsp;${celular}</span>
                  </td>
                </tr>
              </table>

              <!-- BOTÓN JITSI -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${jitsiUrl}" style="
                      display:inline-block;
                      background:linear-gradient(135deg,#2d4a2d,#4a7c4a);
                      color:#ffffff;
                      text-decoration:none;
                      padding:15px 36px;
                      border-radius:12px;
                      font-size:16px;
                      font-family:'Georgia',serif;
                      letter-spacing:0.3px;
                      box-shadow:0 4px 16px rgba(45,74,45,0.35);
                    ">
                      🎥 &nbsp;Entrar a la videollamada
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:10px;font-size:12px;color:#8a9e8a;">
                    El link se activa 5 minutos antes del turno
                  </td>
                </tr>
              </table>

              <!-- NOTA -->
              <div style="
                margin-top:28px;
                padding:14px 18px;
                background:#fffdf7;
                border-left:3px solid #c9a84c;
                border-radius:4px;
                font-size:13px;
                color:#5a6e5a;
                line-height:1.7;
              ">
                <strong style="color:#2d4a2d;">¿Necesitás cambiar el turno?</strong><br>
                Respondé este mail o escribinos a 
                <a href="mailto:consejo@consorciolaenriqueta.com" style="color:#4a7c4a;">
                  consejo@consorciolaenriqueta.com
                </a>
                <br><br>
                <strong style="color:#2d4a2d;">Importante:</strong>
                si el número de lote y el DNI no coinciden con los datos del propietario,
                la reserva quedará cancelada.
              </div>
            </td>
          </tr>

          <!-- PIE -->
          <tr>
            <td align="center" style="padding:24px 0 0;font-size:11px;color:#8a9e8a;letter-spacing:0.5px;">
              © ${new Date().getFullYear()} · Consorcio Club de Campo La Enriqueta<br>
              Este es un mensaje automático — no responder a esta dirección.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
}

// ── ENDPOINT RESERVA ──
app.post('/api/reserva', async (req, res) => {
  const { nombre, apellido, dni, lote, celular, email, fecha, hora, jitsiUrl } = req.body;

  // Validación básica
  const required = { nombre, apellido, dni, lote, celular, email, fecha, hora };
  const faltantes = Object.entries(required).filter(([, v]) => !v || !String(v).trim());
  if (faltantes.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `Faltan campos: ${faltantes.map(([k]) => k).join(', ')}`
    });
  }

  try {
    await asegurarPadronActualizado();
  } catch (err) {
    console.error(`❌ Error al actualizar padrón: ${err.message}`);
    return res.status(503).json({
      ok: false,
      error: 'No se pudo validar el padrón de propietarios. Intentá nuevamente más tarde.'
    });
  }

  if (!validarLoteDniContraPadron(lote, dni)) {
    return res.status(403).json({
      ok: false,
      error: 'El número de lote y DNI no coinciden con el padrón. La reserva queda cancelada.'
    });
  }

  // Formatear fecha legible
  const [y, m, d] = fecha.split('-');
  const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const mesesNombre = ['enero','febrero','marzo','abril','mayo','junio',
                       'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const dateObj = new Date(Number(y), Number(m) - 1, Number(d));
  const fechaStr = `${diasSemana[dateObj.getDay()]} ${d} de ${mesesNombre[Number(m) - 1]} de ${y}`;

  const htmlBody = buildMailHtml({ nombre, apellido, lote, dni, celular, fechaStr, hora, jitsiUrl });

  let reservaId = null;

  try {
    const insertResult = await dbRun(
      `
        INSERT INTO reservas (nombre, apellido, dni, lote, celular, email, fecha, hora, jitsi_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [nombre, apellido, normalizeDni(dni), normalizeLote(lote), celular, email, fecha, hora, jitsiUrl || null]
    );
    reservaId = insertResult.lastID;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({
        ok: false,
        error: 'Ese turno ya fue reservado. Elegí otro horario.'
      });
    }
    console.error('❌ Error al guardar la reserva en SQLite:', err.message);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la reserva. Intentá nuevamente.' });
  }

  try {
    await transporter.sendMail({
      from: `"Consorcio La Enriqueta" <${process.env.SMTP_USER}>`,
      to: email,
      cc: RESERVA_CC_EMAIL,
      subject: `✅ Turno confirmado – ${fechaStr} ${hora} hs`,
      html: htmlBody,
    });

    console.log(`📬 Mail enviado a ${email} (cc: ${RESERVA_CC_EMAIL}) — ${fechaStr} ${hora}`);
    res.json({ ok: true, message: 'Reserva confirmada y mail enviado.' });

  } catch (err) {
    if (reservaId !== null) {
      try {
        await dbRun('DELETE FROM reservas WHERE id = ?', [reservaId]);
      } catch (rollbackErr) {
        console.error(`⚠️ No se pudo revertir la reserva ${reservaId}: ${rollbackErr.message}`);
      }
    }
    console.error('❌ Error al enviar mail:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo enviar el mail. Revisá la config SMTP.' });
  }
});

// ── LOGIN ÁREA RESTRINGIDA ──
app.post('/api/restringido/login', async (req, res) => {
  const usuario = String(req.body?.usuario || '').trim();
  const clave = String(req.body?.clave || '').trim();

  if (!usuario || !clave) {
    return res.status(400).json({ ok: false, error: 'Usuario y clave requeridos.' });
  }

  try {
    const row = await dbGet(
      'SELECT id FROM restricted_users WHERE usuario = ? AND clave = ? LIMIT 1',
      [usuario, clave]
    );

    if (!row) {
      return res.status(401).json({ ok: false, error: 'Credenciales inválidas.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error login restringido:', err.message);
    return res.status(500).json({ ok: false, error: 'No se pudo validar el acceso.' });
  }
});

// ── TURNOS OCUPADOS ──
app.get('/api/turnos-ocupados', async (_, res) => {
  try {
    const rows = await dbAll(
      `
        SELECT fecha, hora
        FROM reservas
        WHERE fecha >= date('now', 'localtime')
        ORDER BY fecha, hora
      `
    );
    const turnos = rows.map((r) => `${r.fecha}_${r.hora}`);
    res.json({ ok: true, turnos });
  } catch (err) {
    console.error('❌ Error consultando turnos ocupados:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo consultar turnos ocupados.' });
  }
});

// ── LOTES DEL PADRÓN ──
app.get('/api/lotes', async (_, res) => {
  try {
    await asegurarPadronActualizado();
  } catch (err) {
    return res.status(503).json({ ok: false, error: 'Padrón no disponible.' });
  }
  const lotes = Array.from(padronPorLote.keys()).sort((a, b) => {
    const na = Number(a); const nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
  res.json({ ok: true, lotes });
});

// ── HEALTH CHECK ──
app.get('/api/health', (_, res) => res.json({
  ok: true,
  service: 'La Enriqueta API',
  padronLotes: padronPorLote.size,
  padronSource,
  padronLastRefreshMs
}));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
